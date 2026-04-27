<script>
    import { onMount, setContext } from "svelte";
    import BandScreen from "./lib/components/band/BandScreen.svelte";
    import HelpScreen from "./lib/components/help/HelpScreen.svelte";
    import BottomNav from "./lib/components/layout/BottomNav.svelte";
    import TopBar from "./lib/components/layout/TopBar.svelte";
    import RollScreen from "./lib/components/roll/RollScreen.svelte";
    import SavedScreen from "./lib/components/saved/SavedScreen.svelte";
    import SongsScreen from "./lib/components/songs/SongsScreen.svelte";
    import { generateDieSvgString, updatePwaIcons } from "./lib/pwa-icon.js";
    import { createRemoteStorageRepository, isIosStandaloneAuthContext } from "./lib/remotestorage.js";
    import { createAppStore } from "./lib/stores/app.svelte.js";
    import { DEFAULT_DIE_COLOR, darkenHex, hexToRgb, hexToRgba } from "./lib/utils.js";

    // Test escape hatch: tests inject a fake in-memory repo via window
    // before the app boots. Production code path is unchanged.
    const repo =
        (typeof window !== "undefined" && typeof window.__SR_TEST_REPO_FACTORY__ === "function"
            ? window.__SR_TEST_REPO_FACTORY__()
            : null) || createRemoteStorageRepository();
    const store = createAppStore(repo);
    setContext("app", store);

    if (typeof window !== "undefined" && window.__SR_TEST__) {
        // Expose store to tests for state-based assertions and seeding helpers.
        window.__SR_STORE__ = store;
        window.__SR_REPO__ = repo;
    }

    onMount(() => {
        return store.init();
    });

    let dieColor = $derived(store.appConfig?.ui?.dieColor || DEFAULT_DIE_COLOR);
    let dieColorRgb = $derived(hexToRgb(dieColor));

    let faviconHref = $derived(
        `data:image/svg+xml,${encodeURIComponent(generateDieSvgString(dieColor))}`
    );

    $effect(() => {
        void updatePwaIcons(dieColor).catch((e) => console.error("PWA icon update failed", e));
    });

    $effect(() => {
        const root = document.documentElement;
        root.style.setProperty("--accent", dieColor);
        root.style.setProperty("--accent-strong", darkenHex(dieColor, 0.85));
        root.style.setProperty("--accent-soft", hexToRgba(dieColor, 0.12));
        root.style.setProperty("--accent-line", hexToRgba(dieColor, 0.24));
    });

    // iOS standalone PWA: after the sync-shell → app-shell DOM swap,
    // WebKit's compositor has stale hit-test regions for the new
    // fixed-position elements (TopBar, BottomNav). A micro-scroll
    // forces the compositor to rebuild its layer hit-test tree.
    // Account swaps re-flip initialSyncComplete (true → false → true);
    // the nudge only matters on the first true after boot, so latch it.
    let iosScrollNudged = false;
    $effect(() => {
        if (iosScrollNudged) return;
        if (store.initialSyncComplete && isIosStandaloneAuthContext()) {
            iosScrollNudged = true;
            requestAnimationFrame(() => {
                const x = window.scrollX;
                const y = window.scrollY;
                window.scrollTo(x, y + 1);
                requestAnimationFrame(() => window.scrollTo(x, y));
            });
        }
    });
</script>

<svelte:head>
    <title>{store.appTitle}</title>
    <link rel="icon" type="image/svg+xml" href={faviconHref} />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
</svelte:head>

{#if store.connectionStatus === "disconnected"}
    <main class="connect-shell">
        <section class="connect-card">
            <p class="eyebrow">Setlist Roller</p>
            <h1>{store.appTitle}</h1>
            <p class="lede">
                Connect to remoteStorage so your songs survive the tour bus.
            </p>

            <label class="field">
                <span>remoteStorage address</span>
                <input
                    value={store.connectAddress}
                    oninput={(e) => store.connectAddress = e.currentTarget.value}
                    placeholder="you@example.com"
                    autocomplete="off"
                    onkeydown={(e) => { if (e.key === "Enter") store.connectStorage(); }}
                />
            </label>

            <button type="button" class="btn primary" onclick={() => store.connectStorage()} disabled={store.connectionStatus === "connecting" || !store.connectAddress.trim()}>
                {store.connectionStatus === "connecting" ? "Connecting..." : "Connect"}
            </button>

            {#if store.loadError}
                <p class="error-text">{store.loadError}</p>
            {/if}

            {#if store.knownAccounts.length > 0}
                <div class="recent-accounts">
                    <span class="recent-label">Recent</span>
                    {#each store.knownAccounts as account (account.address)}
                        <div class="recent-account">
                            <button class="recent-account-btn" onclick={() => store.connectToAccount(account.address)}>
                                <span class="recent-band">{account.metadata?.bandName || "Unnamed"}</span>
                                <span class="recent-address">{account.address}</span>
                            </button>
                            <button class="recent-forget" onclick={() => store.forgetAccount(account.address)} aria-label="Forget account">&times;</button>
                        </div>
                    {/each}
                </div>
            {/if}
        </section>
    </main>
{:else if !store.initialSyncComplete}
    <main class="sync-shell">
        <div class="sync-content">
            <div class="sync-die-face" style="--die-rgb: {dieColorRgb};">
                <span class="sync-pip" style="left:25%;top:25%"></span>
                <span class="sync-pip" style="left:75%;top:25%"></span>
                <span class="sync-pip" style="left:50%;top:50%"></span>
                <span class="sync-pip" style="left:25%;top:75%"></span>
                <span class="sync-pip" style="left:75%;top:75%"></span>
            </div>
            <div class="sync-label">
                <span class="spinner"></span>
                {store.syncStatusLabel}
            </div>
            {#if store.syncLogEntries.length > 0}
                <div class="sync-console" role="log" aria-live="polite">
                    {#each store.syncLogEntries as entry (entry.id)}
                        <div class="sync-console-line">
                            <span class="sync-console-time">{entry.time}</span>
                            <span>{entry.message}</span>
                        </div>
                    {/each}
                </div>
            {/if}
            {#if store.syncStalled}
                <div class="sync-recovery" role="alert">
                    <p class="sync-recovery-text">This is taking longer than usual. The remote storage may be slow or unreachable.</p>
                    <div class="sync-recovery-actions">
                        <button type="button" class="btn primary" onclick={() => store.retrySync()}>Retry</button>
                        <button type="button" class="btn" onclick={() => store.disconnectStorage()}>Disconnect</button>
                    </div>
                </div>
            {/if}
        </div>
    </main>
{:else}
    <div class="app-shell">
        <TopBar />

        <main class="main-content">
            {#if store.activeView === "roll"}
                <RollScreen />
            {:else if store.activeView === "saved"}
                <SavedScreen />
            {:else if store.activeView === "songs"}
                <SongsScreen />
            {:else if store.activeView === "band"}
                <BandScreen />
            {:else if store.activeView === "help"}
                <HelpScreen />
            {/if}
        </main>

        <BottomNav />
    </div>
{/if}

{#if store.showFirstRunPrompt}
    <div class="modal-backdrop">
        <div class="modal">
            <p class="eyebrow">First Run</p>
            <h3>Name Your Band</h3>
            <p class="modal-desc">What do we call this operation? Don't overthink it.</p>
            <label class="field">
                <span>Band name</span>
                <input
                    value={store.firstRunBandName}
                    oninput={(e) => store.firstRunBandName = e.currentTarget.value}
                    placeholder="Your Band Name"
                    onkeydown={(e) => { if (e.key === "Enter") store.finishFirstRun(); }}
                />
            </label>
            <button type="button" class="btn primary" onclick={store.finishFirstRun}>Save</button>
        </div>
    </div>
{/if}

{#if store.busyMessage}
    <div class="busy-overlay">
        <div class="busy-chip">
            <span class="spinner"></span>
            {store.busyMessage}
        </div>
    </div>
{/if}

{#if store.toastMessages.length > 0}
    <div class="toast-stack" class:with-busy={!!store.busyMessage} aria-live="polite">
        {#each store.toastMessages as toast (toast.id)}
            <div class="toast-pill {toast.tone}">
                {toast.message}
            </div>
        {/each}
    </div>
{/if}

<style>
    /* ---- Connect screen ---- */
    .connect-shell {
        min-height: 100dvh;
        display: grid;
        place-items: center;
        padding: var(--space-4);
    }

    .connect-card {
        width: min(100%, 440px);
        padding: var(--space-6);
        display: grid;
        gap: var(--space-4);
        background: var(--paper-strong);
        border: 1px solid var(--line);
        border-radius: var(--radius-xl);
        box-shadow: var(--shadow);
        backdrop-filter: blur(18px);
    }

    .eyebrow {
        margin: 0;
        color: var(--accent);
        font-size: 0.72rem;
        font-weight: 800;
        letter-spacing: 0.18em;
        text-transform: uppercase;
    }

    h1 {
        font-size: clamp(1.6rem, 4vw, 2.4rem);
    }

    .lede {
        color: var(--muted);
    }

    /* ---- Sync screen ---- */
    .sync-shell {
        min-height: 100dvh;
        display: grid;
        place-items: center;
        padding: var(--space-4);
    }

    .sync-content {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--space-4);
        width: min(100%, 34rem);
    }

    .sync-die-face {
        position: relative;
        width: 72px;
        height: 72px;
        border-radius: 14px;
        background: var(--accent-soft);
        border: 2px solid var(--accent-line);
        animation: pulse-fade 2s ease-in-out infinite;
    }

    .sync-pip {
        position: absolute;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--accent-line);
        transform: translate(-50%, -50%);
    }

    .sync-label {
        display: inline-flex;
        align-items: center;
        gap: var(--space-2);
        font-size: 0.9rem;
        font-weight: 600;
        color: var(--muted);
    }

    .sync-console {
        width: 100%;
        max-height: min(34vh, 18rem);
        overflow: auto;
        padding: 0.85rem 1rem;
        border-radius: var(--radius-lg);
        background: rgba(10, 14, 18, 0.72);
        border: 1px solid rgba(255, 255, 255, 0.08);
        box-shadow: var(--shadow);
        color: rgba(244, 241, 234, 0.88);
        font-family: "SFMono-Regular", "SF Mono", ui-monospace, monospace;
        font-size: 0.78rem;
        line-height: 1.5;
    }

    .sync-console-line {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 0.7rem;
    }

    .sync-console-line + .sync-console-line {
        margin-top: 0.3rem;
    }

    .sync-console-time {
        color: rgba(244, 241, 234, 0.5);
        white-space: nowrap;
    }

    .sync-recovery {
        width: 100%;
        display: grid;
        gap: var(--space-3);
        padding: var(--space-3);
        border-radius: var(--radius-lg);
        background: var(--paper-strong);
        border: 1px solid var(--line);
        text-align: center;
    }

    .sync-recovery-text {
        margin: 0;
        font-size: 0.85rem;
        color: var(--muted);
    }

    .sync-recovery-actions {
        display: flex;
        gap: var(--space-2);
        justify-content: center;
        flex-wrap: wrap;
    }

    @keyframes pulse-fade {
        0%, 100% { transform: scale(1); }
        50% { transform: scale(1.06); }
    }

    /* ---- App shell ---- */
    .app-shell {
        min-height: 100dvh;
        display: flex;
        flex-direction: column;
    }

    .main-content {
        flex: 1;
        padding: var(--space-3);
        padding-top: calc(var(--top-bar-height) + var(--space-3));
        padding-bottom: calc(var(--bottom-nav-height) + var(--safe-bottom) + var(--space-3));
        max-width: 640px;
        width: 100%;
        margin: 0 auto;
    }

    @media (min-width: 960px) {
        .main-content {
            max-width: 720px;
        }
    }

    /* ---- Field ---- */
    .field {
        display: grid;
        gap: 0.35rem;
    }

    .field > span {
        color: var(--ink);
        font-weight: 700;
        font-size: 0.85rem;
    }

    input {
        width: 100%;
        min-height: 2.8rem;
        padding: 0.7rem 0.85rem;
        border-radius: var(--radius-md);
        border: 1px solid var(--line);
        background: var(--surface);
        color: var(--ink);
        font-size: 1rem;
        transition: border-color 140ms ease, box-shadow 140ms ease;
    }

    input:focus {
        outline: none;
        border-color: var(--accent-line);
        box-shadow: 0 0 0 0.2rem var(--accent-soft);
    }

    /* ---- Buttons ---- */
    .btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 2.8rem;
        padding: 0.7rem 1rem;
        border-radius: var(--radius-md);
        border: 1px solid transparent;
        background: var(--surface);
        color: var(--ink);
        font-weight: 800;
        font-size: 0.95rem;
        line-height: 1;
        transition: transform 140ms ease, box-shadow 140ms ease, background 140ms ease;
        touch-action: manipulation;
        cursor: pointer;
    }

    .btn:active {
        transform: scale(0.98);
    }

    .btn.primary {
        color: var(--on-accent);
        background: linear-gradient(135deg, var(--accent), var(--accent-strong));
        border-color: var(--hover);
    }

    .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .error-text {
        color: var(--danger);
        font-size: 0.85rem;
    }

    /* ---- Recent accounts ---- */
    .recent-accounts {
        display: grid;
        gap: 0.5rem;
    }

    .recent-label {
        font-size: 0.72rem;
        font-weight: 800;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--muted);
    }

    .recent-account {
        display: flex;
        align-items: center;
        border: 1px solid var(--line);
        border-radius: var(--radius-md);
        background: var(--surface);
        overflow: hidden;
    }

    .recent-account-btn {
        flex: 1;
        /* min-width: 0 lets the flex item shrink below its content's intrinsic
           width so a long .recent-address can be ellipsised instead of pushing
           the row past the card. */
        min-width: 0;
        overflow: hidden;
        display: grid;
        gap: 0.15rem;
        padding: 0.6rem 0.75rem;
        border: none;
        background: none;
        cursor: pointer;
        text-align: left;
        min-height: 44px;
        -webkit-tap-highlight-color: transparent;
    }

    .recent-account-btn:active {
        background: var(--line);
    }

    .recent-band {
        font-size: 0.9rem;
        font-weight: 700;
        color: var(--ink);
    }

    .recent-address {
        font-size: 0.75rem;
        color: var(--muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .recent-forget {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 44px;
        min-height: 44px;
        border: none;
        background: none;
        cursor: pointer;
        font-size: 1.1rem;
        color: var(--muted);
        flex-shrink: 0;
        -webkit-tap-highlight-color: transparent;
    }

    .recent-forget:active {
        background: var(--line);
    }

    /* ---- Modal ---- */
    .modal-backdrop {
        position: fixed;
        inset: 0;
        display: grid;
        place-items: center;
        padding: var(--space-4);
        background: var(--overlay);
        backdrop-filter: blur(8px);
        z-index: 50;
    }

    .modal {
        width: min(100%, 400px);
        padding: var(--space-6);
        display: grid;
        gap: var(--space-4);
        background: var(--paper-strong);
        border: 1px solid var(--line);
        border-radius: var(--radius-xl);
        box-shadow: var(--shadow);
    }

    h3 {
        font-size: 1.2rem;
    }

    .modal-desc {
        color: var(--muted);
        font-size: 0.9rem;
    }

    /* ---- Busy overlay ---- */
    .busy-overlay {
        position: fixed;
        top: calc(var(--top-bar-height) + var(--space-2));
        left: 50%;
        transform: translateX(-50%);
        z-index: 30;
    }

    .busy-chip {
        display: inline-flex;
        align-items: center;
        gap: var(--space-2);
        padding: 0.5rem 1rem;
        border-radius: var(--radius-full);
        background: var(--paper-strong);
        border: 1px solid var(--line);
        box-shadow: var(--shadow-soft);
        font-size: 0.82rem;
        font-weight: 600;
        color: var(--muted);
        white-space: nowrap;
    }

    .spinner {
        width: 0.85rem;
        height: 0.85rem;
        border-radius: 999px;
        border: 2px solid var(--accent-soft);
        border-top-color: var(--accent);
        animation: spin 0.8s linear infinite;
        flex-shrink: 0;
    }

    /* ---- Toast stack ---- */
    .toast-stack {
        position: fixed;
        top: var(--top-bar-height);
        left: 50%;
        transform: translateX(-50%);
        z-index: 300;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--space-1);
        max-width: calc(100vw - 2rem);
        pointer-events: none;
    }

    /* When the busy chip is showing, drop the toast stack below it so they
       don't sit on top of each other. The chip is anchored at top-bar +
       space-2 and is roughly space-8 tall once padding/text are accounted for. */
    .toast-stack.with-busy {
        top: calc(var(--top-bar-height) + var(--space-8) + var(--space-2));
    }

    .toast-pill {
        max-width: 100%;
        padding: 5px 14px;
        font-size: 0.78rem;
        font-weight: 600;
        text-align: center;
        color: var(--toast-fg);
        background: var(--toast-bg);
        border: none;
        border-radius: 0 0 var(--radius-md, 12px) var(--radius-md, 12px);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        /* Allow long error/info messages to wrap instead of getting truncated
           with an ellipsis — the user needs to read the whole error. */
        white-space: normal;
        overflow-wrap: anywhere;
        animation: toast-slide-down 200ms ease;
    }

    .toast-pill.danger {
        background: var(--toast-danger);
        color: var(--toast-fg);
    }

    .toast-pill.warning {
        background: var(--toast-warning);
        color: var(--toast-fg);
    }

    @keyframes spin {
        to { transform: rotate(360deg); }
    }

    @keyframes toast-slide-down {
        from { opacity: 0; transform: translateY(-8px); }
        to { opacity: 1; transform: translateY(0); }
    }
</style>
