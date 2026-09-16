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

// ---------------------------------------------------------------------------
// Shared harness for tests that call store.init().
//
// init() needs window + localStorage; we're in node, so polyfill exactly
// those. (jsdom would trip Svelte's top-level-$effect validation.)
// IndexedDB comes from fake-indexeddb, fresh per install.
// ---------------------------------------------------------------------------

function installBrowserEnv() {
    globalThis.indexedDB = new IDBFactory();
    const origLocalStorage = globalThis.localStorage;
    const origWindow = globalThis.window;
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
    return () => {
        if (typeof origLocalStorage === "undefined") delete globalThis.localStorage;
        else globalThis.localStorage = origLocalStorage;
        if (typeof origWindow === "undefined") delete globalThis.window;
        else globalThis.window = origWindow;
    };
}

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

/** Persist the "first sync finished" marker so the store boots settled. */
async function markCatalogSettled() {
    const db = await openAccountDb("user@example.com");
    await db.putKv("sync-meta", { initialSyncDone: true });
    db.close();
}

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
    it("queues consecutive toasts and gives each its full dwell time", () => {
        vi.useFakeTimers();
        const store = createAppStore({});

        store.toastInfo("First message");
        store.toastError("Latest message");

        expect(store.toastMessages).toHaveLength(2);
        expect(store.toastMessages[0]).toMatchObject({
            message: "First message",
            tone: "info",
        });

        vi.advanceTimersByTime(6000);
        expect(store.toastMessages).toHaveLength(1);
        expect(store.toastMessages[0]?.message).toBe("Latest message");

        vi.advanceTimersByTime(11999);
        expect(store.toastMessages).toHaveLength(1);

        vi.advanceTimersByTime(1);
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

describe("destructive confirm", () => {
    it("resolves with the user's choice and supersedes pending requests", async () => {
        const store = createAppStore({});
        const first = store.requestConfirm({ title: "First?" });
        expect(store.confirmRequest.title).toBe("First?");

        // A newer request supersedes the pending one, which resolves as
        // cancelled — callers are never left hanging.
        const second = store.requestConfirm({ title: "Second?" });
        await expect(first).resolves.toBe(false);
        expect(store.confirmRequest.title).toBe("Second?");

        store.resolveConfirm(true);
        await expect(second).resolves.toBe(true);
        expect(store.confirmRequest).toBeNull();
    });

    it("deleteSong runs only after the confirm resolves true", async () => {
        const repo = { deleteSong: vi.fn(async () => {}) };
        const store = createAppStore(repo);

        const cancelled = store.deleteSong({ id: "s1", name: "Doomed" });
        expect(store.confirmRequest.title).toContain("Doomed");
        store.resolveConfirm(false);
        await cancelled;
        expect(repo.deleteSong).not.toHaveBeenCalled();

        const confirmed = store.deleteSong({ id: "s1", name: "Doomed" });
        store.resolveConfirm(true);
        await confirmed;
        expect(repo.deleteSong).toHaveBeenCalledTimes(1);
    });
});

describe("keep-apart cascade guard", () => {
    const STILL_SYNCING = "Still syncing your catalog";

    it("deleteSong refuses a linked song until the catalog has settled, but deletes unlinked ones", async () => {
        const repo = { deleteSong: vi.fn(async () => {}) };
        const store = createAppStore(repo);
        expect(store.initialSyncDone).toBe(false);

        const linked = store.deleteSong({ id: "s1", name: "Linked", keepApartFrom: ["s2"] });
        store.resolveConfirm(true);
        await linked;
        expect(repo.deleteSong).not.toHaveBeenCalled();
        expect(store.toastMessages.at(-1)).toMatchObject({
            message: `${STILL_SYNCING} — try deleting again in a moment.`,
            tone: "warning",
        });

        const plain = store.deleteSong({ id: "s3", name: "Plain", keepApartFrom: [] });
        store.resolveConfirm(true);
        await plain;
        expect(repo.deleteSong).toHaveBeenCalledTimes(1);
    });

    it("saveSong refuses a keep-apart change until the catalog has settled", async () => {
        const repo = { putSong: vi.fn(async (s) => s) };
        const store = createAppStore(repo);
        store.openNewSong();
        store.updateSongField("name", "New");
        store.updateSongField("keepApartFrom", ["other"]);
        await store.saveSong();
        expect(repo.putSong).not.toHaveBeenCalled();
        expect(store.toastMessages.at(-1)).toMatchObject({
            message: `${STILL_SYNCING} — try saving the keep-apart change again in a moment.`,
            tone: "warning",
        });
    });

    it("saveSong allows a plain new song while the catalog is unsettled", async () => {
        const repo = { putSong: vi.fn(async (s) => s) };
        const store = createAppStore(repo);
        expect(store.initialSyncDone).toBe(false);

        store.openNewSong();
        store.updateSongField("name", "Plain");
        await store.saveSong();

        expect(repo.putSong).toHaveBeenCalledTimes(1);
    });

    describe("with initialized store", () => {
        let restoreEnv;
        beforeEach(() => {
            restoreEnv = installBrowserEnv();
        });
        afterEach(() => restoreEnv());

        async function bootStore(repo, { settled = false } = {}) {
            if (settled) await markCatalogSettled();
            const store = createAppStore(repo);
            const teardown = store.init();
            repo.fire("connected");
            await settle();
            return { store, teardown };
        }

        it("deleteSong guard reads links from the catalog record, not the caller's object", async () => {
            const repo = buildRepo();
            repo.deleteSong = vi.fn(async () => {});
            const { store, teardown } = await bootStore(repo);
            expect(store.initialSyncDone).toBe(false);

            repo.fireChange({
                relativePath: "songs/s1",
                origin: "remote",
                newValue: { id: "s1", name: "Alpha", keepApartFrom: ["s2"] },
            });
            await settle();

            // A list row passes only { id, name }; the catalog says s1 is linked.
            const pending = store.deleteSong({ id: "s1", name: "Alpha" });
            store.resolveConfirm(true);
            await pending;

            expect(repo.deleteSong).not.toHaveBeenCalled();
            expect(store.toastMessages.at(-1)?.message).toMatch(/still syncing/i);
            teardown();
        });

        it("saveSong allows renaming a linked song while unsettled when keepApartFrom is unchanged", async () => {
            const repo = buildRepo();
            repo.putSong = vi.fn(async (s) => s);
            const { store, teardown } = await bootStore(repo);
            expect(store.initialSyncDone).toBe(false);

            repo.fireChange({
                relativePath: "songs/s1",
                origin: "remote",
                newValue: { id: "s1", name: "Alpha", keepApartFrom: ["s2"] },
            });
            repo.fireChange({
                relativePath: "songs/s2",
                origin: "remote",
                newValue: { id: "s2", name: "Beta", keepApartFrom: ["s1"] },
            });
            await settle();

            store.openSong(store.songs.find((s) => s.id === "s1"));
            store.updateSongField("name", "Alpha Renamed");
            await store.saveSong();

            expect(repo.putSong).toHaveBeenCalledTimes(1);
            expect(repo.putSong.mock.calls[0][0].name).toBe("Alpha Renamed");
            teardown();
        });

        it("deleteSong deletes a linked song once settled and scrubs partners", async () => {
            const repo = buildRepo();
            repo.deleteSong = vi.fn(async () => {});
            repo.putSong = vi.fn(async (s) => s);
            const { store, teardown } = await bootStore(repo, { settled: true });
            expect(store.initialSyncDone).toBe(true);

            repo.fireChange({
                relativePath: "songs/s1",
                origin: "remote",
                newValue: { id: "s1", name: "Alpha", keepApartFrom: ["s2"] },
            });
            repo.fireChange({
                relativePath: "songs/s2",
                origin: "remote",
                newValue: { id: "s2", name: "Beta", keepApartFrom: ["s1"] },
            });
            await settle();

            const pending = store.deleteSong({ id: "s1", name: "Alpha", keepApartFrom: ["s2"] });
            store.resolveConfirm(true);
            await pending;

            expect(repo.deleteSong).toHaveBeenCalledWith("s1");
            expect(repo.putSong).toHaveBeenCalledTimes(1);
            expect(repo.putSong.mock.calls[0][0]).toMatchObject({
                id: "s2",
                keepApartFrom: [],
            });
            teardown();
        });

        it("saveSong cascades keep-apart links once settled", async () => {
            const repo = buildRepo();
            repo.putSong = vi.fn(async (s) => s);
            const { store, teardown } = await bootStore(repo, { settled: true });
            expect(store.initialSyncDone).toBe(true);

            repo.fireChange({
                relativePath: "songs/s1",
                origin: "remote",
                newValue: { id: "s1", name: "Alpha", keepApartFrom: [] },
            });
            repo.fireChange({
                relativePath: "songs/s2",
                origin: "remote",
                newValue: { id: "s2", name: "Beta", keepApartFrom: [] },
            });
            await settle();

            store.openSong(store.songs.find((s) => s.id === "s1"));
            store.updateSongField("keepApartFrom", ["s2"]);
            await store.saveSong();

            expect(repo.putSong).toHaveBeenCalledTimes(2);
            expect(repo.putSong.mock.calls[0][0]).toMatchObject({
                id: "s1",
                keepApartFrom: ["s2"],
            });
            expect(repo.putSong.mock.calls[1][0]).toMatchObject({
                id: "s2",
                keepApartFrom: ["s1"],
            });
            teardown();
        });
    });
});

describe("incremental remote sync", () => {
    let restoreEnv;
    beforeEach(() => {
        restoreEnv = installBrowserEnv();
    });
    afterEach(() => {
        vi.useRealTimers();
        restoreEnv();
    });

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
        await markCatalogSettled();
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

    it("queues and removes songs pinned before the first roll", async () => {
        const repo = buildRepo();
        const store = createAppStore(repo);
        const teardown = store.init();
        repo.fire("connected");
        await settle();
        repo.fireChange({ relativePath: "songs/s1", origin: "remote", newValue: { id: "s1", name: "Anchor" } });

        store.pinSongBeforeRoll("s1");
        expect(store.preRollPinnedSongs.map((song) => song.id)).toEqual(["s1"]);
        expect(store.pinnedSongCount).toBe(1);

        store.unpinSongBeforeRoll("s1");
        expect(store.preRollPinnedSongs).toEqual([]);
        expect(store.pinnedSongCount).toBe(0);
        teardown();
    });

    it("starts a manual setlist from empty and clears it even when locked", async () => {
        const repo = buildRepo();
        const store = createAppStore(repo);
        const teardown = store.init();
        repo.fire("connected");
        await settle();
        repo.fireChange({ relativePath: "songs/s1", origin: "remote", newValue: { id: "s1", name: "Starter" } });

        store.addSetlistSong("s1");
        expect(store.generatedSetlist.songs.map((entry) => entry.songId)).toEqual(["s1"]);
        expect(store.displayedSetlist.songs.map((song) => song.name)).toEqual(["Starter"]);

        store.lockSetlist();
        expect(store.setlistLocked).toBe(true);
        store.clearCurrentSetlist();
        expect(store.generatedSetlist).toBeNull();
        expect(store.displayedSetlist).toBeNull();
        expect(store.setlistLocked).toBe(false);
        expect(globalThis.localStorage.getItem(accountSlot("user@example.com").key("current-set"))).toBeNull();
        teardown();
    });

    it("recomputes keep-apart conflict badges after manual reorder", async () => {
        globalThis.localStorage.setItem(
            accountSlot("user@example.com").key("current-set"),
            JSON.stringify({
                seed: 1,
                songs: [
                    { songId: "a", performance: {} },
                    { songId: "c", performance: {} },
                    { songId: "b", performance: {} },
                ],
            }),
        );
        const repo = buildRepo();
        const store = createAppStore(repo);
        const teardown = store.init();
        repo.fire("connected");
        await settle();

        repo.fireChange({
            relativePath: "songs/a",
            origin: "remote",
            newValue: { id: "a", name: "Alpha", keepApartFrom: ["b"] },
        });
        repo.fireChange({
            relativePath: "songs/b",
            origin: "remote",
            newValue: { id: "b", name: "Beta", keepApartFrom: ["a"] },
        });
        repo.fireChange({
            relativePath: "songs/c",
            origin: "remote",
            newValue: { id: "c", name: "Gamma" },
        });

        expect(store.displayedSetlist.songs.map((song) => song.keepApartConflict)).toEqual([false, false, false]);

        store.reorderSetlistSong(2, 1);
        expect(store.displayedSetlist.songs.map((song) => song.keepApartConflict)).toEqual([true, true, false]);
        teardown();
    });

    it("flags keep-apart conflicts when catalog rules make adjacent songs conflict", async () => {
        globalThis.localStorage.setItem(
            accountSlot("user@example.com").key("current-set"),
            JSON.stringify({
                seed: 1,
                songs: [
                    { songId: "a", performance: {} },
                    { songId: "b", performance: {} },
                ],
            }),
        );
        const repo = buildRepo();
        const store = createAppStore(repo);
        const teardown = store.init();
        repo.fire("connected");
        await settle();

        repo.fireChange({
            relativePath: "songs/a",
            origin: "remote",
            newValue: { id: "a", name: "Alpha" },
        });
        repo.fireChange({
            relativePath: "songs/b",
            origin: "remote",
            newValue: { id: "b", name: "Beta" },
        });
        expect(store.displayedSetlist.songs.every((song) => !song.keepApartConflict)).toBe(true);

        repo.fireChange({
            relativePath: "songs/a",
            origin: "remote",
            newValue: { id: "a", name: "Alpha", keepApartFrom: ["b"] },
        });
        expect(store.displayedSetlist.songs.map((song) => song.keepApartConflict)).toEqual([true, true]);
        teardown();
    });

    it("persists pin toggles on the working setlist", async () => {
        globalThis.localStorage.setItem(
            accountSlot("user@example.com").key("current-set"),
            JSON.stringify({ seed: 1, songs: [{ songId: "s1", performance: {} }] }),
        );
        const repo = buildRepo();
        const store = createAppStore(repo);
        const teardown = store.init();
        repo.fire("connected");
        await settle();
        repo.fireChange({ relativePath: "songs/s1", origin: "remote", newValue: { id: "s1", name: "Anchor" } });

        store.toggleSetlistSongPin("s1");
        expect(store.generatedSetlist.songs[0].pinned).toBe(true);
        expect(store.displayedSetlist.songs[0].pinned).toBe(true);
        expect(store.pinnedSongCount).toBe(1);

        const persisted = JSON.parse(
            globalThis.localStorage.getItem(accountSlot("user@example.com").key("current-set")),
        );
        expect(persisted.songs[0].pinned).toBe(true);
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
