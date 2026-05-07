import { afterEach, describe, expect, it, vi } from "vitest";

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
