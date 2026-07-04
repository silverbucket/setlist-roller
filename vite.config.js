import { readFileSync } from "node:fs";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

// Content-Security-Policy (#79). remoteStorage tokens live in localStorage
// (the standard unhosted-app pattern); the app loads no third-party JS, and
// this policy makes that a guarantee — any injected inline/external script
// is refused by the browser. Notes:
// - script-src 'self': no inline scripts anywhere (theme init is an
//   external file in /public for exactly this reason).
// - style-src 'unsafe-inline': Svelte sets style attributes (e.g. dynamic
//   accent colors); component CSS itself is an external file.
// - connect-src https: http:: rs.js talks to whatever storage host the
//   user's WebFinger points at, including plain-HTTP LAN servers.
// - Injected at build time only, so the dev server (HMR websockets,
//   plugin injections) stays unrestricted.
const CSP_POLICY = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self' https: http:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
].join("; ");

function cspPlugin() {
    return {
        name: "inject-csp",
        apply: "build",
        transformIndexHtml() {
            return [
                {
                    tag: "meta",
                    attrs: { "http-equiv": "Content-Security-Policy", content: CSP_POLICY },
                    injectTo: "head-prepend",
                },
            ];
        },
    };
}

// Staging builds (vite build --mode staging, via npm run build:staging and
// .github/workflows/staging.yml) trade a few bytes for debuggability:
// sourcemaps, preserved function/class names in stack traces, a "-staging"
// version suffix, and a renamed PWA manifest so the installed staging app is
// distinguishable from production on a home screen. The app itself reads
// import.meta.env.MODE to show its staging badge.
export default defineConfig(({ mode }) => {
    const isStaging = mode === "staging";
    return {
        plugins: [
            svelte(),
            cspPlugin(),
            VitePWA({
                // Update flow: "prompt" means a new deploy waits until the user
                // taps Refresh (see registerSW in App.svelte) instead of
                // auto-reloading the page — which could eat an unsaved setlist
                // mid-gig.
                registerType: "prompt",
                // The plugin precaches manifest icons by default, which would
                // shadow the dynamic-icon runtime route below — the precache
                // handler wins for an exact URL match, pinning icons to the
                // default color forever.
                includeManifestIcons: false,
                // Static manifest so installability doesn't depend on JS having
                // run (the previous runtime blob-URL manifest broke Chromium's
                // install checks — relative start_url can't resolve against a
                // blob: base — and data-URL icons can't be minted into Android
                // WebAPKs). Icon URLs point at real files in /public; the SW
                // route below lets the page overlay them with die-colored
                // renders via Cache Storage (see src/lib/pwa-icon.js).
                manifest: {
                    name: isStaging ? "Setlist Roller (Staging)" : "Setlist Roller",
                    short_name: isStaging ? "SR Staging" : "Setlist Roller",
                    description: "A dice-powered setlist generator for bands who like to live dangerously.",
                    start_url: "/",
                    scope: "/",
                    display: "standalone",
                    background_color: "#1a1a1e",
                    theme_color: "#e15b37",
                    icons: [
                        { src: "/app-icon-192.png", sizes: "192x192", type: "image/png" },
                        { src: "/app-icon-512.png", sizes: "512x512", type: "image/png" },
                        {
                            src: "/app-icon-maskable-512.png",
                            sizes: "512x512",
                            type: "image/png",
                            purpose: "maskable",
                        },
                    ],
                },
                workbox: {
                    globPatterns: ["**/*.{js,css,html,svg,png,woff,woff2}"],
                    // app-icon-*.png must NOT be precached: the precache route
                    // would win over the runtime route below and pin the icons
                    // to the default color forever.
                    globIgnores: ["**/auth-relay.html", "**/app-icon-*.png", "app-icon-*.png"],
                    navigateFallback: "index.html",
                    navigateFallbackDenylist: [/^\/auth-relay\.html/],
                    runtimeCaching: [
                        {
                            // Serve icons from the cache the page writes colored
                            // renders into; fall through to the network (the
                            // default-orange /public files) when absent.
                            urlPattern: /\/app-icon-[\w-]+\.png$/,
                            handler: "CacheFirst",
                            options: { cacheName: "sr-dynamic-icons" },
                        },
                    ],
                },
            }),
        ],
        define: {
            __APP_VERSION__: JSON.stringify(isStaging ? `${pkg.version}-staging` : pkg.version),
        },
        build: {
            // Sourcemaps on staging so errors in the deployed bundle map
            // back to real source lines. Off in production (unchanged).
            sourcemap: isStaging,
        },
        esbuild: {
            // Keep function/class names on staging — stack traces and
            // console output stay readable even before a sourcemap loads.
            keepNames: isStaging,
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
    };
});
