import { accountSlot, consumeKnownAccountsCorrupted, getAccountToken, getKnownAccounts, removeKnownAccountEntry, saveKnownAccount } from "../accounts.js";
import { CONFIG_SECTIONS } from "../config-meta.js";
import { blankSong, DEFAULT_APP_CONFIG, normalizeAppConfig, normalizeMemberRecord, normalizeSongRecord, sortSongs } from "../defaults.js";
import { buildDefaultPerformance, scoreFixedOrder } from "../generator.js";
import GeneratorWorker from "../generator.worker.js?worker";
import { pruneStaleKeys, sortKeys } from "../keys.js";
import { deleteAccountDb, openAccountDb } from "../local-db.js";
import { migrator } from "../migrations.js";
import { clone, deepMerge, formatDelimitedList, getByPath, nowIso, parseDelimitedList, randomFrom, setByPath, titleForBand, tryParseJson, uid } from "../utils.js";

const STORAGE_PREFIX = "setlist-roller";

// localStorage key remembering which account was active when the app was
// last open. Lets a cold boot hydrate that account's local mirror and show
// the full UI immediately — before (and regardless of whether) remoteStorage
// re-establishes its session.
const ACTIVE_ACCOUNT_KEY = `${STORAGE_PREFIX}-active-account`;

// Toast tone vocabulary. Values are the CSS class names that style the pill;
// callers go through the typed toastInfo/toastWarn/toastError helpers so a
// typo can't silently fall back to the default style.
const TOAST_TONE = Object.freeze({
    INFO: "info",
    WARN: "warning",
    DANGER: "danger",
});
const VALID_TOAST_TONES = new Set(Object.values(TOAST_TONE));
// Danger gets a longer dwell so more severe messages remain visible longer.
const TOAST_DURATION_MS = { default: 6000, danger: 12000 };

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

export function createAppStore(repo) {
    // ---- per-user localStorage scoping ----
    // $state is load-bearing: App.svelte's top-level render gate reads this
    // first in a short-circuiting condition. If it were a plain variable,
    // the {#if} would capture no reactive dependencies while it's truthy
    // and never re-evaluate — the app shell would survive a sign-out.
    let currentUserAddress = $state("");
    function storageKey(base) { return accountSlot(currentUserAddress).key(base); }

    // Monotonic session id — bumped on every connect/swap. Async work that
    // started under one session is discarded if the session has moved on.
    let activeSession = 0;

    // True while orchestrating an account swap. Tells the `disconnected`
    // handler that the mid-swap disconnect of the old account is an
    // intermediate step, not a real sign-out. Nothing destructive hangs off
    // the disconnect path anymore (data wipes are explicit, see
    // forgetAccount), so a stale flag can no longer eat anyone's data.
    let isSwitching = false;

    // Per-account IndexedDB mirror — the local source of truth the UI
    // hydrates from at boot and every accepted change is written back to.
    // Null when no account is active or IndexedDB is unavailable (private
    // browsing); the app then runs memory-only like the pre-v3 builds.
    let mirror = null;

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
    // True once the active account's local mirror has been read into memory.
    // The UI renders as soon as an account is active; this only guards the
    // brief (<50 ms) window before local data lands, so empty-state CTAs
    // don't flash.
    let hydrated = $state(false);
    let firstRunBandName = $state("");

    // ---- sync ----
    // Transient label for the TopBar dot tooltip while a write burst or the
    // connection handshake is in flight. Purely cosmetic.
    let syncStatusLabel = $state("");
    let syncActiveCount = $state(0);
    // High-level sync state for the TopBar dot / RollScreen skeletons:
    // "idle" | "syncing" | "synced" | "error". "synced" is a transient
    // confirmation that fades back to idle.
    let syncState = $state("idle");
    let syncStateTimer = null;
    // True once this account's first full sync has completed — persisted in
    // the mirror ("sync-meta"), so it survives reloads and is per-account.
    // Gates the first-run prompt (we must KNOW there's no remote config, not
    // merely not-have-seen-it-yet) and saved-setlist pruning.
    let initialSyncDone = $state(false);
    // rs.js syncs in back-to-back rounds; sync-done {completed:true} fires
    // after each round, not when the whole tree is in. The only reliable
    // "everything arrived" signal is quiescence: a sync-done followed by one
    // full polling interval with no incoming changes. A single settle timer
    // (armed by sync-done, cancelled by every remote change) encodes that.
    const BOOTSTRAP_SYNC_INTERVAL_MS = 2000; // matches rs.js syncInterval set at construction
    const STEADY_SYNC_INTERVAL_MS = 10000;   // rs.js library default
    const SYNC_SETTLE_MS = BOOTSTRAP_SYNC_INTERVAL_MS + 500;
    let settleTimer = null;
    // If a connect/swap silently never completes (token rejected without an
    // error event, OAuth tab closed), connectionStatus would stay
    // "connecting" and its re-entry guard would lock out retries. This
    // watchdog resets it. The OAuth path gets a much longer window — the
    // user may legitimately be typing a password in the popup.
    const CONNECTING_TIMEOUT_MS = 20000;
    const AUTHING_TIMEOUT_MS = 180000;
    let connectingWatchdogTimer = null;

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
    // = true/false` writes across the sync, account, and deleteAllData paths,
    // finishFirstRun, and the disconnected handler) prevents a class of drift
    // bugs where a partial auth failure leaves the modal visible after
    // connectionStatus has already flipped back to "disconnected" — which
    // surfaced as the user seeing the band-name prompt instead of the login
    // page after a failed authorization. The modal only makes sense when
    // we're actually connected, the initial sync has landed, and there's no
    // appConfig yet — so encode exactly that. initialSyncDone (not merely
    // hydrated) is the load-bearing gate: it proves the remote truly has no
    // config, rather than us just not having pulled it yet.
    let showFirstRunPrompt = $derived(
        connectionStatus === "connected" && initialSyncDone && hydrated && !appConfig,
    );
    let emptyCatalog = $derived(
        (connectionStatus === "connected" || hydrated) && songs.length === 0,
    );
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

    // Once the catalog is fully settled, reconcile any stale song refs that
    // were deferred during the initial sync (or pruned any time a song is
    // deleted mid-session while a setlist is active). Runs whenever
    // catalogSettled, generatedSetlist, or songsById changes — safe because
    // a second run after the mutation finds dropped===0 and exits.
    $effect(() => {
        if (!catalogSettled || !generatedSetlist) return;
        const valid = generatedSetlist.songs.filter((e) => songsById.has(e.songId));
        const dropped = generatedSetlist.songs.length - valid.length;
        if (dropped === 0) return;
        if (valid.length === 0) {
            clearGeneratedSetlist();
            setlistLocked = false;
        } else {
            generatedSetlist = { ...generatedSetlist, songs: valid };
        }
        setlistSaved = false;
        persistCurrentSetlist();
        toastWarn(`Removed ${dropped} song${dropped === 1 ? "" : "s"} no longer in your catalog.`);
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
            // Wrap in a block so the arrow doesn't return Set#add's value —
            // Biome's useIterableCallbackReturn flags implicit returns from
            // forEach callbacks as a likely bug.
            (instruments || []).forEach((name) => {
                names.add(name);
            });
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

    /** Reset the active generated setlist and clear any loaded-saved reference. */
    function clearGeneratedSetlist() {
        generatedSetlist = null;
        loadedSavedId = "";
    }

    /**
     * Catalog lookup table keyed by song id.
     * Recomputes whenever `songs` changes, which is what makes the displayed
     * setlists below auto-refresh on RS pulls and local edits — no manual
     * sync paths required.
     */
    let songsById = $derived(new Map((songs || []).map((s) => [s.id, s])));

    /**
     * Take a lean setlist + the live catalog and produce the fully-fat form
     * that views render: catalog fields overlaid, scores and summary
     * recomputed by scoreFixedOrder.
     *
     * Songs whose ids no longer exist in the catalog are filtered out —
     * saved setlists shrink gracefully when their referenced songs have
     * been deleted.
     *
     * @param {object|null} setlist - Lean setlist object with `songs` array of `{songId, performance}`.
     * @returns {object|null} Hydrated setlist with full song data and recomputed summary, or null.
     */
    function hydrateSetlist(setlist) {
        if (!setlist || !Array.isArray(setlist.songs)) return setlist || null;
        const fat = [];
        for (const entry of setlist.songs) {
            const song = songsById.get(entry.songId);
            if (song) fat.push({ ...song, performance: entry.performance || {} });
        }
        const scored = scoreFixedOrder(fat, appConfig || DEFAULT_APP_CONFIG, {
            keyFlow: generationOptions?.keyFlow,
        });
        return {
            ...setlist,
            songs: scored.songs,
            summary: {
                ...scored.summary,
                minimumsRelaxed: !!setlist.minimumsRelaxed,
                openerFilterRelaxed: !!setlist.openerFilterRelaxed,
                closerFilterRelaxed: !!setlist.closerFilterRelaxed,
            },
        };
    }

    let displayedSetlist = $derived(hydrateSetlist(generatedSetlist));
    let displayedSavedSetlists = $derived((savedSetlists || []).map(hydrateSetlist));

    // True only when the catalog is safe to treat as authoritative (for
    // pruning setlist references against it). Once an account's initial
    // sync has completed, the mirror-backed in-memory catalog is always
    // complete — later changes arrive incrementally.
    let catalogSettled = $derived(initialSyncDone);

    /**
     * Strip a generator/scoring result down to the lean persisted shape.
     *
     * Each setlist entry keeps only what isn't derivable from the catalog
     * (the song reference and the rolled performance choice). Generation
     * metadata moves to top-level fields; the scored summary is recomputed
     * at display time inside hydrateSetlist().
     *
     * @param {object|null} result - Raw generator result with `songs`, `seed`, and `summary`.
     * @returns {object|null} Lean setlist `{seed, minimumsRelaxed, …, songs: [{songId, performance}]}`.
     */
    function leanFromGeneratorResult(result) {
        if (!result) return null;
        const summary = result.summary || {};
        return {
            seed: result.seed,
            minimumsRelaxed: !!summary.minimumsRelaxed,
            openerFilterRelaxed: !!summary.openerFilterRelaxed,
            closerFilterRelaxed: !!summary.closerFilterRelaxed,
            songs: (result.songs || []).map((s) => ({
                songId: s.id,
                performance: s.performance || {},
            })),
        };
    }

    /**
     * Detect a pre-refactor (fat) saved/persisted setlist where each song
     * entry carries embedded catalog fields, and convert it to the lean shape.
     * Idempotent — already-lean entries pass through unchanged.
     *
     * @param {object|null} setlist - Raw setlist, possibly in the old fat format.
     * @returns {object|null} Setlist with lean `{songId, performance}` song entries.
     */
    function normalizeLeanSetlist(setlist) {
        if (!setlist || !Array.isArray(setlist.songs)) return null;
        const songs = setlist.songs.map((s) => ({
            songId: s.songId || s.id,
            performance: s.performance || {},
        }));
        const out = { ...setlist, songs };
        if (out.summary) {
            for (const flag of ["minimumsRelaxed", "openerFilterRelaxed", "closerFilterRelaxed"]) {
                if (out.summary[flag] !== undefined && out[flag] === undefined) out[flag] = out.summary[flag];
            }
            delete out.summary;
        }
        delete out.songNames;
        delete out.songCount;
        return out;
    }

    function loadCurrentSetlist() {
        if (typeof localStorage === "undefined") return null;
        const raw = tryParseJson(localStorage.getItem(storageKey("current-set")), null);
        return normalizeLeanSetlist(raw);
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
    // accounts. Called once per boot from init() — that's the migration path
    // for users coming from the pre-multi-account build, where these keys
    // were written without the per-account hash. Idempotent and cheap.
    function clearUnscopedLocalStorage() {
        if (typeof localStorage === "undefined") return;
        localStorage.removeItem("setlist-roller-ui-options");
        localStorage.removeItem("setlist-roller-saved-sets");
        localStorage.removeItem("setlist-roller-current-set");
    }

    // Load all per-user localStorage data (called on connect when we know the user)
    function loadUserLocalData() {
        const current = loadCurrentSetlist();
        // Restore the persisted current set whether or not it was locked.
        // Previously only locked sets survived a reload — but the page can
        // reload without the user asking for it (service-worker update,
        // browser crash, iOS killing a backgrounded PWA), and losing a
        // rolled-but-unlocked set to any of those mid-gig is unacceptable.
        // The lock flag still means what it meant: it only guards against
        // the NEXT ROLL clobbering the list, not against persistence.
        if (current) {
            generatedSetlist = current;
            setlistLocked = current._locked || false;
        } else {
            clearGeneratedSetlist();
            setlistLocked = false;
        }
        setlistSaved = false;
        generationOptions = loadStoredGenerationOptions();
    }

    // ---- toast ----
    function addToast(message, tone, options = {}) {
        // Unknown tones fall back to INFO instead of silently rendering as the
        // default style with no semantic class (e.g. "warn" vs "warning").
        const validTone = VALID_TOAST_TONES.has(tone) ? tone : TOAST_TONE.INFO;
        const id = uid("toast");
        // Optional action button (e.g. "Refresh" on the update prompt).
        // Clicking it dismisses the toast, then runs the handler.
        const action =
            options.action && typeof options.action.onClick === "function"
                ? { label: options.action.label || "OK", onClick: options.action.onClick }
                : null;
        toastMessages = [{ id, message, tone: validTone, action, sticky: !!options.sticky }];
        if (options.sticky) return;
        const duration = validTone === TOAST_TONE.DANGER ? TOAST_DURATION_MS.danger : TOAST_DURATION_MS.default;
        setTimeout(() => {
            toastMessages = toastMessages.filter((t) => t.id !== id);
        }, duration);
    }
    function dismissToast(id) {
        toastMessages = toastMessages.filter((t) => t.id !== id);
    }
    function toastInfo(message)  { addToast(message, TOAST_TONE.INFO); }
    function toastWarn(message)  { addToast(message, TOAST_TONE.WARN); }
    function toastError(message) { addToast(message, TOAST_TONE.DANGER); }
    /**
     * Persistent toast with an action button. Used for the service-worker
     * update prompt: it must not auto-dismiss (the user may be mid-set and
     * needs to choose their moment), so it stays until acted on or
     * explicitly dismissed via the pill's close button.
     */
    function toastAction(message, actionLabel, onAction) {
        addToast(message, TOAST_TONE.INFO, {
            sticky: true,
            action: { label: actionLabel, onClick: onAction },
        });
    }

    // ---- sync indicators ----
    function beginSync(label = "Syncing") {
        syncActiveCount += 1;
        syncStatusLabel = label;
    }

    function endSync() {
        syncActiveCount = Math.max(0, syncActiveCount - 1);
        if (syncActiveCount === 0) syncStatusLabel = "";
    }

    async function withSync(label, callback) {
        beginSync(label);
        try {
            return await callback();
        } finally {
            endSync();
        }
    }

    function cancelSettleTimer() {
        if (settleTimer) {
            clearTimeout(settleTimer);
            settleTimer = null;
        }
    }

    function cancelConnectingWatchdog() {
        if (connectingWatchdogTimer) {
            clearTimeout(connectingWatchdogTimer);
            connectingWatchdogTimer = null;
        }
    }

    function armConnectingWatchdog(timeoutMs = CONNECTING_TIMEOUT_MS) {
        cancelConnectingWatchdog();
        connectingWatchdogTimer = setTimeout(() => {
            connectingWatchdogTimer = null;
            if (connectionStatus !== "connecting") return;
            isSwitching = false;
            if (repo.isConnected()) {
                connectionStatus = "connected";
            } else {
                connectionStatus = "disconnected";
                loadError = "Connection timed out. Try again.";
                toastError(loadError);
                setSyncState("error");
            }
        }, timeoutMs);
    }

    function setSyncState(next) {
        if (syncStateTimer) {
            clearTimeout(syncStateTimer);
            syncStateTimer = null;
        }
        if (next !== "syncing") cancelSettleTimer();
        syncState = next;
        // "synced" is a transient confirmation — fade back to idle.
        if (next === "synced") {
            syncStateTimer = setTimeout(() => {
                if (syncState === "synced") syncState = "idle";
                syncStateTimer = null;
            }, 2500);
        }
    }

    function relaxSyncInterval() {
        try {
            if (repo.getSyncInterval() < STEADY_SYNC_INTERVAL_MS) {
                repo.setSyncInterval(STEADY_SYNC_INTERVAL_MS);
            }
        } catch (_e) {
            // Non-fatal: polling just stays at the bootstrap pace.
        }
    }

    function tightenSyncInterval() {
        try {
            if (repo.getSyncInterval() > BOOTSTRAP_SYNC_INTERVAL_MS) {
                repo.setSyncInterval(BOOTSTRAP_SYNC_INTERVAL_MS);
            }
        } catch (_e) {
            // Non-fatal.
        }
    }

    // Quiescence detector: rs.js fired sync-done and one full polling
    // interval passed with no incoming remote changes — the tree should be
    // in. Every remote change cancels the timer (see onChange in init); the
    // next sync-done re-arms it. Because rs.js syncs in rounds and the
    // early rounds (root + folder listings) fire no change events, the
    // quiet window alone can elapse while the cache is still skeletal — so
    // before declaring the sync settled we verify the cache is coherent,
    // and while we're at it reconcile the mirror against it (documents
    // deleted remotely while this device was away, or while the account
    // was switched out and rs.js's cache was reset, never fire deletion
    // events — this sweep is what removes them locally).
    function armSettleTimer() {
        if (settleTimer || syncState !== "syncing") return;
        const session = activeSession;
        settleTimer = setTimeout(async () => {
            settleTimer = null;
            if (session !== activeSession || syncState !== "syncing") return;
            let data = null;
            try {
                data = await repo.loadAll();
            } catch (_e) {
                return; // cache unreadable — a later sync-done retries
            }
            if (session !== activeSession || syncState !== "syncing") return;
            if ((data.pendingBodies || 0) > 0) return; // bodies still arriving
            if (Object.keys(data.errors || {}).length > 0) return; // partial read — never prune on it
            const cacheEmpty =
                !data.songs?.length &&
                !data.setlists?.length &&
                !Object.keys(data.members || {}).length &&
                !data.config;
            const memoryHasData =
                songs.length > 0 || savedSetlists.length > 0 || Object.keys(bandMembers).length > 0 || !!appConfig;
            // An empty cache with local data on screen means rs.js hasn't
            // pulled the folder listings yet (fresh cache after a swap) —
            // not that the account is empty. Wait for a later round.
            if (cacheEmpty && memoryHasData) return;

            // The cache is authoritative now: drop anything local it no
            // longer contains.
            const songIds = new Set((data.songs || []).map((s) => s.id));
            for (const song of songs.filter((s) => !songIds.has(s.id))) removeSongLocal(song.id);
            const setlistIds = new Set((data.setlists || []).map((s) => s.id));
            for (const setlist of savedSetlists.filter((s) => !setlistIds.has(s.id))) removeSetlistLocal(setlist.id);
            const memberNames = new Set(Object.keys(data.members || {}));
            for (const name of Object.keys(bandMembers).filter((n) => !memberNames.has(n))) removeMemberLocal(name);
            if (!data.config && appConfig) setConfigLocal(null);

            setSyncState("synced");
            if (!initialSyncDone) {
                initialSyncDone = true;
                relaxSyncInterval();
                void mirror?.putKv("sync-meta", { initialSyncDone: true, completedAt: nowIso() }).catch(() => {});
            }
        }, SYNC_SETTLE_MS);
    }

    // Async-write staleness guard. Capture at the start of any action that
    // awaits repo I/O and check after each await: if the user switched (or
    // signed out of) the account mid-flight, the result belongs to the OLD
    // account and must not be applied to the newly active mirror/state.
    function sessionGuard() {
        const session = activeSession;
        return () => session === activeSession;
    }

    // ---- local catalog mutation ----
    // Single write path for every accepted document, whether it arrived from
    // a remote sync event, the one-time cache seed, or a local edit: update
    // the in-memory state and mirror it to the per-account IndexedDB. All
    // helpers take plain (non-$state) objects.
    function upsertSongLocal(doc) {
        const song = normalizeSongRecord(doc);
        void mirror?.putSong(song).catch(() => {});
        songs = sortSongs(songs.filter((s) => s.id !== song.id).concat(song));
    }

    function removeSongLocal(id) {
        void mirror?.deleteSong(id).catch(() => {});
        songs = songs.filter((s) => s.id !== id);
    }

    function upsertSetlistLocal(doc) {
        const setlist = migrator.migrateDocument("setlists", doc);
        void mirror?.putSetlist(setlist).catch(() => {});
        savedSetlists = savedSetlists
            .filter((s) => s.id !== setlist.id)
            .concat(setlist)
            .sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || ""));
    }

    function removeSetlistLocal(id) {
        void mirror?.deleteSetlist(id).catch(() => {});
        savedSetlists = savedSetlists.filter((s) => s.id !== id);
        if (loadedSavedId === id) loadedSavedId = "";
    }

    function upsertMemberLocal(name, doc) {
        const member = normalizeMemberRecord(doc);
        void mirror?.putMember({ ...member, name }).catch(() => {});
        bandMembers = { ...bandMembers, [name]: member };
    }

    function removeMemberLocal(name) {
        void mirror?.deleteMember(name).catch(() => {});
        const next = { ...bandMembers };
        delete next[name];
        bandMembers = next;
    }

    function setConfigLocal(config) {
        if (config) {
            const normalized = normalizeAppConfig(config);
            void mirror?.putKv("config", normalized).catch(() => {});
            appConfig = normalized;
            generationOptions = deepMerge(defaultGenerationOptions(normalized), generationOptions || {});
        } else {
            void mirror?.deleteKv("config").catch(() => {});
            appConfig = null;
        }
    }

    function setBootstrapLocal(meta) {
        if (meta) {
            void mirror?.putKv("bootstrap", meta).catch(() => {});
            bootstrapMeta = meta;
        } else {
            void mirror?.deleteKv("bootstrap").catch(() => {});
            bootstrapMeta = null;
        }
    }

    // Apply one rs.js change event (remote or conflict origin) to the local
    // catalog. Conflicts take the remote value — same policy rs.js applies
    // to its own cache.
    function applyRemoteChange(event) {
        const path = event?.relativePath || "";
        const value = event?.newValue;
        const hasValue = value && typeof value === "object";
        if (path.startsWith("songs/")) {
            if (hasValue) upsertSongLocal(value);
            else removeSongLocal(path.slice("songs/".length));
        } else if (path.startsWith("setlists/")) {
            if (hasValue) upsertSetlistLocal(value);
            else removeSetlistLocal(path.slice("setlists/".length));
        } else if (path.startsWith("members/")) {
            const key = path.slice("members/".length);
            if (hasValue) upsertMemberLocal(value.name || key, value);
            else removeMemberLocal(key);
        } else if (path === "settings/app-config") {
            setConfigLocal(hasValue ? value : null);
        } else if (path === "meta/bootstrap") {
            setBootstrapLocal(hasValue ? value : null);
        }
    }

    // One-time adoption pass for accounts whose documents already sit in
    // rs.js's internal cache but not in our mirror (v2 → v3 upgrade, or a
    // deleted-and-recreated mirror). Unchanged cached documents never re-fire
    // change events, so without this read they'd stay invisible forever.
    // Idempotent: everything goes through the upsert helpers.
    async function seedFromRepoCache(session) {
        try {
            const data = await repo.loadAll();
            if (session !== activeSession) return;
            for (const song of data.songs || []) upsertSongLocal(song);
            for (const setlist of data.setlists || []) upsertSetlistLocal(setlist);
            for (const [name, member] of Object.entries(data.members || {})) upsertMemberLocal(name, member);
            if (data.config) setConfigLocal(data.config);
            if (data.bootstrap) setBootstrapLocal(data.bootstrap);
        } catch (_e) {
            // Cache read failed — the live sync events will fill things in.
        }
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
        // Address shape validation is webfinger.js's job — it knows the
        // full set of valid remoteStorage address forms (user@host,
        // bare host, IPs, single-label hostnames like `localhost`, etc.)
        // and surfaces real failures via the existing DiscoveryError
        // path. Duplicating that check here would just relitigate the
        // same rules with worse coverage. The empty-input guard above
        // stays because we don't want to send an empty string at all.
        const normalizedToken = normalizeAuthToken(token);
        connectionStatus = "connecting";
        loadError = "";
        syncStatusLabel = "Connecting to remoteStorage";
        armConnectingWatchdog();
        repo.connect(trimmed, normalizedToken);
    }

    /**
     * Sign out of the remote session and return to the login screen. The
     * account's local mirror and scoped localStorage are KEPT — this is
     * "switch away", not "remove my data from this device" (that's
     * forgetAccount). Keeping the mirror is what makes returning to the
     * account instant and offline-capable.
     */
    function disconnectStorage() {
        if (currentUserAddress) {
            saveKnownAccount(currentUserAddress, { bandName: appConfig?.bandName || "" }, repo.getToken());
        }
        activeSession += 1;
        deactivateAccount();
        repo.disconnect();
        // Don't wait for the `disconnected` event: rs.js can still report
        // connected=true while emitting it, which the handler's staleness
        // guard (rightly) skips. This is an explicit user action — the
        // status change is unconditional.
        connectionStatus = "disconnected";
        knownAccounts = getKnownAccounts();
    }

    /** Blank the in-memory state and detach the mirror (data stays on disk). */
    function deactivateAccount() {
        terminateWorker();
        isGenerating = false;
        try { mirror?.close(); } catch (_e) { /* already closed */ }
        mirror = null;
        try { localStorage.removeItem(ACTIVE_ACCOUNT_KEY); } catch (_e) { /* unavailable */ }
        currentUserAddress = "";
        hydrated = false;
        initialSyncDone = false;
        songs = [];
        appConfig = null;
        bootstrapMeta = null;
        clearGeneratedSetlist();
        setlistLocked = false;
        setlistSaved = false;
        savedSetlists = [];
        bandMembers = {};
        selectedSongId = "";
        editorSong = null;
        loadError = "";
        setSyncState("idle");
    }

    /**
     * Make `address` the active local account: open its mirror and hydrate
     * the UI from it. Pure local operation — no network, no remoteStorage.
     * The caller decides whether/how to establish the remote session.
     */
    async function activateAccount(address, session = activeSession) {
        currentUserAddress = address;
        connectAddress = address;
        hydrated = false;
        initialSyncDone = false;
        try { mirror?.close(); } catch (_e) { /* already closed */ }
        mirror = null;
        try { localStorage.setItem(ACTIVE_ACCOUNT_KEY, address); } catch (_e) { /* unavailable */ }

        let data = null;
        try {
            const db = await openAccountDb(address);
            if (session !== activeSession) {
                db.close();
                return;
            }
            mirror = db;
            data = await db.loadAll();
            if (session !== activeSession) return;
        } catch (error) {
            // IndexedDB unavailable (private browsing) or unreadable. Run
            // memory-only: the seed pass + live sync will fill the UI once
            // the remote session is up.
            if (import.meta.env?.DEV) {
                console.warn("[app] activateAccount: mirror unavailable", error);
            }
        }

        songs = sortSongs((data?.songs || []).map(normalizeSongRecord));
        appConfig = data?.config ? normalizeAppConfig(data.config) : null;
        savedSetlists = (data?.setlists || [])
            .map((s) => migrator.migrateDocument("setlists", s))
            .sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || ""));
        bandMembers = Object.fromEntries(
            Object.entries(data?.members || {}).map(([name, d]) => [name, normalizeMemberRecord(d)]),
        );
        bootstrapMeta = data?.bootstrap || null;
        initialSyncDone = !!data?.syncMeta?.initialSyncDone;
        loadUserLocalData();
        if (appConfig) {
            generationOptions = deepMerge(defaultGenerationOptions(appConfig), generationOptions || {});
        }
        hydrated = true;
    }

    /**
     * Switch to another known account. Local data appears instantly from
     * that account's mirror; the remote session is re-established in the
     * background. Works fully offline (the swap just fails quietly and the
     * dot shows disconnected).
     */
    async function connectToAccount(address) {
        if (connectionStatus === "connecting" || isSwitching) {
            toastWarn("Already connecting — hold on.");
            return;
        }
        if (!address) return;
        if (address === currentUserAddress && repo.isConnected()) return;

        isSwitching = true;
        try {
            // Persist the current account's metadata + token for the trip back.
            if (repo.isConnected() && currentUserAddress) {
                saveKnownAccount(currentUserAddress, { bandName: appConfig?.bandName || "" }, repo.getToken());
            }

            // New session: in-flight async from the previous account is stale.
            activeSession += 1;

            // Clear transient per-session state, then hydrate the target
            // account's local data for instant UI.
            clearGeneratedSetlist();
            setlistLocked = false;
            setlistSaved = false;
            pendingRollConfirm = false;
            selectedSongId = "";
            editorSong = null;
            // Enter "syncing" BEFORE the hydrate await: the old account's
            // transient "synced" state must not be observable against the
            // new account's address.
            setSyncState("syncing");
            syncStatusLabel = "Switching accounts";
            await activateAccount(address);

            connectionStatus = "connecting";
            armConnectingWatchdog();
            const savedToken = normalizeAuthToken(getAccountToken(address));
            if (repo.isConnected()) {
                await repo.swap(address, savedToken);
            } else {
                repo.connect(address, savedToken);
            }
            // The `connected` handler finishes the job (status, seed,
            // migrations). If the connection never lands, the user still has
            // the account's local data — nothing is stuck behind a spinner.
        } catch (error) {
            toastError(error?.message || "Could not switch accounts.");
            connectionStatus = repo.isConnected() ? "connected" : "disconnected";
            setSyncState("error");
        } finally {
            isSwitching = false;
        }
    }

    // Per-account localStorage bases owned by the app. Keep this list in sync
    // with anything that reads/writes via accountSlot(address).key(...).
    // "snapshot" is legacy (pre-v3 instant-swap blobs) — still cleared on
    // forget so upgraded installs don't leave old data behind.
    const PER_ACCOUNT_STORAGE_BASES = ["snapshot", "ui-options", "current-set", "saved-sets"];

    /**
     * Remove an account from this device: registry entry, auth token,
     * scoped localStorage, and its entire local mirror database.
     */
    function forgetAccount(address) {
        removeKnownAccountEntry(address);
        if (typeof localStorage !== "undefined") {
            const slot = accountSlot(address);
            for (const base of PER_ACCOUNT_STORAGE_BASES) {
                localStorage.removeItem(slot.key(base));
            }
        }
        if (address === currentUserAddress) {
            // Invalidate in-flight async work tied to the account being
            // forgotten, same as disconnectStorage().
            activeSession += 1;
            deactivateAccount();
        }
        void deleteAccountDb(address).catch(() => {});
        knownAccounts = getKnownAccounts();
    }

    async function finishFirstRun() {
        const bandName = firstRunBandName.trim();
        if (!bandName) {
            toastError("Your band needs a name.");
            return;
        }
        const sessionAlive = sessionGuard();
        try {
            busyMessage = "Setting up...";
            const config = await withSync("Setting up", () => repo.ensureConfig(bandName));
            if (!sessionAlive()) return;
            setConfigLocal(config);
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
        if (!displayedSetlist) return;
        pendingRollConfirm = false;
        const currentSongs = displayedSetlist.songs;
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
            generatedSetlist = leanFromGeneratorResult(result);
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

        // Only prune stale song references when the catalog is fully settled.
        // During initial sync or while bodies are still arriving, songsById is
        // incomplete; filtering against it would silently drop songs that exist
        // remotely but haven't loaded yet. When unsettled, we save the songs
        // verbatim — any truly-deleted entries will be pruned on the next save
        // once the catalog is stable.
        const persistedSongs = catalogSettled
            ? clone(generatedSetlist.songs.filter((e) => songsById.has(e.songId)))
            : clone(generatedSetlist.songs);

        const sessionAlive = sessionGuard();

        // If this setlist was loaded from a saved entry, update that entry in
        // place instead of creating a duplicate with a new id and name.
        if (loadedSavedId) {
            const existing = currentSaved.find((s) => s.id === loadedSavedId);
            if (existing) {
                await updateSavedSetlist(loadedSavedId, {
                    savedAt: nowIso(),
                    seed: generatedSetlist.seed,
                    minimumsRelaxed: !!generatedSetlist.minimumsRelaxed,
                    openerFilterRelaxed: !!generatedSetlist.openerFilterRelaxed,
                    closerFilterRelaxed: !!generatedSetlist.closerFilterRelaxed,
                    songs: persistedSongs,
                });
                if (!sessionAlive()) return;
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
            schemaVersion: 2,
            seed: generatedSetlist.seed,
            minimumsRelaxed: !!generatedSetlist.minimumsRelaxed,
            openerFilterRelaxed: !!generatedSetlist.openerFilterRelaxed,
            closerFilterRelaxed: !!generatedSetlist.closerFilterRelaxed,
            songs: persistedSongs,
        };
        try {
            const saved = await withSync("Saving setlist", () => repo.putSetlist(entry));
            if (!sessionAlive()) return;
            upsertSetlistLocal(saved);
            setlistSaved = true;
            loadedSavedId = entry.id;
        } catch (error) {
            toastError(error?.message || "Could not save setlist.");
        }
    }

    async function removeSavedSetlist(id) {
        const sessionAlive = sessionGuard();
        try {
            await withSync("Removing setlist", () => repo.deleteSetlist(id));
            if (!sessionAlive()) return;
            removeSetlistLocal(id);
        } catch (error) {
            toastError(error?.message || "Could not remove setlist.");
        }
    }

    async function updateSavedSetlist(id, fields) {
        const existing = savedSetlists.find((s) => s.id === id);
        if (!existing) return;
        const merged = { ...existing, ...fields };
        const sessionAlive = sessionGuard();
        try {
            const saved = await withSync("Updating setlist", () => repo.putSetlist(clone(merged)));
            if (!sessionAlive()) return;
            upsertSetlistLocal(saved);
        } catch (error) {
            toastError(error?.message || "Could not update setlist.");
        }
    }

    function loadSavedSetlist(id) {
        const saved = savedSetlists.find((s) => s.id === id);
        if (!saved) return;
        const all = (saved.songs || []).map((e) => ({ songId: e.songId, performance: e.performance || {} }));
        // Guard: only prune against songsById when the catalog is settled.
        // If the catalog is still loading, treat every entry as valid so
        // not-yet-pulled songs don't trigger a false "no longer in catalog" warn.
        const songs = catalogSettled ? all.filter((e) => songsById.has(e.songId)) : all;
        const dropped = catalogSettled ? all.length - songs.length : 0;
        if (catalogSettled && songs.length === 0) {
            // All songs were pruned — don't mark a saved set as loaded with an
            // empty lean list; that would let the next save clobber the document
            // with songs:[]. Clear instead, mirroring the pruning-effect path.
            clearGeneratedSetlist();
            setlistLocked = false;
            setlistSaved = false;
            persistCurrentSetlist();
        } else {
            generatedSetlist = {
                seed: saved.seed,
                minimumsRelaxed: !!saved.minimumsRelaxed,
                openerFilterRelaxed: !!saved.openerFilterRelaxed,
                closerFilterRelaxed: !!saved.closerFilterRelaxed,
                songs,
            };
            setlistLocked = true;
            setlistSaved = true;
            loadedSavedId = id;
            persistCurrentSetlist();
        }
        if (dropped > 0) {
            toastWarn(`Skipped ${dropped} song${dropped === 1 ? "" : "s"} no longer in your catalog.`);
        }
        if (songs.length > 0) {
            toastInfo(`Loaded ${songs.length}-song set.`);
        }
    }

    // Mutation helpers operate on the lean entries — no rescoring needed,
    // since `displayedSetlist` runs scoreFixedOrder() in its derivation
    // chain whenever the underlying data changes.
    //
    // Indices come from the UI, which iterates displayedSetlist.songs.
    // hydrateSetlist() filters out stale (deleted/not-yet-loaded) entries,
    // so the displayed index may not match the raw generatedSetlist index.
    // Resolve by songId to guarantee the right entry is mutated.
    function reorderSetlistSong(fromIndex, toIndex) {
        if (!generatedSetlist || !displayedSetlist) return;
        const fromSongId = displayedSetlist.songs[fromIndex]?.id;
        const toSongId   = displayedSetlist.songs[toIndex]?.id;
        if (!fromSongId || !toSongId) return;
        const rawFrom = generatedSetlist.songs.findIndex((e) => e.songId === fromSongId);
        const rawTo   = generatedSetlist.songs.findIndex((e) => e.songId === toSongId);
        if (rawFrom === -1 || rawTo === -1) return;
        const list = [...generatedSetlist.songs];
        const [moved] = list.splice(rawFrom, 1);
        list.splice(rawTo, 0, moved);
        generatedSetlist = { ...generatedSetlist, songs: list };
        setlistSaved = false;
        persistCurrentSetlist();
    }

    function removeSetlistSong(index) {
        if (!generatedSetlist || !displayedSetlist) return;
        const songId = displayedSetlist.songs[index]?.id;
        if (!songId) return;
        const rawIndex = generatedSetlist.songs.findIndex((e) => e.songId === songId);
        if (rawIndex === -1) return;
        const list = [...generatedSetlist.songs];
        list.splice(rawIndex, 1);
        if (!list.length) {
            clearGeneratedSetlist();
            setlistLocked = false;
            setlistSaved = false;
            persistCurrentSetlist();
            return;
        }
        generatedSetlist = { ...generatedSetlist, songs: list };
        setlistSaved = false;
        persistCurrentSetlist();
    }

    function addSetlistSong(songId) {
        if (!generatedSetlist) return;
        if (generatedSetlist.songs.some((s) => s.songId === songId)) return;
        const song = songsById.get(songId);
        if (!song) return;
        const performance = buildDefaultPerformance(song, generationOptions?.show || {});
        generatedSetlist = {
            ...generatedSetlist,
            songs: [...generatedSetlist.songs, { songId, performance }],
        };
        setlistSaved = false;
        persistCurrentSetlist();
    }

    let songsNotInSetlist = $derived.by(() => {
        if (!generatedSetlist?.songs) return songs.filter((s) => !s.unpracticed);
        const usedIds = new Set(generatedSetlist.songs.map((s) => s.songId));
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
        const sessionAlive = sessionGuard();
        try {
            busyMessage = `Saving "${editorSong.name}"...`;
            const saved = await withSync("Saving song", () => repo.putSong({
                ...editorSong, updatedAt: nowIso()
            }));
            if (!sessionAlive()) return;
            upsertSongLocal(saved);
            // No manual setlist sync needed: displayedSetlist re-derives from
            // the catalog automatically when `songs` changes.

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
                if (!sessionAlive()) return;
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
        const sessionAlive = sessionGuard();
        try {
            busyMessage = `Deleting "${song.name}"...`;
            await withSync("Removing song", () => repo.deleteSong(song.id));
            if (!sessionAlive()) return;
            removeSongLocal(song.id);
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
        const sessionAlive = sessionGuard();
        // Bail out cleanly if the user switches accounts mid-wipe: any
        // further deletes would run against the NEW account's storage paths.
        const abortIfSwitched = () => {
            if (!sessionAlive()) throw new Error("Deletion stopped — the account changed mid-way.");
        };
        try {
            busyMessage = "Deleting everything...";
            // Delete all songs from RS. List from the repo as well as memory
            // so songs that never made it into the in-memory catalog (e.g.
            // mid-first-sync) are still deleted.
            const { songs: listedSongs } = await repo.listSongs();
            const allSongIds = new Set([...songs.map((s) => s.id), ...listedSongs.map((s) => s.id)]);
            for (const id of allSongIds) {
                abortIfSwitched();
                await repo.deleteSong(id);
                void mirror?.deleteSong(id).catch(() => {});
            }
            // Delete all setlists from RS (list from remote to catch any beyond in-memory state)
            const { setlists: allSetlists } = await repo.listSetlists();
            for (const setlist of allSetlists) {
                abortIfSwitched();
                await repo.deleteSetlist(setlist.id);
                void mirror?.deleteSetlist(setlist.id).catch(() => {});
            }
            // Delete all members from RS (list from remote to catch any beyond in-memory state)
            const { members: allMembers } = await repo.listMembers();
            for (const name of Object.keys(allMembers)) {
                abortIfSwitched();
                await repo.deleteMember(name);
                void mirror?.deleteMember(name).catch(() => {});
            }
            // Delete config from RS so first-run triggers on reload
            abortIfSwitched();
            await repo.deleteConfig();
            if (!sessionAlive()) return;
            void mirror?.deleteKv("config").catch(() => {});
            void mirror?.deleteKv("bootstrap").catch(() => {});
            // Clear local state
            appConfig = null;
            songs = [];
            bootstrapMeta = null;
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
        if (field.type === "order-rule") {
            if (!Array.isArray(value) || !Array.isArray(field.rule) || field.rule.length < 2) return false;
            const ruleField = field.rule[0];
            const ruleValue = field.rule[1];
            return value.some((entry) => Array.isArray(entry) && entry.length >= 2 && entry[0] === ruleField && entry[1] === ruleValue);
        }
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
        else if (field.type === "order-rule") {
            if (!Array.isArray(field.rule) || field.rule.length < 2) return;
            const current = getByPath(appConfig, field.path) ?? [];
            const enabled = rawValue === "true" || rawValue === true;
            const ruleField = field.rule[0];
            const ruleValue = field.rule[1];
            const filtered = (Array.isArray(current) ? current : []).filter(
                (entry) => !(Array.isArray(entry) && entry.length >= 2 && entry[0] === ruleField && entry[1] === ruleValue),
            );
            appConfig = setByPath(appConfig, field.path, enabled ? [...filtered, [ruleField, ruleValue]] : filtered);
            return;
        }
        appConfig = setByPath(appConfig, field.path, next);
    }

    async function saveConfig() {
        if (!appConfig) return;
        const sessionAlive = sessionGuard();
        try {
            busyMessage = "Saving config...";
            const nextConfig = normalizeAppConfig({ ...clone(appConfig), updatedAt: nowIso() });
            const saved = await withSync("Saving settings", () => repo.putConfig(nextConfig));
            if (!sessionAlive()) return;
            setConfigLocal(saved);
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
        const sessionAlive = sessionGuard();
        appConfig = normalized;
        try {
            const saved = await withSync("Saving settings", () => repo.putConfig(normalized));
            if (!sessionAlive()) return false;
            setConfigLocal(saved);
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
        const previousMember = bandMembers?.[memberName];
        const sessionAlive = sessionGuard();
        bandMembers = { ...bandMembers, [memberName]: normalized };
        try {
            await withSync("Saving member", () => repo.putMember(memberName, normalized));
            if (!sessionAlive()) return false;
            void mirror?.putMember({ ...normalized, name: memberName }).catch(() => {});
            return true;
        } catch (error) {
            // Revert only our own key, and only if a newer edit hasn't already
            // replaced it, so a failed save can't clobber a concurrent successful
            // edit to this or another member. Post-switch the state was
            // blanked/re-hydrated wholesale — nothing of ours to revert.
            if (sessionAlive() && bandMembers?.[memberName] === normalized) {
                const next = { ...bandMembers };
                if (previousMember === undefined) delete next[memberName];
                else next[memberName] = previousMember;
                bandMembers = next;
            }
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

        const sessionAlive = sessionGuard();
        // Put the new key first so a failure leaves the original member
        // intact — songs that reference `oldName` still resolve, and we
        // bail out without touching local state.
        try {
            await withSync("Renaming member", () => repo.putMember(clean, data));
        } catch (error) {
            toastError(error?.message || "Could not rename member.");
            return;
        }
        if (!sessionAlive()) return;

        // Apply the local rename now: the new key exists remotely, so the
        // UI must switch over even if the follow-up delete fails. The
        // caller (BandScreen) moves `editingMemberName` to `clean` without
        // awaiting this function; without the local mutation here the
        // edit-view filter would match nothing and the pane would go blank.
        upsertMemberLocal(clean, data);
        removeMemberLocal(oldName);
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
        const sessionAlive = sessionGuard();
        try {
            await withSync("Removing member", () => repo.deleteMember(memberName));
            if (!sessionAlive()) return;
            removeMemberLocal(memberName);
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
            savedSetlists: clone(currentSaved),
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
                savedSetlists: Array.isArray(payload.savedSetlists)
                    ? payload.savedSetlists.map((s) => migrator.migrateDocument("setlists", s))
                    : null,
            };
        }
        if (payload?.general && payload.show && payload.props) {
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
        const sessionAlive = sessionGuard();
        const abortIfSwitched = () => {
            if (!sessionAlive()) throw new Error("Import stopped — the account changed mid-way.");
        };
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
                    const saved = await repo.putSong(s);
                    abortIfSwitched();
                    upsertSongLocal(saved); ws++;
                }
                if (imported.config && (importMode === "overwrite" || !appConfig)) {
                    const savedConfig = await repo.putConfig(imported.config);
                    abortIfSwitched();
                    setConfigLocal(savedConfig);
                }
                // Import members
                if (imported.bandMembers) {
                    for (const [name, data] of Object.entries(imported.bandMembers)) {
                        const savedMember = await repo.putMember(name, normalizeMemberRecord(data));
                        abortIfSwitched();
                        upsertMemberLocal(name, savedMember);
                    }
                }
                // Import setlists
                if (imported.savedSetlists && imported.savedSetlists.length > 0) {
                    for (const entry of imported.savedSetlists) {
                        const savedSetlist = await repo.putSetlist(migrator.migrateDocument("setlists", entry));
                        abortIfSwitched();
                        upsertSetlistLocal(savedSetlist);
                    }
                }
                const savedBootstrap = await repo.putBootstrapMeta({
                    source: "uploaded-json", payloadType: imported.payloadType, mode: importMode,
                    fileName: importFile?.name || null, importedSongs: ws
                });
                abortIfSwitched();
                setBootstrapLocal(savedBootstrap);
            });

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
    async function runMigrations() {
        const sessionAlive = sessionGuard();
        // Migrate config: read raw config to check for band.members before normalization strips them
        const rawConfig = await repo.getRawConfig();
        if (!sessionAlive()) return;
        if (rawConfig?.band?.members && Object.keys(rawConfig.band.members).length > 0) {
            // Extract members from old config and write only those not already migrated
            for (const [name, data] of Object.entries(rawConfig.band.members)) {
                if (!bandMembers[name]) {
                    const savedMember = await repo.putMember(name, normalizeMemberRecord(data));
                    if (!sessionAlive()) return;
                    upsertMemberLocal(name, savedMember);
                }
            }
            // Run rs-migrate on the raw config to strip band.members, then save
            const migratedConfig = migrator.migrateDocument("config", rawConfig);
            if (migratedConfig !== rawConfig) {
                const savedConfig = await repo.putConfig(migratedConfig);
                if (!sessionAlive()) return;
                setConfigLocal(savedConfig);
            }
        }

        // Migrate localStorage setlists to remoteStorage
        if (typeof localStorage !== "undefined") {
            const localKey = storageKey("saved-sets");
            const raw = localStorage.getItem(localKey);
            if (raw) {
                const localSets = tryParseJson(raw, []) || [];
                if (localSets.length > 0) {
                    // Normalize via rs-migrate before uploading
                    const remoteIds = new Set(savedSetlists.map((s) => s.id));
                    const toMigrate = localSets.filter((s) => !remoteIds.has(s.id));
                    for (const entry of toMigrate) {
                        const normalized = migrator.migrateDocument("setlists", entry);
                        const savedSetlist = await repo.putSetlist(normalized);
                        if (!sessionAlive()) return;
                        upsertSetlistLocal(savedSetlist);
                    }
                }
                localStorage.removeItem(localKey);
            }
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

        // One-time cleanup of pre-multi-account localStorage keys.
        clearUnscopedLocalStorage();

        // Local-first boot: hydrate the last active account's mirror
        // immediately. The UI is fully usable on local data while rs.js
        // initializes and re-establishes the remote session in parallel.
        let bootAddress = "";
        try {
            bootAddress = localStorage.getItem(ACTIVE_ACCOUNT_KEY) || "";
        } catch (_e) { /* storage unavailable */ }
        // Held so the connected handler can await an in-flight boot hydrate
        // for the SAME account instead of racing it.
        let pendingActivation = bootAddress ? activateAccount(bootAddress) : null;

        // Safety timeout in case RS never fires "connected" or "not-connected"
        // (e.g. library bug or feature loading hangs).
        const safetyTimer = setTimeout(() => {
            if (connectionStatus === "pending") {
                connectionStatus = "disconnected";
            }
        }, 10000);

        // RS fires "not-connected" after features load when there is no
        // stored token and no OAuth redirect params.
        const detachNotConnected = repo.on("not-connected", () => {
            clearTimeout(safetyTimer);
            if (connectionStatus !== "pending") return;
            // rs.js lost its own session but we still have an active local
            // account. If its token is in the registry, re-establish the
            // remote session silently; either way the local data stays up.
            const savedToken = bootAddress ? normalizeAuthToken(getAccountToken(bootAddress)) : undefined;
            if (bootAddress && savedToken) {
                connectionStatus = "connecting";
                armConnectingWatchdog();
                repo.connect(bootAddress, savedToken);
            } else {
                connectionStatus = "disconnected";
            }
        });

        const detachConnecting = repo.on("connecting", () => {
            syncStatusLabel = "Discovering remote storage";
        });
        const detachAuthing = repo.on("authing", () => {
            syncStatusLabel = "Waiting for authorization";
            // The user may be typing a password in the OAuth popup — give
            // this phase the long window.
            if (connectionStatus === "connecting") armConnectingWatchdog(AUTHING_TIMEOUT_MS);
        });
        const detachStandaloneRedirect = repo.on("standalone-auth-redirect", () => {
            syncStatusLabel = "Opening authorization";
        });

        const detachSyncDone = repo.on("sync-done", (event) => {
            // Quiescence detection: sync-done arms the settle timer, any
            // incoming remote change (below) cancels it. One quiet polling
            // interval after a completed round means the tree is in.
            if (event?.completed) armSettleTimer();
        });

        const detachConnected = repo.on("connected", async () => {
            clearTimeout(safetyTimer);
            cancelConnectingWatchdog();
            isSwitching = false;
            connectionStatus = "connected";
            loadError = "";
            const address = repo.getUserAddress() || connectAddress;
            if (pendingActivation) {
                await pendingActivation;
                pendingActivation = null;
            }
            let session = activeSession;
            if (address && address !== currentUserAddress) {
                // Cold connect or OAuth return — adopt the account locally.
                // (Swaps already activated the account before reconnecting.)
                activeSession += 1;
                session = activeSession;
                await activateAccount(address, session);
                if (session !== activeSession) return;
            }
            if (initialSyncDone) relaxSyncInterval();
            else tightenSyncInterval();
            setSyncState("syncing");
            syncStatusLabel = "Syncing";
            saveKnownAccount(currentUserAddress, { bandName: appConfig?.bandName || "" }, repo.getToken());
            knownAccounts = getKnownAccounts();
            // First sync of this account on this device: also adopt whatever
            // already sits in rs.js's own cache (pre-mirror builds), since
            // unchanged cached documents never re-fire change events.
            if (!initialSyncDone) void seedFromRepoCache(session);
            try {
                await runMigrations();
            } catch (err) {
                console.error("Migration failed:", err);
                toastError("Data migration encountered an error. Some data may need re-syncing.");
            }
        });

        const detachDisconnected = repo.on("disconnected", () => {
            // Nothing destructive happens on disconnect anymore — data wipes
            // are explicit (forgetAccount). Mid-swap, the old account's
            // disconnect is an intermediate step; and a "straggler"
            // disconnect can land even after the new account has connected
            // (repo.swap resolves via a safety timeout). Both must not
            // clobber the live connection status.
            if (isSwitching || repo.isConnected()) return;
            cancelConnectingWatchdog();
            connectionStatus = "disconnected";
            cancelSettleTimer();
            if (syncState !== "error") setSyncState("idle");
        });

        const detachError = repo.on("error", (error) => {
            loadError = error?.message || "remoteStorage error.";
            toastError(loadError);
            setSyncState("error");
            // Auth/discovery failures end the remote session — but local
            // data stays: the user may only need to re-authorize. Transient
            // errors (flaky network, 5xx) are left for rs.js to retry.
            const fatal = error?.name === "Unauthorized" || error?.name === "DiscoveryError";
            if (fatal) {
                isSwitching = false;
                cancelConnectingWatchdog();
                if (repo.isConnected()) repo.disconnect();
                // Set the status directly — the disconnected event may be
                // skipped by its staleness guard while rs.js still reports
                // connected mid-teardown.
                connectionStatus = "disconnected";
            }
        });

        const detachOffline = repo.on("network-offline", () => {
            cancelSettleTimer();
            if (syncState === "syncing" || syncState === "synced") setSyncState("idle");
            syncStatusLabel = "Offline";
        });
        const detachOnline = repo.on("network-online", () => {
            if (connectionStatus === "connected") {
                setSyncState("syncing");
                syncStatusLabel = "Syncing";
            }
        });

        // Apply remote/conflict changes incrementally — one document at a
        // time, straight into memory + mirror. Local-origin events are
        // echoes of our own optimistic writes (already applied); "window"
        // origin is disabled at the rs.js constructor.
        const detachChange = repo.onChange((event) => {
            if (event?.origin !== "remote" && event?.origin !== "conflict") return;
            if (!currentUserAddress) return;
            // Mid-swap, in-flight events can still belong to the OLD
            // account's aborted sync — never apply them to the new mirror.
            if (isSwitching) return;
            cancelSettleTimer();
            if (syncState !== "error") setSyncState("syncing");
            applyRemoteChange(event);
        });

        return () => {
            window.removeEventListener("hashchange", syncRouteFromHash);
            clearTimeout(safetyTimer);
            if (syncStateTimer) clearTimeout(syncStateTimer);
            cancelSettleTimer();
            cancelConnectingWatchdog();
            detachConnecting();
            detachAuthing();
            detachStandaloneRedirect();
            detachSyncDone();
            detachConnected();
            detachDisconnected();
            detachNotConnected();
            detachError();
            detachOffline();
            detachOnline();
            detachChange();
            try { mirror?.close(); } catch (_e) { /* already closed */ }
            mirror = null;
        };
    }

    return {
        // state (getters)
        get songs() { return songs; },


        get appConfig() { return appConfig; },
        get bandMembers() { return bandMembers; },
        get generatedSetlist() { return generatedSetlist; },
        get displayedSetlist() { return displayedSetlist; },
        get displayedSavedSetlists() { return displayedSavedSetlists; },
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
        get hydrated() { return hydrated; },
        get initialSyncDone() { return initialSyncDone; },
        get currentUserAddress() { return currentUserAddress; },
        get firstRunBandName() { return firstRunBandName; },
        set firstRunBandName(v) { firstRunBandName = v; },
        get syncStatusLabel() { return syncStatusLabel; },
        get syncActivelyRunning() { return syncActiveCount > 0; },
        get syncState() { return syncState; },
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
        toastAction,
        dismissToast,
        songsUsingMember,
        songsUsingInstrument,
        songsUsingTuning,
        songsUsingTechnique,

        // constants
        CONFIG_SECTIONS,
    };
}
