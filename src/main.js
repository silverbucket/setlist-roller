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

// Keep the shell height tied to the initial layout viewport value that iOS
// standalone exposes most consistently for fixed chrome. The fixed top/bottom
// bars do not depend on this for anchoring; content uses it for its scroll box.
function syncAppHeight() {
    document.documentElement.style.setProperty("--real-vh", `${window.innerHeight}px`);
}

syncAppHeight();
window.addEventListener("resize", syncAppHeight);
window.addEventListener("pageshow", syncAppHeight);
if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", syncAppHeight);
}

registerSW({ immediate: true });

const app = mount(App, {
    target: document.getElementById("app"),
});

export default app;
