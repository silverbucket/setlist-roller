import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saveKnownAccount, scopedKey } from "../accounts.js";
import { createAppStore } from "./app.svelte.js";

/**
 * Lifecycle coverage for `connectToAccount`. Before this file landed, the
 * function had no direct tests — the e2e suite only exercised the connect
 * screen and Add Account, never the actual swap or Recent-click. Each test
 * builds a stub repo whose `on` collector lets the test fire `connected` /
 * `disconnected` / `error` events deterministically, decoupling the
 * connectToAccount state machine from rs.js's real timing.
 *
 * We deliberately stay in vitest's default node environment (no jsdom).
 * The store relies on three browser globals (`localStorage`, `window` for
 * hashchange routing, and `setTimeout`) — we polyfill exactly those rather
 * than pulling in a full DOM. Loading jsdom would activate Svelte's
 * top-level-`$effect` validation and the store's reactive setup would
 * throw `effect_orphan` because the effects aren't running inside a
 * component initializer.
 */

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

beforeEach(() => {
    // Fresh per-test storage so saved tokens / snapshots don't leak.
    globalThis.localStorage = new MemStorage();
    // Minimum window surface the store touches: location.hash for routing
    // and addEventListener for hashchange. We're in node, so no real DOM.
    globalThis.window = {
        location: { hash: "" },
        addEventListener: () => {},
        removeEventListener: () => {},
    };
});

afterEach(() => {
    vi.useRealTimers();
});

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
        syncAndWait: vi.fn(() => Promise.resolve()),
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

    it("releases the swap guard when the connected event fires", async () => {
        saveKnownAccount("user-a@example.com", { bandName: "A" }, "saved-token-a");
        const repo = buildStubRepo({ initiallyConnected: false });
        repo.setUserAddress("user-a@example.com");
        const store = createAppStore(repo);
        store.init();
        repo.fire("not-connected");

        const inFlight = store.connectToAccount("user-a@example.com");
        expect(store.connectionStatus).toBe("connecting");

        repo.fire("connected");
        await inFlight;
        // Drain any awaited work the connected handler may still have queued.
        await new Promise((r) => setTimeout(r, 0));

        expect(store.connectionStatus).toBe("connected");
    });
});

describe("connectToAccount — swap path (currently connected)", () => {
    it("calls repo.swap when already connected to a different account", async () => {
        saveKnownAccount("user-a@example.com", { bandName: "A" }, "token-a");
        saveKnownAccount("user-b@example.com", { bandName: "B" }, "token-b");
        const repo = buildStubRepo({ initiallyConnected: true });
        repo.setUserAddress("user-a@example.com");
        const store = createAppStore(repo);
        store.init();
        repo.fire("connected");
        await new Promise((r) => setTimeout(r, 0));

        const inFlight = store.connectToAccount("user-b@example.com");
        expect(repo.swap).toHaveBeenCalledTimes(1);
        const [addr, token] = repo.swap.mock.calls[0];
        expect(addr).toBe("user-b@example.com");
        expect(token).toBe("token-b");

        repo.fire("connected");
        await inFlight;
    });

    it("watchdog releases the guard after 15s if connected never fires", async () => {
        vi.useFakeTimers();
        saveKnownAccount("user-a@example.com", { bandName: "A" }, "token-a");
        saveKnownAccount("user-b@example.com", { bandName: "B" }, "token-b");
        const repo = buildStubRepo({ initiallyConnected: true });
        repo.setUserAddress("user-a@example.com");
        const store = createAppStore(repo);
        store.init();
        repo.fire("connected");
        await vi.advanceTimersByTimeAsync(0);

        store.connectToAccount("user-b@example.com");
        expect(store.connectionStatus).toBe("connecting");

        await vi.advanceTimersByTimeAsync(15000);
        expect(store.connectionStatus).toBe("disconnected");
    });

    it("releases the swap guard when fatal Unauthorized fires during swap", async () => {
        saveKnownAccount("user-a@example.com", { bandName: "A" }, "token-a");
        saveKnownAccount("user-b@example.com", { bandName: "B" }, "stale-token");
        const repo = buildStubRepo({ initiallyConnected: true });
        repo.setUserAddress("user-a@example.com");
        const store = createAppStore(repo);
        store.init();
        repo.fire("connected");
        await new Promise((r) => setTimeout(r, 0));

        const inFlight = store.connectToAccount("user-b@example.com");

        const err = new Error("token expired");
        err.name = "Unauthorized";
        repo.fire("error", err);
        repo.fire("disconnected");
        await inFlight;

        expect(store.connectionStatus).toBe("disconnected");
        // Subsequent connect attempt must not be blocked by a stuck guard.
        const before = repo.connect.mock.calls.length;
        store.connectAddress = "user-a@example.com";
        store.connectStorage();
        expect(repo.connect.mock.calls.length).toBe(before + 1);
    });
});

describe("connectToAccount — snapshot path", () => {
    it("paints the new account's data instantly when a snapshot exists", async () => {
        saveKnownAccount("user-b@example.com", { bandName: "B" }, "token-b");
        localStorage.setItem(
            scopedKey("snapshot", "user-b@example.com"),
            JSON.stringify({
                songs: [{ id: "s1", name: "Snapshot Song" }],
                config: { bandName: "Band B (snapshot)", schemaVersion: 2 },
                setlists: [],
                members: {},
            }),
        );

        const repo = buildStubRepo({ initiallyConnected: true });
        repo.setUserAddress("user-a@example.com");
        const store = createAppStore(repo);
        store.init();
        repo.fire("connected");
        await new Promise((r) => setTimeout(r, 0));

        const inFlight = store.connectToAccount("user-b@example.com");
        expect(store.initialSyncComplete).toBe(true);
        expect(store.appConfig?.bandName).toBe("Band B (snapshot)");

        repo.fire("connected");
        await inFlight;
    });

    it("snapshot config survives a reloadAll that returns no remote config yet", async () => {
        // Regression guard for the swap → onChange → reloadAll race. After
        // a snapshot-path swap, rs.js streams the new account's data into
        // the cache. While bodies are still arriving, reloadAll can read
        // the cache and find data.config === null (folder listing only,
        // no config body). PR 89's slice-by-slice apply still blanks
        // appConfig in that case (`data.config ? ... : null`), which then
        // tips `showFirstRunPrompt` true and bounces the user into the
        // band-name modal even though they have a perfectly good config
        // both in the snapshot and on the server. This test pins the
        // intended behavior: a snapshot-restored config must not be
        // overwritten by an empty cache read on the same account.
        saveKnownAccount("user-b@example.com", { bandName: "B" }, "token-b");
        localStorage.setItem(
            scopedKey("snapshot", "user-b@example.com"),
            JSON.stringify({
                songs: [],
                config: { bandName: "Band B (snapshot)", schemaVersion: 2 },
                setlists: [],
                members: {},
            }),
        );

        const repo = buildStubRepo({ initiallyConnected: true });
        repo.setUserAddress("user-a@example.com");
        // First reloadAll (during the connected handler in the legacy non-
        // snapshot path) won't run because initialSyncComplete is set true
        // by the snapshot. But onChange-triggered reloadAll runs against
        // the empty new-account cache.
        repo.loadAll = vi.fn(async () => ({
            songs: [],
            config: null,
            bootstrap: null,
            setlists: [],
            members: {},
            pendingBodies: 1,
            errors: {},
        }));
        const store = createAppStore(repo);
        store.init();
        repo.fire("connected");
        await new Promise((r) => setTimeout(r, 0));

        const inFlight = store.connectToAccount("user-b@example.com");
        expect(store.appConfig?.bandName).toBe("Band B (snapshot)");
        repo.fire("connected");
        await inFlight;
        // Simulate the onChange-driven reloadAll burst that follows a swap.
        await store.retrySync();

        // The snapshot config must still be present — and the first-run
        // modal must not be open against an account that already has a
        // config locally.
        expect(store.appConfig?.bandName).toBe("Band B (snapshot)");
        expect(store.showFirstRunPrompt).toBe(false);
    });
});
