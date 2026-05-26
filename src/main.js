import { mount } from "svelte";
import "./app.css";
import { registerSW } from "virtual:pwa-register";
import App from "./App.svelte";

registerSW({ immediate: true });

const app = mount(App, {
    target: document.getElementById("app"),
});

export default app;
