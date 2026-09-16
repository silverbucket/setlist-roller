import type { Page } from "@playwright/test";
import type { SeedSetlist } from "../fixtures/test-fixtures";
import { buildSeed, expect, makeMember, makeSong, test } from "../fixtures/test-fixtures";
import { AppShell } from "../pages/AppShell";
import { BandPage } from "../pages/BandPage";
import { RollPage } from "../pages/RollPage";
import { SavedPage } from "../pages/SavedPage";
import { SongEditorPage } from "../pages/SongEditorPage";
import { SongsPage } from "../pages/SongsPage";

/**
 * iOS Safari zooms the whole page when a form control with a computed
 * font-size below 16px receives focus, and does not zoom back out. In the
 * installed PWA that leaves the fixed chrome mis-rendered. app.css pins
 * every input/select/textarea to 16px, but component styles can override
 * it — this spec walks each screen and checks the *computed* size of every
 * rendered control so a stray override fails the build instead of shipping.
 */
const MIN_FONT_PX = 16;

type Offender = { tag: string; type: string | null; className: string; fontSize: number };

async function collectOffenders(page: Page): Promise<Offender[]> {
    return page.evaluate((min) => {
        const controls = Array.from(document.querySelectorAll<HTMLElement>("input, select, textarea"));
        return controls
            .map((el) => ({
                tag: el.tagName.toLowerCase(),
                type: el.getAttribute("type"),
                className: el.className,
                fontSize: parseFloat(getComputedStyle(el).fontSize),
            }))
            .filter((c) => !(c.fontSize >= min));
    }, MIN_FONT_PX);
}

async function expectNoZoomingControls(page: Page, screen: string) {
    const offenders = await collectOffenders(page);
    expect(offenders, `${screen}: form controls below ${MIN_FONT_PX}px would trigger iOS focus zoom`).toEqual([]);
}

function setlistFixture(overrides: Partial<SeedSetlist> = {}): SeedSetlist {
    return {
        id: "set-1",
        name: "Friday",
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

function seed() {
    return buildSeed({
        songs: {
            a: makeSong({ id: "a", name: "Alpha" }),
            b: makeSong({ id: "b", name: "Bravo" }),
            c: makeSong({ id: "c", name: "Charlie" }),
        },
        members: { Nick: makeMember("Nick", { instruments: [{ name: "Guitar", tunings: [], techniques: [] }] }) },
        setlists: { "set-1": setlistFixture() },
    });
}

test.describe("No form control is small enough to trigger iOS focus zoom", () => {
    test("songs list, song editor, and keep-apart picker", async ({ page, app }) => {
        await app.seed(seed());
        await app.goto();
        await new AppShell(page).gotoSongs();
        await expectNoZoomingControls(page, "songs list");

        const songs = new SongsPage(page);
        const editor = new SongEditorPage(page);
        await songs.openSong("Alpha");
        await editor.waitForVisible();
        await editor.addMemberByName("Nick");
        await editor.expandMember("Nick");
        await expectNoZoomingControls(page, "song editor");

        await editor.openKeepApartPicker();
        await expectNoZoomingControls(page, "keep-apart picker");
    });

    test("roll screen settings and add-song dialog", async ({ page, app }) => {
        await app.seed(seed());
        await app.goto();
        await app.waitForReady();
        await new AppShell(page).gotoRoll();

        const roll = new RollPage(page);
        await roll.openSettings();
        await roll.activateTab("constraints");
        await expectNoZoomingControls(page, "roll settings (demands)");
        await roll.activateTab("chaos");
        await expectNoZoomingControls(page, "roll settings (shape the set)");
        await roll.closeSettings();

        await roll.addSongButton.click();
        await expect(roll.addSongDialog).toBeVisible();
        await expectNoZoomingControls(page, "roll add-song dialog");
    });

    test("band screen, member edit, and advanced config", async ({ page, app }) => {
        await app.seed(seed());
        await app.goto();
        await new AppShell(page).gotoBand();

        const band = new BandPage(page);
        await expectNoZoomingControls(page, "band main (incl. import file input)");

        await band.openMemberEdit("Nick");
        await band.expandInstrument("Guitar");
        await expectNoZoomingControls(page, "band member edit");
        await band.backToMain();

        await band.openAdvancedConfig();
        await expectNoZoomingControls(page, "band advanced config");
    });

    test("saved setlist edit form", async ({ page, app }) => {
        await app.seed(seed());
        await app.goto();
        await new AppShell(page).gotoSaved();

        const saved = new SavedPage(page);
        await saved.startEdit("Friday");
        await expectNoZoomingControls(page, "saved setlist edit");
    });
});
