import type { SeedSetlist } from "../fixtures/test-fixtures";
import { buildSeed, expect, makeSong, test } from "../fixtures/test-fixtures";
import { AppShell } from "../pages/AppShell";
import { RollPage } from "../pages/RollPage";
import { SavedPage } from "../pages/SavedPage";

/**
 * Saved screen ("Greatest Hits") — list of saved setlists, view/edit/load/
 * delete actions, plus the print modal.
 */
function setlistFixture(overrides: Partial<SeedSetlist> = {}): SeedSetlist {
    return {
        id: "set-1",
        name: "Friday Night Set",
        savedAt: "2024-09-15T20:00:00.000Z",
        songs: [
            { songId: "a", performance: {} },
            { songId: "b", performance: {} },
        ],
        schemaVersion: 2,
        createdAt: "2024-09-15T20:00:00.000Z",
        updatedAt: "2024-09-15T20:00:00.000Z",
        ...overrides,
    };
}

function fixtureCatalogSongs(): Record<string, unknown> {
    return {
        a: makeSong({ id: "a", name: "Africa", key: "B" }),
        b: makeSong({ id: "b", name: "Bohemian Rhapsody", key: "Bb", cover: true }),
    };
}

test.describe("Saved screen — empty state", () => {
    test("empty state appears when no saved setlists exist", async ({ page, app }) => {
        await app.seed(buildSeed());
        await app.goto();
        await new AppShell(page).gotoSaved();

        const saved = new SavedPage(page);
        await expect(saved.emptyState).toContainText("Nothing saved yet");
    });
});

test.describe("Saved screen — list", () => {
    test("seeded setlists render as cards with name and song count", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                songs: fixtureCatalogSongs(),
                setlists: {
                    "set-1": setlistFixture({ id: "set-1", name: "Friday" }),
                    "set-2": setlistFixture({ id: "set-2", name: "Saturday", savedAt: "2024-09-16T20:00:00.000Z" }),
                },
            }),
        );
        await app.goto();
        await new AppShell(page).gotoSaved();

        const saved = new SavedPage(page);
        await expect(saved.savedCards).toHaveCount(2);
        await expect(saved.cardByName("Friday")).toBeVisible();
        await expect(saved.cardByName("Saturday")).toBeVisible();
        await expect(saved.cardByName("Friday")).toContainText("2 songs");
    });

    test("setlists are sorted by savedAt (most recent first)", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                setlists: {
                    old: setlistFixture({ id: "old", name: "Old Show", savedAt: "2024-01-01T00:00:00.000Z" }),
                    new: setlistFixture({ id: "new", name: "New Show", savedAt: "2024-12-31T00:00:00.000Z" }),
                },
            }),
        );
        await app.goto();
        await new AppShell(page).gotoSaved();

        const saved = new SavedPage(page);
        // Wait for both cards to render before reading their text — otherwise
        // allInnerTexts() can race the initial render and return [].
        await expect(saved.savedCards).toHaveCount(2);
        const names = await saved.savedCards.locator(".saved-name").allInnerTexts();
        expect(names).toEqual(["New Show", "Old Show"]);
    });
});

test.describe("Saved screen — view modal", () => {
    test("clicking a card opens the print/view modal", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                songs: fixtureCatalogSongs(),
                setlists: { s: setlistFixture({ id: "s", name: "Acoustic" }) },
            }),
        );
        await app.goto();
        await new AppShell(page).gotoSaved();

        const saved = new SavedPage(page);
        await saved.openCard("Acoustic");
        await expect(saved.modal.locator(".print-songs")).toBeVisible();
        await expect(saved.modal).toContainText("Africa");
        await expect(saved.modal).toContainText("Bohemian Rhapsody");
    });

    test("Close button closes the modal", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                setlists: { s: setlistFixture({ id: "s" }) },
            }),
        );
        await app.goto();
        await new AppShell(page).gotoSaved();

        const saved = new SavedPage(page);
        await saved.openCard("Friday Night Set");
        await saved.closeCard();
    });

    test("Load to Roll button loads the setlist into the Roll screen", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                songs: fixtureCatalogSongs(),
                setlists: { s: setlistFixture({ id: "s", name: "Loadable" }) },
            }),
        );
        await app.goto();
        const shell = new AppShell(page);
        await shell.gotoSaved();

        const saved = new SavedPage(page);
        await saved.loadToRoll("Loadable");

        // After Load to Roll the user is moved to the Roll tab.
        await shell.expectActiveView("roll");
        const roll = new RollPage(page);
        const songs = await roll.getSetlistSongNames();
        expect(songs.length).toBeGreaterThan(0);
    });
});

test.describe("Saved screen — edit", () => {
    test("can rename a saved setlist", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                setlists: { s: setlistFixture({ id: "s", name: "Old Name" }) },
            }),
        );
        await app.goto();
        await new AppShell(page).gotoSaved();

        const saved = new SavedPage(page);
        await saved.startEdit("Old Name");
        await saved.fillEditName("Old Name", "New Hotness");
        await saved.saveEdit("Old Name");

        await expect(saved.cardByName("New Hotness")).toBeVisible();
        await expect(saved.cardByName("Old Name")).toHaveCount(0);
    });

    test("Cancel discards the rename", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                setlists: { s: setlistFixture({ id: "s", name: "Stable" }) },
            }),
        );
        await app.goto();
        await new AppShell(page).gotoSaved();

        const saved = new SavedPage(page);
        await saved.startEdit("Stable");
        await saved.fillEditName("Stable", "Discarded");
        await saved.cancelEdit("Stable");
        await expect(saved.cardByName("Stable")).toBeVisible();
    });
});

test.describe("Saved screen — load", () => {
    test("Load button on the card navigates to roll with that setlist", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                setlists: { s: setlistFixture({ id: "s", name: "Direct Load" }) },
            }),
        );
        await app.goto();
        const shell = new AppShell(page);
        await shell.gotoSaved();

        const saved = new SavedPage(page);
        await saved.loadSavedFromCard("Direct Load");
        await shell.expectActiveView("roll");
    });
});

test.describe("Saved screen — delete with confirm", () => {
    test("Remove → Delete? confirms and deletes", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                setlists: { s: setlistFixture({ id: "s", name: "Doomed Set" }) },
            }),
        );
        await app.goto();
        await new AppShell(page).gotoSaved();

        const saved = new SavedPage(page);
        await saved.deleteSaved("Doomed Set");
        await expect(saved.cardByName("Doomed Set")).toHaveCount(0);
    });

    test("Remove → No cancels the deletion", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                setlists: { s: setlistFixture({ id: "s", name: "Reprieve" }) },
            }),
        );
        await app.goto();
        await new AppShell(page).gotoSaved();

        const saved = new SavedPage(page);
        await saved.cancelDelete("Reprieve");
        await expect(saved.cardByName("Reprieve")).toBeVisible();
    });
});

test.describe("Saved screen — dark mode legibility", () => {
    /**
     * Regression: prior to the fix the .print-* viewer styles used hardcoded
     * black/grey colors meant for the printed PDF. In dark mode the modal
     * background is dark, so the song names and rules rendered as
     * black-on-near-black — completely illegible. The viewer now reads from
     * theme tokens (--ink, --muted, --line). This test asserts that the
     * visible text actually contrasts with the modal background.
     */
    test("setlist text contrasts with the modal background in dark mode", async ({ page, app }) => {
        // Drive theme via OS color-scheme emulation rather than clicking
        // through the dropdown. cycleTheme() leaves the menu open and the
        // .menu-backdrop intercepts the subsequent gotoSaved() click. The
        // existing theme.spec.ts uses this same emulateMedia pattern.
        await page.emulateMedia({ colorScheme: "dark" });
        await app.seed(
            buildSeed({
                songs: fixtureCatalogSongs(),
                setlists: { s: setlistFixture({ id: "s", name: "After Dark" }) },
            }),
        );
        await app.goto();
        await app.waitForReady();
        const shell = new AppShell(page);
        expect(await shell.getTheme()).toBe("dark");

        await shell.gotoSaved();
        const saved = new SavedPage(page);
        await saved.openCard("After Dark");

        const songName = saved.modal.locator(".print-song-name").first();

        // Compute relative luminance of the rendered text vs the modal sheet
        // background. We need a meaningful gap between them, otherwise dark
        // text would silently be invisible against a dark background again.
        const contrast = await page.evaluate(
            ({ textSel, bgSel }) => {
                function lum(rgb: string): number {
                    const m = rgb.match(/(\d+(?:\.\d+)?)/g);
                    if (!m || m.length < 3) return 0;
                    const [r, g, b] = m.slice(0, 3).map((v) => Number(v) / 255);
                    return 0.299 * r + 0.587 * g + 0.114 * b;
                }
                const textEl = document.querySelector(textSel);
                const bgEl = document.querySelector(bgSel);
                if (!textEl || !bgEl) return null;
                const textColor = getComputedStyle(textEl).color;
                const bgColor = getComputedStyle(bgEl).backgroundColor;
                return {
                    textLum: lum(textColor),
                    bgLum: lum(bgColor),
                    textColor,
                    bgColor,
                };
            },
            { textSel: ".modal-sheet .print-song-name", bgSel: ".modal-sheet" },
        );
        expect(contrast).not.toBeNull();
        if (!contrast) return;
        // In dark mode the background should be dark, the text should be
        // light. We just need a meaningful gap (>0.4 luminance delta) — the
        // exact ink token is `#e2e6ec` which sits ~0.88, the paper-strong
        // token is rgba(26,30,38,0.96) which sits ~0.12.
        const delta = Math.abs(contrast.textLum - contrast.bgLum);
        expect(delta).toBeGreaterThan(0.4);
        // And the song name itself should be visibly rendered.
        await expect(songName).toBeVisible();
    });

    test("setlist text remains legible in light mode", async ({ page, app }) => {
        // Same rationale as the dark-mode test above: emulate color-scheme
        // rather than clicking through cycleTheme(), which leaves the menu
        // open and blocks subsequent navigation clicks.
        await page.emulateMedia({ colorScheme: "light" });
        await app.seed(
            buildSeed({
                songs: fixtureCatalogSongs(),
                setlists: { s: setlistFixture({ id: "s", name: "Daylight" }) },
            }),
        );
        await app.goto();
        await app.waitForReady();
        const shell = new AppShell(page);
        expect(await shell.getTheme()).toBe("light");

        await shell.gotoSaved();
        const saved = new SavedPage(page);
        await saved.openCard("Daylight");

        const contrast = await page.evaluate(
            ({ textSel, bgSel }) => {
                function lum(rgb: string): number {
                    const m = rgb.match(/(\d+(?:\.\d+)?)/g);
                    if (!m || m.length < 3) return 0;
                    const [r, g, b] = m.slice(0, 3).map((v) => Number(v) / 255);
                    return 0.299 * r + 0.587 * g + 0.114 * b;
                }
                const textEl = document.querySelector(textSel);
                const bgEl = document.querySelector(bgSel);
                if (!textEl || !bgEl) return null;
                return {
                    textLum: lum(getComputedStyle(textEl).color),
                    bgLum: lum(getComputedStyle(bgEl).backgroundColor),
                };
            },
            { textSel: ".modal-sheet .print-song-name", bgSel: ".modal-sheet" },
        );
        expect(contrast).not.toBeNull();
        if (!contrast) return;
        expect(Math.abs(contrast.textLum - contrast.bgLum)).toBeGreaterThan(0.4);
    });
});

test.describe("Saved screen — iOS safe-area handling", () => {
    /**
     * Regression: on iOS PWAs with the translucent status bar overlaying the
     * page (apple-mobile-web-app-status-bar-style=black-translucent), the
     * modal-close (X) button at the top-right of the sheet ended up under
     * the status bar because the centered modal had no top safe-area
     * padding. Two pieces wire this up:
     *   1) index.html declares viewport-fit=cover so iOS exposes the real
     *      env(safe-area-inset-*) values (without it, env() returns 0).
     *   2) The modal-backdrop's padding-top uses max(1rem, var(--safe-top))
     *      so the centered sheet sits below the status bar.
     *
     * We can't make Playwright report a real iOS notch, but we can override
     * --safe-top at the document root and verify the modal-sheet (and the
     * close button inside it) shifts down by that amount.
     */
    test("modal-close button shifts down by the safe-area inset on a notched device", async ({ page, app }) => {
        // The reviewer's note: a small modal centered in a 600px
        // viewport sits ~200px from the top regardless of safe-area
        // padding, so an absolute-threshold y >= 49 assertion is
        // satisfied by grid centering alone — it can't tell "fix in
        // place" from "fix removed".
        //
        // Earlier attempts to force the modal to its max-height and
        // measure the y-delta worked on chromium but were fragile on
        // mobile webkit, where 100dvh, env(safe-area-inset-top), and
        // the iPhone 13 emulator's interaction with viewport-fit=cover
        // shifted the baseline by browser-specific amounts.
        //
        // Cut through all that by reading the rule directly: query the
        // backdrop's *computed* padding-top before and after overriding
        // --safe-top. That's a one-line proof of
        //   padding-top: max(1rem, var(--safe-top, 0px))
        // and is layout-engine-agnostic. Then keep the user-facing
        // assertion that the close button itself ends up at or below
        // the simulated safe-area top.
        await app.seed(
            buildSeed({
                setlists: { s: setlistFixture({ id: "s", name: "Notched" }) },
            }),
        );
        await app.goto();
        await app.waitForReady();
        const shell = new AppShell(page);
        const saved = new SavedPage(page);
        await shell.gotoSaved();
        await saved.openCard("Notched");

        const readBackdropPaddingTop = () =>
            page.evaluate(() => {
                const bd = document.querySelector(".modal-backdrop") as HTMLElement | null;
                return bd ? parseFloat(getComputedStyle(bd).paddingTop) : 0;
            });

        // Baseline. Without an override --safe-top resolves to
        // env(safe-area-inset-top, 0px), which is 0 on every Playwright
        // emulator we run, so padding-top falls back to the 1rem floor
        // (16px at the project's base font size). On a real iPhone with
        // a notch this would resolve to ~47px — still satisfying
        // `>= 16`.
        const baselinePadding = await readBackdropPaddingTop();
        expect(baselinePadding).toBeGreaterThanOrEqual(16);

        // Simulate an 80px status-bar overlay.
        const FAKE_SAFE_TOP = 80;
        await page.evaluate((top) => {
            document.documentElement.style.setProperty("--safe-top", `${top}px`);
        }, FAKE_SAFE_TOP);

        const insetPadding = await readBackdropPaddingTop();
        // If the CSS rule were simplified to a plain `padding: 1rem`,
        // insetPadding would still be 16 — equal to baselinePadding —
        // and this assertion would fail loudly. Catches the regression
        // the reviewer asked us to catch.
        expect(insetPadding).toBeCloseTo(FAKE_SAFE_TOP, 0);
        expect(insetPadding).toBeGreaterThan(baselinePadding);

        // User-facing: the close button (X) must be at or below the
        // safe-area top. With padding-top=80 pushing the sheet down to
        // y >= 80, the X (top: 0.5rem inside the sheet) lands well
        // below the simulated status bar.
        const closeBox = await saved.modalCloseButton.boundingBox();
        expect(closeBox).not.toBeNull();
        if (!closeBox) return;
        expect(closeBox.y).toBeGreaterThanOrEqual(FAKE_SAFE_TOP - 1);
    });

    test("the rendered viewport meta tag enables safe-area insets via viewport-fit=cover", async ({ page, app }) => {
        await app.seed(buildSeed());
        await app.goto();
        await app.waitForReady();

        // Without viewport-fit=cover, iOS resolves env(safe-area-inset-*)
        // to 0 even on notched devices, silently breaking every safe-area
        // computation in the app. Pin this in a test so a careless edit
        // can't quietly regress every modal at once.
        //
        // The repo enforces a single viewport meta tag — index.html owns
        // it; App.svelte's <svelte:head> deliberately does NOT duplicate
        // it. Asserting "some viewport tag has viewport-fit=cover" would
        // be too loose: a stray duplicate without the attribute could be
        // present and the test still pass while the runtime tag silently
        // loses the attribute. So we assert exactly one tag exists and
        // that tag carries viewport-fit=cover.
        const contents = await page
            .locator('meta[name="viewport"]')
            .evaluateAll((els) => els.map((el) => el.getAttribute("content") || ""));
        expect(contents).toHaveLength(1);
        expect(contents[0]).toContain("viewport-fit=cover");
    });
});

test.describe("Saved screen — tall setlist scrolling", () => {
    /**
     * Regression: prior to the fix the modal-sheet was the scroll container
     * but combined with `display: grid; place-items: center` on the backdrop
     * the content could end up clipped above the viewport on tall lists. The
     * fix splits the sheet into a flex column with .modal-content as the
     * scroll region and .modal-actions pinned outside it.
     */
    function tallSetlistFixture(songCount = 40): SeedSetlist {
        const songs = Array.from({ length: songCount }, (_, i) => ({
            songId: `tall-${i}`,
            performance: {},
        }));
        return setlistFixture({ id: "tall", name: "The Marathon", songs, songCount });
    }

    function tallCatalogSongs(count = 40): Record<string, unknown> {
        return Object.fromEntries(
            Array.from({ length: count }, (_, i) => [
                `tall-${i}`,
                makeSong({ id: `tall-${i}`, name: `Marathon Track ${i + 1}`, key: "C" }),
            ]),
        );
    }

    test("the song list scrolls when the setlist is taller than the viewport", async ({ page, app }) => {
        await app.seed(buildSeed({ songs: tallCatalogSongs(40), setlists: { tall: tallSetlistFixture(40) } }));
        await page.setViewportSize({ width: 390, height: 600 });
        await app.goto();
        await app.waitForReady();
        await new AppShell(page).gotoSaved();

        const saved = new SavedPage(page);
        await saved.openCard("The Marathon");

        const scrollState = await saved.modalContent.evaluate((el) => ({
            overflowing: el.scrollHeight > el.clientHeight,
            initialScrollTop: el.scrollTop,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
        }));
        expect(scrollState.overflowing).toBe(true);
        expect(scrollState.initialScrollTop).toBe(0);

        // Scroll to the bottom and confirm the scrollTop actually moved —
        // proving this element really is the scroll container.
        await saved.modalContent.evaluate((el) => {
            el.scrollTop = el.scrollHeight;
        });
        const finalScrollTop = await saved.modalContent.evaluate((el) => el.scrollTop);
        expect(finalScrollTop).toBeGreaterThan(0);
    });

    test("action buttons stay visible while the song list is scrolled", async ({ page, app }) => {
        await app.seed(buildSeed({ songs: tallCatalogSongs(40), setlists: { tall: tallSetlistFixture(40) } }));
        await page.setViewportSize({ width: 390, height: 600 });
        await app.goto();
        await app.waitForReady();
        await new AppShell(page).gotoSaved();

        const saved = new SavedPage(page);
        await saved.openCard("The Marathon");

        // Both action buttons live outside .modal-content (the scroll
        // container), inside .modal-actions. Confirm DOM relationship.
        const actionsContainScrollContent = await saved.modalContent.evaluate((content) => {
            const actions = document.querySelector(".modal-actions");
            if (!actions) return false;
            return content.contains(actions);
        });
        expect(actionsContainScrollContent).toBe(false);

        // Visible before scroll.
        await expect(saved.printButton).toBeVisible();
        await expect(saved.loadToRollButton).toBeVisible();

        // Scroll the list to the bottom; buttons must still be in viewport.
        await saved.modalContent.evaluate((el) => {
            el.scrollTop = el.scrollHeight;
        });
        await expect(saved.printButton).toBeInViewport();
        await expect(saved.loadToRollButton).toBeInViewport();
    });

    test("the last song in a tall setlist can be scrolled into view", async ({ page, app }) => {
        await app.seed(buildSeed({ songs: tallCatalogSongs(40), setlists: { tall: tallSetlistFixture(40) } }));
        await page.setViewportSize({ width: 390, height: 600 });
        await app.goto();
        await app.waitForReady();
        await new AppShell(page).gotoSaved();

        const saved = new SavedPage(page);
        await saved.openCard("The Marathon");

        const lastSong = saved.modal.locator(".print-song").last();
        // Without scrolling the last song is offscreen.
        const visibleBefore = await lastSong.isVisible();
        // isVisible() returns true even for offscreen elements in Playwright,
        // so we go further: assert it's not in the viewport, then scroll it.
        const inViewportBefore = await lastSong.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return r.top < window.innerHeight && r.bottom > 0;
        });
        expect(visibleBefore).toBe(true);
        expect(inViewportBefore).toBe(false);

        await saved.modalContent.evaluate((el) => {
            el.scrollTop = el.scrollHeight;
        });
        const inViewportAfter = await lastSong.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return r.top < window.innerHeight && r.bottom > 0;
        });
        expect(inViewportAfter).toBe(true);
    });
});

test.describe("Saved screen — modal contents", () => {
    test("anxiety summary appears in the modal when present", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                songs: fixtureCatalogSongs(),
                setlists: {
                    s: setlistFixture({ id: "s", name: "With Anxiety" }),
                },
            }),
        );
        await app.goto();
        await new AppShell(page).gotoSaved();

        const saved = new SavedPage(page);
        await saved.openCard("With Anxiety");
        await expect(saved.modal.locator(".print-anxiety")).toBeVisible();
    });

    test("song notes are rendered in the print modal", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                songs: { a: makeSong({ id: "a", name: "Africa", notes: "Cue intro on synth" }) },
                setlists: {
                    s: setlistFixture({
                        id: "s",
                        name: "With Notes",
                        songs: [{ songId: "a", performance: {} }],
                    }),
                },
            }),
        );
        await app.goto();
        await new AppShell(page).gotoSaved();

        const saved = new SavedPage(page);
        await saved.openCard("With Notes");
        await expect(saved.modal.locator(".print-notes")).toContainText("Cue intro");
    });
});
