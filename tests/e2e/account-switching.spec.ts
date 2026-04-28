import { expect, makeSong, test } from "../fixtures/test-fixtures";
import { AppShell } from "../pages/AppShell";
import { ConnectPage } from "../pages/ConnectPage";

/**
 * Account-switching coverage. The connectToAccount() function (TopBar
 * Switch-to / Recent click) had no direct test coverage before this file —
 * connection.spec.ts only covered cold-connect and disconnect, and
 * edge-cases.spec.ts only verified that Add Account leaves the user on the
 * connect screen with Recent listed. Neither exercised the actual swap.
 */

function getToastMessages(state: unknown) {
    const toasts = (state as { toastMessages?: { message?: string }[] } | null)?.toastMessages || [];
    return toasts.map((t) => String(t.message || ""));
}

function expectNoAlreadyConnectingToast(state: unknown) {
    const messages = getToastMessages(state);
    const offending = messages.find((m) => m.toLowerCase().includes("already connecting"));
    expect(offending, `Saw 'Already connecting' toast: ${JSON.stringify(messages)}`).toBeUndefined();
}

test.describe("Account switching", () => {
    test("TopBar Switch-to swaps cleanly and lands on the new account's data", async ({ page, app }) => {
        // Two accounts pre-seeded. user-a is auto-connected; user-b is in
        // the known-accounts list (we'll add them via Add Account flow).
        await app.seed({
            autoConnectAs: "user-a@example.com",
            users: {
                "user-a@example.com": {
                    songs: { s1: makeSong({ id: "s1", name: "Africa" }) },
                    config: {
                        bandName: "Band A",
                        schemaVersion: 2,
                        createdAt: "2024-01-01T00:00:00.000Z",
                        updatedAt: "2024-01-01T00:00:00.000Z",
                    },
                },
                "user-b@example.com": {
                    songs: { s2: makeSong({ id: "s2", name: "Bohemian Rhapsody" }) },
                    config: {
                        bandName: "Band B",
                        schemaVersion: 2,
                        createdAt: "2024-01-01T00:00:00.000Z",
                        updatedAt: "2024-01-01T00:00:00.000Z",
                    },
                },
            },
        });
        await app.goto();
        await app.waitForReady();

        const shell = new AppShell(page);
        await expect(shell.bandTitle).toContainText("Band A");

        // Walk through Add Account -> connect as B so user-b ends up in the
        // known-accounts registry. (This is the real user flow that creates
        // the Switch-to entry; faking it via callStore would skip the
        // saveKnownAccount integration.)
        await shell.openMenu();
        await page.getByRole("button", { name: "Add Account" }).click();
        const connect = new ConnectPage(page);
        await connect.waitForVisible();
        await connect.connect("user-b@example.com");
        await app.waitForReady();
        await expect(shell.bandTitle).toContainText("Band B");

        // Now switch back to user-a via the TopBar dropdown.
        await shell.switchToAccount("user-a@example.com");

        // The band-title flips back, AND the connection is fully settled
        // (no spurious "Already connecting" guard fire).
        await expect(shell.bandTitle).toContainText("Band A", { timeout: 10_000 });
        const state = await app.getState();
        expect(state?.connectionStatus).toBe("connected");
        expectNoAlreadyConnectingToast(state);
        // Per-account isolation: A's song shows, B's doesn't.
        const songNames = (state?.songs as { name?: string }[]).map((s) => s.name);
        expect(songNames).toContain("Africa");
        expect(songNames).not.toContain("Bohemian Rhapsody");
    });

    test("Recent account click on connect screen logs back in", async ({ page, app }) => {
        await app.seed({
            autoConnectAs: "user-a@example.com",
            users: {
                "user-a@example.com": {
                    songs: {},
                    config: {
                        bandName: "Band A",
                        schemaVersion: 2,
                        createdAt: "2024-01-01T00:00:00.000Z",
                        updatedAt: "2024-01-01T00:00:00.000Z",
                    },
                },
            },
        });
        await app.goto();
        await app.waitForReady();

        const shell = new AppShell(page);
        await shell.openMenu();
        await page.getByRole("button", { name: "Add Account" }).click();
        const connect = new ConnectPage(page);
        await connect.waitForVisible();
        await expect(connect.recentAccountByAddress("user-a@example.com")).toBeVisible();

        await connect.recentAccountByAddress("user-a@example.com").click();
        await app.waitForReady();
        await expect(shell.bandTitle).toContainText("Band A");

        const state = await app.getState();
        expect(state?.connectionStatus).toBe("connected");
        expectNoAlreadyConnectingToast(state);
    });

    test("page reload after cold connect stays logged in", async ({ page, app }) => {
        await app.seed({
            autoConnectAs: "user-a@example.com",
            users: {
                "user-a@example.com": {
                    songs: {},
                    config: {
                        bandName: "Band A",
                        schemaVersion: 2,
                        createdAt: "2024-01-01T00:00:00.000Z",
                        updatedAt: "2024-01-01T00:00:00.000Z",
                    },
                },
            },
        });
        await app.goto();
        await app.waitForReady();
        const shell = new AppShell(page);
        await expect(shell.bandTitle).toContainText("Band A");

        await page.reload();
        await app.waitForReady();
        await expect(shell.bandTitle).toContainText("Band A");
        const state = await app.getState();
        expect(state?.connectionStatus).toBe("connected");
    });

    test("page reload after a swap stays on the swapped-to account", async ({ page, app }) => {
        await app.seed({
            autoConnectAs: "user-a@example.com",
            users: {
                "user-a@example.com": {
                    songs: {},
                    config: {
                        bandName: "Band A",
                        schemaVersion: 2,
                        createdAt: "2024-01-01T00:00:00.000Z",
                        updatedAt: "2024-01-01T00:00:00.000Z",
                    },
                },
                "user-b@example.com": {
                    songs: {},
                    config: {
                        bandName: "Band B",
                        schemaVersion: 2,
                        createdAt: "2024-01-01T00:00:00.000Z",
                        updatedAt: "2024-01-01T00:00:00.000Z",
                    },
                },
            },
        });
        await app.goto();
        await app.waitForReady();
        const shell = new AppShell(page);

        await shell.openMenu();
        await page.getByRole("button", { name: "Add Account" }).click();
        const connect = new ConnectPage(page);
        await connect.connect("user-b@example.com");
        await app.waitForReady();
        await expect(shell.bandTitle).toContainText("Band B");

        // Reload — the most-recently-connected user (B) should stay logged in.
        await page.reload();
        await app.waitForReady();
        await expect(shell.bandTitle).toContainText("Band B");
        const state = await app.getState();
        expect(state?.connectionStatus).toBe("connected");
    });

    test("rapid double-click on Switch-to does not corrupt state", async ({ page, app }) => {
        await app.seed({
            autoConnectAs: "user-a@example.com",
            users: {
                "user-a@example.com": {
                    songs: {},
                    config: {
                        bandName: "Band A",
                        schemaVersion: 2,
                        createdAt: "2024-01-01T00:00:00.000Z",
                        updatedAt: "2024-01-01T00:00:00.000Z",
                    },
                },
                "user-b@example.com": {
                    songs: {},
                    config: {
                        bandName: "Band B",
                        schemaVersion: 2,
                        createdAt: "2024-01-01T00:00:00.000Z",
                        updatedAt: "2024-01-01T00:00:00.000Z",
                    },
                },
            },
        });
        await app.goto();
        await app.waitForReady();
        const shell = new AppShell(page);

        // Get user-b into the known-accounts registry first.
        await shell.openMenu();
        await page.getByRole("button", { name: "Add Account" }).click();
        const connect = new ConnectPage(page);
        await connect.connect("user-b@example.com");
        await app.waitForReady();
        await expect(shell.bandTitle).toContainText("Band B");

        // Double-click the Switch-to entry. The second click should hit the
        // re-entry guard and toast "Already connecting"; the first click
        // should still resolve cleanly to user-a. State must not be wedged.
        await shell.openMenu();
        const switchBtn = page.locator(".dropdown-item--account").filter({ hasText: "user-a@example.com" });
        await switchBtn.click();
        // Don't await navigation — fire a second connectToAccount via store
        // to simulate a fast second click. (UI close-menu makes a real
        // double-click hard to reproduce deterministically.)
        await app.callStore("connectToAccount", "user-a@example.com");
        await app.waitForReady();

        await expect(shell.bandTitle).toContainText("Band A", { timeout: 10_000 });
        const state = await app.getState();
        expect(state?.connectionStatus).toBe("connected");
        // The "Already connecting — hold on" guard toast IS expected here
        // (that's correct behavior on a double-click). What we must not see
        // is the connection getting stuck — the band-title check above
        // already proves that, so we don't assert no-toast in this case.
    });

    test("Switch-to entry is hidden for the currently-connected account", async ({ page, app }) => {
        await app.seed({
            autoConnectAs: "user-a@example.com",
            users: {
                "user-a@example.com": {
                    songs: {},
                    config: {
                        bandName: "Band A",
                        schemaVersion: 2,
                        createdAt: "2024-01-01T00:00:00.000Z",
                        updatedAt: "2024-01-01T00:00:00.000Z",
                    },
                },
                "user-b@example.com": {
                    songs: {},
                    config: {
                        bandName: "Band B",
                        schemaVersion: 2,
                        createdAt: "2024-01-01T00:00:00.000Z",
                        updatedAt: "2024-01-01T00:00:00.000Z",
                    },
                },
            },
        });
        await app.goto();
        await app.waitForReady();
        const shell = new AppShell(page);

        // Get user-b into known-accounts.
        await shell.openMenu();
        await page.getByRole("button", { name: "Add Account" }).click();
        const connect = new ConnectPage(page);
        await connect.connect("user-b@example.com");
        await app.waitForReady();

        await shell.openMenu();
        // The currently-connected account (B) must NOT show up under Switch-to.
        const selfEntry = page.locator(".dropdown-item--account").filter({ hasText: "user-b@example.com" });
        await expect(selfEntry).toHaveCount(0);
        // The other account (A) must show.
        const otherEntry = page.locator(".dropdown-item--account").filter({ hasText: "user-a@example.com" });
        await expect(otherEntry).toBeVisible();
    });
});
