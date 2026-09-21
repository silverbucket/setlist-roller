import { consumeKnownAccountsCorrupted, getAccountToken, getKnownAccounts, saveKnownAccount } from "../accounts.js";
import { nowIso } from "../utils.js";

export function normalizeAuthToken(token) {
    return typeof token === "string" && token.length > 0 ? token : undefined;
}

// Remote connection lifecycle and incremental sync reconciliation.
export function createConnectionStore(repo, stores) {
    // ---- connection ----
    let connectionStatus = $state("pending");
    let connectAddress = $state("");
    let loadError = $state("");

    // ---- sync ----
    // Transient label for the TopBar dot tooltip while a write burst or the
    // connection handshake is in flight. Purely cosmetic.
    let syncStatusLabel = $state("");
    let syncActiveCount = $state(0);
    // High-level sync state for the TopBar dot / RollScreen skeletons:
    // "idle" | "syncing" | "synced" | "error". "synced" is a transient
    // confirmation that fades back to idle.
    let syncState = $state("idle");
    let syncStateTimer = null;
    // True once this account's first full sync has completed — persisted in
    // the mirror ("sync-meta"), so it survives reloads and is per-account.
    // Gates the first-run prompt (we must KNOW there's no remote config, not
    // merely not-have-seen-it-yet) and saved-setlist pruning.
    let initialSyncDone = $state(false);
    // rs.js syncs in back-to-back rounds; sync-done {completed:true} fires
    // after each round, not when the whole tree is in. The only reliable
    // "everything arrived" signal is quiescence: a sync-done followed by one
    // full polling interval with no incoming changes. A single settle timer
    // (armed by sync-done, cancelled by every remote change) encodes that.
    const BOOTSTRAP_SYNC_INTERVAL_MS = 2000; // matches rs.js syncInterval set at construction
    const STEADY_SYNC_INTERVAL_MS = 10000;   // rs.js library default
    const SYNC_SETTLE_MS = BOOTSTRAP_SYNC_INTERVAL_MS + 500;
    let settleTimer = null;
    // If a connect/swap silently never completes (token rejected without an
    // error event, OAuth tab closed), connectionStatus would stay
    // "connecting" and its re-entry guard would lock out retries. This
    // watchdog resets it. The OAuth path gets a much longer window — the
    // user may legitimately be typing a password in the popup.
    const CONNECTING_TIMEOUT_MS = 20000;
    const AUTHING_TIMEOUT_MS = 180000;
    let connectingWatchdogTimer = null;

    // True only when the catalog is safe to treat as authoritative (for
    // pruning setlist references against it). Once an account's initial
    // sync has completed, the mirror-backed in-memory catalog is always
    // complete — later changes arrive incrementally.
    let catalogSettled = $derived(initialSyncDone);

    // ---- sync indicators ----
    function beginSync(label = "Syncing") {
        syncActiveCount += 1;
        syncStatusLabel = label;
    }

    function endSync() {
        syncActiveCount = Math.max(0, syncActiveCount - 1);
        if (syncActiveCount === 0) syncStatusLabel = "";
    }

    async function withSync(label, callback) {
        beginSync(label);
        try {
            return await callback();
        } finally {
            endSync();
        }
    }

    function cancelSettleTimer() {
        if (settleTimer) {
            clearTimeout(settleTimer);
            settleTimer = null;
        }
    }

    function cancelConnectingWatchdog() {
        if (connectingWatchdogTimer) {
            clearTimeout(connectingWatchdogTimer);
            connectingWatchdogTimer = null;
        }
    }

    function armConnectingWatchdog(timeoutMs = CONNECTING_TIMEOUT_MS) {
        cancelConnectingWatchdog();
        connectingWatchdogTimer = setTimeout(() => {
            connectingWatchdogTimer = null;
            if (connectionStatus !== "connecting") return;
            stores.accounts.isSwitching = false;
            if (repo.isConnected()) {
                connectionStatus = "connected";
            } else {
                connectionStatus = "disconnected";
                loadError = "Connection timed out. Try again.";
                stores.ui.toastError(loadError);
                setSyncState("error");
            }
        }, timeoutMs);
    }

    function setSyncState(next) {
        if (syncStateTimer) {
            clearTimeout(syncStateTimer);
            syncStateTimer = null;
        }
        if (next !== "syncing") cancelSettleTimer();
        syncState = next;
        // "synced" is a transient confirmation — fade back to idle.
        if (next === "synced") {
            syncStateTimer = setTimeout(() => {
                if (syncState === "synced") syncState = "idle";
                syncStateTimer = null;
            }, 2500);
        }
    }

    function relaxSyncInterval() {
        try {
            if (repo.getSyncInterval() < STEADY_SYNC_INTERVAL_MS) {
                repo.setSyncInterval(STEADY_SYNC_INTERVAL_MS);
            }
        } catch (_e) {
            // Non-fatal: polling just stays at the bootstrap pace.
        }
    }

    function tightenSyncInterval() {
        try {
            if (repo.getSyncInterval() > BOOTSTRAP_SYNC_INTERVAL_MS) {
                repo.setSyncInterval(BOOTSTRAP_SYNC_INTERVAL_MS);
            }
        } catch (_e) {
            // Non-fatal.
        }
    }

    // Quiescence detector: rs.js fired sync-done and one full polling
    // interval passed with no incoming remote changes — the tree should be
    // in. Every remote change cancels the timer (see onChange in init); the
    // next sync-done re-arms it. Because rs.js syncs in rounds and the
    // early rounds (root + folder listings) fire no change events, the
    // quiet window alone can elapse while the cache is still skeletal — so
    // before declaring the sync settled we verify the cache is coherent,
    // and while we're at it reconcile the mirror against it (documents
    // deleted remotely while this device was away, or while the account
    // was switched out and rs.js's cache was reset, never fire deletion
    // events — this sweep is what removes them locally).
    function armSettleTimer() {
        if (settleTimer || syncState !== "syncing") return;
        const session = stores.accounts.activeSession;
        settleTimer = setTimeout(async () => {
            settleTimer = null;
            if (session !== stores.accounts.activeSession || syncState !== "syncing") return;
            let data = null;
            try {
                data = await repo.loadAll();
            } catch (_e) {
                return; // cache unreadable — a later sync-done retries
            }
            if (session !== stores.accounts.activeSession || syncState !== "syncing") return;
            if ((data.pendingBodies || 0) > 0) return; // bodies still arriving
            if (Object.keys(data.errors || {}).length > 0) return; // partial read — never prune on it
            const cacheEmpty =
                !data.songs?.length &&
                !data.setlists?.length &&
                !Object.keys(data.members || {}).length &&
                !data.config;
            const memoryHasData =
                stores.catalog.songs.length > 0 || stores.catalog.savedSetlists.length > 0 || Object.keys(stores.catalog.bandMembers).length > 0 || !!stores.catalog.appConfig;
            // An empty cache with local data on screen means rs.js hasn't
            // pulled the folder listings yet (fresh cache after a swap) —
            // not that the account is empty. Wait for a later round.
            if (cacheEmpty && memoryHasData) return;

            // The cache is authoritative now: drop anything local it no
            // longer contains.
            const songIds = new Set((data.songs || []).map((s) => s.id));
            for (const song of stores.catalog.songs.filter((s) => !songIds.has(s.id))) stores.catalog.removeSongLocal(song.id);
            const setlistIds = new Set((data.setlists || []).map((s) => s.id));
            for (const setlist of stores.catalog.savedSetlists.filter((s) => !setlistIds.has(s.id))) stores.catalog.removeSetlistLocal(setlist.id);
            const memberNames = new Set(Object.keys(data.members || {}));
            for (const name of Object.keys(stores.catalog.bandMembers).filter((n) => !memberNames.has(n))) stores.catalog.removeMemberLocal(name);
            if (!data.config && stores.catalog.appConfig) stores.catalog.setConfigLocal(null);

            setSyncState("synced");
            if (!initialSyncDone) {
                initialSyncDone = true;
                relaxSyncInterval();
                void stores.accounts.mirror?.putKv("sync-meta", { initialSyncDone: true, completedAt: nowIso() }).catch(() => {});
            }
        }, SYNC_SETTLE_MS);
    }

    // Apply one rs.js change event (remote or conflict origin) to the local
    // catalog. Conflicts take the remote value — same policy rs.js applies
    // to its own cache.
    function applyRemoteChange(event) {
        const path = event?.relativePath || "";
        const value = event?.newValue;
        const hasValue = value && typeof value === "object";
        if (path.startsWith("songs/")) {
            if (hasValue) stores.catalog.upsertSongLocal(value);
            else stores.catalog.removeSongLocal(path.slice("songs/".length));
        } else if (path.startsWith("setlists/")) {
            if (hasValue) stores.catalog.upsertSetlistLocal(value);
            else stores.catalog.removeSetlistLocal(path.slice("setlists/".length));
        } else if (path.startsWith("members/")) {
            const key = path.slice("members/".length);
            if (hasValue) stores.catalog.upsertMemberLocal(value.name || key, value);
            else stores.catalog.removeMemberLocal(key);
        } else if (path === "settings/app-config") {
            stores.catalog.setConfigLocal(hasValue ? value : null);
        } else if (path === "meta/bootstrap") {
            stores.catalog.setBootstrapLocal(hasValue ? value : null);
        }
    }

    // One-time adoption pass for accounts whose documents already sit in
    // rs.js's internal cache but not in our mirror (v2 → v3 upgrade, or a
    // deleted-and-recreated mirror). Unchanged cached documents never re-fire
    // change events, so without this read they'd stay invisible forever.
    // Idempotent: everything goes through the upsert helpers.
    async function seedFromRepoCache(session) {
        try {
            const data = await repo.loadAll();
            if (session !== stores.accounts.activeSession) return;
            for (const song of data.songs || []) stores.catalog.upsertSongLocal(song);
            for (const setlist of data.setlists || []) stores.catalog.upsertSetlistLocal(setlist);
            for (const [name, member] of Object.entries(data.members || {})) stores.catalog.upsertMemberLocal(name, member);
            if (data.config) stores.catalog.setConfigLocal(data.config);
            if (data.bootstrap) stores.catalog.setBootstrapLocal(data.bootstrap);
        } catch (_e) {
            // Cache read failed — the live sync events will fill things in.
        }
    }

    // ---- connection ----
    function connectStorage(token) {
        // Lowercase the whole address: hosts are case-insensitive by DNS, and
        // while acct: local parts are technically case-sensitive, providers
        // only issue lowercase usernames in practice — whereas a stray
        // capital (mobile autocapitalize) breaks WebFinger lookup AND forks
        // the local identity (accountSlot hashes the raw string, the
        // known-accounts registry matches it exactly).
        const trimmed = connectAddress.trim().toLowerCase();
        if (!trimmed) {
            stores.ui.toastError("Put in a remoteStorage address first.");
            return;
        }
        // Address shape validation is webfinger.js's job — it knows the
        // full set of valid remoteStorage address forms (user@host,
        // bare host, IPs, single-label hostnames like `localhost`, etc.)
        // and surfaces real failures via the existing DiscoveryError
        // path. Duplicating that check here would just relitigate the
        // same rules with worse coverage. The empty-input guard above
        // stays because we don't want to send an empty string at all.
        const normalizedToken = normalizeAuthToken(token);
        connectionStatus = "connecting";
        loadError = "";
        syncStatusLabel = "Connecting to remoteStorage";
        armConnectingWatchdog();
        repo.connect(trimmed, normalizedToken);
    }

    // ---- init ----
    function init() {
        stores.ui.syncRouteFromHash();
        window.addEventListener("hashchange", stores.ui.syncRouteFromHash);

        // The known-accounts registry was already read at store-creation time
        // (the `let knownAccounts = $state(getKnownAccounts())` initializer).
        // If that read found a corrupt blob, surface it once now — the
        // accounts module can't show toasts itself.
        if (consumeKnownAccountsCorrupted()) {
            stores.ui.toastWarn("Some local data was unreadable and has been reset.");
        }

        // One-time cleanup of pre-multi-account localStorage keys.
        stores.accounts.clearUnscopedLocalStorage();

        // Local-first boot: hydrate the last active account's mirror
        // immediately. The UI is fully usable on local data while rs.js
        // initializes and re-establishes the remote session in parallel.
        let bootAddress = "";
        try {
            bootAddress = localStorage.getItem(stores.accounts.ACTIVE_ACCOUNT_KEY) || "";
        } catch (_e) { /* storage unavailable */ }
        // Held so the connected handler can await an in-flight boot hydrate
        // for the SAME account instead of racing it.
        let pendingActivation = bootAddress ? stores.accounts.activateAccount(bootAddress) : null;

        // Safety timeout in case RS never fires "connected" or "not-connected"
        // (e.g. library bug or feature loading hangs).
        const safetyTimer = setTimeout(() => {
            if (connectionStatus === "pending") {
                connectionStatus = "disconnected";
            }
        }, 10000);

        // RS fires "not-connected" after features load when there is no
        // stored token and no OAuth redirect params.
        const detachNotConnected = repo.on("not-connected", () => {
            clearTimeout(safetyTimer);
            if (connectionStatus !== "pending") return;
            // rs.js lost its own session but we still have an active local
            // account. If its token is in the registry, re-establish the
            // remote session silently; either way the local data stays up.
            const savedToken = bootAddress ? normalizeAuthToken(getAccountToken(bootAddress)) : undefined;
            if (bootAddress && savedToken) {
                connectionStatus = "connecting";
                armConnectingWatchdog();
                repo.connect(bootAddress, savedToken);
            } else {
                connectionStatus = "disconnected";
            }
        });

        const detachConnecting = repo.on("connecting", () => {
            syncStatusLabel = "Discovering remote storage";
        });
        const detachAuthing = repo.on("authing", () => {
            syncStatusLabel = "Waiting for authorization";
            // The user may be typing a password in the OAuth popup — give
            // this phase the long window.
            if (connectionStatus === "connecting") armConnectingWatchdog(AUTHING_TIMEOUT_MS);
        });
        const detachStandaloneRedirect = repo.on("standalone-auth-redirect", () => {
            syncStatusLabel = "Opening authorization";
        });

        const detachSyncDone = repo.on("sync-done", (event) => {
            // Quiescence detection: sync-done arms the settle timer, any
            // incoming remote change (below) cancels it. One quiet polling
            // interval after a completed round means the tree is in.
            if (event?.completed) armSettleTimer();
        });

        const detachConnected = repo.on("connected", async () => {
            clearTimeout(safetyTimer);
            cancelConnectingWatchdog();
            stores.accounts.isSwitching = false;
            connectionStatus = "connected";
            loadError = "";
            const address = repo.getUserAddress() || connectAddress;
            if (pendingActivation) {
                await pendingActivation;
                pendingActivation = null;
            }
            let session = stores.accounts.activeSession;
            if (address && address !== stores.accounts.currentUserAddress) {
                // Cold connect or OAuth return — adopt the account locally.
                // (Swaps already activated the account before reconnecting.)
                stores.accounts.activeSession += 1;
                session = stores.accounts.activeSession;
                await stores.accounts.activateAccount(address, session);
                if (session !== stores.accounts.activeSession) return;
            }
            if (initialSyncDone) relaxSyncInterval();
            else tightenSyncInterval();
            setSyncState("syncing");
            syncStatusLabel = "Syncing";
            saveKnownAccount(stores.accounts.currentUserAddress, { bandName: stores.catalog.appConfig?.bandName || "" }, repo.getToken());
            stores.accounts.knownAccounts = getKnownAccounts();
            // First sync of this account on this device: also adopt whatever
            // already sits in rs.js's own cache (pre-mirror builds), since
            // unchanged cached documents never re-fire change events.
            if (!initialSyncDone) void seedFromRepoCache(session);
            try {
                await stores.dataIo.runMigrations();
            } catch (err) {
                console.error("Migration failed:", err);
                stores.ui.toastError("Data migration encountered an error. Some data may need re-syncing.");
            }
        });

        const detachDisconnected = repo.on("disconnected", () => {
            // Nothing destructive happens on disconnect anymore — data wipes
            // are explicit (forgetAccount). Mid-swap, the old account's
            // disconnect is an intermediate step; and a "straggler"
            // disconnect can land even after the new account has connected
            // (repo.swap resolves via a safety timeout). Both must not
            // clobber the live connection status.
            if (stores.accounts.isSwitching || repo.isConnected()) return;
            cancelConnectingWatchdog();
            connectionStatus = "disconnected";
            cancelSettleTimer();
            if (syncState !== "error") setSyncState("idle");
        });

        const detachError = repo.on("error", (error) => {
            loadError = error?.message || "remoteStorage error.";
            stores.ui.toastError(loadError);
            setSyncState("error");
            // Auth/discovery failures end the remote session — but local
            // data stays: the user may only need to re-authorize. Transient
            // errors (flaky network, 5xx) are left for rs.js to retry.
            const fatal = error?.name === "Unauthorized" || error?.name === "DiscoveryError";
            if (fatal) {
                stores.accounts.isSwitching = false;
                cancelConnectingWatchdog();
                if (repo.isConnected()) repo.disconnect();
                // Set the status directly — the disconnected event may be
                // skipped by its staleness guard while rs.js still reports
                // connected mid-teardown.
                connectionStatus = "disconnected";
            }
        });

        const detachOffline = repo.on("network-offline", () => {
            cancelSettleTimer();
            if (syncState === "syncing" || syncState === "synced") setSyncState("idle");
            syncStatusLabel = "Offline";
        });
        const detachOnline = repo.on("network-online", () => {
            if (connectionStatus === "connected") {
                setSyncState("syncing");
                syncStatusLabel = "Syncing";
            }
        });

        // Apply remote/conflict changes incrementally — one document at a
        // time, straight into memory + mirror. Local-origin events are
        // echoes of our own optimistic writes (already applied); "window"
        // origin is disabled at the rs.js constructor.
        const detachChange = repo.onChange((event) => {
            if (event?.origin !== "remote" && event?.origin !== "conflict") return;
            if (!stores.accounts.currentUserAddress) return;
            // Mid-swap, in-flight events can still belong to the OLD
            // account's aborted sync — never apply them to the new mirror.
            if (stores.accounts.isSwitching) return;
            cancelSettleTimer();
            if (syncState !== "error") setSyncState("syncing");
            applyRemoteChange(event);
        });

        return () => {
            window.removeEventListener("hashchange", stores.ui.syncRouteFromHash);
            clearTimeout(safetyTimer);
            if (syncStateTimer) clearTimeout(syncStateTimer);
            cancelSettleTimer();
            cancelConnectingWatchdog();
            stores.band.cancelConfigSave();
            detachConnecting();
            detachAuthing();
            detachStandaloneRedirect();
            detachSyncDone();
            detachConnected();
            detachDisconnected();
            detachNotConnected();
            detachError();
            detachOffline();
            detachOnline();
            detachChange();
            try { stores.accounts.mirror?.close(); } catch (_e) { /* already closed */ }
            stores.accounts.mirror = null;
        };
    }

    return {
        get connectionStatus() { return connectionStatus; },
        set connectionStatus(value) { connectionStatus = value; },
        get initialSyncDone() { return initialSyncDone; },
        set initialSyncDone(value) { initialSyncDone = value; },
        get catalogSettled() { return catalogSettled; },
        get loadError() { return loadError; },
        set loadError(value) { loadError = value; },
        setSyncState,
        get connectAddress() { return connectAddress; },
        set connectAddress(value) { connectAddress = value; },
        get syncStatusLabel() { return syncStatusLabel; },
        set syncStatusLabel(value) { syncStatusLabel = value; },
        armConnectingWatchdog,
        normalizeAuthToken,
        withSync,
        get syncActiveCount() { return syncActiveCount; },
        get syncState() { return syncState; },
        init,
        connectStorage,
    };
}
