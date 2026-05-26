import { buildSeed, expect, test } from "../fixtures/test-fixtures";
import { AppShell } from "../pages/AppShell";
import { ConnectPage } from "../pages/ConnectPage";

/**
 * The connection screen is the disconnected entry point. Without a seed,
 * the fake repo never auto-connects, so the app stays disconnected — same
 * shape the user sees on first visit.
 */
test.describe("Connection screen", () => {
    test("shows connect form when disconnected", async ({ page, app }) => {
        await app.goto();
        const connect = new ConnectPage(page);
        await connect.waitForVisible();
        await expect(connect.heading).toContainText("Setlist Roller");
        await expect(connect.connectButton).toBeVisible();
    });

    test("connects with an address and shows app shell", { tag: ["@smoke"] }, async ({ page, app }) => {
        const user = await app.provisionUser("alice");
        await app.goto();
        const connect = new ConnectPage(page);
        await connect.waitForVisible();
        await connect.connectViaOAuth(user);

        // After connect, the app shell should appear (BottomNav is the marker)
        const shell = new AppShell(page);
        await expect(shell.rollTab).toBeVisible({ timeout: 15_000 });
    });

    test("Enter key submits the connect form", async ({ page, app }) => {
        // The Enter-to-submit shortcut is what we want to verify, not
        // the full OAuth round-trip. Drive the form via keyboard up to
        // the navigation start, then continue with the same OAuth dance
        // the explicit Connect-click test runs.
        const user = await app.provisionUser("bob");
        await app.goto();
        const connect = new ConnectPage(page);
        await connect.waitForVisible();
        await connect.fillAddress(user.address);
        await Promise.all([page.waitForURL(/\/oauth\//, { timeout: 15_000 }), connect.addressInput.press("Enter")]);
        await page.locator('input[name="password"]').fill(user.password);
        await Promise.all([
            page.waitForURL((u) => u.toString().includes("#access_token="), { timeout: 15_000 }),
            page.locator('button[name="allow"]').click(),
        ]);
        const shell = new AppShell(page);
        await expect(shell.rollTab).toBeVisible({ timeout: 15_000 });
    });

    test("Connect button is disabled when address is empty", async ({ page, app }) => {
        await app.goto();
        const connect = new ConnectPage(page);
        await connect.waitForVisible();
        await expect(connect.connectButton).toBeDisabled();
        // App shell never appears
        await expect(page.locator("nav.bottom-nav")).toHaveCount(0);
    });

    test("known accounts appear in Recent list after connecting", async ({ page, app }) => {
        const user = await app.provisionUser("recurring");
        await app.goto();
        const connect = new ConnectPage(page);
        await connect.waitForVisible();
        await connect.connectViaOAuth(user);
        const shell = new AppShell(page);
        await expect(shell.rollTab).toBeVisible({ timeout: 15_000 });
        await shell.completeFirstRun("Recurring Band");

        // Disconnect and verify the address shows up under Recent
        await shell.openMenu();
        await page.getByRole("button", { name: "Add Account" }).click();
        await connect.waitForVisible();
        await expect(connect.recentAccountsLabel).toBeVisible();
        await expect(connect.recentAccountByAddress(user.address)).toBeVisible();
    });

    test("Recent account can be forgotten", async ({ page, app }) => {
        // Skip the OAuth round-trip; staging the known-accounts entry
        // directly is enough to exercise the Forget UI, which is the
        // unit under test here.
        const user = await app.provisionUser("forget");
        await app.seedAdditionalAccount(user);
        await app.goto();
        const connect = new ConnectPage(page);
        await connect.waitForVisible();
        await expect(connect.recentAccountByAddress(user.address)).toBeVisible();

        await connect.forgetAccount(user.address);
        await expect(connect.recentAccountByAddress(user.address)).toHaveCount(0);
    });
});

test.describe("Auto-connect with seed", { tag: ["@smoke"] }, () => {
    test("seeded user boots straight into app shell", async ({ page, app }) => {
        await app.seed(buildSeed());
        await app.goto();
        const shell = new AppShell(page);
        await expect(shell.rollTab).toBeVisible({ timeout: 10_000 });
        await expect(shell.bandTitle).toContainText("Test Band");
    });

    test("connection dot reads connected after seeded boot", async ({ page, app }) => {
        await app.seed(buildSeed());
        await app.goto();
        await app.waitForReady();
        const shell = new AppShell(page);
        await expect(shell.connectionDot).toHaveClass(/connected/);
    });
});
