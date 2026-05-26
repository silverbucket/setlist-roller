<script>
  import { onMount } from "svelte";

  let { onClose } = $props();

  let diagnostics = $state({});
  let copied = $state(false);

  function round(value) {
    return typeof value === "number" ? Math.round(value * 100) / 100 : value;
  }

  function rectFor(selector) {
    const el = document.querySelector(selector);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      top: round(rect.top),
      bottom: round(rect.bottom),
      height: round(rect.height),
      left: round(rect.left),
      right: round(rect.right),
      width: round(rect.width),
    };
  }

  function collectDiagnostics() {
    const root = document.documentElement;
    const body = document.body;
    const app = document.getElementById("app");
    const shell = document.querySelector(".app-shell");
    const main = document.querySelector(".main-content");
    const navRect = rectFor("nav.bottom-nav");
    const rootStyles = getComputedStyle(root);

    diagnostics = {
      capturedAt: new Date().toISOString(),
      mode: {
        userAgent: navigator.userAgent,
        standaloneMedia: window.matchMedia?.("(display-mode: standalone)").matches ?? null,
        navigatorStandalone: navigator.standalone ?? null,
      },
      window: {
        innerWidth: round(window.innerWidth),
        innerHeight: round(window.innerHeight),
        outerWidth: round(window.outerWidth),
        outerHeight: round(window.outerHeight),
        scrollX: round(window.scrollX),
        scrollY: round(window.scrollY),
        devicePixelRatio: round(window.devicePixelRatio),
      },
      screen: {
        width: round(screen.width),
        height: round(screen.height),
        availWidth: round(screen.availWidth),
        availHeight: round(screen.availHeight),
        orientation: screen.orientation?.type ?? null,
      },
      visualViewport: window.visualViewport
        ? {
            width: round(window.visualViewport.width),
            height: round(window.visualViewport.height),
            offsetTop: round(window.visualViewport.offsetTop),
            offsetLeft: round(window.visualViewport.offsetLeft),
            pageTop: round(window.visualViewport.pageTop),
            pageLeft: round(window.visualViewport.pageLeft),
            scale: round(window.visualViewport.scale),
          }
        : null,
      document: {
        documentElementClientHeight: round(root.clientHeight),
        documentElementScrollHeight: round(root.scrollHeight),
        bodyClientHeight: round(body?.clientHeight),
        bodyScrollHeight: round(body?.scrollHeight),
        appClientHeight: round(app?.clientHeight),
        appScrollHeight: round(app?.scrollHeight),
      },
      css: {
        realVh: rootStyles.getPropertyValue("--real-vh").trim() || null,
        safeTop: rootStyles.getPropertyValue("--safe-top").trim() || null,
        safeBottom: rootStyles.getPropertyValue("--safe-bottom").trim() || null,
        topBarHeight: rootStyles.getPropertyValue("--top-bar-height").trim() || null,
        bottomNavHeight: rootStyles.getPropertyValue("--bottom-nav-height").trim() || null,
      },
      layout: {
        appShellHeight: shell ? round(shell.getBoundingClientRect().height) : null,
        mainContentHeight: main ? round(main.getBoundingClientRect().height) : null,
        topBarRect: rectFor("header.top-bar"),
        bottomNavRect: navRect,
        gapBelowNavFromInnerHeight: navRect ? round(window.innerHeight - navRect.bottom) : null,
        gapBelowNavFromDocumentClientHeight: navRect ? round(root.clientHeight - navRect.bottom) : null,
        gapBelowNavFromVisualViewport: navRect && window.visualViewport
          ? round(window.visualViewport.height - navRect.bottom)
          : null,
      },
    };
  }

  let diagnosticsText = $derived(JSON.stringify(diagnostics, null, 2));

  async function copyDiagnostics() {
    copied = false;
    await navigator.clipboard.writeText(diagnosticsText);
    copied = true;
  }

  onMount(() => {
    let timeoutIds = [];
    let intervalId;

    collectDiagnostics();

    const schedule = () => requestAnimationFrame(collectDiagnostics);
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    window.addEventListener("pageshow", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);

    intervalId = window.setInterval(collectDiagnostics, 250);
    timeoutIds.push(window.setTimeout(() => window.clearInterval(intervalId), 5000));
    for (const delay of [50, 120, 350, 800, 1500, 3000]) {
      timeoutIds.push(window.setTimeout(collectDiagnostics, delay));
    }

    return () => {
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      window.removeEventListener("pageshow", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
      window.clearInterval(intervalId);
      for (const timeoutId of timeoutIds) window.clearTimeout(timeoutId);
    };
  });
</script>

<div class="diagnostics-backdrop" role="presentation" onclick={onClose}></div>
<div class="diagnostics-sheet" role="dialog" aria-modal="true" aria-labelledby="viewport-diagnostics-title">
  <div class="diagnostics-header">
    <div>
      <p class="eyebrow">Debug</p>
      <h2 id="viewport-diagnostics-title">Viewport Diagnostics</h2>
    </div>
    <button type="button" class="icon-btn" onclick={onClose} aria-label="Close viewport diagnostics">&times;</button>
  </div>

  <div class="diagnostics-actions">
    <button type="button" class="diag-btn primary" onclick={copyDiagnostics}>
      {copied ? "Copied" : "Copy diagnostics"}
    </button>
    <button type="button" class="diag-btn" onclick={collectDiagnostics}>Refresh</button>
  </div>

  <pre>{diagnosticsText}</pre>
</div>

<style>
  .diagnostics-backdrop {
    position: fixed;
    inset: 0;
    z-index: 500;
    background: rgba(18, 24, 36, 0.42);
    backdrop-filter: blur(4px);
  }

  .diagnostics-sheet {
    position: fixed;
    left: 12px;
    right: 12px;
    top: calc(var(--safe-top) + 12px);
    bottom: calc(var(--safe-bottom) + 12px);
    z-index: 501;
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr);
    gap: 12px;
    padding: 16px;
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--paper-strong);
    box-shadow: var(--shadow);
  }

  .diagnostics-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .eyebrow {
    margin: 0 0 4px;
    color: var(--accent);
    font-size: 0.72rem;
    font-weight: 800;
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }

  h2 {
    margin: 0;
    font-size: 1.25rem;
    line-height: 1.1;
  }

  .icon-btn {
    width: 44px;
    min-height: 44px;
    border: none;
    border-radius: var(--radius-md);
    background: var(--paper-soft);
    color: var(--ink);
    font-size: 24px;
    line-height: 1;
  }

  .diagnostics-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .diag-btn {
    min-height: 44px;
    padding: 10px 14px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: var(--surface);
    color: var(--ink);
    font-size: 16px;
    font-weight: 800;
  }

  .diag-btn.primary {
    border-color: var(--accent-line);
    background: var(--accent);
    color: var(--on-accent);
  }

  pre {
    min-height: 0;
    margin: 0;
    overflow: auto;
    padding: 12px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: rgba(13, 18, 28, 0.92);
    color: #edf2ff;
    font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    white-space: pre-wrap;
  }
</style>
