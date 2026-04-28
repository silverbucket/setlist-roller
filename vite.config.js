import { readFileSync } from "node:fs";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

export default defineConfig({
    plugins: [
        svelte(),
        VitePWA({
            registerType: "autoUpdate",
            manifest: false,
            workbox: {
                globPatterns: ["**/*.{js,css,html,svg,png,woff,woff2}"],
                globIgnores: ["**/auth-relay.html"],
                navigateFallback: "index.html",
                navigateFallbackDenylist: [/^\/auth-relay\.html/],
            },
        }),
    ],
    define: {
        __APP_VERSION__: JSON.stringify(pkg.version),
    },
    server: {
        host: "0.0.0.0",
        port: 4173,
    },
    // Vitest config — keep Playwright E2E specs out of the unit-test runner.
    // Without this exclude, vitest picks up tests/e2e/*.spec.ts and Playwright's
    // test.describe() throws because it's running under the wrong runner.
    test: {
        exclude: [
            "tests/e2e/**",
            "tests/real-e2e/**",
            "tests/pages/**",
            "tests/fixtures/**",
            "node_modules/**",
            "dist/**",
        ],
    },
});
