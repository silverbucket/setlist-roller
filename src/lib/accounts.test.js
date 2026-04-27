import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    accountSlot,
    getAccountToken,
    getKnownAccounts,
    getKnownAccountsRaw,
    KNOWN_ACCOUNTS_KEY,
    removeKnownAccountEntry,
    saveKnownAccount,
} from "./accounts.js";

// ===================================================================
// localStorage stub
// ===================================================================
let store;

beforeEach(() => {
    store = {};
    globalThis.localStorage = {
        getItem: (k) => store[k] ?? null,
        setItem: (k, v) => {
            store[k] = String(v);
        },
        removeItem: (k) => {
            delete store[k];
        },
    };
    vi.spyOn(Date.prototype, "toISOString").mockReturnValue("2026-04-09T12:00:00.000Z");
});

afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.localStorage;
});

// ===================================================================
// accountSlot
// ===================================================================
describe("accountSlot", () => {
    it("returns unscoped key when no user address", () => {
        expect(accountSlot("").key("snapshot")).toBe("setlist-roller-snapshot");
        expect(accountSlot(undefined).key("snapshot")).toBe("setlist-roller-snapshot");
    });

    it("returns hashed key for a user address", () => {
        expect(accountSlot("alice@example.com").key("snapshot")).toMatch(/^setlist-roller-snapshot-[a-z0-9]+$/);
    });

    it("produces different keys for different addresses", () => {
        const a = accountSlot("alice@example.com").key("snapshot");
        const b = accountSlot("bob@example.com").key("snapshot");
        expect(a).not.toBe(b);
    });

    it("produces the same key for the same address", () => {
        const a = accountSlot("alice@example.com").key("snapshot");
        const b = accountSlot("alice@example.com").key("snapshot");
        expect(a).toBe(b);
    });

    it("produces different keys for different bases", () => {
        const slot = accountSlot("alice@example.com");
        expect(slot.key("snapshot")).not.toBe(slot.key("opts"));
    });

    it("exposes the address", () => {
        expect(accountSlot("alice@example.com").address).toBe("alice@example.com");
    });

    it("isolates keys between accounts", () => {
        expect(accountSlot("a@x").key("snapshot")).not.toBe(accountSlot("b@x").key("snapshot"));
    });
});

// ===================================================================
// saveKnownAccount / getKnownAccounts / getKnownAccountsRaw
// ===================================================================
describe("saveKnownAccount", () => {
    it("adds a new account with metadata", () => {
        saveKnownAccount("alice@example.com", { bandName: "The Band" }, "tok_alice");
        const raw = getKnownAccountsRaw();
        expect(raw).toHaveLength(1);
        expect(raw[0]).toMatchObject({
            address: "alice@example.com",
            metadata: { bandName: "The Band" },
            token: "tok_alice",
            lastUsed: "2026-04-09T12:00:00.000Z",
        });
    });

    it("merges metadata on upsert without dropping existing fields", () => {
        saveKnownAccount("alice@example.com", { bandName: "Old Name", color: "red" }, "tok_1");
        saveKnownAccount("alice@example.com", { bandName: "New Name" }, "tok_2");
        const raw = getKnownAccountsRaw();
        expect(raw).toHaveLength(1);
        expect(raw[0].metadata).toEqual({ bandName: "New Name", color: "red" });
        expect(raw[0].token).toBe("tok_2");
    });

    it("ignores empty/nullish incoming metadata fields", () => {
        saveKnownAccount("alice@example.com", { bandName: "The Band" }, "tok_1");
        saveKnownAccount("alice@example.com", { bandName: "" }, "tok_2");
        expect(getKnownAccountsRaw()[0].metadata.bandName).toBe("The Band");
    });

    it("keeps existing token when new one is falsy", () => {
        saveKnownAccount("alice@example.com", { bandName: "Band" }, "tok_1");
        saveKnownAccount("alice@example.com", { bandName: "Band" }, "");
        expect(getKnownAccountsRaw()[0].token).toBe("tok_1");
    });

    it("does nothing for empty address", () => {
        saveKnownAccount("", { bandName: "Band" }, "tok");
        expect(getKnownAccountsRaw()).toHaveLength(0);
    });

    it("stores multiple accounts", () => {
        saveKnownAccount("alice@example.com", { bandName: "Band A" }, "tok_a");
        saveKnownAccount("bob@example.com", { bandName: "Band B" }, "tok_b");
        expect(getKnownAccountsRaw()).toHaveLength(2);
    });

    it("tolerates undefined metadata", () => {
        saveKnownAccount("alice@example.com", undefined, "tok_a");
        expect(getKnownAccountsRaw()[0].metadata).toEqual({});
    });
});

describe("getKnownAccounts", () => {
    it("strips tokens from the returned list", () => {
        saveKnownAccount("alice@example.com", { bandName: "Band" }, "secret_token");
        const accounts = getKnownAccounts();
        expect(accounts).toHaveLength(1);
        expect(accounts[0]).toEqual({
            address: "alice@example.com",
            metadata: { bandName: "Band" },
            lastUsed: "2026-04-09T12:00:00.000Z",
        });
        expect(accounts[0]).not.toHaveProperty("token");
    });

    it("returns empty array when no accounts stored", () => {
        expect(getKnownAccounts()).toEqual([]);
    });

    it("returns empty array for corrupted localStorage", () => {
        store[KNOWN_ACCOUNTS_KEY] = "not-json{{{";
        expect(getKnownAccounts()).toEqual([]);
    });

    it("sorts by lastUsed descending", () => {
        store[KNOWN_ACCOUNTS_KEY] = JSON.stringify([
            { address: "old@x.com", metadata: { bandName: "Old" }, lastUsed: "2026-01-01T00:00:00.000Z" },
            { address: "new@x.com", metadata: { bandName: "New" }, lastUsed: "2026-04-01T00:00:00.000Z" },
        ]);
        const accounts = getKnownAccounts();
        expect(accounts[0].address).toBe("new@x.com");
        expect(accounts[1].address).toBe("old@x.com");
    });

    it("migrates legacy { bandName } entries to { metadata: { bandName } }", () => {
        store[KNOWN_ACCOUNTS_KEY] = JSON.stringify([
            { address: "legacy@x.com", bandName: "Legacy Band", token: "tok", lastUsed: "2026-01-01T00:00:00.000Z" },
        ]);
        const [account] = getKnownAccounts();
        expect(account.metadata).toEqual({ bandName: "Legacy Band" });
    });

    it("migrates legacy entries that have no bandName to empty metadata", () => {
        store[KNOWN_ACCOUNTS_KEY] = JSON.stringify([
            { address: "legacy@x.com", token: "tok", lastUsed: "2026-01-01T00:00:00.000Z" },
        ]);
        const [account] = getKnownAccounts();
        expect(account.metadata).toEqual({});
    });
});

// ===================================================================
// getAccountToken
// ===================================================================
describe("getAccountToken", () => {
    it("returns token for a known account", () => {
        saveKnownAccount("alice@example.com", { bandName: "Band" }, "tok_alice");
        expect(getAccountToken("alice@example.com")).toBe("tok_alice");
    });

    it("returns empty string for unknown account", () => {
        expect(getAccountToken("unknown@example.com")).toBe("");
    });

    it("returns empty string when no accounts exist", () => {
        expect(getAccountToken("anyone@example.com")).toBe("");
    });

    it("reads tokens from migrated legacy entries", () => {
        store[KNOWN_ACCOUNTS_KEY] = JSON.stringify([
            { address: "legacy@x.com", bandName: "Legacy", token: "legacy_tok", lastUsed: "2026-01-01T00:00:00.000Z" },
        ]);
        expect(getAccountToken("legacy@x.com")).toBe("legacy_tok");
    });
});

// ===================================================================
// removeKnownAccountEntry
// ===================================================================
describe("removeKnownAccountEntry", () => {
    it("removes the specified account", () => {
        saveKnownAccount("alice@example.com", { bandName: "Band A" }, "tok_a");
        saveKnownAccount("bob@example.com", { bandName: "Band B" }, "tok_b");
        removeKnownAccountEntry("alice@example.com");
        const accounts = getKnownAccountsRaw();
        expect(accounts).toHaveLength(1);
        expect(accounts[0].address).toBe("bob@example.com");
    });

    it("does nothing for unknown address", () => {
        saveKnownAccount("alice@example.com", { bandName: "Band A" }, "tok_a");
        removeKnownAccountEntry("unknown@example.com");
        expect(getKnownAccountsRaw()).toHaveLength(1);
    });

    it("does nothing for empty address", () => {
        saveKnownAccount("alice@example.com", { bandName: "Band A" }, "tok_a");
        removeKnownAccountEntry("");
        expect(getKnownAccountsRaw()).toHaveLength(1);
    });

    it("handles removing the last account", () => {
        saveKnownAccount("alice@example.com", { bandName: "Band A" }, "tok_a");
        removeKnownAccountEntry("alice@example.com");
        expect(getKnownAccountsRaw()).toEqual([]);
    });
});
