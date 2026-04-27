import { nowIso } from "./utils.js";

const STORAGE_PREFIX = "setlist-roller";
export const KNOWN_ACCOUNTS_KEY = `${STORAGE_PREFIX}-known-accounts`;

/**
 * Hash a per-account suffix so app-owned localStorage keys (snapshots, UI
 * options, etc.) don't leak between accounts. Internal helper — callers
 * should use accountSlot(address).key(base).
 */
function scopedKey(base, userAddress) {
    if (!userAddress) return `${STORAGE_PREFIX}-${base}`;
    let h = 0;
    for (let i = 0; i < userAddress.length; i++) {
        h = ((h << 5) - h + userAddress.charCodeAt(i)) | 0;
    }
    return `${STORAGE_PREFIX}-${base}-${(h >>> 0).toString(36)}`;
}

/**
 * Per-account namespace for app-owned local data. The registry doesn't read
 * these slots — the app owns their schema. Keep the surface small so it
 * survives a future extraction into a standalone library.
 */
export function accountSlot(address) {
    return {
        address,
        key: (base) => scopedKey(base, address),
    };
}

// Back-compat: legacy entries stored { bandName }; new entries store
// { metadata: { bandName, ... } }. Normalize on read.
function normalizeEntry(entry) {
    if (!entry || typeof entry !== "object") return null;
    if (entry.metadata && typeof entry.metadata === "object") return entry;
    const { bandName, ...rest } = entry;
    return { ...rest, metadata: bandName ? { bandName } : {} };
}

// Drop empty/nullish fields from incoming metadata so callers can pass
// partial updates without clobbering existing values.
function pruneMetadata(metadata) {
    if (!metadata || typeof metadata !== "object") return {};
    const result = {};
    for (const [k, v] of Object.entries(metadata)) {
        if (v !== "" && v !== null && v !== undefined) result[k] = v;
    }
    return result;
}

export function getKnownAccountsRaw() {
    if (typeof localStorage === "undefined") return [];
    try {
        const raw = localStorage.getItem(KNOWN_ACCOUNTS_KEY);
        const list = raw ? JSON.parse(raw) : [];
        return list
            .map(normalizeEntry)
            .filter(Boolean)
            .sort((a, b) => (b.lastUsed || "").localeCompare(a.lastUsed || ""));
    } catch {
        return [];
    }
}

export function getKnownAccounts() {
    return getKnownAccountsRaw().map(({ address, metadata, lastUsed }) => ({ address, metadata, lastUsed }));
}

export function saveKnownAccount(address, metadata, token) {
    if (typeof localStorage === "undefined" || !address) return;
    const list = getKnownAccountsRaw();
    const incoming = pruneMetadata(metadata);
    const existing = list.find((a) => a.address === address);
    if (existing) {
        existing.metadata = { ...existing.metadata, ...incoming };
        if (token) existing.token = token;
        existing.lastUsed = nowIso();
    } else {
        list.push({ address, metadata: incoming, token: token || "", lastUsed: nowIso() });
    }
    localStorage.setItem(KNOWN_ACCOUNTS_KEY, JSON.stringify(list));
}

export function getAccountToken(address) {
    return getKnownAccountsRaw().find((a) => a.address === address)?.token || "";
}

export function removeKnownAccountEntry(address) {
    if (typeof localStorage === "undefined" || !address) return;
    const list = getKnownAccountsRaw().filter((a) => a.address !== address);
    localStorage.setItem(KNOWN_ACCOUNTS_KEY, JSON.stringify(list));
}
