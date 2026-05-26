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

function setAppHeight() {
    document.documentElement.style.setProperty("--real-vh", `${window.innerHeight}px`);
}

// Keep the shell height tied to the layout viewport. In standalone mode, the
// status bar must not be translucent; otherwise iOS lays the viewport out at
// physical y=0 but reports only screen-height - safe-top, leaving that missing
// safe-top-sized region at the bottom of the webview.
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
