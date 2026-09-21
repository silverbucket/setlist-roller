import { normalizeAppConfig, normalizeMemberRecord, normalizeSongRecord, sortSongs } from "../defaults.js";
import { pruneStaleKeys, sortKeys } from "../keys.js";
import { migrator } from "../migrations.js";
import { deepMerge } from "../utils.js";

// Catalog documents, filtered views, and the shared local mirror write path.
export function createCatalogStore(stores) {
    // ---- core state ----
    let songs = $state([]);
    let appConfig = $state(null);
    let bootstrapMeta = $state(null);
    let savedSetlists = $state([]);
    let bandMembers = $state({});
    let songSearch = $state("");
    let songFilter = $state("all");
    let songKeyFilters = $state(new Set());
    let visibleSongs = $derived(computeVisibleSongs());
    let usedKeys = $derived(
        sortKeys([...new Set(songs.map((s) => s.key).filter(Boolean))]),
    );

    $effect(() => {
        const pruned = pruneStaleKeys(songKeyFilters, usedKeys);
        if (pruned) songKeyFilters = pruned;
    });

    // A song is incomplete only when one of its explicit overrides is
    // broken (an instrument row without a name). Members without an
    // override simply inherit their default rig — absence is the normal,
    // zero-effort state, not an error.
    function songIncompleteReasons(song) {
        const reasons = [];
        for (const [name, setup] of Object.entries(song.members || {})) {
            for (const inst of setup?.instruments || []) {
                if (!inst.name) {
                    reasons.push(`${name}: pick an instrument`);
                    break;
                }
            }
        }
        return reasons;
    }

    function isSongIncomplete(song) {
        return songIncompleteReasons(song).length > 0;
    }

    function toggleKeyFilter(key) {
        const next = new Set(songKeyFilters);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        songKeyFilters = next;
    }

    function clearKeyFilters() { songKeyFilters = new Set(); }

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

    /**
     * Catalog lookup table keyed by song id.
     * Recomputes whenever `songs` changes, which is what makes the displayed
     * setlists below auto-refresh on RS pulls and local edits — no manual
     * sync paths required.
     */
    let songsById = $derived(new Map((songs || []).map((s) => [s.id, s])));

    // ---- local catalog mutation ----
    // Single write path for every accepted document, whether it arrived from
    // a remote sync event, the one-time cache seed, or a local edit: update
    // the in-memory state and mirror it to the per-account IndexedDB. All
    // helpers take plain (non-$state) objects.
    function upsertSongLocal(doc) {
        const song = normalizeSongRecord(doc);
        void stores.accounts.mirror?.putSong(song).catch(() => {});
        songs = sortSongs(songs.filter((s) => s.id !== song.id).concat(song));
    }

    function removeSongLocal(id) {
        void stores.accounts.mirror?.deleteSong(id).catch(() => {});
        songs = songs.filter((s) => s.id !== id);
    }

    function upsertSetlistLocal(doc) {
        const setlist = migrator.migrateDocument("setlists", doc);
        void stores.accounts.mirror?.putSetlist(setlist).catch(() => {});
        savedSetlists = savedSetlists
            .filter((s) => s.id !== setlist.id)
            .concat(setlist)
            .sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || ""));
    }

    function removeSetlistLocal(id) {
        void stores.accounts.mirror?.deleteSetlist(id).catch(() => {});
        savedSetlists = savedSetlists.filter((s) => s.id !== id);
        if (stores.generation.loadedSavedId === id) stores.generation.loadedSavedId = "";
    }

    function upsertMemberLocal(name, doc) {
        const member = normalizeMemberRecord(doc);
        void stores.accounts.mirror?.putMember({ ...member, name }).catch(() => {});
        bandMembers = { ...bandMembers, [name]: member };
    }

    function removeMemberLocal(name) {
        void stores.accounts.mirror?.deleteMember(name).catch(() => {});
        const next = { ...bandMembers };
        delete next[name];
        bandMembers = next;
    }

    function setConfigLocal(config) {
        if (config) {
            const normalized = normalizeAppConfig(config);
            void stores.accounts.mirror?.putKv("config", normalized).catch(() => {});
            appConfig = normalized;
            stores.generation.generationOptions = deepMerge(stores.generation.defaultGenerationOptions(normalized), stores.generation.generationOptions || {});
            stores.accounts.rememberBandName(normalized.bandName);
        } else {
            void stores.accounts.mirror?.deleteKv("config").catch(() => {});
            appConfig = null;
        }
    }

    function setBootstrapLocal(meta) {
        if (meta) {
            void stores.accounts.mirror?.putKv("bootstrap", meta).catch(() => {});
            bootstrapMeta = meta;
        } else {
            void stores.accounts.mirror?.deleteKv("bootstrap").catch(() => {});
            bootstrapMeta = null;
        }
    }

    return {
        get appConfig() { return appConfig; },
        set appConfig(value) { appConfig = value; },
        get songs() { return songs; },
        set songs(value) { songs = value; },
        get bandMembers() { return bandMembers; },
        set bandMembers(value) { bandMembers = value; },
        get songsById() { return songsById; },
        get savedSetlists() { return savedSetlists; },
        set savedSetlists(value) { savedSetlists = value; },
        removeSongLocal,
        removeSetlistLocal,
        removeMemberLocal,
        setConfigLocal,
        upsertSongLocal,
        upsertSetlistLocal,
        upsertMemberLocal,
        setBootstrapLocal,
        get bootstrapMeta() { return bootstrapMeta; },
        set bootstrapMeta(value) { bootstrapMeta = value; },
        get songSearch() { return songSearch; },
        set songSearch(value) { songSearch = value; },
        get songFilter() { return songFilter; },
        set songFilter(value) { songFilter = value; },
        toggleKeyFilter,
        clearKeyFilters,
        get songKeyFilters() { return songKeyFilters; },
        get usedKeys() { return usedKeys; },
        get visibleSongs() { return visibleSongs; },
        isSongIncomplete,
        songIncompleteReasons,
    };
}
