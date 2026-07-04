import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { accountSlot } from "../accounts.js";
import { openAccountDb } from "../local-db.js";
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

    it("runToastAction fires the handler and dismisses, in a mutation-safe order", () => {
        const store = createAppStore({});
        const onAction = vi.fn();
        store.toastAction("Update ready", "Refresh", onAction);
        const id = store.toastMessages[0].id;

        // Regression: the old inline handler dismissed first and then read
        // the template's {@const toast}, which had already re-evaluated to
        // undefined — the action never ran.
        store.runToastAction(id);
        expect(onAction).toHaveBeenCalledTimes(1);
        expect(store.toastMessages).toHaveLength(0);

        // Unknown ids are a no-op.
        store.runToastAction("toast-nope");
        expect(onAction).toHaveBeenCalledTimes(1);
    });
});

describe("incremental remote sync", () => {
    // The store's init() needs window + localStorage; we're in node, so
    // polyfill exactly those. (jsdom would trip Svelte's top-level-$effect
    // validation.) IndexedDB comes from fake-indexeddb, fresh per test.
    let _origLocalStorage;
    let _origWindow;
    beforeEach(() => {
        globalThis.indexedDB = new IDBFactory();
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

    function flush() {
        // Drain microtasks + fake-indexeddb's setImmediate-driven work.
        return new Promise((resolve) => setImmediate(resolve));
    }

    async function settle(times = 10) {
        for (let i = 0; i < times; i += 1) await flush();
    }

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
                config: null,
                bootstrap: null,
                setlists: [],
                members: {},
                pendingBodies: 0,
                errors: {},
            })),
            getRawConfig: vi.fn(async () => null),
            getSyncInterval: () => 10000,
            setSyncInterval: vi.fn(),
            isConnected: () => true,
            getUserAddress: () => "user@example.com",
            getToken: () => "stub-token",
            connect: vi.fn(),
            disconnect: vi.fn(),
        };
    }

    it("applies remote changes one document at a time — no full reloads", async () => {
        const repo = buildRepo();
        const store = createAppStore(repo);
        const teardown = store.init();

        repo.fire("connected");
        await settle();
        expect(store.currentUserAddress).toBe("user@example.com");
        expect(store.hydrated).toBe(true);
        // Exactly one cache read: the one-time seed pass for a first sync.
        expect(repo.loadAll.mock.calls.length).toBe(1);

        repo.fireChange({ relativePath: "songs/s1", origin: "remote", newValue: { id: "s1", name: "Alpha" } });
        repo.fireChange({ relativePath: "songs/s2", origin: "remote", newValue: { id: "s2", name: "Beta" } });
        expect(store.songs.map((s) => s.name)).toEqual(["Alpha", "Beta"]);

        // Update in place.
        repo.fireChange({ relativePath: "songs/s1", origin: "remote", newValue: { id: "s1", name: "Zulu" } });
        expect(store.songs.map((s) => s.name)).toEqual(["Beta", "Zulu"]);

        // Remote deletion arrives as a change with no newValue.
        repo.fireChange({ relativePath: "songs/s2", origin: "remote", newValue: undefined });
        expect(store.songs.map((s) => s.name)).toEqual(["Zulu"]);

        // Still no extra full reloads.
        expect(repo.loadAll.mock.calls.length).toBe(1);
        teardown();
    });

    it("applies remote config and clears it on remote deletion", async () => {
        const repo = buildRepo();
        const store = createAppStore(repo);
        const teardown = store.init();
        repo.fire("connected");
        await settle();

        repo.fireChange({
            relativePath: "settings/app-config",
            origin: "remote",
            newValue: { bandName: "The Remotes", schemaVersion: 2 },
        });
        expect(store.appConfig?.bandName).toBe("The Remotes");

        repo.fireChange({ relativePath: "settings/app-config", origin: "remote", newValue: undefined });
        expect(store.appConfig).toBeNull();
        teardown();
    });

    it("ignores window- and local-origin events (local writes are already applied)", async () => {
        const repo = buildRepo();
        const store = createAppStore(repo);
        const teardown = store.init();
        repo.fire("connected");
        await settle();

        repo.fireChange({ relativePath: "songs/w1", origin: "window", newValue: { id: "w1", name: "W" } });
        repo.fireChange({ relativePath: "songs/l1", origin: "local", newValue: { id: "l1", name: "L" } });
        expect(store.songs).toEqual([]);
        teardown();
    });

    it("propagates a remote note edit into the displayed setlist", async () => {
        // Regression for the band report: a note edited on another device
        // showed up in the Songs catalog but not in the rolled setlist.
        // Displayed setlists hydrate from the live catalog, so an
        // incremental remote change must flow through.
        globalThis.localStorage.setItem(
            accountSlot("user@example.com").key("current-set"),
            JSON.stringify({ seed: 1, songs: [{ songId: "s1", performance: {} }] }),
        );
        const repo = buildRepo();
        const store = createAppStore(repo);
        const teardown = store.init();
        repo.fire("connected");
        await settle();

        repo.fireChange({
            relativePath: "songs/s1",
            origin: "remote",
            newValue: { id: "s1", name: "Alpha", notes: "old note" },
        });
        expect(store.displayedSetlist?.songs?.[0]?.notes).toBe("old note");

        repo.fireChange({
            relativePath: "songs/s1",
            origin: "remote",
            newValue: { id: "s1", name: "Alpha", notes: "new note" },
        });
        expect(store.displayedSetlist?.songs?.[0]?.notes).toBe("new note");
        teardown();
    });

    it("squashes overrides equal to the default rig at save time and stages vocabulary adds", async () => {
        const repo = buildRepo();
        repo.putSong = vi.fn(async (s) => s);
        repo.putMember = vi.fn(async (name, data) => ({ ...data, name }));
        const store = createAppStore(repo);
        const teardown = store.init();
        repo.fire("connected");
        await settle();

        // Band config arrives: Nick's default rig is Guitar / Standard.
        repo.fireChange({
            relativePath: "members/Nick",
            origin: "remote",
            newValue: {
                name: "Nick",
                instruments: [
                    {
                        name: "Guitar",
                        tunings: ["Standard"],
                        defaultTuning: "Standard",
                        techniques: [],
                        defaultTechnique: "",
                    },
                ],
                defaultInstrument: "Guitar",
            },
        });

        store.openNewSong();
        store.updateSongField("name", "Riff City");
        // Override prefilled from the default rig, left unchanged — must be
        // squashed out of the stored song.
        store.addMember("Nick");
        // Stage a brand-new tuning for the override; applied to the band
        // config only at save.
        store.stageVocabAdd("Nick", "Guitar", "tuning", "Open G");
        expect(repo.putMember).not.toHaveBeenCalled();

        await store.saveSong();

        // The stored song carries no members — the untouched override
        // matched the default rig.
        expect(repo.putSong).toHaveBeenCalledTimes(1);
        expect(repo.putSong.mock.calls[0][0].members).toEqual({});
        // The staged tuning landed in the band config exactly once, at save.
        expect(repo.putMember).toHaveBeenCalledTimes(1);
        const savedMember = repo.putMember.mock.calls[0][1];
        expect(savedMember.instruments[0].tunings).toContain("Open G");
        expect(store.bandMembers.Nick.instruments[0].tunings).toContain("Open G");
        teardown();
    });

    it("cascades a band-member rename into song overrides and generation constraints", async () => {
        // Renames refuse to run until the catalog is settled (the cascade
        // must see every song) — mark this account's initial sync done.
        const db = await openAccountDb("user@example.com");
        await db.putKv("sync-meta", { initialSyncDone: true });
        db.close();
        const repo = buildRepo();
        repo.putMember = vi.fn(async (name, data) => ({ ...data, name }));
        repo.deleteMember = vi.fn(async () => {});
        repo.putSong = vi.fn(async (s) => s);
        const store = createAppStore(repo);
        const teardown = store.init();
        repo.fire("connected");
        await settle();
        expect(store.initialSyncDone).toBe(true);

        repo.fireChange({
            relativePath: "members/Nick",
            origin: "remote",
            newValue: { name: "Nick", instruments: [{ name: "Guitar", tunings: [], defaultTuning: "" }] },
        });
        repo.fireChange({
            relativePath: "songs/s1",
            origin: "remote",
            newValue: {
                id: "s1",
                name: "Override Song",
                members: { Nick: { instruments: [{ name: "Guitar", tuning: ["Drop D"], capo: 0, picking: [] }] } },
            },
        });
        store.ensureMemberShowConfig("Nick");

        await store.renameBandMember("Nick", "Nicholas");
        await settle();

        expect(store.bandMembers.Nicholas).toBeDefined();
        expect(store.bandMembers.Nick).toBeUndefined();
        const song = store.songs.find((s) => s.id === "s1");
        expect(song.members.Nicholas).toBeDefined();
        expect(song.members.Nick).toBeUndefined();
        expect(store.generationOptions.show.members.Nicholas).toBeDefined();
        expect(store.generationOptions.show.members.Nick).toBeUndefined();
        teardown();
    });

    it("an older config save resolving late cannot roll back a newer edit", async () => {
        const repo = buildRepo();
        const puts = [];
        repo.putConfig = vi.fn(
            (config) =>
                new Promise((resolve) => {
                    puts.push({ config, resolve });
                }),
        );
        const store = createAppStore(repo);
        const teardown = store.init();
        repo.fire("connected");
        await settle();
        repo.fireChange({
            relativePath: "settings/app-config",
            origin: "remote",
            newValue: { bandName: "One", schemaVersion: 2 },
        });

        // First save starts and hangs on a slow network...
        const first = store.saveConfig();
        await flush();
        expect(puts).toHaveLength(1);

        // ...the user edits again and a second save starts and FINISHES.
        store.updateConfigField("bandName", "Two");
        const second = store.saveConfig();
        await flush();
        expect(puts).toHaveLength(2);
        puts[1].resolve({ ...puts[1].config });
        await second;
        expect(store.appConfig.bandName).toBe("Two");

        // Now the slow first save lands with the stale payload — it must
        // not roll the config back.
        puts[0].resolve({ ...puts[0].config });
        await first;
        await settle();
        expect(store.appConfig.bandName).toBe("Two");
        teardown();
    });

    it("keeps unpracticed songs addable to the current setlist", async () => {
        const repo = buildRepo();
        const store = createAppStore(repo);
        const teardown = store.init();
        repo.fire("connected");
        await settle();

        repo.fireChange({
            relativePath: "songs/s1",
            origin: "remote",
            newValue: { id: "s1", name: "Rusty", unpracticed: true },
        });
        expect(store.songsNotInSetlist.map((s) => s.id)).toContain("s1");
        teardown();
    });

    it("flips to synced after a quiet settle window and persists initialSyncDone", async () => {
        const repo = buildRepo();
        const store = createAppStore(repo);
        const teardown = store.init();
        repo.fire("connected");
        await settle();
        expect(store.syncState).toBe("syncing");
        expect(store.initialSyncDone).toBe(false);

        // Only fake the timer APIs the settle logic uses; fake-indexeddb
        // needs the real setImmediate to keep processing transactions.
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        repo.fire("sync-done", { completed: true });
        // An incoming change cancels the pending settle...
        repo.fireChange({ relativePath: "songs/s1", origin: "remote", newValue: { id: "s1", name: "A" } });
        await vi.advanceTimersByTimeAsync(3000);
        expect(store.syncState).toBe("syncing");

        // ...and the next completed round re-arms it. The settle pass
        // verifies against the rs.js cache, so the stub must now report
        // the document the change event delivered.
        repo.loadAll.mockResolvedValue({
            songs: [{ id: "s1", name: "A" }],
            config: null,
            bootstrap: null,
            setlists: [],
            members: {},
            pendingBodies: 0,
            errors: {},
        });
        repo.fire("sync-done", { completed: true });
        await vi.advanceTimersByTimeAsync(2500);
        expect(store.syncState).toBe("synced");
        expect(store.initialSyncDone).toBe(true);
        expect(store.songs.map((s) => s.name)).toEqual(["A"]);

        // The transient confirmation fades back to idle.
        await vi.advanceTimersByTimeAsync(2500);
        expect(store.syncState).toBe("idle");
        teardown();
    });

    it("does not settle while the cache is still skeletal, and prunes stale local docs once it is coherent", async () => {
        const repo = buildRepo();
        const store = createAppStore(repo);
        const teardown = store.init();
        repo.fire("connected");
        await settle();

        // Local catalog holds two songs (e.g. hydrated from the mirror)...
        repo.fireChange({ relativePath: "songs/s1", origin: "remote", newValue: { id: "s1", name: "Keep" } });
        repo.fireChange({ relativePath: "songs/s2", origin: "remote", newValue: { id: "s2", name: "Stale" } });
        expect(store.songs).toHaveLength(2);

        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        // ...but the rs.js cache reads completely empty (fresh cache after
        // a swap, folder listings not pulled yet). The settle pass must
        // NOT flip to synced or prune anything.
        repo.loadAll.mockResolvedValue({
            songs: [],
            config: null,
            bootstrap: null,
            setlists: [],
            members: {},
            pendingBodies: 0,
            errors: {},
        });
        repo.fire("sync-done", { completed: true });
        await vi.advanceTimersByTimeAsync(2500);
        expect(store.syncState).toBe("syncing");
        expect(store.songs).toHaveLength(2);
        expect(store.initialSyncDone).toBe(false);

        // Once the cache is coherent but only contains s1, the settle
        // pass reconciles: s2 was deleted remotely while we were away.
        repo.loadAll.mockResolvedValue({
            songs: [{ id: "s1", name: "Keep" }],
            config: null,
            bootstrap: null,
            setlists: [],
            members: {},
            pendingBodies: 0,
            errors: {},
        });
        repo.fire("sync-done", { completed: true });
        await vi.advanceTimersByTimeAsync(2500);
        expect(store.syncState).toBe("synced");
        expect(store.songs.map((s) => s.name)).toEqual(["Keep"]);
        expect(store.initialSyncDone).toBe(true);
        teardown();
    });
});
