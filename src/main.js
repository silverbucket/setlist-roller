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

registerSW({ immediate: true });

const app = mount(App, {
    target: document.getElementById("app"),
});

export default app;
