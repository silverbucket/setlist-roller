import { CONFIG_SECTIONS } from "../config-meta.js";
import { DEFAULT_APP_CONFIG, resolveSongMembers } from "../defaults.js";
import { buildDefaultPerformance, scoreFixedOrder } from "../generator.js";
import GeneratorWorker from "../generator.worker.js?worker";
import { clone, deepMerge, getByPath, nowIso, randomFrom, setByPath, titleForBand, tryParseJson, uid } from "../utils.js";
import { createAccountsStore } from "./accounts.svelte.js";
import { createBandStore } from "./band.svelte.js";
import { createCatalogStore } from "./catalog.svelte.js";
import { createConnectionStore } from "./connection.svelte.js";
import { createDataIoStore } from "./data-io.svelte.js";
import { createSongEditorStore } from "./song-editor.svelte.js";
import { createUiStore } from "./ui.svelte.js";

export { normalizeAuthToken } from "./connection.svelte.js";

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
//   _extendMode / _extendExistingSongs / _ignoreCurrentPins — One-generation
//                extension context. These select append vs full optimization,
//                carry the lean prefix, and keep existing pins out of the
//                additions-only selection pass. Stripped before worker dispatch.
//
// Adding a new `_*` flag? Make sure (a) it's stripped before any upload to
// remoteStorage, and (b) the lifetime is bounded — long-lived ephemeral flags
// silently accumulate on the object and turn into permanent state.

export function createAppStore(repo) {
    let generatedSetlist = $state(null);
    // Songs explicitly chosen before the first roll. Once a roll completes,
    // pin state moves onto the lean setlist entries so positions can be kept.
    let preRollPinnedIds = $state([]);
    let isGenerating = $state(false);
    let activeWorker = null;
    let generationId = 0;
    let setlistLocked = $state(false);
    let setlistSaved = $state(false);
    // Id of the saved setlist currently loaded into generatedSetlist, if any.
    // Used to update-in-place instead of duplicating when the user re-saves.
    let loadedSavedId = $state("");
    let pendingRollConfirm = $state(false);

    // ---- generation options (loaded properly on connect via loadUserLocalData) ----
    let generationOptions = $state(defaultGenerationOptions(DEFAULT_APP_CONFIG));

    // Private dependency registry. Getters avoid snapshots of rune-backed state
    // and allow mutually dependent actions without creating module singletons.
    const stores = {
        get accounts() { return accounts; },
        get catalog() { return catalog; },
        get band() { return band; },
        get songEditor() { return songEditor; },
        get connection() { return connection; },
        get ui() { return ui; },
        get dataIo() { return dataIo; },
        generation: {
            get generationOptions() { return generationOptions; },
            set generationOptions(value) { generationOptions = value; },
            get loadedSavedId() { return loadedSavedId; },
            set loadedSavedId(value) { loadedSavedId = value; },
            defaultGenerationOptions,
            terminateWorker,
            get isGenerating() { return isGenerating; },
            set isGenerating(value) { isGenerating = value; },
            clearGeneratedSetlist,
            get setlistLocked() { return setlistLocked; },
            set setlistLocked(value) { setlistLocked = value; },
            get setlistSaved() { return setlistSaved; },
            set setlistSaved(value) { setlistSaved = value; },
            loadUserLocalData,
            get pendingRollConfirm() { return pendingRollConfirm; },
            set pendingRollConfirm(value) { pendingRollConfirm = value; },
            persistGenerationOptions,
            persistCurrentSetlist,
        },
    };
    const accounts = createAccountsStore(repo, stores);
    const ui = createUiStore();
    const catalog = createCatalogStore(stores);
    const band = createBandStore(repo, stores);
    const songEditor = createSongEditorStore(repo, stores);
    const connection = createConnectionStore(repo, stores);
    const dataIo = createDataIoStore(repo, stores);

    // ---- derived ----
    let appTitle = $derived(titleForBand(catalog.appConfig?.bandName));
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
        connection.connectionStatus === "connected" && connection.initialSyncDone && accounts.hydrated && !catalog.appConfig,
    );
    let emptyCatalog = $derived(
        (connection.connectionStatus === "connected" || accounts.hydrated) && catalog.songs.length === 0,
    );

    // Once the catalog is fully settled, reconcile any stale song refs that
    // were deferred during the initial sync (or pruned any time a song is
    // deleted mid-session while a setlist is active). Runs whenever
    // catalogSettled, generatedSetlist, or songsById changes — safe because
    // a second run after the mutation finds dropped===0 and exits.
    $effect(() => {
        if (!connection.catalogSettled || !generatedSetlist) return;
        const valid = generatedSetlist.songs.filter((e) => catalog.songsById.has(e.songId));
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
        ui.toastWarn(`Removed ${dropped} song${dropped === 1 ? "" : "s"} no longer in your catalog.`);
    });

    // ---- helpers ----

    function defaultGenerationOptions(config = catalog.appConfig) {
        const source = config || DEFAULT_APP_CONFIG;
        // Use ?? for numeric defaults: a user-set 0 (count, temperature, etc.)
        // would otherwise silently fall back to the default.
        return {
            count: source.general?.count ?? 15,
            beamWidth: source.general?.beamWidth ?? 20,
            maxCovers: source.general?.limits?.covers ?? -1,
            maxInstrumentals: source.general?.limits?.instrumentals ?? -1,
            keyFlow: false,
            includeUnpracticed: false,
            setShape: "build",
            songMix: "balanced",
            seed: "",
            show: {
                members: clone(source.show?.members || {})
            }
        };
    }

    function loadStoredGenerationOptions() {
        const fallback = defaultGenerationOptions(DEFAULT_APP_CONFIG);
        if (typeof localStorage === "undefined") return fallback;
        const stored = tryParseJson(localStorage.getItem(accounts.storageKey("ui-options")), null);
        return stored ? deepMerge(fallback, migrateGenerationOptions(stored)) : fallback;
    }

    /**
     * Options saved by older builds carried knobs that no longer exist. Keep
     * what still maps (the old "rotation" is today's song mix) and drop the
     * rest so they don't linger in storage forever.
     */
    function migrateGenerationOptions(stored) {
        const { rotation, transitionSmoothness, selectionVariety, randomness, ...rest } = stored || {};
        if (rest.songMix === undefined && rotation) rest.songMix = rotation;
        return rest;
    }

    function persistGenerationOptions() {
        if (typeof localStorage === "undefined") return;
        localStorage.setItem(accounts.storageKey("ui-options"), JSON.stringify(generationOptions));
    }

    /** Reset the active generated setlist and clear any loaded-saved reference. */
    function clearGeneratedSetlist() {
        generatedSetlist = null;
        loadedSavedId = "";
    }

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
            const song = catalog.songsById.get(entry.songId);
            if (song) fat.push({ ...song, performance: entry.performance || {}, pinned: !!entry.pinned });
        }
        const scored = scoreFixedOrder(fat, catalog.appConfig || DEFAULT_APP_CONFIG, {
            keyFlow: generationOptions?.keyFlow,
            show: generationOptions?.show,
        });
        const pinnedIds = new Set(fat.filter((song) => song.pinned).map((song) => song.id));
        return {
            ...setlist,
            songs: scored.songs.map((song) => ({ ...song, pinned: pinnedIds.has(song.id) })),
            summary: {
                ...scored.summary,
                minimumsRelaxed: !!setlist.minimumsRelaxed,
                openerFilterRelaxed: !!setlist.openerFilterRelaxed,
                closerFilterRelaxed: !!setlist.closerFilterRelaxed,
            },
        };
    }

    let displayedSetlist = $derived(hydrateSetlist(generatedSetlist));
    let displayedSavedSetlists = $derived((catalog.savedSetlists || []).map(hydrateSetlist));

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
                pinned: !!s.pinned,
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
            pinned: !!s.pinned,
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
        const raw = tryParseJson(localStorage.getItem(accounts.storageKey("current-set")), null);
        return normalizeLeanSetlist(raw);
    }

    function persistCurrentSetlist() {
        if (typeof localStorage === "undefined") return;
        if (generatedSetlist) {
            localStorage.setItem(accounts.storageKey("current-set"), JSON.stringify({ ...generatedSetlist, _locked: setlistLocked }));
        } else {
            localStorage.removeItem(accounts.storageKey("current-set"));
        }
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
            preRollPinnedIds = [];
            setlistLocked = current._locked || false;
        } else {
            clearGeneratedSetlist();
            preRollPinnedIds = [];
            setlistLocked = false;
        }
        setlistSaved = false;
        generationOptions = loadStoredGenerationOptions();
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
        generatedSetlist = generatedSetlist
            ? { ...generatedSetlist, songs: generatedSetlist.songs.map((entry) => ({ ...entry, pinned: false })) }
            : null;
        preRollPinnedIds = [];
        generate({ _clearPins: true });
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
        if (!catalog.songs.length) {
            ui.toastError("Can't roll with no songs! Add a few first.");
            ui.navigate("songs");
            return;
        }
        // Unpracticed songs stay out of the pool unless the user opted in —
        // but songs explicitly pinned by "Optimize Order" (fixedSongIds)
        // always stay in, or the optimize pass would silently drop them.
        const currentPins = overrideOptions._clearPins || overrideOptions._ignoreCurrentPins
            ? []
            : (generatedSetlist?.songs || [])
                  .map((entry, index) => (entry.pinned ? { id: entry.songId, position: index + 1 } : null))
                  .filter(Boolean);
        const queuedPins = overrideOptions._clearPins
            ? []
            : preRollPinnedIds.map((id) => ({ id, position: null }));
        const pinsForRoll = [...currentPins, ...(overrideOptions.fixedSongIds ? [] : queuedPins)];
        const fixedIds = new Set([...(overrideOptions.fixedSongIds || []), ...pinsForRoll.map((pin) => pin.id)]);
        const eligibleSongs = catalog.songs.filter(
            (s) => generationOptions.includeUnpracticed || !s.unpracticed || fixedIds.has(s.id),
        );
        if (!eligibleSongs.length) {
            ui.toastError("Every song is unpracticed. Time to rehearse!");
            return;
        }
        const requestedCount = Number.parseInt(overrideOptions.count ?? generationOptions.count, 10);
        if (
            !overrideOptions.fixedSongIds &&
            Number.isFinite(requestedCount) &&
            requestedCount > eligibleSongs.length &&
            eligibleSongs.length < catalog.songs.length
        ) {
            const excludedCount = catalog.songs.length - eligibleSongs.length;
            ui.toastWarn(
                `Only ${eligibleSongs.length} songs are eligible. Enable “Allow unpracticed” to include the other ${excludedCount}.`,
            );
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
        const thisSession = accounts.activeSession;
        const opts = clone(generationOptions);
        Object.assign(opts, overrideOptions);
        const extendMode = opts._extendMode || "";
        const extendExistingSongs = clone(opts._extendExistingSongs || []);
        delete opts._clearPins;
        delete opts._ignoreCurrentPins;
        delete opts._extendMode;
        delete opts._extendExistingSongs;
        if (pinsForRoll.length) {
            opts.pinnedSongs = pinsForRoll;
            const lastPinnedPosition = Math.max(0, ...currentPins.map((pin) => pin.position));
            opts.count = Math.max(opts.count, pinsForRoll.length, lastPinnedPosition);
        }

        const worker = new GeneratorWorker();
        activeWorker = worker;
        worker.postMessage({
            // The generator works on effective setups: explicit song
            // overrides where they exist, each member's default rig
            // everywhere else. Songs themselves only store deviations.
            songs: clone(eligibleSongs).map((s) => ({ ...s, members: resolveSongMembers(s, catalog.bandMembers) })),
            config: clone(catalog.appConfig || DEFAULT_APP_CONFIG),
            options: opts
        });
        worker.onmessage = (event) => {
            const { type, result } = event.data;
            if (type !== "done") return;
            worker.terminate();
            if (worker === activeWorker) activeWorker = null;
            // Ignore stale results from a previous generation, an account
            // swap, or a disconnected session.
            if (thisGenId !== generationId || thisSession !== accounts.activeSession || !accounts.currentUserAddress) {
                isGenerating = false;
                return;
            }
            isGenerating = false;
            if (!result) {
                ui.toastError(randomFrom([
                    "The generator tripped over a cable.",
                    "Something went sideways. Blame the bassist.",
                    "Critical fumble — try again?",
                ]));
                return;
            }
            const pinnedIds = new Set(pinsForRoll.map((pin) => pin.id));
            const lean = leanFromGeneratorResult(result);
            if (extendMode === "optimize") {
                const combinedIds = [...extendExistingSongs.map((entry) => entry.songId), ...lean.songs.map((entry) => entry.songId)];
                const combinedCatalogSongs = combinedIds.map((id) => catalog.songsById.get(id)).filter(Boolean);
                const combinedCovers = combinedCatalogSongs.filter((song) => song.cover).length;
                const combinedInstrumentals = combinedCatalogSongs.filter((song) => song.instrumental).length;
                isGenerating = false;
                generate({
                    fixedSongIds: combinedIds,
                    count: combinedIds.length,
                    excludedSongIds: [],
                    maxCovers: Math.max(combinedCovers, generationOptions.maxCovers),
                    maxInstrumentals: Math.max(combinedInstrumentals, generationOptions.maxInstrumentals),
                    _keepLock: setlistLocked,
                });
                return;
            }
            if (extendMode === "append") {
                generatedSetlist = {
                    ...lean,
                    songs: [...extendExistingSongs, ...lean.songs],
                };
                setlistSaved = false;
                persistCurrentSetlist();
                ui.toastInfo(`Added ${lean.songs.length} song${lean.songs.length === 1 ? "" : "s"} to the set.`);
                return;
            }
            generatedSetlist = {
                ...lean,
                songs: lean.songs.map((entry) => ({ ...entry, pinned: pinnedIds.has(entry.songId) })),
            };
            preRollPinnedIds = [];
            if (opts._keepLock) {
                setlistSaved = false;
            } else {
                setlistLocked = false;
                setlistSaved = false;
            }
            persistCurrentSetlist();
            if (
                result.summary?.minimumsRelaxed ||
                !validateConstraintMinimums(result)
            ) {
                ui.toastWarn("Couldn't meet every demand, but it got close.");
            }
            if (result.summary?.openerFilterRelaxed) {
                ui.toastWarn("No valid opener found in catalog.");
            }
            if (result.summary?.closerFilterRelaxed) {
                ui.toastWarn("No valid closer found in catalog.");
            }
            if (result.summary?.keepApartRelaxed) {
                ui.toastWarn("Two songs you keep apart ended up together. No other order fit.");
            }
            const n = generatedSetlist.songs.length;
            ui.toastInfo(randomFrom([
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
            ui.toastError(randomFrom([
                "The generator tripped over a cable.",
                "Something went sideways. Blame the bassist.",
                "Critical fumble — try again?",
            ]));
        };
    }

    function extendSetlist(addCount, optimizeFullSet = false) {
        if (isGenerating || !generatedSetlist || !displayedSetlist) return;
        const existingSongs = clone(generatedSetlist.songs);
        const existingIds = new Set(existingSongs.map((entry) => entry.songId));
        const remainingSongs = catalog.songs.filter(
            (song) => !existingIds.has(song.id) && (generationOptions.includeUnpracticed || !song.unpracticed),
        );
        const requested = Math.max(1, Number.parseInt(addCount, 10) || 1);
        const count = Math.min(requested, remainingSongs.length);
        if (!count) {
            ui.toastWarn("Every available song is already in this set.");
            return;
        }
        if (count < requested) {
            ui.toastWarn(`Only ${count} song${count === 1 ? " is" : "s are"} available to add.`);
        }
        const currentSongs = displayedSetlist.songs;
        const currentCovers = currentSongs.filter((song) => song.cover).length;
        const currentInstrumentals = currentSongs.filter((song) => song.instrumental).length;
        const remainingLimit = (limit, used) => (limit < 0 ? -1 : Math.max(0, limit - used));
        // Appending: the first new song sits right after the current tail,
        // so hand the generator that tail for the keep-apart adjacency rule.
        // Catalog songs are reactive proxies; clone the list so it survives
        // the structured-clone into the worker (a raw proxy throws DataCloneError).
        const tail = optimizeFullSet ? null : catalog.songsById.get(existingSongs.at(-1)?.songId);
        generate({
            count,
            excludedSongIds: [...existingIds],
            precedingSong: tail ? { id: tail.id, keepApartFrom: clone(tail.keepApartFrom || []) } : undefined,
            maxCovers: remainingLimit(generationOptions.maxCovers, currentCovers),
            maxInstrumentals: remainingLimit(generationOptions.maxInstrumentals, currentInstrumentals),
            pinnedSongs: [],
            _ignoreCurrentPins: true,
            _extendMode: optimizeFullSet ? "optimize" : "append",
            _extendExistingSongs: existingSongs,
        });
    }

    function lockSetlist() {
        if (!generatedSetlist) return;
        if (setlistLocked) return;
        setlistLocked = true;
        persistCurrentSetlist();
        ui.toastInfo(randomFrom([
            "Setlist locked in. No take-backs.",
            "It's canon now.",
            "Sealed. This one's going on stage.",
        ]));
    }

    async function saveCurrentSetlist() {
        if (!generatedSetlist) return;
        const currentSaved = catalog.savedSetlists || [];

        // Only prune stale song references when the catalog is fully settled.
        // During initial sync or while bodies are still arriving, songsById is
        // incomplete; filtering against it would silently drop songs that exist
        // remotely but haven't loaded yet. When unsettled, we save the songs
        // verbatim — any truly-deleted entries will be pruned on the next save
        // once the catalog is stable.
        const currentSongs = connection.catalogSettled
            ? clone(generatedSetlist.songs.filter((e) => catalog.songsById.has(e.songId)))
            : clone(generatedSetlist.songs);
        // Pins are working-session state, not part of a saved historical set.
        const persistedSongs = currentSongs.map(({ pinned: _pinned, ...entry }) => entry);

        const sessionAlive = accounts.sessionGuard();

        // If this setlist was loaded from a saved entry, update that entry in
        // place instead of creating a duplicate with a new id and name.
        if (loadedSavedId) {
            const existing = currentSaved.find((s) => s.id === loadedSavedId);
            if (existing && !existing.performedAt) {
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
            // Saved entry no longer exists or became performed elsewhere —
            // fall through and create a fresh draft.
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
            "All Killer", "Last Call Legends", "The Loud Part",
            "Neon and Noise", "One More Song", "Worth the Ringing",
            "Stage Leftovers", "The Floor Is Shaking", "Crowd Control",
            "Amped Up", "Good Trouble", "Maximum Volume",
            "Lowered Expectations", "Barely Rehearsed", "This Seemed Easier",
            "Probably Fine", "Against Better Judgment", "The Wheels Are On",
            "Technical Difficulties", "Peak Mediocrity", "No One Asked",
            "A Series of Choices", "Here Goes Nothing", "Still Not Famous",
            "The Last Good Idea", "Diminishing Returns", "Read the Room",
            "Underqualified and Loud", "Everything Is Fine", "Career Limiting Move",
            "Our Apologies", "Dead Air Society",
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
            const saved = await connection.withSync("Saving setlist", () => repo.putSetlist(entry));
            if (!sessionAlive()) return;
            catalog.upsertSetlistLocal(saved);
            setlistSaved = true;
            loadedSavedId = entry.id;
        } catch (error) {
            ui.toastError(error?.message || "Could not save setlist.");
        }
    }

    async function removeSavedSetlist(id) {
        const sessionAlive = accounts.sessionGuard();
        try {
            await connection.withSync("Removing setlist", () => repo.deleteSetlist(id));
            if (!sessionAlive()) return false;
            catalog.removeSetlistLocal(id);
            return true;
        } catch (error) {
            ui.toastError(error?.message || "Could not remove setlist.");
            return false;
        }
    }

    async function updateSavedSetlist(id, fields) {
        const existing = catalog.savedSetlists.find((s) => s.id === id);
        if (!existing) return null;
        const merged = { ...existing, ...fields };
        const sessionAlive = accounts.sessionGuard();
        try {
            const saved = await connection.withSync("Updating setlist", () => repo.putSetlist(clone(merged)));
            if (!sessionAlive()) return null;
            catalog.upsertSetlistLocal(saved);
            return saved;
        } catch (error) {
            ui.toastError(error?.message || "Could not update setlist.");
            return null;
        }
    }

    async function markSetlistPerformed(id, performedAt, venue = null) {
        const existing = catalog.savedSetlists.find((s) => s.id === id);
        if (!existing || !performedAt) return null;
        const saved = await updateSavedSetlist(id, { performedAt, venue });
        if (saved) ui.toastInfo(`Marked "${existing.name || "Untitled Set"}" as performed.`);
        return saved;
    }

    async function moveSetlistToDrafts(id) {
        const existing = catalog.savedSetlists.find((s) => s.id === id);
        if (!existing) return null;
        const saved = await updateSavedSetlist(id, { performedAt: null });
        if (saved) ui.toastInfo(`Moved "${existing.name || "Untitled Set"}" to drafts.`);
        return saved;
    }

    function loadSavedSetlist(id) {
        const saved = catalog.savedSetlists.find((s) => s.id === id);
        if (!saved) return;
        const all = (saved.songs || []).map((e) => ({ songId: e.songId, performance: e.performance || {} }));
        // Guard: only prune against songsById when the catalog is settled.
        // If the catalog is still loading, treat every entry as valid so
        // not-yet-pulled songs don't trigger a false "no longer in catalog" warn.
        const songs = connection.catalogSettled ? all.filter((e) => catalog.songsById.has(e.songId)) : all;
        const dropped = connection.catalogSettled ? all.length - songs.length : 0;
        if (connection.catalogSettled && songs.length === 0) {
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
            // Performed sets are immutable history. Loading one starts a new
            // draft instead of linking future saves back to the performed copy.
            setlistSaved = !saved.performedAt;
            loadedSavedId = saved.performedAt ? "" : id;
            persistCurrentSetlist();
        }
        if (dropped > 0) {
            ui.toastWarn(`Skipped ${dropped} song${dropped === 1 ? "" : "s"} no longer in your catalog.`);
        }
        if (songs.length > 0) {
            ui.toastInfo(`Loaded ${songs.length}-song set.`);
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

    function setlistEntryForSong(song, pinned = true) {
        const performance = buildDefaultPerformance(
            { ...song, members: resolveSongMembers(song, catalog.bandMembers) },
            generationOptions?.show || {},
        );
        return { songId: song.id, performance, pinned };
    }

    function addSetlistSong(songId) {
        const song = catalog.songsById.get(songId);
        if (!song) return;

        // A manual set can start from an empty Roll screen. If songs were
        // already queued as pre-roll pins, carry them into the new list so
        // switching from "pin" to "build manually" never loses a choice.
        if (!generatedSetlist) {
            const queuedEntries = preRollPinnedIds
                .map((id) => catalog.songsById.get(id))
                .filter(Boolean)
                .map((queuedSong) => setlistEntryForSong(queuedSong));
            if (queuedEntries.some((entry) => entry.songId === songId)) return;
            generatedSetlist = {
                seed: generationOptions.seed || 0,
                songs: [...queuedEntries, setlistEntryForSong(song)],
            };
            preRollPinnedIds = [];
            loadedSavedId = "";
            setlistLocked = false;
            setlistSaved = false;
            persistCurrentSetlist();
            return;
        }

        if (generatedSetlist.songs.some((s) => s.songId === songId)) return;
        generatedSetlist = {
            ...generatedSetlist,
            songs: [...generatedSetlist.songs, setlistEntryForSong(song)],
        };
        setlistSaved = false;
        persistCurrentSetlist();
    }

    function clearCurrentSetlist() {
        if (!generatedSetlist && preRollPinnedIds.length === 0 && !isGenerating) return;
        terminateWorker();
        generationId += 1;
        isGenerating = false;
        clearGeneratedSetlist();
        preRollPinnedIds = [];
        setlistLocked = false;
        setlistSaved = false;
        pendingRollConfirm = false;
        persistCurrentSetlist();
    }

    function swapSetlistSong(index, replacementSongId) {
        if (!generatedSetlist || !displayedSetlist) return;
        if (generatedSetlist.songs.some((entry) => entry.songId === replacementSongId)) return;
        const currentSongId = displayedSetlist.songs[index]?.id;
        const replacement = catalog.songsById.get(replacementSongId);
        if (!currentSongId || !replacement) return;
        const rawIndex = generatedSetlist.songs.findIndex((entry) => entry.songId === currentSongId);
        if (rawIndex === -1) return;
        const performance = buildDefaultPerformance(
            { ...replacement, members: resolveSongMembers(replacement, catalog.bandMembers) },
            generationOptions?.show || {},
        );
        const list = [...generatedSetlist.songs];
        list[rawIndex] = {
            songId: replacementSongId,
            performance,
            pinned: true,
        };
        generatedSetlist = { ...generatedSetlist, songs: list };
        setlistSaved = false;
        persistCurrentSetlist();
    }

    function pinSongBeforeRoll(songId) {
        if (generatedSetlist || !catalog.songsById.has(songId) || preRollPinnedIds.includes(songId)) return;
        preRollPinnedIds = [...preRollPinnedIds, songId];
    }

    function unpinSongBeforeRoll(songId) {
        preRollPinnedIds = preRollPinnedIds.filter((id) => id !== songId);
    }

    function toggleSetlistSongPin(songId) {
        if (!generatedSetlist) return;
        generatedSetlist = {
            ...generatedSetlist,
            songs: generatedSetlist.songs.map((entry) =>
                entry.songId === songId ? { ...entry, pinned: !entry.pinned } : entry,
            ),
        };
        setlistSaved = false;
        persistCurrentSetlist();
    }

    let preRollPinnedSongs = $derived(preRollPinnedIds.map((id) => catalog.songsById.get(id)).filter(Boolean));
    let pinnedSongCount = $derived(
        preRollPinnedIds.length + (generatedSetlist?.songs || []).filter((entry) => entry.pinned).length,
    );

    // Unpracticed songs stay in this list on purpose: the roller won't pick
    // them, but the band can still add one to a set deliberately (the picker
    // marks them so it's a knowing choice).
    let songsNotInSetlist = $derived.by(() => {
        if (!generatedSetlist?.songs) return catalog.songs;
        const usedIds = new Set(generatedSetlist.songs.map((s) => s.songId));
        return catalog.songs.filter((s) => !usedIds.has(s.id));
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

    return {
        // state (getters)
        get songs() { return catalog.songs; },

        get appConfig() { return catalog.appConfig; },
        get bandMembers() { return catalog.bandMembers; },
        get generatedSetlist() { return generatedSetlist; },
        get preRollPinnedSongs() { return preRollPinnedSongs; },
        get pinnedSongCount() { return pinnedSongCount; },
        get displayedSetlist() { return displayedSetlist; },
        get displayedSavedSetlists() { return displayedSavedSetlists; },
        get isGenerating() { return isGenerating; },
        get setlistLocked() { return setlistLocked; },
        get setlistSaved() { return setlistSaved; },
        get pendingRollConfirm() { return pendingRollConfirm; },
        get savedSetlists() { return catalog.savedSetlists; },
        get connectionStatus() { return connection.connectionStatus; },
        get connectAddress() { return connection.connectAddress; },
        set connectAddress(v) { connection.connectAddress = v; },
        get activeView() { return ui.activeView; },
        get loadError() { return connection.loadError; },
        get busyMessage() { return ui.busyMessage; },
        get toastMessages() { return ui.toastMessages; },
        get showFirstRunPrompt() { return showFirstRunPrompt; },
        get hydrated() { return accounts.hydrated; },
        get initialSyncDone() { return connection.initialSyncDone; },
        get currentUserAddress() { return accounts.currentUserAddress; },
        get firstRunBandName() { return band.firstRunBandName; },
        set firstRunBandName(v) { band.firstRunBandName = v; },
        get syncStatusLabel() { return connection.syncStatusLabel; },
        get syncActivelyRunning() { return connection.syncActiveCount > 0; },
        get syncState() { return connection.syncState; },
        get generationOptions() { return generationOptions; },
        get editorSong() { return songEditor.editorSong; },
        get selectedSongId() { return songEditor.selectedSongId; },
        get songSearch() { return catalog.songSearch; },
        set songSearch(v) { catalog.songSearch = v; },
        get songFilter() { return catalog.songFilter; },
        set songFilter(v) { catalog.songFilter = v; },
        get songKeyFilters() { return catalog.songKeyFilters; },
        get usedKeys() { return catalog.usedKeys; },
        toggleKeyFilter: catalog.toggleKeyFilter,
        clearKeyFilters: catalog.clearKeyFilters,
        get expandedBandMember() { return band.expandedBandMember; },
        set expandedBandMember(v) { band.expandedBandMember = v; },
        get importMode() { return dataIo.importMode; },
        set importMode(v) { dataIo.importMode = v; },
        get importFile() { return dataIo.importFile; },
        set importFile(v) { dataIo.importFile = v; },

        get bandSubView() { return band.bandSubView; },
        set bandSubView(v) { band.bandSubView = v; },
        get editingMemberName() { return band.editingMemberName; },
        set editingMemberName(v) { band.editingMemberName = v; },

        // derived
        get appTitle() { return appTitle; },
        get emptyCatalog() { return emptyCatalog; },
        get bandMemberEntries() { return band.bandMemberEntries; },
        get availableMemberNames() { return band.availableMemberNames; },
        get memberInstrumentChoicesByMember() { return band.memberInstrumentChoicesByMember; },
        get memberTuningChoicesByMember() { return band.memberTuningChoicesByMember; },
        get defaultTuningByMemberInstrument() { return band.defaultTuningByMemberInstrument; },
        get allInstrumentNamesList() { return band.allInstrumentNamesList; },
        get instrumentTypeCount() { return band.instrumentTypeCount; },
        get visibleSongs() { return catalog.visibleSongs; },
        isSongIncomplete: catalog.isSongIncomplete,
        songIncompleteReasons: catalog.songIncompleteReasons,
        get incompleteSongCount() { return catalog.songs.filter((s) => catalog.isSongIncomplete(s)).length; },
        get unpracticedSongCount() { return catalog.songs.filter((s) => s.unpracticed).length; },

        // accounts
        get knownAccounts() { return accounts.knownAccounts; },
        connectToAccount: accounts.connectToAccount,
        forgetAccount: accounts.forgetAccount,

        // actions
        init: connection.init,
        navigate: ui.navigate,
        connectStorage: connection.connectStorage,
        disconnectStorage: accounts.disconnectStorage,
        finishFirstRun: band.finishFirstRun,
        requestRoll,
        extendSetlist,
        confirmFreshRoll,
        confirmOptimizeOrder,
        cancelRoll,
        lockSetlist,
        saveCurrentSetlist,
        removeSavedSetlist,
        updateSavedSetlist,
        markSetlistPerformed,
        moveSetlistToDrafts,
        loadSavedSetlist,
        reorderSetlistSong,
        removeSetlistSong,
        addSetlistSong,
        clearCurrentSetlist,
        swapSetlistSong,
        pinSongBeforeRoll,
        unpinSongBeforeRoll,
        toggleSetlistSongPin,
        get songsNotInSetlist() { return songsNotInSetlist; },
        updateGenerationField,
        toggleListValue,
        ensureMemberShowConfig,

        openNewSong: songEditor.openNewSong,
        openSong: songEditor.openSong,
        closeEditor: songEditor.closeEditor,
        stageVocabAdd: songEditor.stageVocabAdd,
        stagedInstrumentAdds: songEditor.stagedInstrumentAdds,
        stagedTuningAdds: songEditor.stagedTuningAdds,
        stagedTechniqueAdds: songEditor.stagedTechniqueAdds,
        get editorVocabAdds() { return songEditor.editorVocabAdds; },
        get editReturnView() { return songEditor.editReturnView; },
        set editReturnView(v) { songEditor.editReturnView = v; },
        updateSongField: songEditor.updateSongField,
        addMember: songEditor.addMember,
        removeMember: songEditor.removeMember,
        addInstrumentOption: songEditor.addInstrumentOption,
        removeInstrumentOption: songEditor.removeInstrumentOption,
        updateInstrumentOption: songEditor.updateInstrumentOption,
        saveSong: songEditor.saveSong,
        duplicateSong: songEditor.duplicateSong,
        deleteSong: songEditor.deleteSong,
        deleteAllData: dataIo.deleteAllData,
        configFieldValue: band.configFieldValue,
        updateConfigField: band.updateConfigField,
        saveConfig: band.saveConfig,
        addBandMember: band.addBandMember,
        renameBandMember: band.renameBandMember,
        removeBandMember: band.removeBandMember,
        addBandMemberInstrument: band.addBandMemberInstrument,
        removeBandMemberInstrument: band.removeBandMemberInstrument,
        addTuningChoice: band.addTuningChoice,
        removeTuningChoice: band.removeTuningChoice,
        setMemberDefaultInstrument: band.setMemberDefaultInstrument,
        setInstrumentDefaultTuning: band.setInstrumentDefaultTuning,
        addTechniqueChoice: band.addTechniqueChoice,
        removeTechniqueChoice: band.removeTechniqueChoice,
        setInstrumentDefaultTechnique: band.setInstrumentDefaultTechnique,
        exportAllData: dataIo.exportAllData,
        importFromFile: dataIo.importFromFile,
        performanceSummary: band.performanceSummary,
        toastInfo: ui.toastInfo,
        toastWarn: ui.toastWarn,
        toastError: ui.toastError,
        toastAction: ui.toastAction,
        dismissToast: ui.dismissToast,
        runToastAction: ui.runToastAction,
        get confirmRequest() { return ui.confirmRequest; },
        requestConfirm: ui.requestConfirm,
        resolveConfirm: ui.resolveConfirm,
        songsUsingMember: band.songsUsingMember,
        songsUsingInstrument: band.songsUsingInstrument,
        songsUsingTuning: band.songsUsingTuning,
        songsUsingTechnique: band.songsUsingTechnique,

        // constants
        CONFIG_SECTIONS,
    };
}
