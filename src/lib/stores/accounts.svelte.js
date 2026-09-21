import { accountSlot, getAccountToken, getKnownAccounts, removeKnownAccountEntry, saveKnownAccount } from "../accounts.js";
import { normalizeAppConfig, normalizeMemberRecord, normalizeSongRecord, sortSongs } from "../defaults.js";
import { deleteAccountDb, openAccountDb } from "../local-db.js";
import { migrator } from "../migrations.js";
import { deepMerge } from "../utils.js";

const STORAGE_PREFIX = "setlist-roller";

// localStorage key remembering which account was active when the app was
// last open. Lets a cold boot hydrate that account's local mirror and show
// the full UI immediately — before (and regardless of whether) remoteStorage
// re-establishes its session.
const ACTIVE_ACCOUNT_KEY = `${STORAGE_PREFIX}-active-account`;

// Account identity, local hydration, switching, and stale-write guards.
export function createAccountsStore(repo, stores) {
    // ---- per-user localStorage scoping ----
    // $state is load-bearing: App.svelte's top-level render gate reads this
    // first in a short-circuiting condition. If it were a plain variable,
    // the {#if} would capture no reactive dependencies while it's truthy
    // and never re-evaluate — the app shell would survive a sign-out.
    let currentUserAddress = $state("");
    function storageKey(base) { return accountSlot(currentUserAddress).key(base); }

    // Monotonic session id — bumped on every connect/swap. Async work that
    // started under one session is discarded if the session has moved on.
    let activeSession = 0;

    // True while orchestrating an account swap. Tells the `disconnected`
    // handler that the mid-swap disconnect of the old account is an
    // intermediate step, not a real sign-out. Nothing destructive hangs off
    // the disconnect path anymore (data wipes are explicit, see
    // forgetAccount), so a stale flag can no longer eat anyone's data.
    let isSwitching = false;

    // Per-account IndexedDB mirror — the local source of truth the UI
    // hydrates from at boot and every accepted change is written back to.
    // Null when no account is active or IndexedDB is unavailable (private
    // browsing); the app then runs memory-only like the pre-v3 builds.
    let mirror = null;
    let knownAccounts = $state(getKnownAccounts());
    // True once the active account's local mirror has been read into memory.
    // The UI renders as soon as an account is active; this only guards the
    // brief (<50 ms) window before local data lands, so empty-state CTAs
    // don't flash.
    let hydrated = $state(false);

    // Remove any un-scoped legacy localStorage keys so they can't leak between
    // accounts. Called once per boot from init() — that's the migration path
    // for users coming from the pre-multi-account build, where these keys
    // were written without the per-account hash. Idempotent and cheap.
    function clearUnscopedLocalStorage() {
        if (typeof localStorage === "undefined") return;
        localStorage.removeItem("setlist-roller-ui-options");
        localStorage.removeItem("setlist-roller-saved-sets");
        localStorage.removeItem("setlist-roller-current-set");
    }

    // Async-write staleness guard. Capture at the start of any action that
    // awaits repo I/O and check after each await: if the user switched (or
    // signed out of) the account mid-flight, the result belongs to the OLD
    // account and must not be applied to the newly active mirror/state.
    function sessionGuard() {
        const session = activeSession;
        return () => session === activeSession;
    }

    // Keep the account switcher's label in step with the config. The
    // `connected` handler saves the account before the config has arrived
    // (first login, first-run setup), so without this the menu shows
    // "Unnamed" until the next disconnect or settings save.
    function rememberBandName(bandName) {
        if (!currentUserAddress || !bandName) return;
        const known = knownAccounts.find((a) => a.address === currentUserAddress);
        if (known?.metadata?.bandName === bandName) return;
        saveKnownAccount(currentUserAddress, { bandName }, repo.getToken());
        knownAccounts = getKnownAccounts();
    }

    /**
     * Sign out of the remote session and return to the login screen. The
     * account's local mirror and scoped localStorage are KEPT — this is
     * "switch away", not "remove my data from this device" (that's
     * forgetAccount). Keeping the mirror is what makes returning to the
     * account instant and offline-capable.
     */
    function disconnectStorage() {
        if (currentUserAddress) {
            saveKnownAccount(currentUserAddress, { bandName: stores.catalog.appConfig?.bandName || "" }, repo.getToken());
        }
        activeSession += 1;
        deactivateAccount();
        repo.disconnect();
        // Don't wait for the `disconnected` event: rs.js can still report
        // connected=true while emitting it, which the handler's staleness
        // guard (rightly) skips. This is an explicit user action — the
        // status change is unconditional.
        stores.connection.connectionStatus = "disconnected";
        knownAccounts = getKnownAccounts();
    }

    /** Blank the in-memory state and detach the mirror (data stays on disk). */
    function deactivateAccount() {
        stores.generation.terminateWorker();
        stores.generation.isGenerating = false;
        stores.band.cancelConfigSave();
        try { mirror?.close(); } catch (_e) { /* already closed */ }
        mirror = null;
        try { localStorage.removeItem(ACTIVE_ACCOUNT_KEY); } catch (_e) { /* unavailable */ }
        currentUserAddress = "";
        hydrated = false;
        stores.connection.initialSyncDone = false;
        stores.catalog.songs = [];
        stores.catalog.appConfig = null;
        stores.catalog.bootstrapMeta = null;
        stores.generation.clearGeneratedSetlist();
        stores.generation.setlistLocked = false;
        stores.generation.setlistSaved = false;
        stores.catalog.savedSetlists = [];
        stores.catalog.bandMembers = {};
        stores.songEditor.selectedSongId = "";
        stores.songEditor.editorSong = null;
        stores.connection.loadError = "";
        stores.connection.setSyncState("idle");
    }

    /**
     * Make `address` the active local account: open its mirror and hydrate
     * the UI from it. Pure local operation — no network, no remoteStorage.
     * The caller decides whether/how to establish the remote session.
     */
    async function activateAccount(address, session = activeSession) {
        currentUserAddress = address;
        stores.connection.connectAddress = address;
        hydrated = false;
        stores.connection.initialSyncDone = false;
        try { mirror?.close(); } catch (_e) { /* already closed */ }
        mirror = null;
        try { localStorage.setItem(ACTIVE_ACCOUNT_KEY, address); } catch (_e) { /* unavailable */ }

        let data = null;
        try {
            const db = await openAccountDb(address);
            if (session !== activeSession) {
                db.close();
                return;
            }
            mirror = db;
            data = await db.loadAll();
            if (session !== activeSession) return;
        } catch (error) {
            // IndexedDB unavailable (private browsing) or unreadable. Run
            // memory-only: the seed pass + live sync will fill the UI once
            // the remote session is up.
            if (import.meta.env?.DEV) {
                console.warn("[app] activateAccount: mirror unavailable", error);
            }
        }

        stores.catalog.songs = sortSongs((data?.songs || []).map(normalizeSongRecord));
        stores.catalog.appConfig = data?.config ? normalizeAppConfig(data.config) : null;
        stores.catalog.savedSetlists = (data?.setlists || [])
            .map((s) => migrator.migrateDocument("setlists", s))
            .sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || ""));
        stores.catalog.bandMembers = Object.fromEntries(
            Object.entries(data?.members || {}).map(([name, d]) => [name, normalizeMemberRecord(d)]),
        );
        stores.catalog.bootstrapMeta = data?.bootstrap || null;
        stores.connection.initialSyncDone = !!data?.syncMeta?.initialSyncDone;
        stores.generation.loadUserLocalData();
        if (stores.catalog.appConfig) {
            stores.generation.generationOptions = deepMerge(stores.generation.defaultGenerationOptions(stores.catalog.appConfig), stores.generation.generationOptions || {});
        }
        hydrated = true;
    }

    /**
     * Switch to another known account. Local data appears instantly from
     * that account's mirror; the remote session is re-established in the
     * background. Works fully offline (the swap just fails quietly and the
     * dot shows disconnected).
     */
    async function connectToAccount(address) {
        if (stores.connection.connectionStatus === "connecting" || isSwitching) {
            stores.ui.toastWarn("Already connecting — hold on.");
            return;
        }
        if (!address) return;
        if (address === currentUserAddress && repo.isConnected()) return;

        isSwitching = true;
        try {
            // Persist the current account's metadata + token for the trip back.
            if (repo.isConnected() && currentUserAddress) {
                saveKnownAccount(currentUserAddress, { bandName: stores.catalog.appConfig?.bandName || "" }, repo.getToken());
            }

            // New session: in-flight async from the previous account is stale.
            activeSession += 1;

            // Clear transient per-session state, then hydrate the target
            // account's local data for instant UI.
            stores.generation.clearGeneratedSetlist();
            stores.generation.setlistLocked = false;
            stores.generation.setlistSaved = false;
            stores.generation.pendingRollConfirm = false;
            stores.songEditor.selectedSongId = "";
            stores.songEditor.editorSong = null;
            // Enter "syncing" BEFORE the hydrate await: the old account's
            // transient "synced" state must not be observable against the
            // new account's address.
            stores.connection.setSyncState("syncing");
            stores.connection.syncStatusLabel = "Switching accounts";
            await activateAccount(address);

            stores.connection.connectionStatus = "connecting";
            stores.connection.armConnectingWatchdog();
            const savedToken = stores.connection.normalizeAuthToken(getAccountToken(address));
            if (repo.isConnected()) {
                await repo.swap(address, savedToken);
            } else {
                repo.connect(address, savedToken);
            }
            // The `connected` handler finishes the job (status, seed,
            // migrations). If the connection never lands, the user still has
            // the account's local data — nothing is stuck behind a spinner.
        } catch (error) {
            stores.ui.toastError(error?.message || "Could not switch accounts.");
            stores.connection.connectionStatus = repo.isConnected() ? "connected" : "disconnected";
            stores.connection.setSyncState("error");
        } finally {
            isSwitching = false;
        }
    }

    // Per-account localStorage bases owned by the app. Keep this list in sync
    // with anything that reads/writes via accountSlot(address).key(...).
    // "snapshot" is legacy (pre-v3 instant-swap blobs) — still cleared on
    // forget so upgraded installs don't leave old data behind.
    const PER_ACCOUNT_STORAGE_BASES = ["snapshot", "ui-options", "current-set", "saved-sets"];

    /**
     * Remove an account from this device: registry entry, auth token,
     * scoped localStorage, and its entire local mirror database.
     */
    function forgetAccount(address) {
        removeKnownAccountEntry(address);
        if (typeof localStorage !== "undefined") {
            const slot = accountSlot(address);
            for (const base of PER_ACCOUNT_STORAGE_BASES) {
                localStorage.removeItem(slot.key(base));
            }
        }
        if (address === currentUserAddress) {
            // Invalidate in-flight async work tied to the account being
            // forgotten, same as disconnectStorage().
            activeSession += 1;
            deactivateAccount();
        }
        void deleteAccountDb(address).catch(() => {});
        knownAccounts = getKnownAccounts();
    }

    return {
        get hydrated() { return hydrated; },
        storageKey,
        get isSwitching() { return isSwitching; },
        set isSwitching(value) { isSwitching = value; },
        get activeSession() { return activeSession; },
        set activeSession(value) { activeSession = value; },
        get mirror() { return mirror; },
        set mirror(value) { mirror = value; },
        rememberBandName,
        sessionGuard,
        get currentUserAddress() { return currentUserAddress; },
        clearUnscopedLocalStorage,
        get ACTIVE_ACCOUNT_KEY() { return ACTIVE_ACCOUNT_KEY; },
        activateAccount,
        get knownAccounts() { return knownAccounts; },
        set knownAccounts(value) { knownAccounts = value; },
        connectToAccount,
        forgetAccount,
        disconnectStorage,
    };
}
