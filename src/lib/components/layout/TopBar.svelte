<script>
  import { getContext, tick } from "svelte";
  import { cycleTheme, getThemePreference } from "../../theme.svelte.js";
  import Icon from "../shared/Icon.svelte";

  const store = getContext("app");
  // Staging builds (vite build --mode staging) show a badge next to the
  // band name so a deployed staging PWA can never be mistaken for prod.
  const isStaging = import.meta.env.MODE === "staging";

  let menuOpen = $state(false);
  let menuBtnEl = $state();
  let dropdownEl = $state();
  const themeLabel = { system: "System", light: "Light", dark: "Dark" };
  const themeIcon = { system: "monitor", light: "sun", dark: "moon" };

  function toggleMenu() {
    menuOpen = !menuOpen;
  }

  function closeMenu() {
    menuOpen = false;
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
    <span class="band-name">{store.appConfig?.bandName || "Setlist Roller"}</span>
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
    {#if isStaging}
      <span class="staging-badge" title="This is the staging deployment ({__APP_VERSION__})">Staging</span>
    {/if}
  </div>

  <div class="menu-wrapper">
    <button
      type="button"
      class="icon-btn menu-btn"
      bind:this={menuBtnEl}
      onclick={toggleMenu}
      aria-label="Menu"
      aria-haspopup="true"
      aria-expanded={menuOpen}
    >
      <Icon name="more" size={22} />
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
        <button type="button" class="dropdown-item dropdown-item--add" onclick={handleAddAccount}>
          <Icon name="user-plus" size={18} />
          Add Account
        </button>
        <button type="button" class="dropdown-item" onclick={cycleTheme}>
          <Icon name={themeIcon[getThemePreference()]} size={18} />
          Theme: {themeLabel[getThemePreference()]}
        </button>
      </div>
    {/if}
  </div>
</header>

<style>
  .top-bar {
    /* In normal flow at the top of the flex app shell — no position:fixed.
       Needs its own stacking context so the dropdown overlays main-content. */
    position: relative;
    flex: none;
    height: var(--top-bar-height);
    padding: env(safe-area-inset-top, 0px) 6px 0 var(--space-4);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    background: var(--bg);
    border-bottom: 1px solid var(--line);
    z-index: 200;
  }

  @media (min-width: 900px) {
    .top-bar {
      height: 64px;
      padding: 0 var(--space-6) 0 var(--space-8);
    }
  }

  .title-group {
    display: flex;
    align-items: center;
    gap: 10px;
    overflow: hidden;
    min-width: 0;
  }

  .band-name {
    font-family: var(--font-display);
    font-size: 1.2rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* The dot is the single sync indicator: grey = disconnected, green = up to
     date, blue (throbbing) = syncing, red = error. The throb is a combined
     opacity + scale + glow pulse so the state is readable at a glance even
     at small sizes. */
  .conn-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--line-strong);
    flex-shrink: 0;
    transition: background 300ms ease, box-shadow 300ms ease;
  }

  .conn-dot.connected {
    background: var(--success);
    box-shadow: 0 0 0 3px var(--success-soft);
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
    background: var(--danger);
    box-shadow: 0 0 0 3px var(--danger-soft);
  }

  /* Pulse the dot itself so it visibly "breathes": opacity dips to 40%,
     scale grows to 1.7x, and the glow widens from 4px → 14px. Each
     property reinforces the others so the change is unmistakable even at
     8px. */
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
     stays animated within accessibility-friendly bounds. The !important
     flags outrank the global reduced-motion reset in app.css. */
  @media (prefers-reduced-motion: reduce) {
    .conn-dot.syncing {
      animation: dot-pulse-soft 2s ease-in-out infinite !important;
      animation-duration: 2s !important;
      animation-iteration-count: infinite !important;
    }
  }

  @keyframes dot-pulse-soft {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.55; }
  }

  /* Compile-time badge: only rendered in staging builds. Amber so it reads
     as "caution/not prod" without clashing with the sync-dot colors. */
  .staging-badge {
    flex-shrink: 0;
    padding: 2px 8px;
    border-radius: var(--radius-full);
    background: var(--warning-soft);
    color: var(--warning);
    font-size: 0.72rem;
    font-weight: 700;
  }

  .menu-wrapper {
    position: relative;
    flex-shrink: 0;
  }

  .menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 199;
  }

  .dropdown {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    width: max-content;
    min-width: 240px;
    max-width: min(320px, calc(100vw - 24px));
    padding: 6px;
    background: var(--paper-strong);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-soft);
    z-index: 201;
    animation: menu-in 140ms cubic-bezier(0.2, 0.8, 0.2, 1);
    transform-origin: top right;
  }

  @keyframes menu-in {
    from { opacity: 0; transform: scale(0.96) translateY(-4px); }
    to { opacity: 1; transform: none; }
  }

  .dropdown-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 44px;
    padding: 8px 10px;
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    cursor: pointer;
    font-size: 0.94rem;
    font-weight: 500;
    color: var(--ink);
    text-align: left;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
  }

  .dropdown-item:hover {
    background: var(--hover);
  }

  .dropdown-item:active {
    background: var(--hover-strong);
  }

  .dropdown-item :global(svg) {
    color: var(--muted);
    flex-shrink: 0;
  }

  .dropdown-current {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 10px 10px;
  }

  .active-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--success);
    box-shadow: 0 0 0 3px var(--success-soft);
    flex-shrink: 0;
  }

  .current-info {
    display: grid;
    gap: 1px;
    min-width: 0;
  }

  .current-band {
    font-size: 0.94rem;
    font-weight: 600;
    color: var(--ink);
  }

  .current-addr,
  .account-addr {
    font-size: 0.8rem;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dropdown-label {
    display: block;
    padding: 8px 10px 2px;
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--muted);
  }

  .dropdown-divider {
    height: 1px;
    margin: 6px -6px;
    background: var(--line);
  }

  .dropdown-item--account {
    display: grid;
    gap: 1px;
  }

  .account-band {
    font-weight: 600;
  }
</style>
