<script>
    import { registerSW } from "virtual:pwa-register";
    import { onMount, setContext } from "svelte";
    import BandScreen from "./lib/components/band/BandScreen.svelte";
    import HelpScreen from "./lib/components/help/HelpScreen.svelte";
    import BottomNav from "./lib/components/layout/BottomNav.svelte";
    import TopBar from "./lib/components/layout/TopBar.svelte";
    import RollScreen from "./lib/components/roll/RollScreen.svelte";
    import SavedScreen from "./lib/components/saved/SavedScreen.svelte";
    import SongsScreen from "./lib/components/songs/SongsScreen.svelte";
    import { generateDieSvgString, updatePwaIcons } from "./lib/pwa-icon.js";
    import { createRemoteStorageRepository } from "./lib/remotestorage.js";
    import { createAppStore } from "./lib/stores/app.svelte.js";
    import { DEFAULT_DIE_COLOR, darkenHex, hexToRgba } from "./lib/utils.js";

    const repo = createRemoteStorageRepository();
    const store = createAppStore(repo);
    setContext("app", store);

    // Staging builds (vite build --mode staging) mark the connect screen;
    // TopBar carries the in-app badge.
    const isStaging = import.meta.env.MODE === "staging";

    // ---- destructive-confirm modal ----
    let confirmTypedText = $state("");
    // Reset the typed-verification text whenever a new request opens.
    $effect(() => {
        void store.confirmRequest;
        confirmTypedText = "";
    });

    function handleConfirmKeydown(e) {
        if (store.confirmRequest && e.key === "Escape") {
            e.preventDefault();
            store.resolveConfirm(false);
        }
    }

    async function confirmForget(account) {
        const label = account.metadata?.bandName
            ? `${account.metadata.bandName} (${account.address})`
            : account.address;
        const confirmed = await store.requestConfirm({
            title: `Forget ${label}?`,
            message:
                "Removes this account's saved songs, setlists, and sign-in from this device. Data on the remoteStorage server is untouched.",
            confirmLabel: "Forget",
        });
        if (confirmed) store.forgetAccount(account.address);
    }

    // Prompt-style service-worker updates. autoUpdate reloaded the page the
    // moment a new deploy activated — mid-gig, that could eat an unsaved
    // setlist. Instead we surface a persistent toast and let the user pick
    // their moment; updateSW(true) applies the waiting worker and reloads.
    const updateSW = registerSW({
        immediate: true,
        onNeedRefresh() {
            store.toastAction("A new version of Setlist Roller is ready.", "Refresh", () => updateSW(true));
        },
        onRegisteredSW(_swUrl, registration) {
            // Long-lived sessions (installed PWA left open between shows)
            // never re-navigate, so the browser's own update-on-navigation
            // check never runs. Poll hourly instead.
            if (!registration) return;
            setInterval(() => {
                registration.update().catch(() => { /* offline — retry next tick */ });
            }, 60 * 60 * 1000);
        },
    });

    if (typeof window !== "undefined" && window.__SR_TEST__) {
        // Test-mode escape hatch: expose the store + repo on window so
        // e2e tests can read state directly (`__SR_STORE__.songs`, etc.)
        // and drive store methods that don't have a UI surface
        // (`__SR_STORE__.retrySync()`). The flag is set by Playwright's
        // `addInitScript` in tests/fixtures/test-fixtures.ts and is
        // never set in production builds. Both stays gated by the
        // window check so SSR contexts (if we ever add any) don't trip.
        window.__SR_STORE__ = store;
        window.__SR_REPO__ = repo;
    }

    onMount(() => {
        return store.init();
    });

    let dieColor = $derived(store.appConfig?.ui?.dieColor || DEFAULT_DIE_COLOR);

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

</script>

<svelte:head>
    <title>{store.appTitle}</title>
    <link rel="icon" type="image/svg+xml" href={faviconHref} />
    <!-- The viewport meta lives in index.html (static, single source). It
         needs to be present at first paint anyway, before svelte:head can
         inject it; duplicating it here just causes two tags in the DOM. -->
</svelte:head>

{#if store.currentUserAddress || store.connectionStatus === "connected"}
    <!-- Offline-first: as soon as an account is active, the full app renders
         from its local mirror. The remote session connects in the background
         and the TopBar dot reports its state. -->
    <div class="app-shell">
        <TopBar />

        <main class="main-content">
            <div class="content-column">
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
            </div>
        </main>

        <BottomNav />
    </div>
{:else if store.connectionStatus === "pending"}
    <!-- Boot instant with no restorable account: rs.js resolves to
         connected or not-connected almost immediately; render nothing
         rather than flashing the login form. -->
{:else}
    <main class="connect-shell">
        <section class="connect-card">
            <p class="eyebrow">
                Setlist Roller
                {#if isStaging}<span class="eyebrow-staging">· Staging</span>{/if}
            </p>
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
                            <button type="button" class="recent-account-btn" onclick={() => store.connectToAccount(account.address)}>
                                <span class="recent-band">{account.metadata?.bandName || "Unnamed"}</span>
                                <span class="recent-address">{account.address}</span>
                            </button>
                            <button type="button" class="recent-forget" onclick={() => confirmForget(account)} aria-label="Forget account">&times;</button>
                        </div>
                    {/each}
                </div>
            {/if}
        </section>
    </main>
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

<svelte:window onkeydown={handleConfirmKeydown} />

{#if store.confirmRequest}
    {@const confirm = store.confirmRequest}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="modal-backdrop confirm-backdrop" onclick={() => store.resolveConfirm(false)}>
        <div
            class="modal"
            role="alertdialog"
            aria-modal="true"
            aria-label={confirm.title}
            onclick={(e) => e.stopPropagation()}
        >
            <h3>{confirm.title}</h3>
            {#if confirm.message}
                <p class="modal-desc">{confirm.message}</p>
            {/if}
            {#if confirm.requireText}
                <label class="field">
                    <span>Type <strong>{confirm.requireText}</strong> to confirm</span>
                    <input
                        value={confirmTypedText}
                        oninput={(e) => { confirmTypedText = e.currentTarget.value; }}
                        placeholder={confirm.requireText}
                        autocomplete="off"
                    />
                </label>
            {/if}
            <div class="confirm-actions">
                <button type="button" class="btn" onclick={() => store.resolveConfirm(false)}>{confirm.cancelLabel}</button>
                <button
                    type="button"
                    class="btn danger"
                    disabled={!!confirm.requireText && confirmTypedText.trim() !== confirm.requireText}
                    onclick={() => store.resolveConfirm(true)}
                >{confirm.confirmLabel}</button>
            </div>
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

{#if store.toastMessages[0]}
    {@const toast = store.toastMessages[0]}
    <div class="toast-stack" class:with-busy={!!store.busyMessage} aria-live="polite">
        <div class="toast-pill {toast.tone}" class:sticky={toast.sticky}>
            {toast.message}
            {#if toast.action}
                <button
                    type="button"
                    class="toast-action"
                    onclick={() => store.runToastAction(toast.id)}
                >{toast.action.label}</button>
            {/if}
            {#if toast.sticky}
                <button type="button" class="toast-dismiss" aria-label="Dismiss" onclick={() => store.dismissToast(toast.id)}>&times;</button>
            {/if}
        </div>
    </div>
{/if}

<style>
    /* ---- Connect screen ---- */
    .connect-shell {
        height: 100%;
        display: grid;
        place-items: center;
        overflow-y: auto;
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

    .eyebrow-staging {
        color: var(--toast-warning);
    }

    h1 {
        font-size: clamp(1.6rem, 4vw, 2.4rem);
    }

    .lede {
        color: var(--muted);
    }

    /* ---- App shell ----
       A fixed-height flex column: TopBar and BottomNav sit in normal flow
       and only .main-content scrolls. No position:fixed chrome — that's
       what caused the iOS bug where the nav drifted mid-screen after the
       keyboard dismissed and never recovered. 100dvh tracks the dynamic
       viewport (keyboard, browser chrome) natively, no JS required. */
    .app-shell {
        height: 100dvh;
        display: flex;
        flex-direction: column;
    }

    .main-content {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior-y: contain;
        padding: var(--space-3);
    }

    .content-column {
        max-width: 640px;
        width: 100%;
        margin: 0 auto;
    }

    @media (min-width: 960px) {
        .content-column {
            max-width: 720px;
        }
    }

    @media print {
        .app-shell {
            height: auto;
            display: block;
        }

        .main-content {
            overflow: visible;
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
        /* iOS zooms inputs <16px on focus — keep at 16px (not rem) to prevent zoom. See app.css. */
        font-size: 16px;
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

    /* Destructive-confirm modal sits above everything, including the
       song-editor overlay (z-index 300). */
    .confirm-backdrop {
        z-index: 400;
    }

    .confirm-actions {
        display: flex;
        gap: var(--space-2);
        justify-content: flex-end;
    }

    .confirm-actions .btn {
        flex: 1;
    }

    .btn.danger {
        color: var(--on-accent);
        background: var(--danger);
        border-color: transparent;
    }

    .btn.danger:disabled {
        opacity: 0.4;
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
        left: 0;
        right: 0;
        z-index: 300;
        width: 100%;
        pointer-events: none;
    }

    /* When the busy chip is showing, drop the toast stack below it so they
       don't sit on top of each other. The chip is anchored at top-bar +
       space-2 and is roughly space-8 tall once padding/text are accounted for. */
    .toast-stack.with-busy {
        top: calc(var(--top-bar-height) + var(--space-8) + var(--space-2));
    }

    .toast-pill {
        width: 100%;
        min-width: 0;
        box-sizing: border-box;
        padding: 5px 14px;
        font-size: 0.78rem;
        font-weight: 600;
        text-align: center;
        color: var(--toast-fg);
        background: var(--toast-bg);
        border: none;
        border-radius: 0 0 var(--radius-md, 12px) var(--radius-md, 12px);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        animation: toast-slide-down 200ms ease;
    }

    /* Sticky toasts (e.g. the update prompt) carry buttons — switch from
       centered ellipsized text to an inline flex row. They must also
       restore hit-testing: the stack is pointer-events:none so passive
       toasts never block taps on content underneath, but a toast with
       actions has to be clickable. */
    .toast-pill.sticky {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        white-space: normal;
        text-overflow: clip;
        pointer-events: auto;
    }

    .toast-action {
        flex: none;
        padding: 2px 10px;
        font: inherit;
        font-weight: 700;
        color: var(--toast-bg);
        background: var(--toast-fg);
        border: none;
        border-radius: 999px;
        cursor: pointer;
    }

    .toast-dismiss {
        flex: none;
        padding: 0 2px;
        font-size: 1rem;
        line-height: 1;
        color: var(--toast-fg);
        background: none;
        border: none;
        opacity: 0.7;
        cursor: pointer;
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
