<script>
  import { getContext } from "svelte";
  import { generateDieSvgString } from "../../pwa-icon.js";
  import { DEFAULT_DIE_COLOR } from "../../utils.js";
  import Icon from "../shared/Icon.svelte";

  const store = getContext("app");

  const tabs = [
    { id: "roll", label: "Roll", icon: "dice" },
    { id: "saved", label: "Saved", icon: "bookmark" },
    { id: "songs", label: "Songs", icon: "music" },
    { id: "band", label: "Band", icon: "users" },
    { id: "help", label: "Help", icon: "help" },
  ];

  let dieHref = $derived(
    `data:image/svg+xml,${encodeURIComponent(generateDieSvgString(store.appConfig?.ui?.dieColor || DEFAULT_DIE_COLOR))}`
  );
</script>

<nav class="bottom-nav" aria-label="Main">
  <!-- Wordmark: only shown when the nav is a desktop sidebar. -->
  <div class="brand" aria-hidden="true">
    <img class="brand-die" src={dieHref} alt="" width="28" height="28" />
    <span class="brand-name">Setlist Roller</span>
  </div>

  {#each tabs as tab (tab.id)}
    <button type="button"
      class="tab"
      class:active={store.activeView === tab.id}
      aria-current={store.activeView === tab.id ? "page" : undefined}
      onclick={() => store.navigate(tab.id)}
    >
      <span class="tab-icon"><Icon name={tab.icon} size={22} stroke={store.activeView === tab.id ? 2.2 : 1.9} /></span>
      <span class="tab-label">{tab.label}</span>
    </button>
  {/each}
</nav>

<style>
  .bottom-nav {
    /* In normal flow at the bottom of the flex app shell — no
       position:fixed. The old fixed positioning is what let iOS strand the
       bar mid-screen after keyboard dismissal (stale visual viewport). */
    flex: none;
    height: var(--bottom-nav-height);
    display: flex;
    align-items: stretch;
    background: var(--surface);
    border-top: 1px solid var(--line);
    padding: 0 var(--space-1) var(--bottom-nav-safe-padding);
  }

  @media print {
    .bottom-nav {
      display: none;
    }
  }

  .brand {
    display: none;
  }

  .tab {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    min-height: 44px;
    min-width: 44px;
    border: none;
    background: none;
    cursor: pointer;
    color: var(--muted);
    padding: 6px 0 4px;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
    transition: color 0.15s ease;
  }

  .tab:hover {
    color: var(--ink);
  }

  .tab-icon {
    display: grid;
    place-items: center;
    width: 52px;
    height: 28px;
    border-radius: var(--radius-full);
    transition: background 0.15s ease;
  }

  .tab:active .tab-icon {
    background: var(--hover-strong);
  }

  .tab.active {
    color: var(--accent-text);
  }

  .tab.active .tab-icon {
    background: var(--accent-soft);
  }

  .tab-label {
    font-size: 0.72rem;
    font-weight: 600;
    line-height: 1;
  }

  /* ---- Desktop: the same nav, laid out as a sidebar ---- */
  @media (min-width: 900px) {
    .bottom-nav {
      height: auto;
      flex-direction: column;
      align-items: stretch;
      gap: 2px;
      padding: var(--space-4) var(--space-3);
      border-top: none;
      border-right: 1px solid var(--line);
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      height: 40px;
      padding: 0 10px;
      margin-bottom: var(--space-5);
    }

    .brand-die {
      width: 28px;
      height: 28px;
      transform: rotate(-8deg);
    }

    .brand-name {
      font-family: var(--font-display);
      font-size: 1.05rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--ink);
      white-space: nowrap;
    }

    .tab {
      flex: none;
      flex-direction: row;
      justify-content: flex-start;
      gap: 12px;
      min-height: 42px;
      padding: 0 10px;
      border-radius: var(--radius-md);
      color: var(--ink-2);
    }

    .tab:hover {
      background: var(--hover);
    }

    .tab-icon {
      width: 22px;
      height: 22px;
      border-radius: 0;
      color: var(--muted);
    }

    .tab:active .tab-icon,
    .tab.active .tab-icon {
      background: none;
    }

    .tab.active {
      background: var(--accent-soft);
      color: var(--accent-text);
    }

    .tab.active .tab-icon {
      color: inherit;
    }

    .tab-label {
      font-size: 0.94rem;
    }

    /* Help sits apart at the bottom of the rail: it's reference, not a
       place you work in. */
    .tab:last-child {
      margin-top: auto;
    }
  }
</style>
