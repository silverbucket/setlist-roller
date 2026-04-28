import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_APP_CONFIG } from "../defaults.js";
import { createAppStore, normalizeAuthToken, syncSavedSongIntoSetlist } from "./app.svelte.js";

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

describe("syncSavedSongIntoSetlist", () => {
    it("updates matching song metadata in the current setlist immediately", () => {
        const setlist = {
            seed: 42,
            summary: { score: 999 },
            songs: [
                {
                    id: "song-1",
                    name: "Old Name",
                    cover: false,
                    instrumental: false,
                    key: "C",
                    notes: "old notes",
                    performance: {
                        nick: { instrument: "guitar", tuning: "Standard", capo: 0, picking: [] },
                    },
                },
                {
                    id: "song-2",
                    name: "Keep Me",
                    cover: false,
                    instrumental: false,
                    key: "G",
                    notes: "",
                    performance: {
                        nick: { instrument: "guitar", tuning: "DADGAD", capo: 0, picking: [] },
                    },
                },
            ],
        };

        const savedSong = {
            id: "song-1",
            name: "New Name",
            cover: true,
            instrumental: true,
            key: "D",
            notes: "new notes",
        };

        const result = syncSavedSongIntoSetlist(setlist, savedSong, DEFAULT_APP_CONFIG, false);

        expect(result).not.toBe(setlist);
        expect(result.songs[0]).toMatchObject({
            id: "song-1",
            name: "New Name",
            cover: true,
            instrumental: true,
            key: "D",
            notes: "new notes",
        });
        expect(result.songs[1]).toMatchObject({
            id: "song-2",
            name: "Keep Me",
            key: "G",
        });
        expect(result.summary).toBeDefined();
    });

    it("returns the original setlist when the saved song is not present", () => {
        const setlist = {
            summary: { score: 1 },
            songs: [
                {
                    id: "song-1",
                    name: "Only Song",
                    cover: false,
                    instrumental: false,
                    key: "C",
                    notes: "",
                    performance: {
                        nick: { instrument: "guitar", tuning: "Standard", capo: 0, picking: [] },
                    },
                },
            ],
        };

        const result = syncSavedSongIntoSetlist(
            setlist,
            { id: "song-2", name: "Different Song", notes: "no-op" },
            DEFAULT_APP_CONFIG,
            false,
        );

        expect(result).toBe(setlist);
    });
});
