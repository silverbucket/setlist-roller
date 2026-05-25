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
// render. Keep it updated on resize so keyboard show/hide is also covered.
function syncAppHeight() {
    document.documentElement.style.setProperty("--real-vh", window.innerHeight + "px");
}
syncAppHeight();
window.addEventListener("resize", syncAppHeight);

registerSW({ immediate: true });

const app = mount(App, {
    target: document.getElementById("app"),
});

export default app;
