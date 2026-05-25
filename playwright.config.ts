import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for Setlist Roller.
 *
 * The whole suite runs against a real armadietto remoteStorage server
 * brought up via docker-compose at the repo root. There is no fake
 * repo path — every test exercises real rs.js + real webfinger + real
 * OAuth + real sync. CI brings up the container before invoking
 * `playwright test`; locally run `npm run armadietto:up` first.
 *
 * baseURL points at `localhost` (not `127.0.0.1`) so the page origin
 * matches the OAuth redirect_uri armadietto sends back; rs.js parses
 * the access_token out of `window.location.hash` after armadietto's
 * 302 redirect, and a host mismatch there breaks the round-trip.
 */
export default defineConfig({
    testDir: "./tests/e2e",
    /* Run files in parallel */
    fullyParallel: true,
    /* Fail the build on CI if you accidentally left test.only in source */
    forbidOnly: !!process.env.CI,
    /* Retry on CI only */
    retries: process.env.CI ? 2 : 0,
    /* Opt out of parallel tests on CI */
    workers: process.env.CI ? 1 : undefined,
    reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],
    // Real-backend tests do real I/O — give them more headroom than the
    // 30s the fake-repo suite ran with. 45s is still generous for any
    // single test but fails faster than 60s when something hangs.
    timeout: 45_000,
    expect: {
        timeout: 10_000,
    },
    use: {
        baseURL: "http://localhost:4173",
        trace: "on-first-retry",
        screenshot: "only-on-failure",
        video: "retain-on-failure",
        actionTimeout: 10_000,
        navigationTimeout: 15_000,
    },

    projects: [
        {
            name: "chromium",
            use: { ...devices["Desktop Chrome"] },
        },
        {
            name: "mobile",
            use: { ...devices["iPhone 13"] },
        },
    ],

    /* Run the dev server before starting tests */
    webServer: {
        // Bind to localhost (not 0.0.0.0) so the dev server is reachable
        // via the same hostname rs.js will redirect to during OAuth.
        command: "npm run dev -- --host localhost --port 4173",
        url: "http://localhost:4173",
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
        stdout: "pipe",
        stderr: "pipe",
    },
});
