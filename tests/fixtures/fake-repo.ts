/**
 * In-memory fake remoteStorage repo, runs inside the browser via
 * `page.addInitScript`. Implements the same interface used by `createAppStore`
 * (see `src/lib/remotestorage.js`) but stores everything in memory and emits
 * lifecycle events synchronously / on microtask timing.
 *
 * Tests can pre-seed state by setting `window.__SR_FAKE_SEED__` before
 * navigating, and can drive the repo at runtime via `window.__SR_REPO__`.
 *
 * Two behaviors that mirror the real rs.js library so tests can exercise
 * full connect / swap / reload lifecycles:
 *   - Per-account data isolation. Each user address has its own in-memory
 *     bucket; switching accounts does not leak songs/config/etc.
 *   - Session persistence across page reloads. The connected user's address
 *     and token are written to localStorage on connect (under a fake-repo
 *     namespace), and the factory reads them back on construction, firing
 *     a synthetic `connected` event the way rs.js does. Without this the
 *     "refresh stays logged in" path was unreachable in tests.
 */

/**
 * Domain-shape aliases used throughout the seed data. We keep them open with
 * `[key: string]: unknown` because tests routinely seed partial / extended
 * shapes (e.g. anxiety summaries) without wanting the full app types.
 */
export type SeedSong = { id: string; name?: string; [key: string]: unknown };
export type SeedSetlist = { id: string; name?: string; [key: string]: unknown };
export type SeedMember = { name: string; [key: string]: unknown };
export type SeedConfig = { bandName?: string; [key: string]: unknown };
export type SeedBootstrap = { [key: string]: unknown };

export type SeedUserData = {
    songs?: Record<string, SeedSong>;
    setlists?: Record<string, SeedSetlist>;
    members?: Record<string, SeedMember>;
    config?: SeedConfig | null;
    bootstrap?: SeedBootstrap | null;
};

export type FakeRepoSeed = {
    /** When set, the repo boots in connected state with this user address */
    autoConnectAs?: string;
    /**
     * Per-user data buckets. The auto-connect user reads from `users[address]`
     * if present; otherwise from the top-level legacy fields below (kept for
     * backward compatibility with existing single-user tests).
     */
    users?: Record<string, SeedUserData>;
    songs?: Record<string, SeedSong>;
    setlists?: Record<string, SeedSetlist>;
    members?: Record<string, SeedMember>;
    config?: SeedConfig;
    bootstrap?: SeedBootstrap;
};

/**
 * The script that gets injected into the browser. We serialize this as a
 * string and run it via Playwright's addInitScript so that the fake repo is
 * available *before* the app's main bundle executes.
 */
export const FAKE_REPO_INIT_SCRIPT = `
(() => {
    if (window.__SR_FAKE_REPO_INSTALLED__) return;
    window.__SR_FAKE_REPO_INSTALLED__ = true;
    window.__SR_TEST__ = true;

    // localStorage keys used to persist the fake-repo session across reloads,
    // mirroring how the real rs.js writes its session into localStorage.
    const SESSION_USER_KEY = "__SR_FAKE_SESSION_USER__";
    const SESSION_TOKEN_KEY = "__SR_FAKE_SESSION_TOKEN__";

    function clone(value) { return JSON.parse(JSON.stringify(value)); }
    function nowIso() { return new Date().toISOString(); }

    function readSession() {
        try {
            const user = localStorage.getItem(SESSION_USER_KEY) || "";
            const token = localStorage.getItem(SESSION_TOKEN_KEY) || "";
            return user ? { user, token } : null;
        } catch { return null; }
    }
    function writeSession(user, token) {
        try {
            localStorage.setItem(SESSION_USER_KEY, user || "");
            localStorage.setItem(SESSION_TOKEN_KEY, token || "");
        } catch { /* ignore */ }
    }
    function clearSession() {
        try {
            localStorage.removeItem(SESSION_USER_KEY);
            localStorage.removeItem(SESSION_TOKEN_KEY);
        } catch { /* ignore */ }
    }

    function createFakeRepo() {
        const seed = window.__SR_FAKE_SEED__ || {};

        // Per-account in-memory data buckets so account swaps don't leak
        // data between users. We seed the auto-connect user's bucket from
        // either seed.users[addr] or (legacy) the top-level seed fields,
        // and lazy-create empty buckets for any other address that connects.
        const userBuckets = {};
        function emptyBucket() {
            return { songs: {}, setlists: {}, members: {}, config: null, bootstrap: null };
        }
        function ensureBucket(address) {
            if (!address) return emptyBucket();
            if (!userBuckets[address]) {
                const seeded = seed.users && seed.users[address];
                if (seeded) {
                    userBuckets[address] = {
                        songs: clone(seeded.songs || {}),
                        setlists: clone(seeded.setlists || {}),
                        members: clone(seeded.members || {}),
                        config: seeded.config ? clone(seeded.config) : null,
                        bootstrap: seeded.bootstrap ? clone(seeded.bootstrap) : null,
                    };
                } else {
                    userBuckets[address] = emptyBucket();
                }
            }
            return userBuckets[address];
        }

        // Legacy single-bucket seed: if the test set top-level songs/config/etc.
        // and an autoConnectAs, hydrate that user's bucket from those fields.
        if (seed.autoConnectAs && !(seed.users && seed.users[seed.autoConnectAs])) {
            userBuckets[seed.autoConnectAs] = {
                songs: clone(seed.songs || {}),
                setlists: clone(seed.setlists || {}),
                members: clone(seed.members || {}),
                config: seed.config ? clone(seed.config) : null,
                bootstrap: seed.bootstrap ? clone(seed.bootstrap) : null,
            };
        }

        let connected = false;
        let userAddress = "";
        let token = "";
        let syncIntervalMs = 10000;

        // Currently-active data bucket — points at userBuckets[userAddress]
        // when connected. Reads/writes go through this so they always hit
        // the connected user.
        let data = emptyBucket();

        const listeners = new Map();
        const changeListeners = new Set();

        function emit(eventName, payload) {
            const handlers = listeners.get(eventName);
            if (!handlers) return;
            for (const handler of Array.from(handlers)) {
                try { handler(payload); } catch (e) { console.error("fake-repo listener", eventName, e); }
            }
        }

        // Async-emit on the microtask queue so listeners registered after the
        // event already fired don't miss it (the real rs.js fires events
        // asynchronously after construction too).
        function emitAsync(eventName, payload) {
            queueMicrotask(() => emit(eventName, payload));
        }

        function emitChange(payload) {
            for (const handler of Array.from(changeListeners)) {
                try { handler(payload); } catch (e) { console.error("fake-repo change", e); }
            }
        }

        // Helper to notify the store that data changed so it triggers reload.
        function notifyChange(path, oldValue, newValue) {
            emitChange({
                origin: "remote",
                path,
                oldValue,
                newValue,
                relativePath: path,
            });
        }

        function activateUser(addr, tok) {
            userAddress = String(addr || "").trim();
            token = tok || "";
            data = ensureBucket(userAddress);
            connected = true;
        }

        const repo = {
            // Public test helpers — not part of the production interface.
            __isFake: true,
            __buckets: userBuckets,

            connect(addr, tok) {
                activateUser(addr, tok);
                writeSession(userAddress, token);
                emitAsync("connecting");
                emitAsync("connected");
                emitAsync("sync-done", { completed: true });
            },

            disconnect() {
                connected = false;
                userAddress = "";
                token = "";
                data = emptyBucket();
                clearSession();
                emitAsync("disconnected");
            },

            async swap(addr, tok) {
                if (connected) {
                    connected = false;
                    emit("disconnected");
                }
                activateUser(addr, tok);
                writeSession(userAddress, token);
                emitAsync("connecting");
                emitAsync("connected");
                emitAsync("sync-done", { completed: true });
            },

            async sync() {
                emitAsync("sync-started");
                emitAsync("sync-done", { completed: true });
            },

            syncAndWait() {
                return Promise.resolve();
            },

            getSyncInterval() { return syncIntervalMs; },
            setSyncInterval(ms) { syncIntervalMs = ms; },

            on(eventName, handler) {
                if (!listeners.has(eventName)) listeners.set(eventName, new Set());
                listeners.get(eventName).add(handler);
                return () => listeners.get(eventName)?.delete(handler);
            },

            onChange(handler) {
                changeListeners.add(handler);
                return () => changeListeners.delete(handler);
            },

            isConnected() { return connected; },
            getUserAddress() { return userAddress; },
            getToken() { return token; },

            async loadAll({ onStep } = {}) {
                onStep?.("Loading songs");
                const songsRes = await this.listSongs();
                onStep?.(\`Loaded \${songsRes.songs.length} songs\`);
                onStep?.("Loading settings");
                const config = await this.getConfig();
                onStep?.(config ? "Loaded settings" : "No settings found yet");
                onStep?.("Loading bootstrap info");
                const bootstrap = await this.getBootstrapMeta();
                onStep?.(bootstrap ? "Loaded bootstrap info" : "No bootstrap info found");
                onStep?.("Loading saved setlists");
                const setlistsRes = await this.listSetlists();
                onStep?.(\`Loaded \${setlistsRes.setlists.length} saved setlists\`);
                onStep?.("Loading band members");
                const membersRes = await this.listMembers();
                onStep?.(\`Loaded \${Object.keys(membersRes.members || {}).length} band members\`);

                return {
                    songs: songsRes.songs,
                    config,
                    bootstrap,
                    setlists: setlistsRes.setlists,
                    members: membersRes.members,
                    pendingBodies: 0,
                    errors: {},
                };
            },

            async listSongs() {
                const records = Object.values(data.songs).map((s) => clone(s));
                records.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
                return { songs: records, pending: 0 };
            },

            async putSong(song) {
                const next = clone({ ...song, updatedAt: nowIso() });
                data.songs[next.id] = next;
                notifyChange(\`songs/\${next.id}\`, null, next);
                return next;
            },

            async deleteSong(songId) {
                const old = data.songs[songId];
                delete data.songs[songId];
                notifyChange(\`songs/\${songId}\`, old, null);
            },

            async getConfig() {
                return data.config ? clone(data.config) : null;
            },

            async getRawConfig() {
                return data.config ? clone(data.config) : null;
            },

            async deleteConfig() {
                const old = data.config;
                data.config = null;
                notifyChange("settings/app-config", old, null);
            },

            async ensureConfig(bandName) {
                if (data.config) return clone(data.config);
                const cfg = {
                    bandName: bandName || "",
                    schemaVersion: 2,
                    createdAt: nowIso(),
                    updatedAt: nowIso(),
                    ui: { dieColor: null },
                };
                data.config = cfg;
                notifyChange("settings/app-config", null, cfg);
                return clone(cfg);
            },

            async putConfig(config) {
                const next = clone({ ...config, updatedAt: nowIso() });
                data.config = next;
                notifyChange("settings/app-config", null, next);
                return next;
            },

            async getBootstrapMeta() {
                return data.bootstrap ? clone(data.bootstrap) : null;
            },

            async putBootstrapMeta(meta) {
                const next = clone({ ...meta, updatedAt: nowIso() });
                data.bootstrap = next;
                notifyChange("meta/bootstrap", null, next);
                return next;
            },

            async listSetlists() {
                const records = Object.values(data.setlists).map((s) => clone(s));
                records.sort((a, b) => String(b.savedAt || "").localeCompare(String(a.savedAt || "")));
                return { setlists: records, pending: 0 };
            },

            async putSetlist(setlist) {
                const next = clone({ ...setlist, updatedAt: nowIso() });
                data.setlists[next.id] = next;
                notifyChange(\`setlists/\${next.id}\`, null, next);
                return next;
            },

            async deleteSetlist(setlistId) {
                const old = data.setlists[setlistId];
                delete data.setlists[setlistId];
                notifyChange(\`setlists/\${setlistId}\`, old, null);
            },

            async listMembers() {
                const out = {};
                for (const [name, value] of Object.entries(data.members)) {
                    out[name] = clone(value);
                }
                return { members: out, pending: 0 };
            },

            async putMember(name, doc) {
                const next = clone({ ...doc, name, updatedAt: nowIso() });
                data.members[name] = next;
                notifyChange(\`members/\${name}\`, null, next);
                return next;
            },

            async deleteMember(name) {
                const old = data.members[name];
                delete data.members[name];
                notifyChange(\`members/\${name}\`, old, null);
            },
        };

        // Boot path. Order of precedence:
        //   1. Persisted fake-repo session in localStorage — this user was
        //      already connected on the previous page load. Restore them
        //      transparently so reload-stays-logged-in works in tests.
        //   2. seed.autoConnectAs — explicit test seed for cold-boot
        //      auto-connect.
        //   3. Otherwise fire "not-connected" so the app shows the connect
        //      screen.
        const persistedSession = readSession();
        if (persistedSession) {
            // Make sure the bucket exists so listSongs/etc. don't blow up.
            ensureBucket(persistedSession.user);
            try {
                const KNOWN_ACCOUNTS_KEY = "setlist-roller-known-accounts";
                const existing = JSON.parse(localStorage.getItem(KNOWN_ACCOUNTS_KEY) || "[]");
                if (!existing.find((a) => a.address === persistedSession.user)) {
                    existing.push({
                        address: persistedSession.user,
                        metadata: { bandName: userBuckets[persistedSession.user]?.config?.bandName || "" },
                        token: persistedSession.token || "",
                        lastUsed: nowIso(),
                    });
                    localStorage.setItem(KNOWN_ACCOUNTS_KEY, JSON.stringify(existing));
                }
            } catch { /* ignore */ }
            setTimeout(() => {
                activateUser(persistedSession.user, persistedSession.token);
                emit("connecting");
                emit("connected");
                emit("sync-done", { completed: true });
            }, 0);
        } else if (seed.autoConnectAs) {
            // Seed the accounts list so the app sees a "known" account.
            try {
                const KNOWN_ACCOUNTS_KEY = "setlist-roller-known-accounts";
                const existing = JSON.parse(localStorage.getItem(KNOWN_ACCOUNTS_KEY) || "[]");
                const has = existing.find((a) => a.address === seed.autoConnectAs);
                if (!has) {
                    const seededBucket = userBuckets[seed.autoConnectAs];
                    existing.push({
                        address: seed.autoConnectAs,
                        metadata: { bandName: seededBucket?.config?.bandName || "" },
                        token: "fake-token",
                        lastUsed: nowIso(),
                    });
                    localStorage.setItem(KNOWN_ACCOUNTS_KEY, JSON.stringify(existing));
                }
            } catch (e) { /* ignore */ }

            // Trigger the same lifecycle the real repo would on a saved-token
            // reconnect. Wrapped in setTimeout so any listeners registered by
            // the store after construction are in place before events fire.
            setTimeout(() => {
                activateUser(seed.autoConnectAs, "fake-token");
                writeSession(userAddress, token);
                emit("connecting");
                emit("connected");
                emit("sync-done", { completed: true });
            }, 0);
        } else {
            // No saved token / cold boot: the real rs.js fires "not-connected"
            // after features finish loading. Without this, the store stays in
            // its initial "pending" state until the 10s safety timeout hits
            // and the user sees a blank page during tests.
            setTimeout(() => emit("not-connected"), 0);
        }

        return repo;
    }

    window.__SR_TEST_REPO_FACTORY__ = createFakeRepo;
})();
`;

// Helper for tests to seed data via init-script before the app boots.
export function buildSeedScript(seed: FakeRepoSeed): string {
    return `window.__SR_FAKE_SEED__ = ${JSON.stringify(seed)};`;
}
