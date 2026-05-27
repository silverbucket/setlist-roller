import { buildSeed, expect, test } from "../fixtures/test-fixtures";
import { AppShell } from "../pages/AppShell";

/**
 * App-level navigation — bottom tab bar, hash routing, persistence across
 * reloads. Five tabs: roll, saved, songs, band, help.
 */
test.describe("Tab navigation", { tag: ["@smoke"] }, () => {
    test("each bottom-nav tab navigates to its view", async ({ page, app }) => {
        await app.seed(buildSeed());
        await app.goto();
        const shell = new AppShell(page);

        await shell.gotoBand();
        await shell.expectActiveView("band");

        await shell.gotoSongs();
        await shell.expectActiveView("songs");

        await shell.gotoSaved();
        await shell.expectActiveView("saved");

        await shell.gotoHelp();
        await shell.expectActiveView("help");

        await shell.gotoRoll();
        await shell.expectActiveView("roll");
    });

    test("default view is 'roll' on cold boot", async ({ page, app }) => {
        await app.seed(buildSeed());
        await app.goto();
        const shell = new AppShell(page);
        await shell.expectActiveView("roll");
    });
});

test.describe("Hash routing", () => {
    test("navigating to /#/songs lands on the songs tab directly", async ({ page, app }) => {
        await app.seed(buildSeed());
        await app.goto("/#/songs");
        const shell = new AppShell(page);
        await shell.expectActiveView("songs");
    });

    test("navigating to /#/band lands on the band tab", async ({ page, app }) => {
        await app.seed(buildSeed());
        await app.goto("/#/band");
        const shell = new AppShell(page);
        await shell.expectActiveView("band");
    });

    test("invalid hash falls back to 'roll'", async ({ page, app }) => {
        await app.seed(buildSeed());
        await app.goto("/#/nonsense");
        const shell = new AppShell(page);
        await shell.expectActiveView("roll");
    });

    test("clicking a tab updates the URL hash", async ({ page, app }) => {
        await app.seed(buildSeed());
        await app.goto();
        const shell = new AppShell(page);

        await shell.gotoSongs();
        await expect.poll(() => page.url()).toContain("#/songs");

        await shell.gotoSaved();
        await expect.poll(() => page.url()).toContain("#/saved");
    });
});

test.describe("Browser navigation", () => {
    test("browser back returns to previous tab", async ({ page, app }) => {
        await app.seed(buildSeed());
        await app.goto();
        const shell = new AppShell(page);

        await shell.gotoSongs();
        await shell.expectActiveView("songs");
        await shell.gotoBand();
        await shell.expectActiveView("band");

        await page.goBack();
        await shell.expectActiveView("songs");
    });

    test("browser forward returns to next tab", async ({ page, app }) => {
        await app.seed(buildSeed());
        await app.goto();
        const shell = new AppShell(page);

        await shell.gotoSongs();
        await shell.gotoBand();
        await page.goBack();
        await page.goForward();
        await shell.expectActiveView("band");
    });

    test("page reload preserves the active view", async ({ page, app }) => {
        await app.seed(buildSeed());
        await app.goto();
        const shell = new AppShell(page);

        await shell.gotoSongs();
        await page.reload();
        await shell.expectActiveView("songs");
    });
});

test.describe("Top bar visibility", () => {
    test("top bar with band name and connection dot is visible across all tabs", async ({ page, app }) => {
        await app.seed(buildSeed());
        await app.goto();
        const shell = new AppShell(page);

        for (const goto of [shell.gotoRoll, shell.gotoSongs, shell.gotoBand, shell.gotoSaved, shell.gotoHelp]) {
            await goto.call(shell);
            await expect(shell.bandTitle).toBeVisible();
            await expect(shell.connectionDot).toBeVisible();
        }
    });

    test("bottom-nav highlights the active tab", async ({ page, app }) => {
        await app.seed(buildSeed());
        await app.goto();
        const shell = new AppShell(page);

        await shell.gotoSongs();
        // BottomNav adds a .active class on the active tab button.
        await expect(shell.songsTab).toHaveClass(/active/);
        await expect(shell.rollTab).not.toHaveClass(/active/);
    });

    test("fixed chrome anchors the bottom nav to the viewport bottom", async ({ page, app }) => {
        // Chromium cannot reproduce installed iOS PWA rubber-band/safe-area bugs;
        // this guards the static CSS invariant before real-device verification.
        await page.setViewportSize({ width: 390, height: 600 });
        await app.seed(buildSeed());
        await app.goto();
        await app.waitForReady();

        const chrome = await page.evaluate(() => {
            const nav = document.querySelector("nav.bottom-nav");
            const top = document.querySelector("header.top-bar");
            const main = document.querySelector(".main-content");
            const navRect = nav?.getBoundingClientRect();
            const topRect = top?.getBoundingClientRect();
            const topStyles = top ? getComputedStyle(top) : null;
            const navStyles = nav ? getComputedStyle(nav) : null;
            const mainStyles = main ? getComputedStyle(main) : null;

            return {
                topPosition: topStyles?.position,
                topTopStyle: topStyles?.top,
                topTop: topRect?.top ?? -1,
                navPosition: navStyles?.position,
                navBottomStyle: navStyles?.bottom,
                mainOverflowY: mainStyles?.overflowY,
                navBottom: navRect?.bottom ?? 0,
                viewportHeight: window.innerHeight,
            };
        });

        expect(chrome.topPosition).toBe("fixed");
        expect(chrome.topTopStyle).toBe("0px");
        expect(Math.abs(chrome.topTop)).toBeLessThanOrEqual(1);
        expect(chrome.navPosition).toBe("fixed");
        expect(chrome.navBottomStyle).toBe("0px");
        expect(chrome.mainOverflowY).toBe("visible");
        expect(Math.abs(chrome.viewportHeight - chrome.navBottom)).toBeLessThanOrEqual(1);
    });
});
