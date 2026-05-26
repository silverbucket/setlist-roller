import { mount } from "svelte";
import "./app.css";
import { registerSW } from "virtual:pwa-register";
import App from "./App.svelte";

// Prevent the browser / iOS PWA runtime from restoring a stale scroll
// position on cold-start.  Without this, iOS will replay whatever scrollY
// the user had last session onto the freshly-mounted (and possibly shorter)
// idle layout, producing phantom whitespace below the hero card.
if ("scrollRestoration" in history) {
    history.scrollRestoration = "manual";
}

// iOS standalone PWA: 100dvh is computed lazily by WebKit and starts at an
// incorrect (too large) value on cold-start, creating a gap before the first
// user touch corrects it. window.innerHeight is authoritative from the first
// render. Keep it updated on multiple events so the value stays correct after
// keyboard show/hide, orientation changes, and page-restore from background.
function syncAppHeight() {
    document.documentElement.style.setProperty("--real-vh", window.innerHeight + "px");
}
syncAppHeight();
window.addEventListener("resize", syncAppHeight);
// pageshow fires on back-forward cache restore where resize may not fire
window.addEventListener("pageshow", syncAppHeight);
// visualViewport.resize is more reliable than window.resize on iOS for
// catching height changes caused by the on-screen keyboard
if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", syncAppHeight);
}

registerSW({ immediate: true });

const app = mount(App, {
    target: document.getElementById("app"),
});

export default app;
