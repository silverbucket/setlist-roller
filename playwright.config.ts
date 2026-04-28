import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for Setlist Roller.
 *
 * Two e2e modes live here:
 *
 *   chromium / mobile (default `npm run test:e2e`)
 *     Run against `tests/e2e/` with the in-memory fake repo
 *     (`tests/fixtures/fake-repo.ts`) injected via
 *     `window.__SR_TEST_REPO_FACTORY__` before the app boots. Fast, no
 *     external services, exercises the store and the connect-screen UX
 *     against a deterministic backend.
 *
 *   real-chromium (opt-in via `npm run test:e2e:real`)
 *     Runs against `tests/real-e2e/` with no fake repo — the real rs.js
 *     library talks to a local armadietto remoteStorage server (see
 *     docker-compose.yml at repo root). Catches behavior that only shows
 *     up against real OAuth + sync, e.g. token-expired swap recovery and
 *     the user-reported "refresh sends me to login" symptom. Requires
 *     `docker compose up -d` first; tests fail loudly with a helpful
 *     message if the server isn't reachable.
 */
const REAL_BACKEND_BASE = process.env.SR_REAL_BASE_URL || "http://localhost:4173";

export default defineConfig({
    /* Run files in parallel */
    fullyParallel: true,
    /* Fail the build on CI if you accidentally left test.only in source */
    forbidOnly: !!process.env.CI,
    /* Retry on CI only */
    retries: process.env.CI ? 2 : 0,
    /* Opt out of parallel tests on CI */
    workers: process.env.CI ? 1 : undefined,
    reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],
    timeout: 30_000,
    expect: {
        timeout: 5_000,
    },
    use: {
        baseURL: "http://127.0.0.1:4173",
        trace: "on-first-retry",
        screenshot: "only-on-failure",
        video: "retain-on-failure",
        actionTimeout: 10_000,
        navigationTimeout: 15_000,
    },

    projects: [
        {
            name: "chromium",
            testDir: "./tests/e2e",
            use: { ...devices["Desktop Chrome"] },
        },
        {
            name: "mobile",
            testDir: "./tests/e2e",
            use: { ...devices["iPhone 13"] },
        },
        {
            // Real-backend project. Hit `localhost` (not 127.0.0.1) so the
            // page origin matches the OAuth redirect_uri that armadietto's
            // popup sends back; rs.js parses tokens out of
            // `window.location.hash` after the popup self-redirects.
            name: "real-chromium",
            testDir: "./tests/real-e2e",
            timeout: 60_000,
            use: {
                ...devices["Desktop Chrome"],
                baseURL: REAL_BACKEND_BASE,
            },
        },
    ],

    /* Run the dev server before starting tests */
    webServer: {
        command: "npm run dev -- --host 127.0.0.1 --port 4173",
        url: "http://127.0.0.1:4173",
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
        stdout: "pipe",
        stderr: "pipe",
    },
});
