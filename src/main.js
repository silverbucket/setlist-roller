import { mount } from "svelte";
import "./app.css";
import { registerSW } from "virtual:pwa-register";
import App from "./App.svelte";

// Prevent the browser / iOS PWA runtime from restoring a stale scroll
// position on cold-start. Without this, iOS can replay a scrollY from the
// previous session onto the freshly-mounted app shell.
if ("scrollRestoration" in history) {
    history.scrollRestoration = "manual";
}

function readPxCustomProperty(name) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function isStandalonePwa() {
    return window.matchMedia?.("(display-mode: standalone)").matches || window.navigator?.standalone === true;
}

function getAppHeight() {
    const viewportHeight = window.innerHeight;

    if (!isStandalonePwa()) return viewportHeight;

    const physicalHeight = Math.max(screen.height || 0, window.outerHeight || 0);
    const missingHeight = physicalHeight - viewportHeight;
    const safeTop = readPxCustomProperty("--safe-top");

    // iOS standalone can report innerHeight/visualViewport.height as the area
    // below the status bar while still painting the full physical screen. When
    // the missing region exactly matches safe-area-inset-top, use the physical
    // height and offset fixed bottom chrome into that recovered space.
    if (physicalHeight > viewportHeight && safeTop > 0 && Math.abs(missingHeight - safeTop) <= 2) {
        return physicalHeight;
    }

    return viewportHeight;
}

function setAppHeight() {
    const appHeight = getAppHeight();
    const fixedBottomOffset = Math.min(0, window.innerHeight - appHeight);

    document.documentElement.style.setProperty("--real-vh", `${appHeight}px`);
    document.documentElement.style.setProperty("--fixed-bottom-offset", `${fixedBottomOffset}px`);
}

// Keep shell/chrome sizing in sync with the viewport values iOS standalone
// actually paints. Installed PWAs can under-report innerHeight by safe-top.
let appHeightRaf = 0;
function syncAppHeight() {
    if (appHeightRaf) return;
    appHeightRaf = requestAnimationFrame(() => {
        appHeightRaf = 0;
        setAppHeight();
    });
}

setAppHeight();
window.addEventListener("resize", syncAppHeight);
// Rotation should also re-sync even on iOS builds that coalesce or delay resize.
window.addEventListener("orientationchange", syncAppHeight);
// Re-sync on bfcache restore: iOS may change orientation while backgrounded.
window.addEventListener("pageshow", syncAppHeight);
if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", syncAppHeight);
}

registerSW({ immediate: true });

const app = mount(App, {
    target: document.getElementById("app"),
});

export default app;
