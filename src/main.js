import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";

// Prevent the browser / iOS PWA runtime from restoring a stale scroll
// position on cold-start. Without this, iOS can replay a scrollY from the
// previous session onto the freshly-mounted app shell.
if ("scrollRestoration" in history) {
    history.scrollRestoration = "manual";
}

// Service-worker registration lives in App.svelte: with prompt-style
// updates (vite.config.js registerType: "prompt"), onNeedRefresh must
// surface a toast, and the toast system belongs to the app store.

const app = mount(App, {
    target: document.getElementById("app"),
});

export default app;
