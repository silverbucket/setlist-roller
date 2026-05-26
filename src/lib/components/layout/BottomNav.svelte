<script>
  import { getContext } from "svelte";

  const store = getContext("app");

  const tabs = [
    { id: "roll", label: "Roll", icon: "\u2684" },
    { id: "saved", label: "Saved", icon: "\u2605" },
    { id: "songs", label: "Songs", icon: "\u266B" },
    { id: "band", label: "Band", icon: "\u2699" },
    { id: "help", label: "Help", icon: "?" },
  ];
</script>

<nav class="bottom-nav">
  {#each tabs as tab (tab.id)}
    <button type="button"
      class="tab"
      class:active={store.activeView === tab.id}
      onclick={() => store.navigate(tab.id)}
    >
      <span class="tab-icon" aria-hidden="true">{tab.icon}</span>
      <span class="tab-label">{tab.label}</span>
    </button>
  {/each}
</nav>

<style>
  .bottom-nav {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    height: var(--bottom-nav-height);
    display: flex;
    align-items: stretch;
    background: var(--paper);
    border-top: 1px solid var(--line);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    padding-bottom: env(safe-area-inset-bottom, 0px);
    z-index: 100;
  }

  .tab {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    min-height: 44px;
    min-width: 44px;
    border: none;
    background: none;
    cursor: pointer;
    color: var(--muted);
    padding: 6px 0;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
    transition: color 0.15s ease;
  }

  .tab:active {
    opacity: 0.7;
  }

  .tab.active {
    color: var(--accent);
  }

  .tab-icon {
    font-size: 22px;
    line-height: 1;
  }

  .tab-label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }
</style>
