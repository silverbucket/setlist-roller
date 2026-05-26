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

// iOS standalone PWA: 100dvh / 100svh and window.innerHeight are frequently
// wrong or stale on cold start, orientation, and some PWA launches. We
// prefer window.visualViewport.height when available (this is the value
// WebKit actually uses for the visual content area in many installed PWA
// scenarios). We also do extra settling measurements on iOS standalone.
function syncAppHeight() {
    const vv = window.visualViewport;
    const h = vv && typeof vv.height === "number" && vv.height > 0 ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty("--real-vh", `${h}px`);
}

syncAppHeight();
window.addEventListener("resize", syncAppHeight);
// pageshow fires on back-forward cache restore where resize may not fire
window.addEventListener("pageshow", syncAppHeight);

// visualViewport events are the most reliable signal on iOS for PWA window
// size changes (keyboard, rotation, some cold-start corrections).
if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", syncAppHeight);
    // scroll can fire during settling on some iOS PWA launches
    window.visualViewport.addEventListener("scroll", syncAppHeight);
}

// Extra aggressive settling for installed iOS PWA. visualViewport and
// innerHeight can take a few frames (or a user gesture) to report the
// true visual bounds. We re-measure a few times after first paint.
const isStandalone = window.matchMedia?.("(display-mode: standalone)").matches || window.navigator?.standalone === true;

if (isStandalone) {
    // Run a few settling syncs. These are cheap and have prevented the
    // "whitespace below nav / floating UI" symptom on real devices in the past.
    requestAnimationFrame(() => syncAppHeight());
    setTimeout(syncAppHeight, 120);
    setTimeout(syncAppHeight, 350);
    setTimeout(syncAppHeight, 800);
}

registerSW({ immediate: true });

const app = mount(App, {
    target: document.getElementById("app"),
});

export default app;
