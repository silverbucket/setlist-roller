import { accountSlot } from "./accounts.js";

// Per-account IndexedDB mirror of the user's remoteStorage documents.
//
// This is the app's local source of truth: the UI hydrates from it
// synchronously-fast at boot (no network, no remoteStorage init), and the
// sync layer writes every accepted change back into it. remotestorage.js
// keeps its own internal cache, but that cache is shared across accounts
// and gets reset on every account switch — the mirror is what makes
// per-account offline-first switching possible.
//
// One database per account (name derived from the same address hash used
// for localStorage scoping), so wiping an account is a single
// deleteAccountDb() and accounts can never read each other's stores.

const DB_VERSION = 1;

const STORE_DEFS = [
    ["songs", { keyPath: "id" }],
    ["setlists", { keyPath: "id" }],
    ["members", { keyPath: "name" }],
    // Singleton documents (config, bootstrap, sync meta) keyed explicitly.
    ["kv", {}],
];

export function accountDbName(address) {
    return accountSlot(address).key("db");
}

function requestToPromise(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
    });
}

function withStore(db, storeName, mode, run) {
    return new Promise((resolve, reject) => {
        let result;
        let tx;
        try {
            tx = db.transaction(storeName, mode);
        } catch (error) {
            reject(error);
            return;
        }
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
        tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
        try {
            const maybePromise = run(tx.objectStore(storeName), (value) => {
                result = value;
            });
            if (maybePromise?.catch) maybePromise.catch(reject);
        } catch (error) {
            try {
                tx.abort();
            } catch (_e) {
                /* already aborted */
            }
            reject(error);
        }
    });
}

/**
 * Open (creating if needed) the mirror database for an account.
 * Returns a small promise-based wrapper; call close() when switching away.
 */
export async function openAccountDb(address) {
    if (!address) throw new Error("openAccountDb requires an account address");
    if (typeof indexedDB === "undefined") throw new Error("IndexedDB is not available");

    const name = accountDbName(address);
    const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(name, DB_VERSION);
        request.onupgradeneeded = () => {
            const database = request.result;
            for (const [storeName, options] of STORE_DEFS) {
                if (!database.objectStoreNames.contains(storeName)) {
                    database.createObjectStore(storeName, options);
                }
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error(`Could not open ${name}`));
    });

    async function getAll(storeName) {
        return withStore(db, storeName, "readonly", async (store, setResult) => {
            setResult(await requestToPromise(store.getAll()));
        });
    }

    return {
        address,

        /** Read every collection in one go — the boot/switch hydrate path. */
        async loadAll() {
            const [songs, setlists, members, kvEntries] = await Promise.all([
                getAll("songs"),
                getAll("setlists"),
                getAll("members"),
                withStore(db, "kv", "readonly", async (store, setResult) => {
                    const [keys, values] = await Promise.all([
                        requestToPromise(store.getAllKeys()),
                        requestToPromise(store.getAll()),
                    ]);
                    setResult(Object.fromEntries(keys.map((key, i) => [key, values[i]])));
                }),
            ]);
            return {
                songs,
                setlists,
                members: Object.fromEntries(members.map((m) => [m.name, m])),
                config: kvEntries.config ?? null,
                bootstrap: kvEntries.bootstrap ?? null,
                syncMeta: kvEntries["sync-meta"] ?? null,
            };
        },

        putSong(song) {
            return withStore(db, "songs", "readwrite", (store) => {
                store.put(song);
            });
        },
        deleteSong(id) {
            return withStore(db, "songs", "readwrite", (store) => {
                store.delete(id);
            });
        },
        putSetlist(setlist) {
            return withStore(db, "setlists", "readwrite", (store) => {
                store.put(setlist);
            });
        },
        deleteSetlist(id) {
            return withStore(db, "setlists", "readwrite", (store) => {
                store.delete(id);
            });
        },
        putMember(member) {
            return withStore(db, "members", "readwrite", (store) => {
                store.put(member);
            });
        },
        deleteMember(name) {
            return withStore(db, "members", "readwrite", (store) => {
                store.delete(name);
            });
        },
        putKv(key, value) {
            return withStore(db, "kv", "readwrite", (store) => {
                store.put(value, key);
            });
        },
        deleteKv(key) {
            return withStore(db, "kv", "readwrite", (store) => {
                store.delete(key);
            });
        },
        getKv(key) {
            return withStore(db, "kv", "readonly", async (store, setResult) => {
                setResult(await requestToPromise(store.get(key)));
            });
        },

        close() {
            db.close();
        },
    };
}

/**
 * Delete an account's mirror database entirely (logout / forget).
 * Any open wrapper for this account must be close()d first, otherwise the
 * deletion blocks until that connection goes away.
 */
export function deleteAccountDb(address) {
    if (!address || typeof indexedDB === "undefined") return Promise.resolve();
    return new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(accountDbName(address));
        request.onsuccess = () => resolve();
        // `blocked` still completes once the blocking connection closes;
        // treat it as success so a stray open tab can't wedge a logout.
        request.onblocked = () => resolve();
        request.onerror = () => reject(request.error || new Error("Could not delete account database"));
    });
}
