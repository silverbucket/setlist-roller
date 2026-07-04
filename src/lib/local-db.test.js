import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { accountDbName, deleteAccountDb, openAccountDb } from "./local-db.js";

const ADDRESS_A = "alice@example.com";
const ADDRESS_B = "bob@example.com";

beforeEach(() => {
    // Fresh IndexedDB universe per test.
    globalThis.indexedDB = new IDBFactory();
});

describe("accountDbName", () => {
    it("derives distinct names per address", () => {
        expect(accountDbName(ADDRESS_A)).not.toBe(accountDbName(ADDRESS_B));
        expect(accountDbName(ADDRESS_A)).toMatch(/^setlist-roller-db-/);
    });

    it("is stable for the same address", () => {
        expect(accountDbName(ADDRESS_A)).toBe(accountDbName(ADDRESS_A));
    });
});

describe("openAccountDb", () => {
    it("rejects without an address", async () => {
        await expect(openAccountDb("")).rejects.toThrow(/address/);
    });

    it("starts empty", async () => {
        const db = await openAccountDb(ADDRESS_A);
        const data = await db.loadAll();
        expect(data).toEqual({
            songs: [],
            setlists: [],
            members: {},
            config: null,
            bootstrap: null,
            syncMeta: null,
        });
        db.close();
    });

    it("round-trips songs, setlists, and members", async () => {
        const db = await openAccountDb(ADDRESS_A);
        await db.putSong({ id: "s1", name: "Thunder Road" });
        await db.putSong({ id: "s2", name: "Atlantic City" });
        await db.putSetlist({ id: "set1", name: "Friday", savedAt: "2026-01-01" });
        await db.putMember({ name: "Nick", instruments: [] });

        const data = await db.loadAll();
        expect(data.songs.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
        expect(data.setlists).toEqual([{ id: "set1", name: "Friday", savedAt: "2026-01-01" }]);
        expect(data.members).toEqual({ Nick: { name: "Nick", instruments: [] } });
        db.close();
    });

    it("upserts on repeated put of the same key", async () => {
        const db = await openAccountDb(ADDRESS_A);
        await db.putSong({ id: "s1", name: "Old Name" });
        await db.putSong({ id: "s1", name: "New Name" });
        const data = await db.loadAll();
        expect(data.songs).toEqual([{ id: "s1", name: "New Name" }]);
        db.close();
    });

    it("deletes documents", async () => {
        const db = await openAccountDb(ADDRESS_A);
        await db.putSong({ id: "s1", name: "Gone Soon" });
        await db.putMember({ name: "Nick", instruments: [] });
        await db.deleteSong("s1");
        await db.deleteMember("Nick");
        const data = await db.loadAll();
        expect(data.songs).toEqual([]);
        expect(data.members).toEqual({});
        db.close();
    });

    it("stores config, bootstrap, and sync meta in kv", async () => {
        const db = await openAccountDb(ADDRESS_A);
        await db.putKv("config", { bandName: "The Rollers" });
        await db.putKv("bootstrap", { source: "test" });
        await db.putKv("sync-meta", { initialSyncDone: true });
        const data = await db.loadAll();
        expect(data.config).toEqual({ bandName: "The Rollers" });
        expect(data.bootstrap).toEqual({ source: "test" });
        expect(data.syncMeta).toEqual({ initialSyncDone: true });
        expect(await db.getKv("config")).toEqual({ bandName: "The Rollers" });
        await db.deleteKv("config");
        expect(await db.getKv("config")).toBeUndefined();
        db.close();
    });

    it("isolates accounts from each other", async () => {
        const dbA = await openAccountDb(ADDRESS_A);
        const dbB = await openAccountDb(ADDRESS_B);
        await dbA.putSong({ id: "s1", name: "Alice Only" });

        expect((await dbB.loadAll()).songs).toEqual([]);
        expect((await dbA.loadAll()).songs).toHaveLength(1);
        dbA.close();
        dbB.close();
    });
});

describe("deleteAccountDb", () => {
    it("wipes one account's data and leaves others intact", async () => {
        const dbA = await openAccountDb(ADDRESS_A);
        const dbB = await openAccountDb(ADDRESS_B);
        await dbA.putSong({ id: "s1", name: "Alice Only" });
        await dbB.putSong({ id: "s2", name: "Bob Only" });
        dbA.close();

        await deleteAccountDb(ADDRESS_A);

        const reopenedA = await openAccountDb(ADDRESS_A);
        expect((await reopenedA.loadAll()).songs).toEqual([]);
        expect((await dbB.loadAll()).songs).toHaveLength(1);
        reopenedA.close();
        dbB.close();
    });

    it("resolves for a missing address", async () => {
        await expect(deleteAccountDb("")).resolves.toBeUndefined();
    });
});
