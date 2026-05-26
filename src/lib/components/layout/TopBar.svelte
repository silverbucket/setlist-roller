<script>
  import { getContext, tick } from "svelte";
  import { cycleTheme, getThemePreference } from "../../theme.svelte.js";
  import ViewportDiagnostics from "./ViewportDiagnostics.svelte";

  const store = getContext("app");
  // TEMP(iOS diagnostics): keep this reachable in installed PWA builds until
  // the viewport gap is measured and fixed.
  const viewportDiagnosticsEnabled = import.meta.env.DEV || (typeof window !== "undefined" && (
    window.matchMedia?.("(display-mode: standalone)").matches || window.navigator?.standalone === true
  ));

  let menuOpen = $state(false);
  let diagnosticsOpen = $state(false);
  let menuBtnEl = $state();
  let dropdownEl = $state();
  const themeLabel = { system: "◐ System", light: "☀ Light", dark: "☽ Dark" };

  function toggleMenu() {
    menuOpen = !menuOpen;
  }

  function closeMenu() {
    menuOpen = false;
  }

  function openDiagnostics() {
    closeMenu();
    diagnosticsOpen = true;
  }

  async function closeDiagnostics() {
    diagnosticsOpen = false;
    await tick();
    menuBtnEl?.focus();
  }

  let currentAccount = $derived(
    store.knownAccounts.find((a) => a.address === store.connectAddress)
  );

  let otherAccounts = $derived(
    store.knownAccounts.filter((a) => a.address !== store.connectAddress)
  );

  // Single screen-reader/tooltip label for the sync dot. Mirrors the dot's
  // visual state so screen readers announce transitions and power users can
  // hover for the underlying syncStatusLabel from rs.js.
  let dotLabel = $derived.by(() => {
    if (store.connectionStatus !== "connected") return "Disconnected";
    if (store.syncState === "error") return store.syncStatusLabel || "Sync failed";
    if (store.syncActivelyRunning || store.syncState === "syncing") {
      return store.syncStatusLabel || "Syncing";
    }
    return "Up to date";
  });

  function handleSwitchTo(address) {
    closeMenu();
    store.connectToAccount(address);
  }

  function handleAddAccount() {
    closeMenu();
    store.connectAddress = "";
    store.disconnectStorage();
  }

  // Focusable items inside the dropdown — used for the Tab cycle and for
  // moving initial focus into the menu when it opens.
  function getFocusableElements() {
    if (!dropdownEl) return [];
    return [
      ...dropdownEl.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ];
  }

  function handleMenuKeydown(e) {
    if (!menuOpen) return;

    if (e.key === "Escape") {
      e.preventDefault();
      closeMenu();
      // Return focus to the trigger so keyboard users land somewhere sensible.
      menuBtnEl?.focus();
      return;
    }

    if (e.key === "Tab") {
      const focusable = getFocusableElements();
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (!dropdownEl?.contains(active)) {
        e.preventDefault();
        first.focus();
        return;
      }

      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  // Wire up keyboard handling and initial focus while the menu is open.
  $effect(() => {
    if (!menuOpen) return;

    window.addEventListener("keydown", handleMenuKeydown);

    tick().then(() => {
      if (!menuOpen) return;
      const focusable = getFocusableElements();
      if (focusable.length > 0) focusable[0].focus();
    });

    return () => {
      window.removeEventListener("keydown", handleMenuKeydown);
    };
  });
</script>

{#if menuOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="menu-backdrop" onclick={closeMenu}></div>
{/if}

<header class="top-bar">
  <div class="title-group">
    <span
      class="conn-dot"
      class:connected={store.connectionStatus === 'connected'}
      class:syncing={store.syncActivelyRunning || store.syncState === 'syncing'}
      class:errored={store.syncState === 'error'}
      role="status"
      aria-live="polite"
      aria-label={dotLabel}
      title={dotLabel}
    ></span>
    <span class="band-name">{store.appConfig?.bandName || "Setlist Roller"}</span>
  </div>

  <div class="right">

    <div class="menu-wrapper">
      <button
        type="button"
        class="menu-btn"
        bind:this={menuBtnEl}
        onclick={toggleMenu}
        aria-label="Menu"
        aria-haspopup="true"
        aria-expanded={menuOpen}
      >
        &middot;&middot;&middot;
      </button>

      {#if menuOpen}
        <div class="dropdown" bind:this={dropdownEl}>
          {#if currentAccount}
            <div class="dropdown-current">
              <span class="active-dot"></span>
              <div class="current-info">
                <span class="current-band">{currentAccount.metadata?.bandName || "Unnamed"}</span>
                <span class="current-addr">{currentAccount.address}</span>
              </div>
            </div>
          {/if}

          {#if otherAccounts.length > 0}
            <div class="dropdown-divider"></div>
            <span class="dropdown-label">Switch to</span>
            {#each otherAccounts as account (account.address)}
              <button type="button" class="dropdown-item dropdown-item--account" onclick={() => handleSwitchTo(account.address)}>
                <span class="account-band">{account.metadata?.bandName || "Unnamed"}</span>
                <span class="account-addr">{account.address}</span>
              </button>
            {/each}
          {/if}

          <div class="dropdown-divider"></div>
          <button type="button" class="dropdown-item dropdown-item--add" onclick={handleAddAccount}>Add Account</button>

          <div class="dropdown-divider"></div>
          <button type="button" class="dropdown-item" onclick={cycleTheme}>Theme: {themeLabel[getThemePreference()]}</button>

          {#if viewportDiagnosticsEnabled}
            <div class="dropdown-divider"></div>
            <button type="button" class="dropdown-item" onclick={openDiagnostics}>Viewport Diagnostics</button>
          {/if}
        </div>
      {/if}
    </div>
  </div>
</header>

{#if viewportDiagnosticsEnabled && diagnosticsOpen}
  <ViewportDiagnostics onClose={closeDiagnostics} />
{/if}

<style>
  .top-bar {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: var(--top-bar-height);
    padding-top: env(safe-area-inset-top, 0px);
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    padding-left: 16px;
    padding-right: 8px;
    background: var(--paper);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border-bottom: 1px solid var(--line);
    z-index: 200;
  }

  .title-group {
    grid-column: 2;
    display: flex;
    align-items: center;
    gap: 8px;
    overflow: hidden;
    min-width: 0;
  }

  /* The dot is the single sync indicator: grey = disconnected, green = up to
     date, blue (throbbing) = syncing, red = error. The throb is a combined
     opacity + scale + glow pulse so the state is readable at a glance even
     at small sizes. */
  .conn-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--line);
    flex-shrink: 0;
    transition: background 300ms ease, box-shadow 300ms ease;
  }

  .conn-dot.connected {
    background: var(--success);
    box-shadow: 0 0 4px color-mix(in srgb, var(--success) 40%, transparent);
  }

  /* `.syncing` overrides `.connected` since both are toggled when sync fires
     mid-session. Order matters in the cascade — keep `.syncing` after
     `.connected`. Uses `--sync` (fixed blue), NOT `--accent`: the accent
     is band-themed and could match `--success` (green), erasing the
     visual difference between "syncing" and "up to date". */
  .conn-dot.syncing {
    background: var(--sync);
    animation: dot-pulse 1.1s ease-in-out infinite;
  }

  .conn-dot.errored {
    background: var(--danger, #d44);
    box-shadow: 0 0 6px color-mix(in srgb, var(--danger, #d44) 40%, transparent);
  }

  /* Pulse the dot itself so it visibly "breathes": opacity dips to 40%,
     scale grows to 1.7x, and the glow widens from 4px → 14px. Each
     property reinforces the others so the change is unmistakable even at
     8px. `transform-origin` defaults to center so scaling is symmetrical
     even when the dot sits flush against the title-group's left edge. */
  @keyframes dot-pulse {
    0%, 100% {
      opacity: 1;
      transform: scale(1);
      box-shadow: 0 0 4px color-mix(in srgb, var(--sync) 40%, transparent);
    }
    50% {
      opacity: 0.4;
      transform: scale(1.7);
      box-shadow: 0 0 14px color-mix(in srgb, var(--sync) 80%, transparent);
    }
  }

  /* Don't fully suppress motion — users still need to know sync is alive.
     Drop the scale/glow but keep a slow opacity breath so the indicator
     stays animated within accessibility-friendly bounds. */
  @media (prefers-reduced-motion: reduce) {
    .conn-dot.syncing { animation: dot-pulse-soft 2s ease-in-out infinite; }
  }

  @keyframes dot-pulse-soft {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.55; }
  }

  .band-name {
    font-size: 16px;
    font-weight: 700;
    color: var(--ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: center;
  }

  .right {
    grid-column: 3;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    position: relative;
    z-index: 1;
  }

  .menu-wrapper {
    position: relative;
  }

  .menu-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    min-height: 44px;
    border: none;
    background: none;
    cursor: pointer;
    font-size: 20px;
    letter-spacing: 2px;
    color: var(--ink);
    border-radius: var(--radius-md);
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
  }

  .menu-btn:active {
    background: var(--line);
  }

  .menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 199;
  }

  .dropdown {
    position: absolute;
    top: 100%;
    right: 0;
    min-width: 200px;
    background: var(--paper);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
    overflow: hidden;
    z-index: 201;
  }

  .dropdown-item {
    display: block;
    width: 100%;
    padding: 12px 16px;
    border: none;
    background: none;
    cursor: pointer;
    font-size: 14px;
    color: var(--ink);
    text-align: left;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
  }

  .dropdown-item:active {
    background: var(--line);
  }

  .dropdown-item + .dropdown-item {
    border-top: 1px solid var(--line);
  }

  .dropdown-current {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
  }

  .active-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--success);
    box-shadow: 0 0 4px color-mix(in srgb, var(--success) 40%, transparent);
    flex-shrink: 0;
  }

  .current-info {
    display: grid;
    gap: 2px;
  }

  .current-band {
    font-size: 13px;
    font-weight: 700;
    color: var(--ink);
  }

  .current-addr {
    font-size: 11px;
    color: var(--muted);
  }

  .dropdown-label {
    display: block;
    padding: 8px 16px 4px;
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .dropdown-divider {
    height: 1px;
    background: var(--line);
  }

  .dropdown-item--account {
    display: grid;
    gap: 1px;
    padding: 10px 16px;
  }

  .dropdown-item--account + .dropdown-item--account {
    border-top: 1px solid var(--line);
  }

  .account-band {
    font-size: 13px;
    font-weight: 600;
  }

  .account-addr {
    font-size: 11px;
    color: var(--muted);
  }

  .dropdown-item--add {
    font-weight: 700;
    color: var(--accent);
  }
</style>
