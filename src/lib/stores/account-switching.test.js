import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saveKnownAccount } from "../accounts.js";
import { openAccountDb } from "../local-db.js";
import { createAppStore } from "./app.svelte.js";

/**
 * Lifecycle coverage for the v3 account model: per-account IndexedDB
 * mirrors, instant local switching, disconnect-keeps-data, and
 * forget-wipes-data. Each test builds a stub repo whose `on` collector
 * lets the test fire `connected` / `disconnected` / `error` events
 * deterministically, decoupling the store from rs.js's real timing.
 *
 * We deliberately stay in vitest's default node environment (no jsdom).
 * The store relies on `localStorage`, `window` (hashchange routing), and
 * IndexedDB — we polyfill exactly those (IndexedDB via fake-indexeddb).
 * Loading jsdom would activate Svelte's top-level-`$effect` validation and
 * the store's reactive setup would throw `effect_orphan`.
 */

const ACTIVE_ACCOUNT_KEY = "setlist-roller-active-account";

// Minimal localStorage shim — Map-backed, throws nothing.
class MemStorage {
    constructor() {
        this.map = new Map();
    }
    getItem(key) {
        return this.map.has(key) ? this.map.get(key) : null;
    }
    setItem(key, value) {
        this.map.set(key, String(value));
    }
    removeItem(key) {
        this.map.delete(key);
    }
    clear() {
        this.map.clear();
    }
    key(i) {
        return [...this.map.keys()][i] ?? null;
    }
    get length() {
        return this.map.size;
    }
}

let _origLocalStorage;
let _origWindow;

beforeEach(() => {
    _origLocalStorage = globalThis.localStorage;
    _origWindow = globalThis.window;
    globalThis.localStorage = new MemStorage();
    globalThis.indexedDB = new IDBFactory();
    globalThis.window = {
        location: { hash: "" },
        addEventListener: () => {},
        removeEventListener: () => {},
    };
});

afterEach(() => {
    vi.useRealTimers();
    if (typeof _origLocalStorage === "undefined") delete globalThis.localStorage;
    else globalThis.localStorage = _origLocalStorage;
    if (typeof _origWindow === "undefined") delete globalThis.window;
    else globalThis.window = _origWindow;
});

function flush() {
    return new Promise((resolve) => setImmediate(resolve));
}

async function settle(times = 10) {
    for (let i = 0; i < times; i += 1) await flush();
}

/** Pre-populate an account's mirror as if it had synced before. */
async function seedMirror(address, { songs = [], config = null, initialSyncDone = true } = {}) {
    const db = await openAccountDb(address);
    for (const song of songs) await db.putSong(song);
    if (config) await db.putKv("config", config);
    if (initialSyncDone) await db.putKv("sync-meta", { initialSyncDone: true });
    db.close();
}

/**
 * Build a stub repo with controllable event emission.
 * - `repo.fire(eventName, payload)` invokes registered listeners synchronously.
 * - `repo.connect`/`swap`/`disconnect` are vi.fn so tests can assert calls.
 */
function buildStubRepo({ initiallyConnected = false, getToken = () => "stub-token" } = {}) {
    const listeners = new Map();
    let connected = initiallyConnected;
    let userAddress = "";

    return {
        fire(eventName, payload) {
            const handlers = listeners.get(eventName);
            if (!handlers) return;
            for (const handler of [...handlers]) handler(payload);
        },
        setUserAddress(addr) {
            userAddress = addr;
        },
        on(eventName, handler) {
            if (!listeners.has(eventName)) listeners.set(eventName, new Set());
            listeners.get(eventName).add(handler);
            return () => listeners.get(eventName)?.delete(handler);
        },
        onChange() {
            return () => {};
        },
        isConnected() {
            return connected;
        },
        getUserAddress() {
            return userAddress;
        },
        getToken,
        connect: vi.fn((addr, token) => {
            connected = true;
            userAddress = addr;
            void token;
        }),
        disconnect: vi.fn(() => {
            connected = false;
            userAddress = "";
        }),
        swap: vi.fn(async (addr, token) => {
            connected = true;
            userAddress = addr;
            void token;
        }),
        sync: vi.fn(async () => {}),
        getSyncInterval: () => 10000,
        setSyncInterval: vi.fn(),
        loadAll: vi.fn(async () => ({
            songs: [],
            config: null,
            bootstrap: null,
            setlists: [],
            members: {},
            pendingBodies: 0,
            errors: {},
        })),
        // Migrations probe the raw config; returning null short-circuits
        // the migrator without us having to model schema versions here.
        getRawConfig: vi.fn(async () => null),
        putBootstrapMeta: vi.fn(async () => ({})),
    };
}

describe("local-first boot", () => {
    it("hydrates the last active account's mirror before any remote event", async () => {
        await seedMirror("user-a@example.com", {
            songs: [{ id: "s1", name: "Local Song" }],
            config: { bandName: "Band A", schemaVersion: 2 },
        });
        localStorage.setItem(ACTIVE_ACCOUNT_KEY, "user-a@example.com");

        const repo = buildStubRepo();
        const store = createAppStore(repo);
        store.init();
        await settle();

        // No connected/not-connected event has fired — data is local.
        expect(store.currentUserAddress).toBe("user-a@example.com");
        expect(store.hydrated).toBe(true);
        expect(store.songs.map((s) => s.name)).toEqual(["Local Song"]);
        expect(store.appConfig?.bandName).toBe("Band A");
        expect(store.initialSyncDone).toBe(true);
    });

    it("reconnects with the saved token when rs.js lost its session", async () => {
        await seedMirror("user-a@example.com", { config: { bandName: "Band A", schemaVersion: 2 } });
        localStorage.setItem(ACTIVE_ACCOUNT_KEY, "user-a@example.com");
        saveKnownAccount("user-a@example.com", { bandName: "Band A" }, "saved-token-a");

        const repo = buildStubRepo();
        const store = createAppStore(repo);
        store.init();
        await settle();

        repo.fire("not-connected");
        expect(repo.connect).toHaveBeenCalledTimes(1);
        expect(repo.connect.mock.calls[0]).toEqual(["user-a@example.com", "saved-token-a"]);
        expect(store.connectionStatus).toBe("connecting");
    });

    it("stays on local data (no login bounce) when no token is saved", async () => {
        await seedMirror("user-a@example.com", { config: { bandName: "Band A", schemaVersion: 2 } });
        localStorage.setItem(ACTIVE_ACCOUNT_KEY, "user-a@example.com");

        const repo = buildStubRepo();
        const store = createAppStore(repo);
        store.init();
        await settle();

        repo.fire("not-connected");
        expect(repo.connect).not.toHaveBeenCalled();
        expect(store.connectionStatus).toBe("disconnected");
        // The account (and its data) are still active locally.
        expect(store.currentUserAddress).toBe("user-a@example.com");
        expect(store.appConfig?.bandName).toBe("Band A");
    });
});

describe("connectToAccount — re-entry guard", () => {
    it("toasts and bails when connectionStatus is already connecting", async () => {
        const repo = buildStubRepo();
        const store = createAppStore(repo);
        store.init();
        store.connectAddress = "user-a@example.com";
        store.connectStorage();
        expect(store.connectionStatus).toBe("connecting");

        await store.connectToAccount("user-b@example.com");
        const toastTexts = store.toastMessages.map((t) => t.message);
        expect(toastTexts.some((m) => m.toLowerCase().includes("already connecting"))).toBe(true);
        expect(repo.swap).not.toHaveBeenCalled();
    });

    it("ignores empty address", async () => {
        const repo = buildStubRepo();
        const store = createAppStore(repo);
        store.init();
        await store.connectToAccount("");
        expect(repo.swap).not.toHaveBeenCalled();
        expect(repo.connect).not.toHaveBeenCalled();
    });
});

describe("connectToAccount — cold path (not currently connected)", () => {
    it("calls repo.connect with the saved token when not connected", async () => {
        saveKnownAccount("user-a@example.com", { bandName: "A" }, "saved-token-a");
        const repo = buildStubRepo({ initiallyConnected: false });
        const store = createAppStore(repo);
        store.init();
        repo.fire("not-connected");

        await store.connectToAccount("user-a@example.com");

        expect(repo.connect).toHaveBeenCalledTimes(1);
        const [addr, token] = repo.connect.mock.calls[0];
        expect(addr).toBe("user-a@example.com");
        expect(token).toBe("saved-token-a");
    });

    it("finishes in connected state when the connected event fires", async () => {
        saveKnownAccount("user-a@example.com", { bandName: "A" }, "saved-token-a");
        const repo = buildStubRepo({ initiallyConnected: false });
        repo.setUserAddress("user-a@example.com");
        const store = createAppStore(repo);
        store.init();
        repo.fire("not-connected");

        const inFlight = store.connectToAccount("user-a@example.com");
        await inFlight;
        expect(store.connectionStatus).toBe("connecting");

        repo.fire("connected");
        await settle();

        expect(store.connectionStatus).toBe("connected");
        expect(store.currentUserAddress).toBe("user-a@example.com");
    });
});

describe("connectToAccount — swap path (currently connected)", () => {
    it("calls repo.swap with the target's saved token", async () => {
        saveKnownAccount("user-a@example.com", { bandName: "A" }, "token-a");
        saveKnownAccount("user-b@example.com", { bandName: "B" }, "token-b");
        const repo = buildStubRepo({ initiallyConnected: true });
        repo.setUserAddress("user-a@example.com");
        const store = createAppStore(repo);
        store.init();
        repo.fire("connected");
        await settle();

        const inFlight = store.connectToAccount("user-b@example.com");
        await inFlight;
        expect(repo.swap).toHaveBeenCalledTimes(1);
        const [addr, token] = repo.swap.mock.calls[0];
        expect(addr).toBe("user-b@example.com");
        expect(token).toBe("token-b");

        repo.fire("connected");
        await settle();
        expect(store.connectionStatus).toBe("connected");
    });

    it("hydrates the target's mirror instantly, before the remote session lands", async () => {
        await seedMirror("user-b@example.com", {
            songs: [{ id: "sb", name: "B Side" }],
            config: { bandName: "Band B", schemaVersion: 2 },
        });
        saveKnownAccount("user-b@example.com", { bandName: "B" }, "token-b");
        const repo = buildStubRepo({ initiallyConnected: true });
        repo.setUserAddress("user-a@example.com");
        const store = createAppStore(repo);
        store.init();
        repo.fire("connected");
        await settle();

        await store.connectToAccount("user-b@example.com");

        // No connected event for B has fired yet — this is pure local data.
        expect(store.songs.map((s) => s.name)).toEqual(["B Side"]);
        expect(store.appConfig?.bandName).toBe("Band B");
        expect(store.initialSyncDone).toBe(true);
        expect(store.showFirstRunPrompt).toBe(false);

        repo.fire("connected");
        await settle();
        // Local data survives the connection — there's no cache reload that
        // could blank a config the remote hasn't streamed yet.
        expect(store.appConfig?.bandName).toBe("Band B");
        expect(store.showFirstRunPrompt).toBe(false);
    });

    it("watchdog resets a swap that never connects, without losing local data", async () => {
        await seedMirror("user-b@example.com", { config: { bandName: "Band B", schemaVersion: 2 } });
        saveKnownAccount("user-b@example.com", { bandName: "B" }, "token-b");
        const repo = buildStubRepo({ initiallyConnected: true });
        // Make swap "succeed" without ever firing connected, and report
        // not-connected afterwards.
        repo.swap = vi.fn(async () => {});
        const origIsConnected = repo.isConnected;
        let swapCalled = false;
        repo.swap.mockImplementation(async () => {
            swapCalled = true;
        });
        repo.isConnected = () => (swapCalled ? false : origIsConnected());
        repo.setUserAddress("user-a@example.com");
        const store = createAppStore(repo);
        store.init();
        repo.fire("connected");
        await settle();

        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const inFlight = store.connectToAccount("user-b@example.com");
        await inFlight;
        expect(store.connectionStatus).toBe("connecting");

        await vi.advanceTimersByTimeAsync(20000);
        expect(store.connectionStatus).toBe("disconnected");
        // Local data for the target account is still there and usable.
        expect(store.currentUserAddress).toBe("user-b@example.com");
        expect(store.appConfig?.bandName).toBe("Band B");
    });

    it("keeps local data when a fatal Unauthorized fires during swap", async () => {
        await seedMirror("user-b@example.com", { config: { bandName: "Band B", schemaVersion: 2 } });
        saveKnownAccount("user-a@example.com", { bandName: "A" }, "token-a");
        saveKnownAccount("user-b@example.com", { bandName: "B" }, "stale-token");
        const repo = buildStubRepo({ initiallyConnected: true });
        repo.setUserAddress("user-a@example.com");
        const store = createAppStore(repo);
        store.init();
        repo.fire("connected");
        await settle();

        const inFlight = store.connectToAccount("user-b@example.com");
        await inFlight;

        const err = new Error("token expired");
        err.name = "Unauthorized";
        repo.fire("error", err);
        repo.fire("disconnected");
        await settle();

        expect(store.connectionStatus).toBe("disconnected");
        // The account's local data is kept — the user only needs to re-auth.
        expect(store.currentUserAddress).toBe("user-b@example.com");
        expect(store.appConfig?.bandName).toBe("Band B");

        // Subsequent connect attempt must not be blocked by a stuck guard.
        const before = repo.connect.mock.calls.length;
        store.connectAddress = "user-a@example.com";
        store.connectStorage();
        expect(repo.connect.mock.calls.length).toBe(before + 1);
    });
});

describe("disconnect vs forget", () => {
    it("disconnectStorage keeps the mirror so returning is instant", async () => {
        await seedMirror("user-a@example.com", {
            songs: [{ id: "s1", name: "Keeper" }],
            config: { bandName: "Band A", schemaVersion: 2 },
        });
        localStorage.setItem(ACTIVE_ACCOUNT_KEY, "user-a@example.com");
        const repo = buildStubRepo({ initiallyConnected: true });
        repo.setUserAddress("user-a@example.com");
        const store = createAppStore(repo);
        store.init();
        await settle();
        expect(store.songs).toHaveLength(1);

        store.disconnectStorage();
        repo.fire("disconnected");
        await settle();

        // In-memory state is blanked and the session is gone...
        expect(store.currentUserAddress).toBe("");
        expect(store.songs).toEqual([]);
        expect(store.connectionStatus).toBe("disconnected");
        expect(localStorage.getItem(ACTIVE_ACCOUNT_KEY)).toBeNull();

        // ...but the mirror still holds the account's data.
        const db = await openAccountDb("user-a@example.com");
        const data = await db.loadAll();
        db.close();
        expect(data.songs.map((s) => s.name)).toEqual(["Keeper"]);
        expect(data.config?.bandName).toBe("Band A");
    });

    it("forgetAccount wipes the mirror and the registry entry", async () => {
        await seedMirror("user-a@example.com", {
            songs: [{ id: "s1", name: "Gone" }],
            config: { bandName: "Band A", schemaVersion: 2 },
        });
        saveKnownAccount("user-a@example.com", { bandName: "Band A" }, "token-a");
        const repo = buildStubRepo();
        const store = createAppStore(repo);
        store.init();
        await settle();

        store.forgetAccount("user-a@example.com");
        await settle();

        expect(store.knownAccounts.find((a) => a.address === "user-a@example.com")).toBeUndefined();
        const db = await openAccountDb("user-a@example.com");
        const data = await db.loadAll();
        db.close();
        expect(data.songs).toEqual([]);
        expect(data.config).toBeNull();
    });
});
