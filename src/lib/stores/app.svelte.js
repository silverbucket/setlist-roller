import { accountSlot, consumeKnownAccountsCorrupted, getAccountToken, getKnownAccounts, removeKnownAccountEntry, saveKnownAccount } from "../accounts.js";
import { CONFIG_SECTIONS } from "../config-meta.js";
import { blankSong, DEFAULT_APP_CONFIG, normalizeAppConfig, normalizeMemberRecord, normalizeSongRecord } from "../defaults.js";
import { buildDefaultPerformance, scoreFixedOrder } from "../generator.js";
import GeneratorWorker from "../generator.worker.js?worker";
import { pruneStaleKeys, sortKeys } from "../keys.js";
import { migrator } from "../migrations.js";
import { clone, deepMerge, formatDelimitedList, getByPath, nowIso, parseDelimitedList, randomFrom, setByPath, titleForBand, tryParseJson, uid } from "../utils.js";

const STORAGE_PREFIX = "setlist-roller";

// Toast tone vocabulary. Values are the CSS class names that style the pill;
// callers go through the typed toastInfo/toastWarn/toastError helpers so a
// typo can't silently fall back to the default style.
const TOAST_TONE = Object.freeze({
    INFO: "info",
    WARN: "warning",
    DANGER: "danger",
});
const VALID_TOAST_TONES = new Set(Object.values(TOAST_TONE));
// Stack cap. New toasts past this drop the oldest so each one is visible.
const MAX_TOASTS = 3;
// Danger gets a longer dwell so multi-line error messages can actually be read.
const TOAST_DURATION_MS = { default: 6000, danger: 12000 };
// Cap on the in-memory sync log surfaced in the diagnostic panel. Old entries
// roll off so the list doesn't grow unbounded across a long session.
const MAX_SYNC_LOG = 12;

// ---- underscore-prefix property convention ----
// Properties prefixed with `_` are ephemeral, internal-only flags that ride
// alongside user-facing data. They are NEVER persisted to remoteStorage and
// must never be read by UI components as if they were domain fields.
//
//   _locked    — On the persisted "current-set" localStorage blob: `true`
//                while the user has the setlist locked (prevents the next
//                roll from clobbering it). Round-tripped through localStorage
//                only; stripped before upload to remoteStorage.
//
//   _keepLock  — On the options object passed into `generate()`: signals that
//                "Optimize Order" should preserve `setlistLocked` across the
//                regeneration. Lives only inside one generate() call; never
//                stored anywhere.
//
// Adding a new `_*` flag? Make sure (a) it's stripped before any upload to
// remoteStorage, and (b) the lifetime is bounded — long-lived ephemeral flags
// silently accumulate on the object and turn into permanent state.

export function normalizeAuthToken(token) {
    return typeof token === "string" && token.length > 0 ? token : undefined;
}

// Sanity-check a remoteStorage address before handing it to webfinger
// discovery. Accepts either `user@host.tld` or a bare `host.tld`. We
// can't validate that the host actually serves remoteStorage without a
// network round-trip — this just rejects obvious typos so the user
// gets immediate feedback instead of a 1–3 s spinner ending in a
// confusing rs.js error.
const CONNECT_ADDRESS_RE = /^([^\s@]+@)?[^\s@.]+\.[^\s@]+$/;

export function isValidConnectAddress(address) {
    if (typeof address !== "string") return false;
    return CONNECT_ADDRESS_RE.test(address.trim());
}

export function syncSavedSongIntoSetlist(setlist, savedSong, appConfig, keyFlow = false) {
    if (!setlist?.songs?.length || !savedSong?.id) return setlist;

    let changed = false;
    const syncedSongs = setlist.songs.map((song) => {
        if (song.id !== savedSong.id) return song;

        const nextSong = {
            ...song,
            name: savedSong.name,
            cover: savedSong.cover || false,
            instrumental: savedSong.instrumental || false,
            key: savedSong.key || "",
            notes: savedSong.notes || "",
        };

        if (
            nextSong.name !== song.name ||
            nextSong.cover !== song.cover ||
            nextSong.instrumental !== song.instrumental ||
            nextSong.key !== song.key ||
            nextSong.notes !== song.notes
        ) {
            changed = true;
        }

        return nextSong;
    });

    if (!changed) return setlist;

    const rescored = scoreFixedOrder(syncedSongs, appConfig || DEFAULT_APP_CONFIG, { keyFlow });
    return { ...setlist, songs: rescored.songs, summary: rescored.summary };
}

export function createAppStore(repo) {
    // ---- per-user localStorage scoping ----
    let currentUserAddress = "";
    function storageKey(base) { return accountSlot(currentUserAddress).key(base); }

    // Monotonic session id — bumped on every connect/swap. Async work that
    // started under one session is discarded if the session has moved on.
    let activeSession = 0;

    // True while orchestrating an account swap; tells the global disconnected
    // handler to skip its full state-wipe (we want the snapshot to stay).
    // Held from `connectToAccount` entry until the new account's `connected`
    // event fires (or a fatal error / watchdog releases it). Holding past
    // `repo.swap()` resolution is critical: the swap promise can resolve via
    // its 3 s timeout before rs.js actually emits the old account's
    // `disconnected` event, and that late event would otherwise take the
    // wipe path against the new account.
    let isSwitching = false;
    // Backstop in case neither `connected` nor a fatal error fires after a
    // swap (e.g. token rejected silently, OAuth tab closed). Without this,
    // a single failed swap would lock out future swap attempts via the
    // `isSwitching` re-entry guard.
    let switchingWatchdog = null;
    // Post-swap "straggler" guard. Even after `connected` fires for the new
    // account and we release `isSwitching`, rs.js can still emit the OLD
    // account's `disconnected` event a moment later — it was queued behind
    // repo.swap()'s 3 s safety timeout, which sometimes lets the swap
    // promise resolve before the underlying disconnect actually finishes.
    // Without this flag, the late event takes the wipe path against the
    // newly-connected account. We arm it at swap entry, leave it set across
    // the `connected` boundary, and let either the late disconnect itself
    // or a 5 s timeout consume it (5 s is generous vs swap()'s 3 s, but
    // small enough that a real user-initiated disconnect right after a
    // swap isn't accidentally swallowed).
    let pendingSwapDisconnect = false;
    let pendingSwapDisconnectTimer = null;
    function expectSwapDisconnect() {
        pendingSwapDisconnect = true;
        if (pendingSwapDisconnectTimer) clearTimeout(pendingSwapDisconnectTimer);
        pendingSwapDisconnectTimer = setTimeout(() => {
            pendingSwapDisconnectTimer = null;
            pendingSwapDisconnect = false;
        }, 5000);
    }
    function consumePendingSwapDisconnect() {
        if (!pendingSwapDisconnect && !pendingSwapDisconnectTimer) return;
        pendingSwapDisconnect = false;
        if (pendingSwapDisconnectTimer) {
            clearTimeout(pendingSwapDisconnectTimer);
            pendingSwapDisconnectTimer = null;
        }
    }
    function releaseSwitching(reason) {
        if (!isSwitching && !switchingWatchdog) return;
        isSwitching = false;
        if (switchingWatchdog) {
            clearTimeout(switchingWatchdog);
            switchingWatchdog = null;
        }
        if (reason) pushSyncLog(`Swap guard released (${reason})`);
    }

    // ---- core state ----
    let songs = $state([]);
    let appConfig = $state(null);
    let bootstrapMeta = $state(null);
    let generatedSetlist = $state(null);
    let isGenerating = $state(false);
    let activeWorker = null;
    let generationId = 0;
    let setlistLocked = $state(false);
    let setlistSaved = $state(false);
    // Id of the saved setlist currently loaded into generatedSetlist, if any.
    // Used to update-in-place instead of duplicating when the user re-saves.
    let loadedSavedId = $state("");
    let pendingRollConfirm = $state(false);
    let savedSetlists = $state([]);
    let bandMembers = $state({});

    // ---- connection ----
    let connectionStatus = $state("pending");
    let connectAddress = $state("");
    let knownAccounts = $state(getKnownAccounts());

    // ---- ui ----
    let activeView = $state("roll");
    let loadError = $state("");
    let busyMessage = $state("");
    let toastMessages = $state([]);
    let initialSyncComplete = $state(false);
    let firstRunBandName = $state("");

    // ---- sync ----
    let syncIndicatorVisible = $state(false);
    let syncStatusLabel = $state("Preparing connection");
    let syncActiveCount = 0;
    let syncIndicatorTimer = null;
    let syncLogEntries = $state([]);
    // High-level reload state for the in-app pill / skeletons. Distinct from
    // syncActiveCount (which tracks per-write bursts) and from
    // initialSyncComplete (which gates the full-screen sync-shell). This drives
    // the post-swap experience where the user sees instant snapshot UI but a
    // background reload is still in flight.
    let syncState = $state("idle"); // "idle" | "syncing" | "synced" | "error"
    let syncStateTimer = null;
    // Count of in-flight reloadAll calls. We can't mark "synced" while any
    // reload is mid-flight.
    let reloadInFlight = 0;
    // Bumped when manual recovery abandons a stalled reload. Late completions
    // from older epochs are still stale via reloadGen, and should not touch
    // in-flight accounting for the fresh retry.
    let reloadEpoch = 0;
    // Monotonic counter incremented on every reloadAll START. After a reload
    // completes, it only applies its results if its captured generation is
    // still the latest — older concurrent reloads (which captured an emptier
    // cache snapshot) get discarded so their stale results don't clobber a
    // newer reload's fresh data. Without this, a fast burst of onChange
    // events during bootstrap can race in completion order and the UI lands
    // on whichever reload happens to finish last, regardless of how recent
    // the cache state it captured was.
    let reloadGen = 0;
    // Number of documents whose bodies rs.js has not yet pulled from remote.
    // Read deterministically from the cache after each reloadAll: as long as
    // any folder has stub entries (children present in the listing but with
    // no body), the catalog is not actually hydrated — even if rs.js has
    // already fired sync-done. The pill stays in "syncing" until this hits 0
    // AND we've seen at least one sync round complete (so we don't false-
    // resolve before rs.js has pulled the folder listings themselves).
    let pendingBodies = $state(0);
    // Set true the first time rs.js fires sync-done {completed: true} since
    // the last (re)connect. Without this, an empty cache (no listing yet)
    // would read pendingBodies=0 and resolve immediately.
    let syncRoundCompleted = false;
    // rs.js does its work in multiple back-to-back "rounds" — sync-done
    // {completed:true} fires after each round's queue drains, not when the
    // whole tree is in. After each round, rs.js waits `syncInterval` ms
    // (configured in src/lib/remotestorage.js) before starting the next
    // round; round 1 typically pulls only the root + a few small docs,
    // round 2 pulls the folder listings, round 3 pulls the bodies. The
    // only deterministic "all rounds drained" signal is "rs.js's next
    // polling tick had no new work" — i.e. quiescence for at least one
    // full sync interval. The settle is therefore matched to rs.js's
    // bootstrap polling cadence, plus a small buffer for tasks to drain.
    // Once the pill first flips to "synced", we relax rs.js's polling to
    // STEADY_SYNC_INTERVAL_MS so the app doesn't hammer the server long-
    // term — see `relaxSyncInterval()`.
    const BOOTSTRAP_SYNC_INTERVAL_MS = 2000; // matches rs.js syncInterval set at construction
    const STEADY_SYNC_INTERVAL_MS = 10000;   // rs.js library default
    const SYNC_SETTLE_MS = BOOTSTRAP_SYNC_INTERVAL_MS + 500;
    let syncFlipTimer = null;
    // Tracks whether we've ever flipped to "synced" since the last
    // (re)connect. Used to drive the one-time syncInterval relaxation.
    let initialSyncSettled = false;
    // Watchdog for stalled reloads. If reloadAll runs longer than
    // SYNC_STALL_TIMEOUT_MS (15 s) — flaky network, rs.js stuck mid-pull —
    // surface a Retry / Disconnect CTA in the sync-shell so the user
    // isn't trapped on a spinner. The init flow already has its own 10 s
    // pending → disconnected fallback (init() below); this covers the
    // gap once the connection has succeeded but the data load hangs.
    const SYNC_STALL_TIMEOUT_MS = 15000;
    let syncStalled = $state(false);
    let syncStalledTimer = null;

    // ---- generation options (loaded properly on connect via loadUserLocalData) ----
    let generationOptions = $state(defaultGenerationOptions(DEFAULT_APP_CONFIG));

    // ---- song editor ----
    let editorSong = $state(null);
    let selectedSongId = $state("");
    let editReturnView = $state("");
    let songSearch = $state("");
    let songFilter = $state("all");
    let songKeyFilters = $state(new Set());

    // ---- band editing ----
    let expandedBandMember = $state("");
    let newMemberName = $state("");
    let newInstrumentByMember = $state({});
    let newTuningByInstrument = $state({});
    let newTechniqueByInstrument = $state({});

    // ---- import/export ----
    let importMode = $state("skip");
    let importFile = $state(null);


    // ---- advanced config sub-view ----
    let bandSubView = $state("main"); // "main" | "advanced" | "member-edit"
    let editingMemberName = $state("");

    // ---- derived ----
    let appTitle = $derived(titleForBand(appConfig?.bandName));
    // First-run modal visibility is derived, not stored. Tying it to the
    // connection state (rather than scattering imperative `showFirstRunPrompt
    // = true/false` writes across reloadAll, restoreSnapshot, deleteAllData,
    // finishFirstRun, and the disconnected handler) prevents a class of drift
    // bugs where a partial auth failure leaves the modal visible after
    // connectionStatus has already flipped back to "disconnected" — which
    // surfaced as the user seeing the band-name prompt instead of the login
    // page after a failed authorization. The modal only makes sense when
    // we're actually connected, the initial sync has landed, and there's no
    // appConfig yet — so encode exactly that.
    let showFirstRunPrompt = $derived(
        connectionStatus === "connected" && initialSyncComplete && !appConfig,
    );
    let emptyCatalog = $derived(connectionStatus === "connected" && songs.length === 0);
    let bandMemberEntries = $derived(
        Object.entries(bandMembers || {}).sort(([a], [b]) => a.localeCompare(b))
    );
    let availableMemberNames = $derived(buildAvailableMemberNames());
    let memberInstrumentChoicesByMember = $derived(buildMemberInstrumentChoicesByMember());
    let memberTuningChoicesByMember = $derived(buildMemberTuningChoicesByMember());
    let defaultTuningByMemberInstrument = $derived(buildDefaultTuningByMemberInstrument());
    let allInstrumentNamesList = $derived(buildAllInstrumentNames());
    let instrumentTypeCount = $derived(allInstrumentNamesList.length);
    let visibleSongs = $derived(computeVisibleSongs());
    let usedKeys = $derived(
        sortKeys([...new Set(songs.map((s) => s.key).filter(Boolean))]),
    );

    $effect(() => {
        const pruned = pruneStaleKeys(songKeyFilters, usedKeys);
        if (pruned) songKeyFilters = pruned;
    });

    // Keep the per-account snapshot fresh: any direct edit (saveSong,
    // persistMemberEdit, addSetlistSong, etc.) mutates these state slots,
    // so a debounced scheduleSnapshot() here covers all of them. Without
    // this, the snapshot only refreshed at the end of reloadAll, so a
    // fast account swap right after editing showed last-synced data.
    $effect(() => {
        // Touch the state we want to snapshot.
        void songs;
        void appConfig;
        void savedSetlists;
        void bandMembers;
        if (currentUserAddress) scheduleSnapshot();
    });

    // ---- helpers ----

    function defaultGenerationOptions(config = appConfig) {
        const source = config || DEFAULT_APP_CONFIG;
        // Use ?? for numeric defaults: a user-set 0 (count, temperature, etc.)
        // would otherwise silently fall back to the default.
        return {
            count: source.general?.count ?? 15,
            beamWidth: source.general?.beamWidth ?? 20,
            maxCovers: source.general?.limits?.covers ?? -1,
            maxInstrumentals: source.general?.limits?.instrumentals ?? -1,
            keyFlow: false,
            seed: "",
            randomness: {
                temperature: source.general?.randomness?.temperature ?? 0.85,
                finalChoicePool: source.general?.randomness?.finalChoicePool ?? 12
            },
            show: {
                members: clone(source.show?.members || {})
            }
        };
    }

    function buildAvailableMemberNames() {
        const names = new Set([
            ...Object.keys(bandMembers || {}),
            ...Object.keys(generationOptions.show?.members || {}),
            ...songs.flatMap((song) => Object.keys(song.members || {}))
        ]);
        return Array.from(names).sort();
    }

    function buildMemberInstrumentChoicesByMember() {
        return availableMemberNames.reduce((result, memberName) => {
            const fromSongs = songs.flatMap((song) =>
                (song.members?.[memberName]?.instruments || []).map((o) => o.name)
            );
            const fromConfig = generationOptions.show?.members?.[memberName]?.allowedInstruments || [];
            const fromBand = (bandMembers?.[memberName]?.instruments || []).map((i) => i.name);
            result[memberName] = Array.from(new Set([...fromBand, ...fromSongs, ...fromConfig].filter(Boolean))).sort();
            return result;
        }, {});
    }

    function buildMemberTuningChoicesByMember() {
        return availableMemberNames.reduce((result, memberName) => {
            result[memberName] = (memberInstrumentChoicesByMember[memberName] || []).reduce((ir, instrumentName) => {
                const fromBand = (bandMembers?.[memberName]?.instruments || [])
                    .find((i) => i.name === instrumentName)?.tunings || [];
                const fromConfig = generationOptions.show?.members?.[memberName]?.allowedTunings?.[instrumentName] || [];
                ir[instrumentName] = Array.from(new Set([...fromBand, ...fromConfig].filter(Boolean))).sort();
                return ir;
            }, {});
            return result;
        }, {});
    }

    function buildDefaultTuningByMemberInstrument() {
        return availableMemberNames.reduce((result, memberName) => {
            result[memberName] = (bandMembers?.[memberName]?.instruments || []).reduce((ir, instrument) => {
                ir[instrument.name] = instrument.defaultTuning || "";
                return ir;
            }, {});
            return result;
        }, {});
    }

    function buildAllInstrumentNames() {
        const names = new Set();
        Object.values(memberInstrumentChoicesByMember || {}).forEach((instruments) => {
            (instruments || []).forEach((name) => names.add(name));
        });
        return Array.from(names).sort();
    }

    function songIncompleteReasons(song) {
        const members = bandMembers || {};
        const memberNames = Object.keys(members);
        if (memberNames.length === 0) return [];
        const songMembers = song.members || {};
        const reasons = [];
        for (const name of memberNames) {
            const memberSetup = songMembers[name];
            if (!memberSetup) { reasons.push(`${name}: not set up`); continue; }
            const instruments = memberSetup.instruments || [];
            if (instruments.length === 0) { reasons.push(`${name}: needs instrument`); continue; }
            for (const inst of instruments) {
                if (!inst.name) { reasons.push(`${name}: instrument not selected`); continue; }
                const bandInst = (members[name].instruments || []).find((i) => i.name === inst.name);
                if (bandInst && (bandInst.techniques || []).length > 0 && (!Array.isArray(inst.picking) || inst.picking.length === 0)) {
                    reasons.push(`${name}: ${inst.name} needs technique`);
                }
            }
        }
        return reasons;
    }

    function isSongIncomplete(song) {
        return songIncompleteReasons(song).length > 0;
    }

    function computeVisibleSongs() {
        const query = songSearch.trim().toLowerCase();
        return songs.filter((song) => {
            if (songFilter === "covers" && !song.cover) return false;
            if (songFilter === "instrumentals" && !song.instrumental) return false;
            if (songFilter === "originals" && song.cover) return false;
            if (songFilter === "incomplete" && !isSongIncomplete(song)) return false;
            if (songFilter === "unpracticed" && !song.unpracticed) return false;
            if (songKeyFilters.size > 0 && !songKeyFilters.has(song.key)) return false;
            if (!query) return true;
            return [song.name, song.key, ...Object.keys(song.members || {})]
                .join(" ").toLowerCase().includes(query);
        });
    }

    function loadStoredGenerationOptions() {
        const fallback = defaultGenerationOptions(DEFAULT_APP_CONFIG);
        if (typeof localStorage === "undefined") return fallback;
        const stored = tryParseJson(localStorage.getItem(storageKey("ui-options")), null);
        return stored ? deepMerge(fallback, stored) : fallback;
    }

    function persistGenerationOptions() {
        if (typeof localStorage === "undefined") return;
        localStorage.setItem(storageKey("ui-options"), JSON.stringify(generationOptions));
    }

    function replaceGeneratedSetlist(nextSetlist) {
        generatedSetlist = nextSetlist;
    }

    function updateCurrentSetlist(nextSetlist) {
        generatedSetlist = nextSetlist;
    }

    function clearGeneratedSetlist() {
        generatedSetlist = null;
        loadedSavedId = "";
    }

    // Strip deprecated "energy" field and energy-related notes from saved setlist songs
    function stripEnergy(sets) {
        if (!Array.isArray(sets)) return sets;
        return sets.map((s) => ({
            ...s,
            songs: (s.songs || []).map((song) => {
                const { energy, ...rest } = song;
                return {
                    ...rest,
                    transitionNotes: (rest.transitionNotes || []).filter((n) => !/energy/i.test(n)),
                    contextNotes: (rest.contextNotes || []).filter((n) => !/energy/i.test(n)),
                };
            }),
        }));
    }

    function loadCurrentSetlist() {
        if (typeof localStorage === "undefined") return null;
        return tryParseJson(localStorage.getItem(storageKey("current-set")), null);
    }

    function persistCurrentSetlist() {
        if (typeof localStorage === "undefined") return;
        if (generatedSetlist) {
            localStorage.setItem(storageKey("current-set"), JSON.stringify({ ...generatedSetlist, _locked: setlistLocked }));
        } else {
            localStorage.removeItem(storageKey("current-set"));
        }
    }

    // Remove any un-scoped legacy localStorage keys so they can't leak between
    // accounts. Called only from the `disconnected` handler — that's the
    // migration path for users coming from the pre-multi-account build, where
    // these keys were written without the per-account hash. After one
    // disconnect, the keys are gone; we don't re-run this on every connect.
    function clearUnscopedLocalStorage() {
        if (typeof localStorage === "undefined") return;
        localStorage.removeItem("setlist-roller-ui-options");
        localStorage.removeItem("setlist-roller-saved-sets");
        localStorage.removeItem("setlist-roller-current-set");
    }

    // Clear the current user's scoped localStorage keys (called on disconnect)
    function clearUserLocalStorage() {
        if (typeof localStorage === "undefined" || !currentUserAddress) return;
        localStorage.removeItem(storageKey("ui-options"));
        localStorage.removeItem(storageKey("saved-sets"));
        localStorage.removeItem(storageKey("current-set"));
    }

    // Load all per-user localStorage data (called on connect when we know the user)
    function loadUserLocalData() {
        const current = loadCurrentSetlist();
        const locked = current?._locked || false;
        if (locked) replaceGeneratedSetlist(current);
        else clearGeneratedSetlist();
        setlistLocked = locked;
        setlistSaved = false;
        generationOptions = loadStoredGenerationOptions();
    }

    // ---- toast ----
    function addToast(message, tone) {
        // Unknown tones fall back to INFO instead of silently rendering as the
        // default style with no semantic class (e.g. "warn" vs "warning").
        const validTone = VALID_TOAST_TONES.has(tone) ? tone : TOAST_TONE.INFO;
        const id = uid("toast");
        // Cap the stack — drop oldest so a fresh toast is always visible.
        const next = [...toastMessages, { id, message, tone: validTone }];
        toastMessages = next.length > MAX_TOASTS ? next.slice(-MAX_TOASTS) : next;
        const duration = validTone === TOAST_TONE.DANGER ? TOAST_DURATION_MS.danger : TOAST_DURATION_MS.default;
        setTimeout(() => {
            toastMessages = toastMessages.filter((t) => t.id !== id);
        }, duration);
    }
    function toastInfo(message)  { addToast(message, TOAST_TONE.INFO); }
    function toastWarn(message)  { addToast(message, TOAST_TONE.WARN); }
    function toastError(message) { addToast(message, TOAST_TONE.DANGER); }

    function pushSyncLog(message) {
        if (!message) return;
        const time = new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        });
        syncLogEntries = [
            ...syncLogEntries.slice(-(MAX_SYNC_LOG - 1)),
            { id: uid("sync-log"), time, message },
        ];
    }

    function clearSyncLog() {
        syncLogEntries = [];
    }

    // ---- sync indicators ----
    function beginSync(label = "Syncing") {
        syncActiveCount += 1;
        syncStatusLabel = label;
        syncIndicatorVisible = true;
        pushSyncLog(label);
        if (syncIndicatorTimer) {
            clearTimeout(syncIndicatorTimer);
            syncIndicatorTimer = null;
        }
    }

    function endSync(nextLabel = "All changes saved") {
        syncActiveCount = Math.max(0, syncActiveCount - 1);
        if (syncActiveCount > 0) return;
        syncStatusLabel = nextLabel;
        if (syncIndicatorTimer) clearTimeout(syncIndicatorTimer);
        syncIndicatorTimer = setTimeout(() => {
            syncIndicatorVisible = false;
            syncIndicatorTimer = null;
        }, 1000);
    }

    async function withSync(label, callback) {
        beginSync(label);
        try {
            return await callback();
        } finally {
            endSync();
        }
    }

    // [DEBUG SYNC] Tagged logger — flip on in the console with `DEBUG_SYNC=1`.
    // Centralised so we can change format / silence in one place.
    function dbg(...args) {
        if (typeof window !== "undefined" && window.DEBUG_SYNC) {
            console.log("[sync]", ...args);
        }
    }

    function setSyncState(next) {
        if (syncState !== next) dbg(`syncState: ${syncState} → ${next}`);
        if (syncStateTimer) {
            clearTimeout(syncStateTimer);
            syncStateTimer = null;
        }
        // Any state transition cancels a pending flip — if we're going back
        // to "syncing" the gates failed, and "error"/"idle" make the flip
        // moot.
        if (next !== "synced" && syncFlipTimer) {
            clearTimeout(syncFlipTimer);
            syncFlipTimer = null;
        }
        syncState = next;
        // "synced" is a transient confirmation — fade back to idle so the pill
        // doesn't linger forever after a successful background reload.
        if (next === "synced") {
            // Bootstrap is over: relax rs.js's polling to its steady-state
            // interval so we don't hammer the server every 2 s for the rest
            // of the session. Only do this once per connect.
            if (!initialSyncSettled) {
                initialSyncSettled = true;
                relaxSyncInterval();
            }
            syncStateTimer = setTimeout(() => {
                if (syncState === "synced") syncState = "idle";
                syncStateTimer = null;
            }, 2500);
        }
    }

    function relaxSyncInterval() {
        try {
            const current = repo.getSyncInterval();
            if (current < STEADY_SYNC_INTERVAL_MS) {
                dbg(`relaxSyncInterval: ${current}ms → ${STEADY_SYNC_INTERVAL_MS}ms`);
                repo.setSyncInterval(STEADY_SYNC_INTERVAL_MS);
            }
        } catch (e) {
            // Non-fatal: bootstrap interval keeps polling, just more
            // frequently than ideal. Log and move on.
            dbg(`relaxSyncInterval failed: ${e?.message || e}`);
        }
    }

    function tightenSyncInterval() {
        try {
            const current = repo.getSyncInterval();
            if (current > BOOTSTRAP_SYNC_INTERVAL_MS) {
                dbg(`tightenSyncInterval: ${current}ms → ${BOOTSTRAP_SYNC_INTERVAL_MS}ms`);
                repo.setSyncInterval(BOOTSTRAP_SYNC_INTERVAL_MS);
            }
        } catch (e) {
            dbg(`tightenSyncInterval failed: ${e?.message || e}`);
        }
    }

    // Cancel any pending "synced" flip because rs.js just told us it's still
    // working. Called from every signal that proves activity is ongoing:
    // sync-started, sync-req-done, remote onChange, reloadAll start. The
    // pending flip will be re-scheduled by the next maybeMarkSynced() call
    // once the gates pass again.
    function bumpSyncActivity(reason) {
        if (syncFlipTimer) {
            dbg(`bumpSyncActivity: cancelling pending flip (${reason})`);
            clearTimeout(syncFlipTimer);
            syncFlipTimer = null;
        }
    }

    // Decide whether sync activity is genuinely settled. Three deterministic
    // gates, all read from real state:
    //   1. No reloadAll currently running.
    //   2. The cache has zero pending document bodies.
    //   3. rs.js has reported at least one completed sync round in this
    //      session — guards against an empty cache (no folder listing yet)
    //      reading as "0 pending" and false-resolving on connect.
    // The gates can pass after round 1 with the cache still empty (rs.js
    // hasn't yet pulled the catalog folders); rs.js then waits one full
    // `syncInterval` before starting the next round. The only way to know
    // "no more rounds are coming" is to observe one full polling interval
    // of silence. SYNC_SETTLE_MS = syncInterval + small buffer encodes
    // exactly that: any sync-started / sync-req-done / remote onChange /
    // reloadAll bumpSyncActivity()s and re-arms the gate. Once a full poll
    // cycle elapses without any of those, rs.js's next scheduled wake-up
    // demonstrably found no new work — and only then do we flip "synced".
    function maybeMarkSynced() {
        const reason =
            syncState !== "syncing" ? `not-syncing(${syncState})` :
            reloadInFlight > 0 ? `reloadInFlight=${reloadInFlight}` :
            pendingBodies > 0 ? `pendingBodies=${pendingBodies}` :
            !syncRoundCompleted ? "syncRoundCompleted=false" :
            loadError ? "loadError" :
            null;
        dbg(`maybeMarkSynced: ${reason ? `blocked by ${reason}` : "scheduling flip"} (state=${syncState} reload=${reloadInFlight} pending=${pendingBodies} round=${syncRoundCompleted})`);
        if (reason) return;
        // Already scheduled — let the existing timer run; nothing has changed
        // that would justify resetting it.
        if (syncFlipTimer) return;
        syncFlipTimer = setTimeout(() => {
            syncFlipTimer = null;
            // Re-check the gates: any of them may have flipped during the
            // settle window (a new reload kicked off, a body event landed).
            const blocker =
                syncState !== "syncing" ? `not-syncing(${syncState})` :
                reloadInFlight > 0 ? `reloadInFlight=${reloadInFlight}` :
                pendingBodies > 0 ? `pendingBodies=${pendingBodies}` :
                !syncRoundCompleted ? "syncRoundCompleted=false" :
                loadError ? "loadError" :
                null;
            if (blocker) {
                dbg(`syncFlipTimer fired but gates failed: ${blocker}`);
                return;
            }
            dbg("syncFlipTimer fired — FLIPPING to synced");
            setSyncState("synced");
        }, SYNC_SETTLE_MS);
    }

    // ---- navigation ----
    function syncRouteFromHash() {
        const next = window.location.hash.replace(/^#\/?/, "") || "roll";
        const allowed = ["roll", "saved", "songs", "band", "help"];
        activeView = allowed.includes(next) ? next : "roll";
    }

    function navigate(view) {
        window.location.hash = `/${view}`;
    }

    // ---- connection ----
    function connectStorage(token) {
        const trimmed = connectAddress.trim();
        if (!trimmed) {
            toastError("Put in a remoteStorage address first.");
            return;
        }
        if (!isValidConnectAddress(trimmed)) {
            // Inline error — webfinger would otherwise spin 1–3 s before
            // reporting a confusing DiscoveryError.
            loadError = "That doesn't look like a remoteStorage address. Try user@host or host.tld.";
            return;
        }
        const normalizedToken = normalizeAuthToken(token);
        clearSyncLog();
        connectionStatus = "connecting";
        loadError = "";
        syncStatusLabel = "Connecting to remoteStorage";
        pushSyncLog(`Connecting to ${trimmed}`);
        repo.connect(trimmed, normalizedToken);
    }

    function disconnectStorage() {
        // Save current token before disconnecting so we can switch back later
        if (currentUserAddress) {
            saveKnownAccount(currentUserAddress, { bandName: appConfig?.bandName || "" }, repo.getToken());
        }
        repo.disconnect();
    }

    async function connectToAccount(address) {
        // Refuse if a connect/swap is already in flight — clicking switch
        // mid-discovery used to take the wrong branch and double-connect.
        if (connectionStatus === "connecting" || isSwitching) {
            toastWarn("Already connecting — hold on.");
            return;
        }
        if (!address) return;

        const savedToken = normalizeAuthToken(getAccountToken(address));

        // 1. Persist the current account before touching state.
        if (repo.isConnected()) {
            saveSnapshot();
            if (currentUserAddress) {
                saveKnownAccount(currentUserAddress, { bandName: appConfig?.bandName || "" }, repo.getToken());
            }
        }

        // 2. Bump the session — any in-flight async (reloadAll, worker
        //    callbacks) from the previous account is now stale.
        activeSession += 1;

        // 3. Restore the target account's snapshot for instant UI; otherwise
        //    blank the visible state until the connected/sync handlers fill it.
        const hasSnapshot = restoreSnapshot(address);
        if (hasSnapshot) {
            currentUserAddress = address;
            connectAddress = address;
            loadUserLocalData();
            initialSyncComplete = true;
        } else {
            songs = [];
            appConfig = null;
            savedSetlists = [];
            bandMembers = {};
            initialSyncComplete = false;
            currentUserAddress = "";
            connectAddress = address;
        }

        // Clear transient state
        clearGeneratedSetlist();
        setlistLocked = false;
        setlistSaved = false;
        selectedSongId = "";
        editorSong = null;

        clearSyncLog();
        connectionStatus = "connecting";
        syncStatusLabel = "Switching accounts";
        // Snapshot path skips the full-screen sync-shell, so the user lands on
        // Roll instantly. Mark sync in-flight up front so the TopBar pill and
        // RollScreen skeletons render immediately rather than waiting for
        // reloadAll() to start. Reset the per-session sync gates — the new
        // account starts a fresh round and inherits no completion state from
        // the previous session.
        setSyncState("syncing");
        syncRoundCompleted = false;
        pendingBodies = 0;
        initialSyncSettled = false;
        bumpSyncActivity("account swap");
        // The previous account may have relaxed rs.js to its steady-state
        // polling interval; tighten it back up so the new account gets a
        // snappy bootstrap.
        tightenSyncInterval();
        pushSyncLog(`Switching to ${address}`);

        // 4. Swap the rs.js connection. `swap()` disconnects cleanly (which
        //    fires `disconnected`; the global handler skips its wipe because
        //    isSwitching is true) and resets the cache before reconnecting.
        //    `isSwitching` is intentionally NOT cleared in `finally`: rs.js's
        //    `disconnected` event for the OLD account can fire after
        //    `repo.swap()` resolves (the swap promise resolves via its 3 s
        //    safety timeout before the actual event lands). The connected
        //    handler clears it on a successful swap; the watchdog clears it
        //    if neither connected nor a thrown error ever lands.
        isSwitching = true;
        if (switchingWatchdog) clearTimeout(switchingWatchdog);
        switchingWatchdog = setTimeout(() => {
            switchingWatchdog = null;
            if (!isSwitching) return;
            // Full reset — the re-entry guard at the top of connectToAccount
            // checks BOTH isSwitching AND connectionStatus === "connecting",
            // so just clearing isSwitching would leave the user locked out
            // of retrying. Drop everything back to a clean disconnected
            // state and surface the failure so they know what happened.
            isSwitching = false;
            consumePendingSwapDisconnect();
            connectionStatus = "disconnected";
            setSyncState("error");
            loadError = "Account swap timed out. Try again.";
            toastError(loadError);
            pushSyncLog("Swap watchdog: released after 15s — neither connected nor error fired");
        }, 15000);
        try {
            if (repo.isConnected()) {
                // rs.js will fire `disconnected` (for the old account) and
                // then `connected` (for the new). Usually the disconnect
                // lands first while isSwitching is true. But repo.swap()
                // resolves via a 3 s safety timeout that doesn't wait for
                // the underlying disconnect to actually fire, so the OLD
                // account's `disconnected` can arrive AFTER the new
                // account's `connected` — by which point isSwitching has
                // already been released. Arm the straggler guard so that
                // out-of-order late disconnect is swallowed instead of
                // taking the wipe path against the new account.
                expectSwapDisconnect();
                await repo.swap(address, savedToken);
            } else {
                // Not connected — straight connect, no swap dance needed.
                connectAddress = address;
                connectStorage(savedToken);
            }
        } catch (error) {
            toastError(error?.message || "Could not switch accounts.");
            connectionStatus = "disconnected";
            consumePendingSwapDisconnect();
            releaseSwitching("swap threw");
        }
    }

    // Per-account localStorage bases owned by the app. Keep this list in sync
    // with anything that reads/writes via accountSlot(address).key(...).
    const PER_ACCOUNT_STORAGE_BASES = ["snapshot", "ui-options", "current-set", "saved-sets"];

    function forgetAccount(address) {
        removeKnownAccountEntry(address);
        if (typeof localStorage !== "undefined") {
            const slot = accountSlot(address);
            for (const base of PER_ACCOUNT_STORAGE_BASES) {
                localStorage.removeItem(slot.key(base));
            }
        }
        knownAccounts = getKnownAccounts();
    }

    // ---- per-account data snapshot ----
    let snapshotTimer = null;
    function scheduleSnapshot() {
        if (snapshotTimer) clearTimeout(snapshotTimer);
        snapshotTimer = setTimeout(saveSnapshot, 2000);
    }

    function saveSnapshot() {
        if (snapshotTimer) { clearTimeout(snapshotTimer); snapshotTimer = null; }
        if (typeof localStorage === "undefined" || !currentUserAddress) return;
        try {
            const data = {
                songs: songs.map(clone),
                config: appConfig ? clone(appConfig) : null,
                setlists: clone(savedSetlists),
                members: clone(bandMembers),
            };
            localStorage.setItem(accountSlot(currentUserAddress).key("snapshot"), JSON.stringify(data));
        } catch (error) {
            // Most likely localStorage full or write blocked. Non-fatal: the
            // next reloadAll repopulates everything from remote, so the user
            // won't lose data — they just lose the instant-snapshot UX on a
            // future swap. Log in dev so a real regression isn't masked.
            if (import.meta.env?.DEV) {
                console.warn("[app] saveSnapshot failed", error);
            }
        }
    }

    function restoreSnapshot(address) {
        if (typeof localStorage === "undefined") return false;
        const key = accountSlot(address).key("snapshot");
        // Reading localStorage can throw even when the global is defined —
        // Safari "Block all cookies", iOS private browsing, etc. Catch
        // separately from the parse path so a blocked read just falls back
        // to the full sync path; only an actual corrupt blob triggers the
        // cleanup-and-toast branch.
        let raw;
        try {
            raw = localStorage.getItem(key);
        } catch (error) {
            if (import.meta.env?.DEV) {
                console.warn("[app] restoreSnapshot: localStorage read blocked", error);
            }
            return false;
        }
        if (!raw) return false;
        try {
            const data = JSON.parse(raw);
            if (!data.config) return false;
            songs = (data.songs || []).map(normalizeSongRecord);
            appConfig = normalizeAppConfig(data.config);
            savedSetlists = stripEnergy(data.setlists || []);
            bandMembers = Object.fromEntries(
                Object.entries(data.members || {}).map(([name, d]) => [name, normalizeMemberRecord(d)])
            );
            // generationOptions is intentionally not touched here:
            // currentUserAddress still points at the previous account. The
            // caller sets it after this returns, then loadUserLocalData()
            // loads the target account's stored options.
            return true;
        } catch (error) {
            // The blob exists but is unreadable — corrupt or written by an
            // older incompatible build. Drop it so we don't keep failing on
            // every swap, and tell the user (instant-snapshot UI silently
            // falls back to the full sync path otherwise).
            if (import.meta.env?.DEV) {
                console.warn("[app] restoreSnapshot failed; dropping corrupt blob", error);
            }
            try { localStorage.removeItem(key); } catch (_removeError) {
                if (import.meta.env?.DEV) {
                    console.warn("[app] restoreSnapshot: removeItem also failed", _removeError);
                }
            }
            toastWarn("Some local data was unreadable and has been reset.");
            return false;
        }
    }

    // ---- data loading ----
    async function reloadAll({ quiet = false, session = activeSession } = {}) {
        const callId = Math.random().toString(36).slice(2, 6);
        const myEpoch = reloadEpoch;
        // Capture this reload's generation. By the time we return, a newer
        // reload may have started; if so, that newer one captured a more
        // recent cache snapshot and ours is stale. We discard our results
        // even though our session matches.
        reloadGen += 1;
        const myGen = reloadGen;
        dbg(`reloadAll[${callId}] START gen=${myGen} session=${session}/${activeSession} quiet=${quiet}`);
        // Starting a reload is unambiguous proof of activity — cancel any
        // pending "synced" flip from the previous round so we don't resolve
        // while we're literally about to re-read the cache.
        bumpSyncActivity("reloadAll start");
        setSyncState("syncing");
        reloadInFlight += 1;
        // Re-arm the stall watchdog. Cleared in `finally`, so each reload
        // gets its own fresh window — long-running rs.js streams that
        // emit progress through onChange (which kicks a new reload) keep
        // resetting the timer instead of falsely tripping it.
        if (syncStalledTimer) clearTimeout(syncStalledTimer);
        syncStalled = false;
        syncStalledTimer = setTimeout(() => {
            syncStalledTimer = null;
            if (reloadInFlight > 0) syncStalled = true;
        }, SYNC_STALL_TIMEOUT_MS);
        try {
            busyMessage = quiet ? "" : "Loading your songs...";
            loadError = "";
            const data = await repo.loadAll({
                onStep: (message) => {
                    syncStatusLabel = message;
                    pushSyncLog(message);
                },
            });
            // Guard against stale results landing after an account swap.
            if (session !== activeSession) {
                pushSyncLog("Discarded stale load (account swapped)");
                return;
            }
            // Guard against this reload being superseded by a newer one
            // started while we were awaiting loadAll. The newer reload
            // captured a fresher cache snapshot — applying our (older)
            // results would regress the in-memory state.
            if (myGen !== reloadGen) {
                dbg(`reloadAll[${callId}] DISCARD gen=${myGen} (current=${reloadGen}) — superseded by newer reload`);
                pushSyncLog("Discarded superseded load");
                return;
            }
            // Update the pending count even if we early-return below — the
            // pill state depends on it being current.
            pendingBodies = data.pendingBodies || 0;
            const errors = data.errors || {};
            const errorEntries = Object.entries(errors);
            dbg(
                `reloadAll[${callId}] data: ${data.songs?.length ?? "—"} songs, pendingBodies=${pendingBodies}, hasConfig=${!!data.config}, errors=${errorEntries.length}`,
            );
            // Apply each slice only when its load actually succeeded. A
            // rejected slice leaves the prior in-memory value intact rather
            // than blanking the UI — partial offline-first loads are the
            // whole point of allSettled. `data.<slice>` is undefined when
            // that slice rejected.
            if (data.songs !== undefined) {
                songs = data.songs.map(normalizeSongRecord);
            }
            if (!errors.bootstrap) {
                bootstrapMeta = data.bootstrap;
            }
            if (!errors.config) {
                appConfig = data.config ? normalizeAppConfig(data.config) : null;
            }
            if (data.setlists !== undefined) {
                savedSetlists = stripEnergy(data.setlists);
            }
            if (data.members !== undefined) {
                bandMembers = Object.fromEntries(
                    Object.entries(data.members).map(([name, data]) => [name, normalizeMemberRecord(data)]),
                );
            }

            // Surface partial-failure warnings without short-circuiting. We
            // skip a toast for `bootstrap` because the metadata is already
            // optional (callers treat missing bootstrap as "none yet").
            for (const [slice, error] of errorEntries) {
                pushSyncLog(`Could not load ${slice}: ${error.message}`);
                if (slice === "bootstrap") continue;
                if (!quiet) toastWarn(`Couldn't load ${slice} — keeping last known data.`);
            }

            // First-run prompt: only when we *know* the config is truly
            // absent (the slice loaded successfully and returned null), not
            // when the config slice failed and we kept the previous value.
            // Without this guard a transient config read failure would push
            // a returning user into first-run, risking a duplicate config.
            if (!errors.config && !appConfig) {
                firstRunBandName = "";
                navigate("roll");
                generationOptions = defaultGenerationOptions(DEFAULT_APP_CONFIG);
                persistGenerationOptions();
                return;
            }

            if (appConfig) {
                generationOptions = deepMerge(defaultGenerationOptions(appConfig), generationOptions || {});
                persistGenerationOptions();
                scheduleSnapshot();
            }
            pushSyncLog("Initial data load finished");
        } catch (error) {
            loadError = error?.message || "Could not load remote data.";
            toastError(loadError);
            pushSyncLog(loadError);
            // Stale results from an old session shouldn't flip the indicator —
            // the live session will resolve its own state.
            if (session === activeSession) setSyncState("error");
        } finally {
            if (myEpoch === reloadEpoch) {
                reloadInFlight = Math.max(0, reloadInFlight - 1);
                busyMessage = "";
                initialSyncComplete = true;
                // Only the last in-flight reload should clear the watchdog —
                // a fast one finishing while a slow one is still pulling
                // shouldn't drop the stall guard.
                if (reloadInFlight === 0) {
                    if (syncStalledTimer) clearTimeout(syncStalledTimer);
                    syncStalledTimer = null;
                    syncStalled = false;
                }
            } else {
                dbg(`reloadAll[${callId}] ignored stale epoch ${myEpoch} (current=${reloadEpoch})`);
            }
            dbg(`reloadAll[${callId}] END gen=${myGen} songs=${songs.length} pending=${pendingBodies} reloadInFlight=${reloadInFlight}`);
            // Try to resolve the pill. Falls through silently if any of the
            // gates (pending bodies, in-flight reloads, sync round) aren't
            // satisfied yet — a later reload (triggered by an onChange when
            // the next body arrives) will check again.
            if (session === activeSession && myEpoch === reloadEpoch) maybeMarkSynced();
        }
    }

    // Manual recovery for the stall watchdog. Invoked from the sync-shell's
    // Retry button. We don't try to abort a stuck rs.js operation; instead
    // we retire it from our accounting and start a fresh reload. If the
    // underlying load finally resolves, its generation/epoch guards keep it
    // from applying stale data or blocking the retry.
    async function retrySync() {
        reloadEpoch += 1;
        reloadInFlight = 0;
        syncStalled = false;
        if (syncStalledTimer) {
            clearTimeout(syncStalledTimer);
            syncStalledTimer = null;
        }
        pushSyncLog("User triggered retry");
        await reloadAll({ quiet: true });
    }

    async function finishFirstRun() {
        const bandName = firstRunBandName.trim();
        if (!bandName) {
            toastError("Your band needs a name.");
            return;
        }
        try {
            busyMessage = "Setting up...";
            appConfig = await withSync("Setting up", () => repo.ensureConfig(bandName));
            generationOptions = defaultGenerationOptions(appConfig);
            persistGenerationOptions();
            toastInfo(`Welcome, ${bandName}.`);
        } catch (error) {
            toastError(error?.message || "Could not save your band name.");
        } finally {
            busyMessage = "";
        }
    }

    // ---- generation ----
    function validateConstraintMinimums(result) {
        const memberConstraints = generationOptions.show?.members || {};
        for (const [memberName, constraints] of Object.entries(memberConstraints)) {
            const allowed = constraints.allowedInstruments || [];
            const minPerInst = constraints.minSongsPerInstrument ?? 2;
            if (allowed.length >= 2) {
                const counts = {};
                allowed.forEach((inst) => { counts[inst] = 0; });
                (result.songs || []).forEach((song) => {
                    const inst = song.performance?.[memberName]?.instrument;
                    if (inst && inst in counts) counts[inst]++;
                });
                if (Object.values(counts).some((c) => c < minPerInst)) return false;
            }
            const allowedTunings = constraints.allowedTunings || {};
            const minPerTuning = constraints.minSongsPerTuning || {};
            for (const [instName, tunings] of Object.entries(allowedTunings)) {
                const minT = minPerTuning[instName] ?? 2;
                if (tunings.length >= 2) {
                    const counts = {};
                    tunings.forEach((t) => { counts[t] = 0; });
                    (result.songs || []).forEach((song) => {
                        const perf = song.performance?.[memberName];
                        if (perf?.instrument === instName && perf.tuning && perf.tuning in counts) counts[perf.tuning]++;
                    });
                    if (Object.values(counts).some((c) => c < minT)) return false;
                }
            }
        }
        return true;
    }

    function requestRoll() {
        if (isGenerating) return;
        if (setlistLocked) {
            pendingRollConfirm = true;
            return;
        }
        generate();
    }

    function confirmFreshRoll() {
        pendingRollConfirm = false;
        setlistLocked = false;
        generate();
    }

    function confirmOptimizeOrder() {
        if (!generatedSetlist) return;
        pendingRollConfirm = false;
        const currentSongs = generatedSetlist.songs;
        const currentCovers = currentSongs.filter(s => s.cover).length;
        const currentInstrumentals = currentSongs.filter(s => s.instrumental).length;
        generate({
            fixedSongIds: currentSongs.map(s => s.id),
            count: currentSongs.length,
            maxCovers: Math.max(currentCovers, generationOptions.maxCovers),
            maxInstrumentals: Math.max(currentInstrumentals, generationOptions.maxInstrumentals),
            _keepLock: true,
        });
    }

    function cancelRoll() {
        pendingRollConfirm = false;
    }

    function terminateWorker() {
        if (activeWorker) {
            activeWorker.terminate();
            activeWorker = null;
        }
    }

    function generate(overrideOptions = {}) {
        if (isGenerating) return;
        if (!songs.length) {
            toastError("Can't roll with no songs! Add a few first.");
            navigate("songs");
            return;
        }
        const eligibleSongs = songs.filter((s) => !s.unpracticed);
        if (!eligibleSongs.length) {
            toastError("Every song is unpracticed. Time to rehearse!");
            return;
        }

        terminateWorker();
        // A new generation produces fresh content; any prior "loaded from
        // saved" identity no longer applies, so saving creates a new entry.
        loadedSavedId = "";
        isGenerating = true;
        const thisGenId = ++generationId;
        // Capture the session so a result that lands after an account swap
        // (even into another connected account) is discarded — checking
        // currentUserAddress alone isn't enough.
        const thisSession = activeSession;
        const opts = clone(generationOptions);
        Object.assign(opts, overrideOptions);

        const worker = new GeneratorWorker();
        activeWorker = worker;
        worker.postMessage({
            songs: clone(eligibleSongs),
            config: clone(appConfig || DEFAULT_APP_CONFIG),
            options: opts
        });
        worker.onmessage = (event) => {
            const { type, result } = event.data;
            if (type !== "done") return;
            worker.terminate();
            if (worker === activeWorker) activeWorker = null;
            // Ignore stale results from a previous generation, an account
            // swap, or a disconnected session.
            if (thisGenId !== generationId || thisSession !== activeSession || !currentUserAddress) {
                isGenerating = false;
                return;
            }
            isGenerating = false;
            if (!result) {
                toastError(randomFrom([
                    "The generator tripped over a cable.",
                    "Something went sideways. Blame the bassist.",
                    "Critical fumble — try again?",
                ]));
                return;
            }
            replaceGeneratedSetlist(result);
            if (opts._keepLock) {
                setlistSaved = false;
            } else {
                setlistLocked = false;
                setlistSaved = false;
            }
            persistCurrentSetlist();
            if (result.summary?.minimumsRelaxed || !validateConstraintMinimums(result)) {
                toastWarn("Couldn't meet every demand, but it got close.");
            }
            if (result.summary?.openerFilterRelaxed) {
                toastWarn("No valid opener found in catalog.");
            }
            if (result.summary?.closerFilterRelaxed) {
                toastWarn("No valid closer found in catalog.");
            }
            const n = generatedSetlist.songs.length;
            toastInfo(randomFrom([
                `🎲 The dice have spoken. ${n} songs.`,
                `${n} songs, rolled fresh. No refunds.`,
                `Behold: ${n} tracks of pure destiny.`,
                `${n} songs. Trust the roll.`,
                `The rock gods have decided. ${n} songs.`,
            ]));
        };
        worker.onerror = (err) => {
            worker.terminate();
            if (worker === activeWorker) activeWorker = null;
            isGenerating = false;
            toastError(randomFrom([
                "The generator tripped over a cable.",
                "Something went sideways. Blame the bassist.",
                "Critical fumble — try again?",
            ]));
        };
    }

    function lockSetlist() {
        if (!generatedSetlist) return;
        if (setlistLocked) return;
        setlistLocked = true;
        persistCurrentSetlist();
        toastInfo(randomFrom([
            "Setlist locked in. No take-backs.",
            "It's canon now.",
            "Sealed. This one's going on stage.",
        ]));
    }

    async function saveCurrentSetlist() {
        if (!generatedSetlist) return;
        const currentSaved = savedSetlists || [];
        const songNames = generatedSetlist.songs.map(s => s.name || s.title || "?");

        // If this setlist was loaded from a saved entry, update that entry in
        // place instead of creating a duplicate with a new id and name.
        if (loadedSavedId) {
            const existing = currentSaved.find((s) => s.id === loadedSavedId);
            if (existing) {
                await updateSavedSetlist(loadedSavedId, {
                    savedAt: nowIso(),
                    summary: clone(generatedSetlist.summary),
                    songs: clone(generatedSetlist.songs),
                    songNames,
                    seed: generatedSetlist.seed,
                    songCount: generatedSetlist.songs.length,
                });
                setlistSaved = true;
                return;
            }
            // Saved entry no longer exists (deleted elsewhere) — fall through.
            loadedSavedId = "";
        }

        const funNames = [
            "The Unhinged Encore", "Chaos Theory",
            "No Refunds", "The One That Slaps", "Certified Banger",
            "Tuesday Night Special", "Blame the Dice", "Accidentally Perfect",
            "The Hot Mess Express", "Trust the Process", "Vibe Check",
            "Sound & Fury", "The Audacity", "Full Send",
            "Controlled Chaos", "Plot Twist", "The Good Stuff",
            "Questionable Choices", "Send It", "No Notes",
        ];
        // Pick a random name, avoid recently used names
        const usedNames = new Set(currentSaved.slice(0, 5).map(s => s.name));
        const available = funNames.filter(n => !usedNames.has(n));
        const pool = available.length > 0 ? available : funNames;
        const randomName = pool[Math.floor(Math.random() * pool.length)];
        const entry = {
            id: uid("set"),
            name: randomName,
            savedAt: nowIso(),
            summary: clone(generatedSetlist.summary),
            songs: clone(generatedSetlist.songs),
            songNames,
            seed: generatedSetlist.seed,
            songCount: generatedSetlist.songs.length
        };
        try {
            await withSync("Saving setlist", () => repo.putSetlist(entry));
            savedSetlists = [entry, ...currentSaved];
            setlistSaved = true;
            loadedSavedId = entry.id;
        } catch (error) {
            toastError(error?.message || "Could not save setlist.");
        }
    }

    async function removeSavedSetlist(id) {
        try {
            await withSync("Removing setlist", () => repo.deleteSetlist(id));
            savedSetlists = savedSetlists.filter((s) => s.id !== id);
            if (loadedSavedId === id) loadedSavedId = "";
        } catch (error) {
            toastError(error?.message || "Could not remove setlist.");
        }
    }

    async function updateSavedSetlist(id, fields) {
        const existing = savedSetlists.find((s) => s.id === id);
        if (!existing) return;
        const merged = { ...existing, ...fields };
        try {
            await withSync("Updating setlist", () => repo.putSetlist(merged));
            savedSetlists = savedSetlists.map((s) => s.id === id ? merged : s);
        } catch (error) {
            toastError(error?.message || "Could not update setlist.");
        }
    }

    function loadSavedSetlist(id) {
        const saved = savedSetlists.find((s) => s.id === id);
        if (!saved) return;
        replaceGeneratedSetlist({
            songs: clone(saved.songs),
            summary: clone(saved.summary),
            seed: saved.seed,
        });
        setlistLocked = true;
        setlistSaved = true;
        loadedSavedId = id;
        persistCurrentSetlist();
        toastInfo(`Loaded ${saved.songs?.length || 0}-song set.`);
    }

    function reorderSetlistSong(fromIndex, toIndex) {
        if (!generatedSetlist) return;
        const songList = clone(generatedSetlist.songs);
        const [moved] = songList.splice(fromIndex, 1);
        songList.splice(toIndex, 0, moved);
        const rescored = scoreFixedOrder(songList, appConfig, { keyFlow: generationOptions.keyFlow });
        updateCurrentSetlist({ ...generatedSetlist, songs: rescored.songs, summary: rescored.summary });
        setlistSaved = false;
        persistCurrentSetlist();
    }

    function removeSetlistSong(index) {
        if (!generatedSetlist) return;
        const songList = clone(generatedSetlist.songs);
        songList.splice(index, 1);
        if (!songList.length) {
            clearGeneratedSetlist();
            setlistLocked = false;
            setlistSaved = false;
            persistCurrentSetlist();
            return;
        }
        const rescored = scoreFixedOrder(songList, appConfig, { keyFlow: generationOptions.keyFlow });
        updateCurrentSetlist({ ...generatedSetlist, songs: rescored.songs, summary: rescored.summary });
        setlistSaved = false;
        persistCurrentSetlist();
    }

    function addSetlistSong(songId) {
        if (!generatedSetlist) return;
        if (generatedSetlist.songs.some((s) => s.id === songId)) return;
        const song = songs.find((s) => s.id === songId);
        if (!song) return;
        const performance = buildDefaultPerformance(song, generationOptions?.show || {});
        const songList = clone(generatedSetlist.songs);
        songList.push({
            id: song.id,
            name: song.name,
            cover: song.cover || false,
            instrumental: song.instrumental || false,
            key: song.key || "",
            notes: song.notes || "",
            performance,
            // position is intentionally omitted; scoreFixedOrder re-stamps it
            // after rescoring. Setting it here was off-by-one.
            incrementalScore: 0,
            cumulativeScore: 0,
            transitionNotes: [],
            positionNotes: [],
            contextNotes: [],
        });
        const rescored = scoreFixedOrder(songList, appConfig, { keyFlow: generationOptions.keyFlow });
        updateCurrentSetlist({ ...generatedSetlist, songs: rescored.songs, summary: rescored.summary });
        setlistSaved = false;
        persistCurrentSetlist();
    }

    let songsNotInSetlist = $derived.by(() => {
        if (!generatedSetlist?.songs) return songs.filter((s) => !s.unpracticed);
        const usedIds = new Set(generatedSetlist.songs.map((s) => s.id));
        return songs.filter((s) => !s.unpracticed && !usedIds.has(s.id));
    });

    // ---- generation options ----
    function updateGenerationField(path, value) {
        generationOptions = setByPath(generationOptions, path, value);
        persistGenerationOptions();
    }

    function toggleListValue(path, value) {
        const current = getByPath(generationOptions, path, []);
        const next = current.includes(value)
            ? current.filter((e) => e !== value)
            : current.concat(value);
        updateGenerationField(path, next);
    }

    function ensureMemberShowConfig(memberName) {
        if (generationOptions.show?.members?.[memberName]) return;
        generationOptions = setByPath(generationOptions, `show.members.${memberName}`, {
            allowedInstruments: [],
            allowedTunings: {}
        });
        persistGenerationOptions();
    }


    // ---- song editor ----
    function openNewSong() {
        const song = blankSong();
        Object.entries(bandMembers || {}).forEach(([name, config]) => {
            const defaultInstName = config.defaultInstrument || "";
            const defaultInst = (config.instruments || []).find((i) => i.name === defaultInstName);
            const inst = defaultInst
                ? { name: defaultInst.name, tuning: defaultInst.defaultTuning ? [defaultInst.defaultTuning] : [], capo: 0, picking: defaultInst.defaultTechnique ? [defaultInst.defaultTechnique] : [] }
                : { name: "", tuning: [], capo: 0, picking: [] };
            song.members[name] = { instruments: [inst] };
        });
        editorSong = song;
        selectedSongId = "";
    }

    function openSong(song) {
        editorSong = normalizeSongRecord(song);
        selectedSongId = editorSong.id;
    }

    function closeEditor() {
        const returnTo = editReturnView;
        editorSong = null;
        selectedSongId = "";
        editReturnView = "";
        if (returnTo) navigate(returnTo);
    }

    function updateEditor(mutator) {
        const next = clone(editorSong);
        mutator(next);
        editorSong = next;
    }

    function updateSongField(key, value) {
        updateEditor((s) => { s[key] = value; });
    }

    function renameMember(prev, next) {
        const clean = next.trim();
        if (!clean || clean === prev) return;
        updateEditor((song) => {
            const entries = Object.entries(song.members || {});
            const rebuilt = {};
            entries.forEach(([name, val]) => { rebuilt[name === prev ? clean : name] = val; });
            song.members = rebuilt;
        });
    }

    function addMember(memberName) {
        updateEditor((song) => {
            let name = memberName;
            if (!name) {
                const base = `member${Object.keys(song.members || {}).length + 1}`;
                name = base;
                let c = 1;
                while (song.members[name]) { c++; name = `${base}-${c}`; }
            }
            if (song.members[name]) return; // already in this song
            // Seed instruments from band config if this member exists there
            const bandMember = bandMembers?.[name];
            if (bandMember && (bandMember.instruments || []).length > 0) {
                const defaultInst = bandMember.defaultInstrument || bandMember.instruments[0]?.name || "";
                const inst = bandMember.instruments.find((i) => i.name === defaultInst) || bandMember.instruments[0];
                const defaultTuning = inst?.defaultTuning;
                const defaultTechnique = inst?.defaultTechnique;
                song.members[name] = {
                    instruments: [{
                        name: inst.name,
                        tuning: defaultTuning ? [defaultTuning] : [],
                        capo: 0,
                        picking: defaultTechnique ? [defaultTechnique] : []
                    }]
                };
            } else {
                song.members[name] = { instruments: [{ name: "", tuning: [], capo: 0, picking: [] }] };
            }
        });
    }

    function removeMember(memberName) {
        updateEditor((song) => { delete song.members[memberName]; });
    }

    function addInstrumentOption(memberName) {
        updateEditor((song) => {
            song.members[memberName].instruments.push({
                name: "", tuning: [], capo: 0, picking: []
            });
        });
    }

    function removeInstrumentOption(memberName, index) {
        updateEditor((song) => { song.members[memberName].instruments.splice(index, 1); });
    }

    function instrumentConfigFor(memberName, instrumentName) {
        return (bandMembers?.[memberName]?.instruments || [])
            .find((i) => i.name === instrumentName) || null;
    }

    function updateInstrumentOption(memberName, index, key, value) {
        updateEditor((song) => {
            const option = song.members[memberName].instruments[index];
            option[key] = value;
            if (key === "name") {
                const instConfig = instrumentConfigFor(memberName, value);
                const defaultTuning = instConfig?.defaultTuning || "";
                option.tuning = defaultTuning ? [defaultTuning] : [];
                option.picking = instConfig?.defaultTechnique ? [instConfig.defaultTechnique] : [];
            }
        });
    }

    async function saveSong() {
        if (!editorSong || !String(editorSong.name || "").trim()) {
            toastError("Songs need names.");
            return;
        }
        try {
            busyMessage = `Saving "${editorSong.name}"...`;
            const saved = await withSync("Saving song", () => repo.putSong({
                ...editorSong, updatedAt: nowIso()
            }));
            songs = songs.filter((s) => s.id !== saved.id).concat(saved).sort((a, b) => a.name.localeCompare(b.name));
            const syncedSetlist = syncSavedSongIntoSetlist(
                generatedSetlist,
                saved,
                appConfig,
                generationOptions.keyFlow,
            );
            if (syncedSetlist !== generatedSetlist) {
                updateCurrentSetlist(syncedSetlist);
                persistCurrentSetlist();
            }

            // Sync member names and instruments from the song into band members
            const dirtyMembers = new Map();

            for (const [memberName, memberSetup] of Object.entries(saved.members || {})) {
                let member = clone(bandMembers[memberName] || null);
                let dirty = false;
                if (!member) {
                    member = { instruments: [] };
                    dirty = true;
                }
                if (!member.instruments) member.instruments = [];
                for (const inst of (memberSetup.instruments || [])) {
                    if (!inst.name) continue;
                    const existing = member.instruments.find((i) => i.name === inst.name);
                    if (!existing) {
                        member.instruments.push({
                            name: inst.name, tunings: [], defaultTuning: "",
                            techniques: [], defaultTechnique: ""
                        });
                        dirty = true;
                    }
                    // Sync tunings that appear in songs but not in band members
                    const bandInst = member.instruments.find((i) => i.name === inst.name);
                    for (const tuning of (inst.tuning || [])) {
                        if (tuning && !(bandInst.tunings || []).includes(tuning)) {
                            if (!bandInst.tunings) bandInst.tunings = [];
                            bandInst.tunings.push(tuning);
                            if (!bandInst.defaultTuning) bandInst.defaultTuning = tuning;
                            dirty = true;
                        }
                    }
                }
                if (dirty) dirtyMembers.set(memberName, member);
            }
            for (const [memberName, memberData] of dirtyMembers) {
                await persistMemberEdit(memberName, memberData);
            }

            closeEditor();
            toastInfo(`Saved "${saved.name}".`);
        } catch (error) {
            toastError(error?.message || "Could not save.");
        } finally {
            busyMessage = "";
        }
    }

    function duplicateSong(song) {
        const copy = normalizeSongRecord({
            ...clone(song), id: uid("song"), name: `${song.name} (Copy)`,
            createdAt: nowIso(), updatedAt: nowIso()
        });
        editorSong = copy;
        selectedSongId = "";
        toastInfo(`Duplicated "${song.name}".`);
    }

    async function deleteSong(song) {
        if (!window.confirm(`Delete "${song.name}"?`)) return;
        try {
            busyMessage = `Deleting "${song.name}"...`;
            await withSync("Removing song", () => repo.deleteSong(song.id));
            songs = songs.filter((e) => e.id !== song.id);
            if (editorSong?.id === song.id) closeEditor();
            toastInfo(`Deleted "${song.name}".`);
        } catch (error) {
            toastError(error?.message || "Could not delete.");
        } finally {
            busyMessage = "";
        }
    }

    async function deleteAllData() {
        if (!window.confirm("This will delete ALL songs, band config, and saved setlists. This cannot be undone.\n\nAre you sure?")) return;
        if (!window.confirm("Really? Everything will be gone forever.")) return;
        try {
            busyMessage = "Deleting everything...";
            // Delete all songs from RS
            for (const song of songs) {
                await repo.deleteSong(song.id);
            }
            // Delete all setlists from RS (list from remote to catch any beyond in-memory state)
            const { setlists: allSetlists } = await repo.listSetlists();
            for (const setlist of allSetlists) {
                await repo.deleteSetlist(setlist.id);
            }
            // Delete all members from RS (list from remote to catch any beyond in-memory state)
            const { members: allMembers } = await repo.listMembers();
            for (const name of Object.keys(allMembers)) {
                await repo.deleteMember(name);
            }
            // Delete config from RS so first-run triggers on reload
            await repo.deleteConfig();
            // Clear local state
            appConfig = null;
            songs = [];
            clearGeneratedSetlist();
            setlistLocked = false;
            setlistSaved = false;
            savedSetlists = [];
            bandMembers = {};
            persistCurrentSetlist();
            if (editorSong) closeEditor();
            // Trigger first-run experience: with appConfig now null and the
            // session still connected/synced, the derived showFirstRunPrompt
            // will evaluate to true and the modal will render.
            firstRunBandName = "";
            navigate("roll");
            generationOptions = defaultGenerationOptions(DEFAULT_APP_CONFIG);
            persistGenerationOptions();
            toastInfo("All data deleted. Name your band to start fresh.");
        } catch (error) {
            toastError(error?.message || "Could not delete.");
        } finally {
            busyMessage = "";
        }
    }

    // ---- config ----
    function configFieldValue(config, field) {
        const value = getByPath(config, field.path);
        if (field.type === "list") return formatDelimitedList(value);
        return value;
    }

    function updateConfigField(fieldOrPath, rawValue) {
        if (!appConfig) return;
        // Accept either a field object { path, type } or a plain path string
        if (typeof fieldOrPath === "string") {
            appConfig = setByPath(appConfig, fieldOrPath, rawValue);
            return;
        }
        const field = fieldOrPath;
        let next = rawValue;
        if (field.type === "number") next = Number(rawValue);
        else if (field.type === "boolean") next = Boolean(rawValue);
        else if (field.type === "list") next = parseDelimitedList(rawValue);
        appConfig = setByPath(appConfig, field.path, next);
    }

    async function saveConfig() {
        if (!appConfig) return;
        try {
            busyMessage = "Saving config...";
            const nextConfig = normalizeAppConfig({ ...clone(appConfig), updatedAt: nowIso() });
            appConfig = await withSync("Saving settings", () => repo.putConfig(nextConfig));
            generationOptions = deepMerge(defaultGenerationOptions(appConfig), generationOptions);
            persistGenerationOptions();
            if (currentUserAddress && appConfig?.bandName) {
                saveKnownAccount(currentUserAddress, { bandName: appConfig.bandName }, repo.getToken());
                knownAccounts = getKnownAccounts();
            }
            toastInfo("Settings saved.");
        } catch (error) {
            toastError(error?.message || "Could not save config.");
        } finally {
            busyMessage = "";
        }
    }

    async function persistConfigEdit(nextConfig, errorMessage = "Could not save config.") {
        const normalized = normalizeAppConfig({ ...clone(nextConfig), updatedAt: nowIso() });
        appConfig = normalized;
        try {
            appConfig = await withSync("Saving settings", () => repo.putConfig(normalized));
            generationOptions = deepMerge(defaultGenerationOptions(appConfig), generationOptions);
            persistGenerationOptions();
            return true;
        } catch (error) {
            toastError(error?.message || errorMessage);
            return false;
        }
    }

    // ---- band members ----
    async function persistMemberEdit(memberName, data, errorMessage = "Could not save member.") {
        const normalized = normalizeMemberRecord(data);
        bandMembers = { ...bandMembers, [memberName]: normalized };
        try {
            await withSync("Saving member", () => repo.putMember(memberName, normalized));
            return true;
        } catch (error) {
            toastError(error?.message || errorMessage);
            return false;
        }
    }

    async function addBandMember() {
        const clean = newMemberName.trim();
        if (!clean) { toastError("Name the member first."); return; }
        if (bandMemberEntries.some(([n]) => n === clean)) { toastError("Already exists."); return; }
        if (await persistMemberEdit(clean, { instruments: [] }, "Could not add member.")) {
            expandedBandMember = clean;
            newMemberName = "";
            toastInfo(`Added "${clean}".`);
        }
    }

    async function renameBandMember(oldName, newName) {
        const clean = newName.trim();
        if (!clean || clean === oldName || bandMemberEntries.some(([n]) => n === clean)) return;
        const data = bandMembers[oldName] || { instruments: [] };

        // Put the new key first so a failure leaves the original member
        // intact — songs that reference `oldName` still resolve, and we
        // bail out without touching local state.
        try {
            await withSync("Renaming member", () => repo.putMember(clean, data));
        } catch (error) {
            toastError(error?.message || "Could not rename member.");
            return;
        }

        // Apply the local rename now: the new key exists remotely, so the
        // UI must switch over even if the follow-up delete fails. The
        // caller (BandScreen) moves `editingMemberName` to `clean` without
        // awaiting this function; without the local mutation here the
        // edit-view filter would match nothing and the pane would go blank.
        const next = { ...bandMembers };
        delete next[oldName];
        next[clean] = data;
        bandMembers = next;
        if (expandedBandMember === oldName) expandedBandMember = clean;

        // Best-effort delete of the old key. A failure here leaves a
        // temporary duplicate in remoteStorage; rs.js retries on the next
        // sync round and the next reloadAll reconciles. This is the
        // explicit "duplicate member that resolves on next sync" failure
        // mode #70 accepts — surface it as a warning, not a hard error.
        try {
            await withSync("Cleaning up old member name", () => repo.deleteMember(oldName));
            toastInfo(`Renamed "${oldName}" to "${clean}".`);
        } catch (error) {
            toastWarn(
                `Renamed to "${clean}". Old name will clear on the next sync.${
                    error?.message ? ` (${error.message})` : ""
                }`,
            );
        }
    }

    function songsUsingMember(memberName) {
        return songs.filter((s) => s.members && memberName in s.members);
    }

    function songsUsingInstrument(memberName, instrumentName) {
        return songs.filter((s) =>
            (s.members?.[memberName]?.instruments || []).some((i) => i.name === instrumentName)
        );
    }

    function songsUsingTuning(memberName, instrumentName, tuning) {
        return songs.filter((s) =>
            (s.members?.[memberName]?.instruments || []).some((i) =>
                i.name === instrumentName && (i.tuning || []).includes(tuning)
            )
        );
    }

    function songsUsingTechnique(memberName, instrumentName, technique) {
        return songs.filter((s) =>
            (s.members?.[memberName]?.instruments || []).some((i) =>
                i.name === instrumentName && (Array.isArray(i.picking) ? i.picking : []).includes(technique)
            )
        );
    }

    async function removeBandMember(memberName) {
        const usedIn = songsUsingMember(memberName);
        if (usedIn.length > 0) {
            const names = usedIn.slice(0, 5).map((s) => s.name).join(", ");
            const extra = usedIn.length > 5 ? ` and ${usedIn.length - 5} more` : "";
            if (!window.confirm(
                `"${memberName}" is referenced in ${usedIn.length} song${usedIn.length === 1 ? "" : "s"}: ${names}${extra}.\n\nRemoving this member from the band config won't change existing songs, but new setlists won't account for their setup.\n\nAre you sure?`
            )) return;
        } else {
            if (!window.confirm(`Remove "${memberName}" from the band?`)) return;
        }
        try {
            await withSync("Removing member", () => repo.deleteMember(memberName));
            const next = { ...bandMembers };
            delete next[memberName];
            bandMembers = next;
            if (expandedBandMember === memberName) expandedBandMember = "";
            toastInfo(`Removed "${memberName}".`);
        } catch (error) {
            toastError(error?.message || "Could not remove member.");
        }
    }

    async function addBandMemberInstrument(memberName) {
        const draft = (newInstrumentByMember[memberName] || "").trim();
        if (!draft) { toastError("Type an instrument name first."); return; }
        const member = bandMembers[memberName] || { instruments: [] };
        const current = member.instruments || [];
        if (current.some((i) => i.name === draft)) { toastError("Already on this member."); return; }
        const updated = { ...member, instruments: current.concat({ name: draft, tunings: [], defaultTuning: "", techniques: [], defaultTechnique: "" }) };
        if (await persistMemberEdit(memberName, updated)) {
            newInstrumentByMember = { ...newInstrumentByMember, [memberName]: "" };
            toastInfo(`Added ${draft} for ${memberName}.`);
        }
    }

    async function removeBandMemberInstrument(memberName, instrumentName) {
        const usedIn = songsUsingInstrument(memberName, instrumentName);
        if (usedIn.length > 0) {
            const names = usedIn.slice(0, 5).map((s) => s.name).join(", ");
            const extra = usedIn.length > 5 ? ` and ${usedIn.length - 5} more` : "";
            if (!window.confirm(
                `"${instrumentName}" for ${memberName} is used in ${usedIn.length} song${usedIn.length === 1 ? "" : "s"}: ${names}${extra}.\n\nRemoving it from the band config won't change existing songs, but the instrument won't appear as a choice for new songs.\n\nAre you sure?`
            )) return;
        } else {
            if (!window.confirm(`Remove "${instrumentName}" from ${memberName}?`)) return;
        }
        const member = bandMembers[memberName] || { instruments: [] };
        const updated = { ...member, instruments: (member.instruments || []).filter((i) => i.name !== instrumentName) };
        if (await persistMemberEdit(memberName, updated)) toastInfo(`Removed ${instrumentName} from ${memberName}.`);
    }

    function tuningDraftKey(memberName, instrumentName) {
        return `${memberName}::${instrumentName}`;
    }

    // Ensure a member and instrument exist in band members (creates them if missing)
    async function ensureBandInstrument(memberName, instrumentName) {
        if (!memberName || !instrumentName) return;
        let dirty = false;
        let member = clone(bandMembers[memberName] || null);
        if (!member) {
            member = { instruments: [] };
            dirty = true;
        }
        if (!member.instruments) member.instruments = [];
        if (!member.instruments.find((i) => i.name === instrumentName)) {
            member.instruments.push({ name: instrumentName, tunings: [], defaultTuning: "", techniques: [], defaultTechnique: "" });
            dirty = true;
        }
        if (dirty) await persistMemberEdit(memberName, member);
    }

    async function addTuningChoice(memberName, instrumentName) {
        const draftKey = tuningDraftKey(memberName, instrumentName);
        const clean = (newTuningByInstrument[draftKey] || "").trim();
        if (!clean) { toastError("Type a tuning name first."); return; }
        await ensureBandInstrument(memberName, instrumentName);
        const member = bandMembers[memberName] || { instruments: [] };
        const currentInstruments = member.instruments || [];
        const current = currentInstruments.find((i) => i.name === instrumentName);
        if ((current?.tunings || []).includes(clean)) { toastError("Already exists."); return; }
        const updated = { ...member, instruments: currentInstruments.map((i) => i.name !== instrumentName ? i : { ...i, tunings: (i.tunings || []).concat(clean) }) };
        if (await persistMemberEdit(memberName, updated)) {
            newTuningByInstrument = { ...newTuningByInstrument, [draftKey]: "" };
            toastInfo(`Added "${clean}" to ${instrumentName}.`);
        }
        return clean;
    }

    async function removeTuningChoice(memberName, instrumentName, tuning) {
        const usedIn = songsUsingTuning(memberName, instrumentName, tuning);
        if (usedIn.length > 0) {
            const names = usedIn.slice(0, 5).map((s) => s.name).join(", ");
            const extra = usedIn.length > 5 ? ` and ${usedIn.length - 5} more` : "";
            if (!window.confirm(
                `"${tuning}" tuning for ${memberName}'s ${instrumentName} is used in ${usedIn.length} song${usedIn.length === 1 ? "" : "s"}: ${names}${extra}.\n\nRemoving it won't change existing songs, but the tuning won't appear as a choice for new songs.\n\nAre you sure?`
            )) return;
        }
        const member = bandMembers[memberName] || { instruments: [] };
        const currentInstruments = member.instruments || [];
        const updated = { ...member, instruments: currentInstruments.map((i) => i.name !== instrumentName ? i : {
            ...i, tunings: (i.tunings || []).filter((t) => t !== tuning),
            defaultTuning: i.defaultTuning === tuning ? "" : (i.defaultTuning || "")
        }) };
        if (await persistMemberEdit(memberName, updated)) toastInfo(`Removed "${tuning}" from ${instrumentName}.`);
    }

    async function setMemberDefaultInstrument(memberName, instrumentName) {
        const member = bandMembers[memberName];
        if (!member) return;
        const updated = { ...member, defaultInstrument: instrumentName };
        if (await persistMemberEdit(memberName, updated)) {
            toastInfo(instrumentName ? `Default instrument set to "${instrumentName}".` : `Cleared default instrument.`);
        }
    }

    async function setInstrumentDefaultTuning(memberName, instrumentName, defaultTuning) {
        const member = bandMembers[memberName] || { instruments: [] };
        const currentInstruments = member.instruments || [];
        const updated = { ...member, instruments: currentInstruments.map((i) => i.name !== instrumentName ? i : { ...i, defaultTuning }) };
        if (await persistMemberEdit(memberName, updated)) {
            toastInfo(defaultTuning ? `Default set to "${defaultTuning}".` : `Cleared default tuning.`);
        }
    }

    function techniqueDraftKey(memberName, instrumentName) {
        return `${memberName}::${instrumentName}::tech`;
    }

    async function addTechniqueChoice(memberName, instrumentName) {
        const draftKey = techniqueDraftKey(memberName, instrumentName);
        const clean = (newTechniqueByInstrument[draftKey] || "").trim();
        if (!clean) { toastError("Type a technique name first."); return; }
        await ensureBandInstrument(memberName, instrumentName);
        const member = bandMembers[memberName] || { instruments: [] };
        const currentInstruments = member.instruments || [];
        const current = currentInstruments.find((i) => i.name === instrumentName);
        if ((current?.techniques || []).includes(clean)) { toastError("Already exists."); return; }
        const updated = { ...member, instruments: currentInstruments.map((i) => i.name !== instrumentName ? i : { ...i, techniques: (i.techniques || []).concat(clean) }) };
        if (await persistMemberEdit(memberName, updated)) {
            newTechniqueByInstrument = { ...newTechniqueByInstrument, [draftKey]: "" };
            toastInfo(`Added "${clean}" technique to ${instrumentName}.`);
        }
        return clean;
    }

    async function removeTechniqueChoice(memberName, instrumentName, technique) {
        const usedIn = songsUsingTechnique(memberName, instrumentName, technique);
        if (usedIn.length > 0) {
            const names = usedIn.slice(0, 5).map((s) => s.name).join(", ");
            const extra = usedIn.length > 5 ? ` and ${usedIn.length - 5} more` : "";
            if (!window.confirm(
                `"${technique}" technique for ${memberName}'s ${instrumentName} is used in ${usedIn.length} song${usedIn.length === 1 ? "" : "s"}: ${names}${extra}.\n\nRemoving it won't change existing songs, but the technique won't appear as a choice for new songs.\n\nAre you sure?`
            )) return;
        }
        const member = bandMembers[memberName] || { instruments: [] };
        const currentInstruments = member.instruments || [];
        const updated = { ...member, instruments: currentInstruments.map((i) => i.name !== instrumentName ? i : {
            ...i, techniques: (i.techniques || []).filter((t) => t !== technique),
            defaultTechnique: i.defaultTechnique === technique ? "" : (i.defaultTechnique || "")
        }) };
        if (await persistMemberEdit(memberName, updated)) toastInfo(`Removed "${technique}" technique from ${instrumentName}.`);
    }

    async function setInstrumentDefaultTechnique(memberName, instrumentName, defaultTechnique) {
        const member = bandMembers[memberName] || { instruments: [] };
        const currentInstruments = member.instruments || [];
        const updated = { ...member, instruments: currentInstruments.map((i) => i.name !== instrumentName ? i : { ...i, defaultTechnique }) };
        if (await persistMemberEdit(memberName, updated)) {
            toastInfo(defaultTechnique ? `Default technique set to "${defaultTechnique}".` : `Cleared default technique.`);
        }
    }

    // ---- import/export ----
    function buildExportPayload() {
        const currentSaved = savedSetlists || [];
        return {
            app: "setlist-roller", schemaVersion: 2, exportedAt: nowIso(),
            songs: songs.map(normalizeSongRecord),
            config: clone(appConfig),
            bandMembers: clone(bandMembers),
            savedSetlists: stripEnergy(clone(currentSaved)),
            meta: {
                bandName: appConfig?.bandName || "",
                songCount: songs.length,
                savedSetlistCount: currentSaved.length,
            }
        };
    }

    function exportAllData() {
        const payload = buildExportPayload();
        const safeName = (appConfig?.bandName || "band-setlist").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "band-setlist";
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${safeName}-data.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        toastInfo("Exported the whole catalog.");
    }

    function normalizeImportPayload(payload) {
        if (Array.isArray(payload)) {
            return { payloadType: "songs-array", songs: payload.map(normalizeSongRecord), config: null, bandMembers: null, savedSetlists: null };
        }
        if (payload && Array.isArray(payload.songs)) {
            // Extract old-format members BEFORE normalizeAppConfig strips them
            let importedMembers = payload.bandMembers || null;
            if (!importedMembers && payload.config?.band?.members && Object.keys(payload.config.band.members).length > 0) {
                importedMembers = clone(payload.config.band.members);
            }
            const config = payload.config ? normalizeAppConfig({
                ...clone(payload.config), bandName: payload.config.bandName || appConfig?.bandName || "", updatedAt: nowIso()
            }) : null;
            // Run rs-migrate on config to strip members
            const migratedConfig = config ? migrator.migrateDocument("config", config) : null;
            return {
                payloadType: "full-export",
                songs: payload.songs.map(normalizeSongRecord),
                config: migratedConfig,
                bandMembers: importedMembers,
                savedSetlists: Array.isArray(payload.savedSetlists) ? stripEnergy(payload.savedSetlists) : null,
            };
        }
        if (payload && payload.general && payload.show && payload.props) {
            return {
                payloadType: "config-object", songs: [],
                config: normalizeAppConfig({ ...clone(payload), bandName: payload.bandName || appConfig?.bandName || "", updatedAt: nowIso() }),
                bandMembers: null,
                savedSetlists: null,
            };
        }
        throw new Error("Unsupported JSON format.");
    }

    async function importFromFile() {
        if (!importFile) { toastError("Choose a JSON file first."); return; }
        try {
            busyMessage = "Importing...";
            const text = await importFile.text();
            const payload = JSON.parse(text);
            const existing = new Map(songs.map((s) => [s.id, s]));
            const imported = normalizeImportPayload(payload);
            let ws = 0;

            await withSync("Importing data", async () => {
                for (const s of imported.songs) {
                    if (importMode === "skip" && existing.has(s.id)) continue;
                    await repo.putSong(s); ws++;
                }
                if (imported.config && (importMode === "overwrite" || !appConfig)) {
                    await repo.putConfig(imported.config);
                }
                // Import members
                if (imported.bandMembers) {
                    for (const [name, data] of Object.entries(imported.bandMembers)) {
                        await repo.putMember(name, normalizeMemberRecord(data));
                    }
                }
                // Import setlists
                if (imported.savedSetlists && imported.savedSetlists.length > 0) {
                    for (const entry of imported.savedSetlists) {
                        await repo.putSetlist(migrator.migrateDocument("setlists", entry));
                    }
                }
                bootstrapMeta = await repo.putBootstrapMeta({
                    source: "uploaded-json", payloadType: imported.payloadType, mode: importMode,
                    fileName: importFile?.name || null, importedSongs: ws
                });
            });

            await reloadAll({ quiet: true });
            const parts = [`${ws} song${ws === 1 ? "" : "s"}`];
            if (imported.savedSetlists?.length) parts.push(`${imported.savedSetlists.length} saved setlist${imported.savedSetlists.length === 1 ? "" : "s"}`);
            if (imported.bandMembers) parts.push(`${Object.keys(imported.bandMembers).length} member${Object.keys(imported.bandMembers).length === 1 ? "" : "s"}`);
            toastInfo(`Imported ${parts.join(", ")}.`);
        } catch (error) {
            toastError(error?.message || "Import failed.");
        } finally {
            busyMessage = "";
        }
    }

    // ---- performance summary ----
    function performanceSummary(performance) {
        return Object.keys(performance || {}).sort().map((member) => {
            const setup = performance[member];
            const details = [];
            if (setup.instrument) details.push(setup.instrument);
            if (setup.tuning) details.push(setup.tuning);
            if (setup.capo) details.push(`capo ${setup.capo}`);
            const techniques = Array.isArray(setup.picking) ? setup.picking : (setup.picking ? [setup.picking] : []);
            if (techniques.length) details.push(techniques.join(", "));
            return `${member}: ${details.join(", ") || "default"}`;
        }).join(" | ");
    }

    // ---- migrations ----
    async function runMigrations({ skipReload = false } = {}) {
        let needsReload = false;

        // Migrate config: read raw config to check for band.members before normalization strips them
        pushSyncLog("Checking data migrations");
        const rawConfig = await repo.getRawConfig();
        if (rawConfig?.band?.members && Object.keys(rawConfig.band.members).length > 0) {
            pushSyncLog("Migrating band members from legacy config");
            // Extract members from old config and write only those not already migrated
            for (const [name, data] of Object.entries(rawConfig.band.members)) {
                if (!bandMembers[name]) {
                    await repo.putMember(name, normalizeMemberRecord(data));
                }
            }
            // Run rs-migrate on the raw config to strip band.members, then save
            const migratedConfig = migrator.migrateDocument("config", rawConfig);
            if (migratedConfig !== rawConfig) {
                await repo.putConfig(migratedConfig);
            }
            needsReload = true;
        }

        // Migrate localStorage setlists to remoteStorage
        if (typeof localStorage !== "undefined") {
            const localKey = storageKey("saved-sets");
            const raw = localStorage.getItem(localKey);
            if (raw) {
                pushSyncLog("Migrating saved setlists from local storage");
                const localSets = stripEnergy(tryParseJson(raw, []) || []);
                if (localSets.length > 0) {
                    // Normalize via rs-migrate before uploading
                    const remoteIds = new Set(savedSetlists.map((s) => s.id));
                    const toMigrate = localSets.filter((s) => !remoteIds.has(s.id));
                    for (const entry of toMigrate) {
                        const normalized = migrator.migrateDocument("setlists", entry);
                        await repo.putSetlist(normalized);
                    }
                    if (toMigrate.length > 0) needsReload = true;
                }
                localStorage.removeItem(localKey);
            }
        }

        if (needsReload) {
            if (skipReload) {
                pushSyncLog("Migrations applied; reload skipped");
            } else {
                pushSyncLog("Reloading after migrations");
                await reloadAll({ quiet: true });
            }
        } else {
            pushSyncLog("No migrations needed");
        }
    }

    // ---- init ----
    function init() {
        syncRouteFromHash();
        window.addEventListener("hashchange", syncRouteFromHash);

        // The known-accounts registry was already read at store-creation time
        // (the `let knownAccounts = $state(getKnownAccounts())` initializer).
        // If that read found a corrupt blob, surface it once now — the
        // accounts module can't show toasts itself.
        if (consumeKnownAccountsCorrupted()) {
            toastWarn("Some local data was unreadable and has been reset.");
        }

        // Safety timeout in case RS never fires "connected" or "not-connected"
        // (e.g. library bug or feature loading hangs).
        const safetyTimer = setTimeout(() => {
            if (connectionStatus === "pending") {
                connectionStatus = "disconnected";
            }
        }, 10000);

        // RS fires "not-connected" after features load when there is no stored
        // token and no OAuth redirect params. This replaces the old fixed 800ms
        // timer that could race against async feature init (IndexedDB open).
        const detachNotConnected = repo.on("not-connected", () => {
            clearTimeout(safetyTimer);
            if (connectionStatus === "pending") {
                connectionStatus = "disconnected";
            }
        });

        const detachConnecting = repo.on("connecting", () => {
            syncStatusLabel = "Discovering remote storage";
            pushSyncLog("Discovering remote storage endpoint");
        });
        const detachAuthing = repo.on("authing", () => {
            syncStatusLabel = "Waiting for authorization";
            pushSyncLog("Authorization required");
        });
        const detachStandaloneRedirect = repo.on("standalone-auth-redirect", () => {
            syncStatusLabel = "Opening authorization";
            pushSyncLog("Redirecting this app to the remoteStorage login");
        });
        const detachSyncStarted = repo.on("sync-started", () => {
            dbg("rs.js event: sync-started");
            pushSyncLog("Sync cycle started");
            // Diagnostic only. We deliberately do NOT bumpSyncActivity or
            // setSyncState("syncing") here: rs.js fires sync-started for
            // every sync cycle, including periodic ETag-refresh cycles that
            // accomplish no actual data movement. Treating those as
            // "activity" pinned the flip indefinitely (each ~2 s poll
            // cancelled the pending settle). Real data movement is signaled
            // by remote `onChange` events, which DO bumpSyncActivity and
            // re-set the syncing state — so any actual round 2/3 work
            // during bootstrap, or genuine remote changes during steady
            // state, will correctly extend / re-arm the indicator.
        });
        const detachSyncReqDone = repo.on("sync-req-done", (event) => {
            dbg(`rs.js event: sync-req-done tasksRemaining=${event?.tasksRemaining ?? 0}`);
            pushSyncLog(`Sync request finished, ${event?.tasksRemaining ?? 0} remaining`);
            // Diagnostic only — see sync-started above. A task completing
            // doesn't imply data changed (refresh tasks finish without
            // firing onChange when ETags match).
        });
        const detachSyncDone = repo.on("sync-done", (event) => {
            dbg(`rs.js event: sync-done completed=${event?.completed}`);
            pushSyncLog(event?.completed ? "Sync cycle completed" : "Sync cycle paused for retry");
            // sync-done {completed:true} is necessary but not sufficient: rs.js
            // sometimes fires this before all body change events propagate, so
            // pendingBodies (read from the cache after each reload) is the
            // authoritative gate. We just record the milestone — the actual
            // pill flip happens once the next reloadAll lands and confirms
            // pendingBodies === 0.
            if (event?.completed) {
                syncRoundCompleted = true;
                maybeMarkSynced();
            }
        });

        const detachConnected = repo.on("connected", async () => {
            clearTimeout(safetyTimer);
            // Swap landed (or first connect completed). Release the swap
            // guard now: any further `disconnected` event must be a real
            // user-initiated disconnect, not the old account's stale
            // cleanup. Idempotent — does nothing on cold connects where
            // the guard was never raised.
            releaseSwitching("connected");
            // Each connect starts a fresh session so prior async work is
            // discarded even on a plain (non-swap) reconnect.
            activeSession += 1;
            connectionStatus = "connected";
            // Fresh connection — clear any cross-session sync gates so the
            // pill doesn't inherit completion state from the previous
            // account. (connectToAccount already resets these for the
            // snapshot path; this covers cold connect and OAuth-redirect.)
            syncRoundCompleted = false;
            pendingBodies = 0;
            initialSyncSettled = false;
            bumpSyncActivity("connected");
            // Cold connect / OAuth path: ensure rs.js is in bootstrap-pace
            // polling. (connectToAccount already does this for swaps.)
            tightenSyncInterval();
            if (syncState !== "error") setSyncState("syncing");
            connectAddress = repo.getUserAddress() || connectAddress;
            currentUserAddress = connectAddress;
            loadUserLocalData();
            pushSyncLog(`Connected as ${currentUserAddress}`);

            if (initialSyncComplete) {
                // Snapshot already restored (account switch) — don't overwrite
                // with stale cache. The onChange handler will pick up fresh
                // data once rs.js finishes syncing with the new remote.
                try {
                    await runMigrations({ skipReload: true });
                } catch (err) {
                    console.error("Migration failed:", err);
                    toastError("Data migration encountered an error. Some data may need re-syncing.");
                    pushSyncLog("Data migration encountered an error");
                }
            } else {
                // First load or switch without snapshot — read from cache
                beginSync("Loading");
                try {
                    await reloadAll({ quiet: true });
                    await runMigrations();
                } catch (err) {
                    console.error("Migration/reload failed:", err);
                    toastError("Data sync encountered an error. Some data may need re-syncing.");
                    pushSyncLog("Initial sync encountered an error");
                } finally {
                    endSync();
                }
            }
            saveKnownAccount(currentUserAddress, { bandName: appConfig?.bandName || "" }, repo.getToken());
            knownAccounts = getKnownAccounts();
        });

        const detachDisconnected = repo.on("disconnected", () => {
            // Mid-swap, the disconnected event is just an intermediate step.
            // Don't wipe state — the snapshot we restored stays visible until
            // the next `connected` event fills in real data.
            if (isSwitching) {
                // Consume the straggler flag too: the in-window disconnect
                // satisfies the expectation set by expectSwapDisconnect(),
                // and we don't want a stale flag living past this point.
                consumePendingSwapDisconnect();
                pushSyncLog("Disconnected (switching accounts)");
                return;
            }
            // Post-swap straggler: rs.js's old-account `disconnected` event
            // can arrive AFTER the new account's `connected` because
            // repo.swap() resolves via a 3 s safety timeout that doesn't
            // wait for the underlying disconnect to actually finish. By the
            // time this lands, isSwitching has already been released by the
            // connected handler — but we still need to skip the wipe, since
            // it's the OLD account telling us about itself. The straggler
            // flag was armed at swap entry exactly for this case.
            if (pendingSwapDisconnect) {
                consumePendingSwapDisconnect();
                pushSyncLog("Disconnected (post-swap straggler from old account — ignored)");
                return;
            }
            terminateWorker();
            isGenerating = false;
            connectionStatus = "disconnected";
            reloadInFlight = 0;
            pendingBodies = 0;
            syncRoundCompleted = false;
            initialSyncSettled = false;
            if (syncStalledTimer) clearTimeout(syncStalledTimer);
            syncStalledTimer = null;
            syncStalled = false;
            bumpSyncActivity("disconnected");
            // Reset the pill's high-level state too. Without this, a
            // disconnect mid-bootstrap (or mid-swap that fell through the
            // wipe path) leaves syncState pinned at "syncing" — RollScreen
            // then keeps rendering the sync skeleton forever instead of the
            // onboarding/login UI.
            setSyncState("idle");
            loadError = "";
            clearUserLocalStorage();
            clearUnscopedLocalStorage();
            currentUserAddress = "";
            songs = [];
            appConfig = null;
            clearGeneratedSetlist();
            setlistLocked = false;
            setlistSaved = false;
            savedSetlists = [];
            bandMembers = {};
            initialSyncComplete = false;
            selectedSongId = "";
            editorSong = null;
            pushSyncLog("Disconnected");
        });

        const detachError = repo.on("error", (error) => {
            loadError = error?.message || "remoteStorage error.";
            toastError(loadError);
            pushSyncLog(loadError);
            // Surface the error in the pill/skeleton state. Without this,
            // setting `loadError` alone keeps maybeMarkSynced blocked while
            // syncState stays "syncing" — the dot pulses blue forever and
            // the user never sees the errored state. The next reloadAll
            // (triggered by user action or fresh remote onChange) will
            // unconditionally re-set syncState back to "syncing" via the
            // bumpSyncActivity / setSyncState calls in reloadAll start, so
            // we don't need a separate recovery path here.
            setSyncState("error");
            // Only nuke the session for auth/discovery failures. SyncError and
            // friends are typically transient (flaky network, 5xx) — let rs.js
            // retry instead of dropping the user back to the login screen.
            const fatal = error?.name === "Unauthorized" || error?.name === "DiscoveryError";
            if (fatal) {
                // If we're mid-swap, release the guard so the upcoming
                // `disconnected` event runs the wipe instead of being
                // swallowed by the swap-in-progress check. Also consume
                // the straggler flag — otherwise repo.disconnect() below
                // would land a `disconnected` event that gets eaten by
                // the post-swap branch instead of running the wipe we
                // want for a fatal auth failure.
                releaseSwitching("fatal error during swap");
                consumePendingSwapDisconnect();
                repo.disconnect();
            }
        });

        const detachChange = repo.onChange(async (event) => {
            dbg(`rs.js change: path=${event?.relativePath || event?.path || "?"} origin=${event?.origin} oldVal=${typeof event?.oldValue} newVal=${typeof event?.newValue}`);
            if (connectionStatus !== "connected" || event?.origin === "window") return;
            // Remote-origin events mean rs.js is streaming bodies in. Show
            // activity in the pill even if no reload runs (defensive — the
            // reload below will normally handle this), and cancel any
            // pending settle-window flip since data is still arriving.
            if (event?.origin === "remote") {
                bumpSyncActivity("remote onChange");
                if (syncState !== "error") setSyncState("syncing");
            }
            // Pin the session at the moment the event fired. If the user
            // swaps accounts mid-reload, the awaited reloadAll() returns
            // into a different session and we drop its results.
            const session = activeSession;
            beginSync(event?.origin === "remote" ? "Pulling remote changes" : "Syncing");
            try { await reloadAll({ quiet: true, session }); }
            finally { endSync(); }
        });

        return () => {
            window.removeEventListener("hashchange", syncRouteFromHash);
            clearTimeout(safetyTimer);
            if (syncIndicatorTimer) clearTimeout(syncIndicatorTimer);
            if (syncStateTimer) clearTimeout(syncStateTimer);
            if (syncFlipTimer) clearTimeout(syncFlipTimer);
            if (syncStalledTimer) clearTimeout(syncStalledTimer);
            if (switchingWatchdog) clearTimeout(switchingWatchdog);
            if (pendingSwapDisconnectTimer) clearTimeout(pendingSwapDisconnectTimer);
            detachConnecting();
            detachAuthing();
            detachStandaloneRedirect();
            detachSyncStarted();
            detachSyncReqDone();
            detachSyncDone();
            detachConnected();
            detachDisconnected();
            detachNotConnected();
            detachError();
            detachChange();
        };
    }

    return {
        // state (getters)
        get songs() { return songs; },


        get appConfig() { return appConfig; },
        get bandMembers() { return bandMembers; },
        get generatedSetlist() { return generatedSetlist; },
        get isGenerating() { return isGenerating; },
        get setlistLocked() { return setlistLocked; },
        get setlistSaved() { return setlistSaved; },
        get pendingRollConfirm() { return pendingRollConfirm; },
        get savedSetlists() { return savedSetlists; },
        get connectionStatus() { return connectionStatus; },
        get connectAddress() { return connectAddress; },
        set connectAddress(v) { connectAddress = v; },
        get activeView() { return activeView; },
        get loadError() { return loadError; },
        get busyMessage() { return busyMessage; },
        get toastMessages() { return toastMessages; },
        get showFirstRunPrompt() { return showFirstRunPrompt; },
        get initialSyncComplete() { return initialSyncComplete; },
        get firstRunBandName() { return firstRunBandName; },
        set firstRunBandName(v) { firstRunBandName = v; },
        get syncIndicatorVisible() { return syncIndicatorVisible; },
        get syncStatusLabel() { return syncStatusLabel; },
        get syncActivelyRunning() { return syncActiveCount > 0; },
        get syncState() { return syncState; },
        get syncLogEntries() { return syncLogEntries; },
        get syncStalled() { return syncStalled; },
        retrySync,
        get generationOptions() { return generationOptions; },
        get editorSong() { return editorSong; },
        get selectedSongId() { return selectedSongId; },
        get songSearch() { return songSearch; },
        set songSearch(v) { songSearch = v; },
        get songFilter() { return songFilter; },
        set songFilter(v) { songFilter = v; },
        get songKeyFilters() { return songKeyFilters; },
        get usedKeys() { return usedKeys; },
        toggleKeyFilter(key) {
            const next = new Set(songKeyFilters);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            songKeyFilters = next;
        },
        clearKeyFilters() { songKeyFilters = new Set(); },
        get expandedBandMember() { return expandedBandMember; },
        set expandedBandMember(v) { expandedBandMember = v; },
        get newMemberName() { return newMemberName; },
        set newMemberName(v) { newMemberName = v; },
        get newInstrumentByMember() { return newInstrumentByMember; },
        set newInstrumentByMember(v) { newInstrumentByMember = v; },
        get newTuningByInstrument() { return newTuningByInstrument; },
        set newTuningByInstrument(v) { newTuningByInstrument = v; },
        get newTechniqueByInstrument() { return newTechniqueByInstrument; },
        set newTechniqueByInstrument(v) { newTechniqueByInstrument = v; },
        get importMode() { return importMode; },
        set importMode(v) { importMode = v; },
        get importFile() { return importFile; },
        set importFile(v) { importFile = v; },


        get bandSubView() { return bandSubView; },
        set bandSubView(v) { bandSubView = v; },
        get editingMemberName() { return editingMemberName; },
        set editingMemberName(v) { editingMemberName = v; },

        // derived
        get appTitle() { return appTitle; },
        get emptyCatalog() { return emptyCatalog; },
        get bandMemberEntries() { return bandMemberEntries; },
        get availableMemberNames() { return availableMemberNames; },
        get memberInstrumentChoicesByMember() { return memberInstrumentChoicesByMember; },
        get memberTuningChoicesByMember() { return memberTuningChoicesByMember; },
        get defaultTuningByMemberInstrument() { return defaultTuningByMemberInstrument; },
        get allInstrumentNamesList() { return allInstrumentNamesList; },
        get instrumentTypeCount() { return instrumentTypeCount; },
        get visibleSongs() { return visibleSongs; },
        isSongIncomplete,
        songIncompleteReasons,
        get incompleteSongCount() { return songs.filter((s) => isSongIncomplete(s)).length; },
        get unpracticedSongCount() { return songs.filter((s) => s.unpracticed).length; },

        // accounts
        get knownAccounts() { return knownAccounts; },
        connectToAccount,
        forgetAccount,

        // actions
        init,
        navigate,
        connectStorage,
        disconnectStorage,
        finishFirstRun,
        requestRoll,
        confirmFreshRoll,
        confirmOptimizeOrder,
        cancelRoll,
        lockSetlist,
        saveCurrentSetlist,
        removeSavedSetlist,
        updateSavedSetlist,
        loadSavedSetlist,
        reorderSetlistSong,
        removeSetlistSong,
        addSetlistSong,
        get songsNotInSetlist() { return songsNotInSetlist; },
        updateGenerationField,
        toggleListValue,
        ensureMemberShowConfig,


        openNewSong,
        openSong,
        closeEditor,
        get editReturnView() { return editReturnView; },
        set editReturnView(v) { editReturnView = v; },
        updateSongField,
        renameMember,
        addMember,
        removeMember,
        addInstrumentOption,
        removeInstrumentOption,
        updateInstrumentOption,
        saveSong,
        duplicateSong,
        deleteSong,
        deleteAllData,
        configFieldValue,
        updateConfigField,
        saveConfig,
        addBandMember,
        renameBandMember,
        removeBandMember,
        addBandMemberInstrument,
        removeBandMemberInstrument,
        addTuningChoice,
        removeTuningChoice,
        setMemberDefaultInstrument,
        setInstrumentDefaultTuning,
        addTechniqueChoice,
        removeTechniqueChoice,
        setInstrumentDefaultTechnique,
        techniqueDraftKey,
        tuningDraftKey,
        exportAllData,
        importFromFile,
        performanceSummary,
        toastInfo,
        toastWarn,
        toastError,
        songsUsingMember,
        songsUsingInstrument,
        songsUsingTuning,
        songsUsingTechnique,

        // constants
        CONFIG_SECTIONS,
    };
}
