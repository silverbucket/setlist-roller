<script>
    import { registerSW } from "virtual:pwa-register";
    import { onMount, setContext } from "svelte";
    import BandScreen from "./lib/components/band/BandScreen.svelte";
    import HelpScreen from "./lib/components/help/HelpScreen.svelte";
    import BottomNav from "./lib/components/layout/BottomNav.svelte";
    import TopBar from "./lib/components/layout/TopBar.svelte";
    import RollScreen from "./lib/components/roll/RollScreen.svelte";
    import SavedScreen from "./lib/components/saved/SavedScreen.svelte";
    import Icon from "./lib/components/shared/Icon.svelte";
    import SongsScreen from "./lib/components/songs/SongsScreen.svelte";
    import { generateDieSvgString, updatePwaIcons } from "./lib/pwa-icon.js";
    import { createRemoteStorageRepository } from "./lib/remotestorage.js";
    import { createAppStore } from "./lib/stores/app.svelte.js";
    import { getEffectiveTheme } from "./lib/theme.svelte.js";
    import { accentForTheme, DEFAULT_DIE_COLOR, darkenHex, hexToRgba } from "./lib/utils.js";

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
        const custom = store.appConfig?.ui?.dieColor;
        if (!custom) {
            // No custom die colour: let each theme's own accent tokens in
            // app.css apply instead of pinning the light-theme default.
            for (const name of ["--accent", "--accent-strong", "--accent-soft", "--accent-line"]) {
                root.style.removeProperty(name);
            }
            return;
        }
        // The die keeps the raw colour; the UI accent is nudged until it is
        // legible on the active theme (a near-black die would otherwise
        // render accent text black-on-black in dark mode).
        const accent = accentForTheme(custom, getEffectiveTheme());
        root.style.setProperty("--accent", accent);
        root.style.setProperty("--accent-strong", darkenHex(accent, 0.85));
        root.style.setProperty("--accent-soft", hexToRgba(accent, 0.12));
        root.style.setProperty("--accent-line", hexToRgba(accent, 0.24));
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
            <div class="connect-brand">
                <img class="connect-die" src={faviconHref} alt="" width="56" height="56" />
                {#if isStaging}<span class="badge badge-warn">Staging</span>{/if}
            </div>
            <div class="connect-intro">
                <h1>{store.appTitle}</h1>
                <p class="lede">
                    Connect to remoteStorage so your songs survive the tour bus.
                </p>
            </div>

            <label class="field">
                <span class="field-label">remoteStorage address</span>
                <input
                    class="input"
                    value={store.connectAddress}
                    oninput={(e) => store.connectAddress = e.currentTarget.value}
                    placeholder="you@example.com"
                    autocomplete="off"
                    autocapitalize="none"
                    autocorrect="off"
                    spellcheck="false"
                    inputmode="email"
                    onkeydown={(e) => { if (e.key === "Enter") store.connectStorage(); }}
                />
            </label>

            <button type="button" class="btn btn-primary btn-block connect-btn" onclick={() => store.connectStorage()} disabled={store.connectionStatus === "connecting" || !store.connectAddress.trim()}>
                {store.connectionStatus === "connecting" ? "Connecting..." : "Connect"}
            </button>

            {#if store.loadError}
                <p class="error-text" role="alert">{store.loadError}</p>
            {/if}

            {#if store.knownAccounts.length > 0}
                <div class="recent-accounts">
                    <span class="recent-label">Recent</span>
                    <div class="recent-list">
                        {#each store.knownAccounts as account (account.address)}
                            <div class="recent-account">
                                <button type="button" class="recent-account-btn" onclick={() => store.connectToAccount(account.address)}>
                                    <span class="recent-band">{account.metadata?.bandName || "Unnamed"}</span>
                                    <span class="recent-address">{account.address}</span>
                                </button>
                                <button type="button" class="icon-btn recent-forget" onclick={() => confirmForget(account)} aria-label="Forget account"><Icon name="x" size={18} /></button>
                            </div>
                        {/each}
                    </div>
                </div>
            {/if}
        </section>
    </main>
{/if}

{#if store.showFirstRunPrompt}
    <div class="modal-backdrop dialog-backdrop first-run-backdrop">
        <div class="modal dialog">
            <h3 class="dialog-title">Name your band</h3>
            <p class="modal-desc dialog-desc">What do we call this operation? Don't overthink it.</p>
            <label class="field">
                <span class="field-label">Band name</span>
                <input
                    class="input"
                    value={store.firstRunBandName}
                    oninput={(e) => store.firstRunBandName = e.currentTarget.value}
                    placeholder="Your Band Name"
                    onkeydown={(e) => { if (e.key === "Enter") store.finishFirstRun(); }}
                />
            </label>
            <button type="button" class="btn btn-primary" onclick={store.finishFirstRun}>Save</button>
        </div>
    </div>
{/if}

<svelte:window onkeydown={handleConfirmKeydown} />

{#if store.confirmRequest}
    {@const confirm = store.confirmRequest}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="modal-backdrop confirm-backdrop dialog-backdrop" onclick={() => store.resolveConfirm(false)}>
        <div
            class="modal dialog"
            role="alertdialog"
            aria-modal="true"
            aria-label={confirm.title}
            onclick={(e) => e.stopPropagation()}
        >
            <h3 class="dialog-title">{confirm.title}</h3>
            {#if confirm.message}
                <p class="modal-desc dialog-desc">{confirm.message}</p>
            {/if}
            {#if confirm.requireText}
                <label class="field">
                    <span class="field-label">Type <strong>{confirm.requireText}</strong> to confirm</span>
                    <input
                        class="input"
                        value={confirmTypedText}
                        oninput={(e) => { confirmTypedText = e.currentTarget.value; }}
                        placeholder={confirm.requireText}
                        autocomplete="off"
                    />
                </label>
            {/if}
            <div class="confirm-actions dialog-actions">
                <button type="button" class="btn" onclick={() => store.resolveConfirm(false)}>{confirm.cancelLabel}</button>
                <button
                    type="button"
                    class="btn btn-danger"
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
    <div class="toast-stack" class:with-busy={!!store.busyMessage} class:in-app={!!store.currentUserAddress || store.connectionStatus === "connected"} aria-live="polite">
        {#key toast.id}
            <div class="toast-pill {toast.tone}" class:sticky={toast.sticky}>
                <span class="toast-text">{toast.message}</span>
                {#if toast.action}
                    <button
                        type="button"
                        class="toast-action"
                        onclick={() => store.runToastAction(toast.id)}
                    >{toast.action.label}</button>
                {/if}
                {#if toast.sticky}
                    <button type="button" class="toast-dismiss" aria-label="Dismiss" onclick={() => store.dismissToast(toast.id)}><Icon name="x" size={16} /></button>
                {/if}
            </div>
        {/key}
    </div>
{/if}

<style>
    /* ---- Connect screen ---- */
    .connect-shell {
        height: 100%;
        display: grid;
        place-items: center;
        overflow-y: auto;
        padding: max(var(--space-4), var(--safe-top)) var(--space-4) max(var(--space-4), var(--safe-bottom));
    }

    .connect-card {
        width: min(100%, 420px);
        padding: var(--space-6);
        display: grid;
        gap: var(--space-5);
        background: var(--surface);
        border: 1px solid var(--line);
        border-radius: var(--radius-xl);
        box-shadow: var(--shadow-soft);
    }

    @media (min-width: 600px) {
        .connect-card {
            padding: var(--space-8);
        }
    }

    .connect-brand {
        display: flex;
        align-items: center;
        justify-content: space-between;
    }

    .connect-die {
        display: block;
        width: 56px;
        height: 56px;
        /* A die mid-tumble: the one bit of personality on an otherwise
           plain form. */
        transform: rotate(-8deg);
        filter: drop-shadow(0 6px 10px rgba(18, 22, 30, 0.18));
    }

    .connect-intro {
        display: grid;
        gap: var(--space-2);
    }

    h1 {
        font-size: clamp(1.8rem, 6vw, 2.25rem);
        letter-spacing: -0.03em;
        line-height: 1.05;
        overflow-wrap: anywhere;
    }

    .lede {
        color: var(--muted);
        font-size: 1rem;
        line-height: 1.5;
    }

    .connect-btn {
        min-height: 48px;
        font-size: 1rem;
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
        padding: var(--space-4) var(--space-4) var(--space-8);
    }

    .content-column {
        max-width: 640px;
        width: 100%;
        margin: 0 auto;
    }

    /* Desktop: the tab bar becomes a full-height sidebar (BottomNav
       restyles itself at the same breakpoint) and the top bar + content
       share the remaining column. Still no position:fixed. */
    @media (min-width: 900px) {
        .app-shell {
            display: grid;
            grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
            grid-template-rows: auto minmax(0, 1fr);
        }

        .app-shell > :global(.top-bar) {
            grid-column: 2;
            grid-row: 1;
        }

        .app-shell > :global(.bottom-nav) {
            grid-column: 1;
            grid-row: 1 / -1;
        }

        .main-content {
            grid-column: 2;
            grid-row: 2;
            padding: var(--space-6) var(--space-8) 4rem;
        }

        /* Left-aligned so screen titles line up with the band name in the
           top bar instead of floating in the middle of a wide window. */
        .content-column {
            max-width: 1040px;
            margin: 0;
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

    .error-text {
        padding: 0.6rem 0.8rem;
        border-radius: var(--radius-md);
        background: var(--danger-soft);
        color: var(--danger);
        font-size: 0.9rem;
        font-weight: 500;
    }

    /* ---- Recent accounts ---- */
    .recent-accounts {
        display: grid;
        gap: 0.5rem;
        padding-top: var(--space-4);
        border-top: 1px solid var(--line);
    }

    .recent-label {
        font-size: 0.86rem;
        font-weight: 600;
        color: var(--muted);
    }

    .recent-list {
        display: grid;
        gap: 0.4rem;
    }

    .recent-account {
        display: flex;
        align-items: center;
        border: 1px solid var(--line);
        border-radius: var(--radius-md);
        background: var(--surface);
        overflow: hidden;
        transition: border-color 120ms ease;
    }

    .recent-account:hover {
        border-color: var(--line-strong);
    }

    .recent-account-btn {
        flex: 1;
        /* min-width: 0 lets the flex item shrink below its content's intrinsic
           width so a long .recent-address can be ellipsised instead of pushing
           the row past the card. */
        min-width: 0;
        overflow: hidden;
        display: grid;
        gap: 0.1rem;
        padding: 0.6rem 0.8rem;
        border: none;
        background: none;
        cursor: pointer;
        text-align: left;
        min-height: 52px;
        -webkit-tap-highlight-color: transparent;
    }

    .recent-account-btn:hover {
        background: var(--hover);
    }

    .recent-account-btn:active {
        background: var(--hover-strong);
    }

    .recent-band {
        font-size: 0.96rem;
        font-weight: 600;
        color: var(--ink);
    }

    .recent-address {
        font-size: 0.82rem;
        color: var(--muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .recent-forget {
        color: var(--muted);
        border-radius: 0;
        height: 52px;
    }

    /* ---- Dialog layering ----
       The dialog shell itself lives in app.css (.dialog-backdrop/.dialog).
       Destructive-confirm sits above everything, including the song
       editor (z-index 300) and its pickers. */
    .first-run-backdrop {
        z-index: 350;
    }

    .confirm-backdrop {
        z-index: 700;
    }

    /* ---- Busy chip ---- */
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
        padding: 0.45rem 0.9rem;
        border-radius: var(--radius-full);
        background: var(--paper-strong);
        border: 1px solid var(--line);
        box-shadow: var(--shadow-soft);
        font-size: 0.86rem;
        font-weight: 500;
        color: var(--ink-2);
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

    /* ---- Toasts ----
       A floating pill near the bottom edge, above the tab bar. It used to
       be a full-width strip under the top bar, where it covered the first
       row of whatever screen you were on. */
    .toast-stack {
        position: fixed;
        left: 0;
        right: 0;
        bottom: calc(var(--space-4) + var(--safe-bottom));
        z-index: 800;
        display: flex;
        justify-content: center;
        padding: 0 var(--space-4);
        pointer-events: none;
    }

    .toast-stack.in-app {
        bottom: calc(var(--bottom-nav-height) + var(--space-3));
    }

    @media (min-width: 900px) {
        .toast-stack.in-app {
            left: var(--sidebar-width);
            bottom: var(--space-6);
        }
    }

    .toast-pill {
        display: inline-flex;
        align-items: center;
        gap: 0.6rem;
        max-width: min(100%, 520px);
        min-height: 44px;
        padding: 0.55rem 1rem;
        font-size: 0.92rem;
        font-weight: 500;
        line-height: 1.35;
        color: var(--toast-fg);
        background: var(--toast-bg);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-soft);
        animation: toast-rise 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
    }

    .toast-text {
        min-width: 0;
    }

    /* Sticky toasts (e.g. the update prompt) carry buttons. They must
       restore hit-testing: the stack is pointer-events:none so passive
       toasts never block taps on content underneath, but a toast with
       actions has to be clickable. */
    .toast-pill.sticky {
        pointer-events: auto;
        padding-right: 0.5rem;
    }

    .toast-action {
        flex: none;
        min-height: 32px;
        padding: 0 0.75rem;
        font: inherit;
        font-weight: 600;
        color: var(--toast-bg);
        background: var(--toast-fg);
        border: none;
        border-radius: var(--radius-sm);
        cursor: pointer;
    }

    .toast-dismiss {
        flex: none;
        display: inline-grid;
        place-items: center;
        width: 32px;
        height: 32px;
        color: var(--toast-fg);
        background: none;
        border: none;
        border-radius: var(--radius-sm);
        opacity: 0.75;
        cursor: pointer;
    }

    .toast-dismiss:hover {
        opacity: 1;
    }

    .toast-pill.danger {
        background: var(--toast-danger);
        color: #fff;
    }

    .toast-pill.warning {
        background: var(--toast-warning);
        color: #fff;
    }

    :global(:root[data-theme="dark"]) .toast-pill.danger,
    :global(:root[data-theme="dark"]) .toast-pill.warning {
        color: #16191f;
    }

    @keyframes spin {
        to { transform: rotate(360deg); }
    }

    @keyframes toast-rise {
        from { opacity: 0; transform: translateY(8px); }
        to { opacity: 1; transform: translateY(0); }
    }
</style>
