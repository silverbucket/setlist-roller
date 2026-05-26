<script>
  import { onMount, tick } from "svelte";

  // TEMP(iOS diagnostics): remove this component after the installed-PWA
  // viewport gap is measured and fixed.

  let { onClose } = $props();

  let diagnostics = $state({});
  let copied = $state(false);
  let copyError = $state("");
  let sheetEl = $state();
  let closeBtnEl = $state();
  let previousFocus = null;

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
  let findings = $derived.by(() => {
    const layout = diagnostics.layout || {};
    const mode = diagnostics.mode || {};
    const viewport = diagnostics.visualViewport;
    const items = [];

    if (!mode.standaloneMedia && mode.navigatorStandalone !== true) {
      items.push("Not detected as standalone PWA.");
    }
    if (Math.abs(layout.gapBelowNavFromInnerHeight || 0) > 2) {
      items.push(`innerHeight/nav gap: ${layout.gapBelowNavFromInnerHeight}px`);
    }
    if (Math.abs(layout.gapBelowNavFromVisualViewport || 0) > 2) {
      items.push(`visualViewport/nav gap: ${layout.gapBelowNavFromVisualViewport}px`);
    }
    if (viewport?.scale && viewport.scale !== 1) {
      items.push(`visualViewport scale is ${viewport.scale}.`);
    }
    if (!diagnostics.css?.realVh) {
      items.push("--real-vh is missing.");
    }

    return items.length > 0 ? items : ["No obvious viewport mismatch in current sample."];
  });

  function handleKeydown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose?.();
    }
  }

  async function copyDiagnostics() {
    copied = false;
    copyError = "";
    try {
      await navigator.clipboard.writeText(diagnosticsText);
      copied = true;
    } catch (error) {
      copyError = error instanceof Error ? error.message : "Clipboard copy failed";
    }
  }

  onMount(() => {
    const timeoutIds = [];
    let rafId = 0;

    previousFocus = document.activeElement;
    collectDiagnostics();

    const schedule = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        collectDiagnostics();
      });
    };

    tick().then(() => {
      closeBtnEl?.focus();
    });

    window.addEventListener("keydown", handleKeydown);
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    window.addEventListener("pageshow", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);

    for (const delay of [50, 250, 1000]) {
      timeoutIds.push(window.setTimeout(collectDiagnostics, delay));
    }

    return () => {
      window.removeEventListener("keydown", handleKeydown);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      window.removeEventListener("pageshow", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
      if (rafId) cancelAnimationFrame(rafId);
      for (const timeoutId of timeoutIds) window.clearTimeout(timeoutId);
      if (
        previousFocus &&
        typeof previousFocus.focus === "function" &&
        document.body.contains(previousFocus)
      ) {
        previousFocus.focus();
      }
      previousFocus = null;
    };
  });
</script>

<div
  class="diagnostics-sheet"
  bind:this={sheetEl}
  role="dialog"
  aria-modal="false"
  aria-labelledby="viewport-diagnostics-title"
  tabindex="-1"
>
  <div class="diagnostics-header">
    <div>
      <p class="eyebrow">Debug</p>
      <h2 id="viewport-diagnostics-title">Viewport Diagnostics</h2>
    </div>
    <button bind:this={closeBtnEl} type="button" class="icon-btn" onclick={onClose} aria-label="Close viewport diagnostics">&times;</button>
  </div>

  <div class="findings" aria-live="polite">
    {#each findings as finding (finding)}
      <p>{finding}</p>
    {/each}
  </div>

  <div class="diagnostics-actions">
    <button type="button" class="diag-btn primary" onclick={copyDiagnostics}>
      {copied ? "Copied" : "Copy diagnostics"}
    </button>
    <button type="button" class="diag-btn" onclick={collectDiagnostics}>Refresh</button>
  </div>

  {#if copyError}
    <p class="copy-error" role="alert">Copy failed: {copyError}</p>
  {/if}

  <pre>{diagnosticsText}</pre>
</div>

<style>
  .diagnostics-sheet {
    position: fixed;
    left: 12px;
    right: 12px;
    top: calc(var(--top-bar-height) + 8px);
    bottom: calc(var(--bottom-nav-height) + 8px);
    z-index: 250;
    display: grid;
    grid-template-rows: auto auto auto auto minmax(0, 1fr);
    gap: 12px;
    padding: 16px;
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--paper-strong);
    box-shadow: var(--shadow);
  }

  .diagnostics-sheet:focus {
    outline: none;
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

  .findings {
    display: grid;
    gap: 4px;
    padding: 10px 12px;
    border: 1px solid var(--accent-line);
    border-radius: var(--radius-md);
    background: var(--accent-soft);
  }

  .findings p,
  .copy-error {
    margin: 0;
    font-size: 13px;
    line-height: 1.35;
  }

  .copy-error {
    color: var(--danger);
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
    font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    white-space: pre-wrap;
  }
</style>
