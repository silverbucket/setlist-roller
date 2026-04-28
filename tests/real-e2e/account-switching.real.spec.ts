import { mintToken, signupUser } from "./fixtures/armadietto";
import { expect, test } from "./fixtures/test-fixtures";

/**
 * Real-backend account-switching coverage. Same scenarios as
 * tests/e2e/account-switching.spec.ts but against a live armadietto +
 * rs.js stack, so the OAuth redirect, webfinger discovery, and IndexedDB
 * cache are all exercised. The fake-repo equivalents pass — these catch
 * the regressions that only surface against real machinery.
 */

test.describe("Real backend — connect via OAuth redirect", () => {
    test("connect address redirects to armadietto OAuth, lands in app shell after Allow", async ({ page, app }) => {
        const user = await app.provisionUser("oauth");
        await app.goto();
        await page.getByPlaceholder("you@example.com").fill(user.address);

        // rs.js's default authorize path on non-iOS-PWA browsers
        // navigates the current page to the auth URL — it's not a popup
        // (the popup form lives behind the iOS-standalone branch in
        // src/lib/remotestorage.js). So we wait for the navigation, fill
        // the form on armadietto, and let armadietto's 302 redirect bring
        // us back to the app with the token in the hash.
        await Promise.all([
            page.waitForURL(/\/oauth\//, { timeout: 15_000 }),
            page.getByRole("button", { name: /^Connect/ }).click(),
        ]);
        await page.locator('input[name="password"]').fill(user.password);
        await Promise.all([
            page.waitForURL((u) => u.toString().includes("#access_token="), { timeout: 15_000 }),
            page.locator('button[name="allow"]').click(),
        ]);

        // The post-redirect app load runs rs.js's _rs_init, which parses
        // the token from the hash, configures the WireClient, and emits
        // 'connected'. Our store's connected handler then runs reloadAll
        // + saveKnownAccount. Bottom-nav visible = app shell rendered.
        await app.waitForReady();
        await expect(page.locator(".band-name")).toBeVisible();
    });
});

test.describe("Real backend — pre-seeded session", () => {
    test("page loads connected when localStorage already has a valid session", async ({ page, app }) => {
        // Skip the popup entirely — armadietto-minted token, written to
        // localStorage in an init script, lets rs.js cold-boot in the
        // connected state. This is the path a returning user takes after
        // closing and reopening the app.
        const user = await app.provisionUser("seed");
        await app.seedConnectedAccount(user);
        await app.goto();
        await app.waitForReady();
        // A cold-boot connected user should NOT see the connect screen.
        await expect(page.getByPlaceholder("you@example.com")).toHaveCount(0);
    });

    test("reload after seeded connect stays logged in", async ({ page, app }) => {
        const user = await app.provisionUser("reload");
        await app.seedConnectedAccount(user);
        await app.goto();
        await app.waitForReady();

        await page.reload();
        await app.waitForReady();
        // Crucial property: the session in rs.js's localStorage survives a
        // reload. This is what failed for the user reporting "refresh
        // sends me to login" — fake-repo couldn't catch it because it
        // didn't model session persistence.
        await expect(page.getByPlaceholder("you@example.com")).toHaveCount(0);
    });
});

test.describe("Real backend — multi-account swap", () => {
    test("seeding two accounts and swapping via TopBar lands on the swapped-to account", async ({ page, app }) => {
        const userA = await app.provisionUser("a");
        const userB = await app.provisionUser("b");
        await app.seedConnectedAccount(userA);
        await app.seedAdditionalAccount(userB);

        await app.goto();
        await app.waitForReady();

        // Open menu → Switch-to user-b. The custom Discover override in
        // src/lib/remotestorage.js fetches user-b's webfinger record from
        // armadietto, then rs.js configures the WireClient with the
        // pre-minted token and emits 'connected' — the app's swap state
        // machine settles into the connected-as-userB state.
        await page.locator("header.top-bar").getByRole("button", { name: "Menu" }).click();
        await page.locator(".dropdown-item--account").filter({ hasText: userB.address }).click();
        await app.waitForReady();

        // Swap should NOT have torn down rs.js's session — refreshing must
        // keep us connected as user-b. This is the property the
        // user-reported regression broke.
        await page.reload();
        await app.waitForReady();
        await expect(page.getByPlaceholder("you@example.com")).toHaveCount(0);
    });
});

test.describe("Real backend — provisioning sanity", () => {
    test("signupUser is idempotent on re-signup of the same name", async () => {
        // Tests reuse usernames if the volume is mounted across runs. The
        // helper must not throw on the second signup or the very first
        // test of every rerun would fail.
        const username = `idem${Math.random().toString(36).slice(2, 8)}`;
        const password = "Pass-12345";
        await signupUser(username, password);
        await signupUser(username, password); // must not throw
        // And we can still mint a token after the duplicate signup.
        const token = await mintToken(username, password);
        expect(token).toMatch(/^[A-Za-z0-9+/=%-]+$/);
    });
});
