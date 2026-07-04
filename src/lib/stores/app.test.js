import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_APP_CONFIG } from "../defaults.js";
import { migrator } from "../migrations.js";
import { createAppStore, normalizeAuthToken } from "./app.svelte.js";

afterEach(() => {
    vi.useRealTimers();
});

describe("normalizeAuthToken", () => {
    it("keeps non-empty string tokens", () => {
        expect(normalizeAuthToken("saved-token")).toBe("saved-token");
    });

    it("drops click events and other non-string values", () => {
        expect(normalizeAuthToken({ type: "click" })).toBeUndefined();
        expect(normalizeAuthToken("")).toBeUndefined();
        expect(normalizeAuthToken(null)).toBeUndefined();
    });
});

describe("retrySync", () => {
    it("recovers from a stalled reload even if the original load never resolves", async () => {
        vi.useFakeTimers();
        let calls = 0;
        const repo = {
            loadAll: vi.fn(() => {
                calls += 1;
                if (calls === 1) return new Promise(() => {});
                return Promise.resolve({
                    songs: [],
                    pendingBodies: 0,
                    bootstrap: null,
                    config: DEFAULT_APP_CONFIG,
                    setlists: [],
                    members: {},
                });
            }),
        };
        const store = createAppStore(repo);

        store.retrySync();
        await vi.advanceTimersByTimeAsync(15000);
        expect(store.syncStalled).toBe(true);

        await store.retrySync();
        expect(store.syncStalled).toBe(false);
        expect(store.initialSyncComplete).toBe(true);

        await vi.advanceTimersByTimeAsync(15000);
        expect(store.syncStalled).toBe(false);
    });
});

describe("toasts", () => {
    it("keeps only the latest toast and ignores stale dismiss timers", () => {
        vi.useFakeTimers();
        const store = createAppStore({});

        store.toastInfo("First message");
        store.toastError("Latest message");

        expect(store.toastMessages).toHaveLength(1);
        expect(store.toastMessages[0]).toMatchObject({
            message: "Latest message",
            tone: "danger",
        });

        vi.advanceTimersByTime(6000);
        expect(store.toastMessages).toHaveLength(1);
        expect(store.toastMessages[0]?.message).toBe("Latest message");

        vi.advanceTimersByTime(6000);
        expect(store.toastMessages).toHaveLength(0);
    });
});

describe("setlist v2 migration", () => {
    it("collapses a fat saved setlist to lean references and hoists the relaxed flags", () => {
        const fat = {
            id: "set-1",
            name: "Old School",
            savedAt: "2026-01-01T00:00:00.000Z",
            seed: 42,
            songNames: ["A", "B"],
            songCount: 2,
            summary: {
                score: 17,
                anxiety: { scaled: 4 },
                minimumsRelaxed: true,
                openerFilterRelaxed: false,
                closerFilterRelaxed: true,
            },
            songs: [
                {
                    id: "song-1",
                    name: "A",
                    cover: false,
                    instrumental: false,
                    key: "C",
                    notes: "n1",
                    performance: { nick: { instrument: "guitar" } },
                    position: 1,
                    incrementalScore: 0,
                    cumulativeScore: 0,
                    transitionNotes: ["whatever"],
                },
                {
                    id: "song-2",
                    name: "B",
                    cover: true,
                    instrumental: false,
                    key: "G",
                    notes: "",
                    performance: { nick: { instrument: "bass" } },
                    position: 2,
                },
            ],
        };

        const migrated = migrator.migrateDocument("setlists", fat);

        expect(migrated.songs).toEqual([
            { songId: "song-1", performance: { nick: { instrument: "guitar" } } },
            { songId: "song-2", performance: { nick: { instrument: "bass" } } },
        ]);
        expect(migrated.minimumsRelaxed).toBe(true);
        expect(migrated.openerFilterRelaxed).toBe(false);
        expect(migrated.closerFilterRelaxed).toBe(true);
        expect(migrated.summary).toBeUndefined();
        expect(migrated.songNames).toBeUndefined();
        expect(migrated.songCount).toBeUndefined();
        // Identity fields are preserved.
        expect(migrated.id).toBe("set-1");
        expect(migrated.name).toBe("Old School");
        expect(migrated.seed).toBe(42);
    });

    it("is idempotent on already-lean entries", () => {
        const lean = {
            id: "set-2",
            name: "Already Lean",
            savedAt: "2026-01-02T00:00:00.000Z",
            schemaVersion: 2,
            seed: 7,
            minimumsRelaxed: false,
            openerFilterRelaxed: false,
            closerFilterRelaxed: false,
            songs: [{ songId: "song-9", performance: {} }],
        };

        const once = migrator.migrateDocument("setlists", { ...lean, songs: [...lean.songs] });
        const twice = migrator.migrateDocument("setlists", once);

        expect(twice.songs).toEqual([{ songId: "song-9", performance: {} }]);
        expect(twice.summary).toBeUndefined();
        expect(twice.minimumsRelaxed).toBe(false);
    });
});

describe("sticky action toasts", () => {
    it("does not auto-dismiss and exposes the action", () => {
        vi.useFakeTimers();
        const store = createAppStore({});
        const onAction = vi.fn();

        store.toastAction("Update ready", "Refresh", onAction);
        expect(store.toastMessages).toHaveLength(1);
        expect(store.toastMessages[0]).toMatchObject({
            message: "Update ready",
            tone: "info",
            sticky: true,
        });
        expect(store.toastMessages[0].action.label).toBe("Refresh");

        // Sticky toasts survive the normal dwell timers.
        vi.advanceTimersByTime(60000);
        expect(store.toastMessages).toHaveLength(1);

        store.toastMessages[0].action.onClick();
        expect(onAction).toHaveBeenCalledTimes(1);

        store.dismissToast(store.toastMessages[0].id);
        expect(store.toastMessages).toHaveLength(0);
    });
});

describe("change-driven reload coalescing", () => {
    // The store's init() needs window + localStorage; we're in node, so
    // polyfill exactly those (same approach as account-switching.test.js —
    // jsdom would trip Svelte's top-level-$effect validation).
    let _origLocalStorage;
    let _origWindow;
    beforeEach(() => {
        _origLocalStorage = globalThis.localStorage;
        _origWindow = globalThis.window;
        const map = new Map();
        globalThis.localStorage = {
            getItem: (k) => (map.has(k) ? map.get(k) : null),
            setItem: (k, v) => map.set(k, String(v)),
            removeItem: (k) => map.delete(k),
            clear: () => map.clear(),
        };
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

    function buildRepo() {
        const listeners = new Map();
        let changeHandler = null;
        return {
            on(eventName, handler) {
                if (!listeners.has(eventName)) listeners.set(eventName, new Set());
                listeners.get(eventName).add(handler);
                return () => listeners.get(eventName)?.delete(handler);
            },
            fire(eventName, payload) {
                for (const handler of [...(listeners.get(eventName) || [])]) handler(payload);
            },
            onChange(handler) {
                changeHandler = handler;
                return () => {
                    changeHandler = null;
                };
            },
            fireChange(event) {
                changeHandler?.(event);
            },
            loadAll: vi.fn(async () => ({
                songs: [],
                pendingBodies: 0,
                bootstrap: null,
                config: DEFAULT_APP_CONFIG,
                setlists: [],
                members: {},
                errors: {},
            })),
            getRawConfig: vi.fn(async () => null),
            isConnected: () => true,
            getUserAddress: () => "user@example.com",
            getToken: () => "stub-token",
            connect: vi.fn(),
            disconnect: vi.fn(),
        };
    }

    it("collapses a burst of change events into a single reload", async () => {
        vi.useFakeTimers();
        const repo = buildRepo();
        const store = createAppStore(repo);
        const teardown = store.init();

        repo.fire("connected");
        // Let the connected handler's own reloadAll settle.
        await vi.runOnlyPendingTimersAsync();
        const baseline = repo.loadAll.mock.calls.length;

        // Simulate rs.js streaming a 150-song catalog: one remote-origin
        // change event per document body.
        for (let i = 0; i < 150; i += 1) {
            repo.fireChange({ relativePath: `songs/id-${i}`, origin: "remote", newValue: {} });
        }
        expect(repo.loadAll.mock.calls.length).toBe(baseline);

        await vi.advanceTimersByTimeAsync(1000);
        expect(repo.loadAll.mock.calls.length).toBe(baseline + 1);
        expect(store.songs).toEqual([]);

        teardown();
    });

    it("still reloads promptly after a lone remote change", async () => {
        vi.useFakeTimers();
        const repo = buildRepo();
        const store = createAppStore(repo);
        const teardown = store.init();

        repo.fire("connected");
        await vi.runOnlyPendingTimersAsync();
        const baseline = repo.loadAll.mock.calls.length;

        repo.fireChange({ relativePath: "songs/id-1", origin: "remote", newValue: {} });
        await vi.advanceTimersByTimeAsync(300);
        expect(repo.loadAll.mock.calls.length).toBe(baseline + 1);

        teardown();
    });

    it("ignores window-origin events and does not schedule a reload", async () => {
        vi.useFakeTimers();
        const repo = buildRepo();
        const store = createAppStore(repo);
        const teardown = store.init();

        repo.fire("connected");
        await vi.runOnlyPendingTimersAsync();
        const baseline = repo.loadAll.mock.calls.length;

        repo.fireChange({ relativePath: "songs/id-1", origin: "window", newValue: {} });
        await vi.advanceTimersByTimeAsync(1000);
        expect(repo.loadAll.mock.calls.length).toBe(baseline);

        teardown();
    });
});
