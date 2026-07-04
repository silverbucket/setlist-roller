import { buildSeed, expect, makeMember, makeSong, test } from "../fixtures/test-fixtures";
import { AppShell } from "../pages/AppShell";
import { BandPage } from "../pages/BandPage";
import { SongsPage } from "../pages/SongsPage";

/**
 * Data-management features on the Band screen — export to JSON, import from
 * JSON (with skip/overwrite modes), and delete-all-data (with double
 * confirmation gate).
 */

test.describe("Export", () => {
    test("Export All produces a JSON download with the expected payload shape", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                songs: {
                    s1: makeSong({ id: "s1", name: "Africa", key: "B" }),
                    s2: makeSong({ id: "s2", name: "Bohemian Rhapsody", key: "Bb" }),
                },
                members: {
                    Alice: makeMember("Alice", { instruments: [{ id: "guitar", name: "Guitar" }] }),
                },
            }),
        );
        await app.goto();
        await app.waitForReady();
        await app.waitForSynced();
        await new AppShell(page).gotoBand();

        const band = new BandPage(page);
        const downloadPromise = page.waitForEvent("download");
        await band.exportAllButton.click();
        const download = await downloadPromise;

        // Filename derives from the band name slug.
        expect(download.suggestedFilename()).toMatch(/^test-band-data\.json$/);

        // Read the downloaded buffer back and inspect it.
        const stream = await download.createReadStream();
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(chunk as Buffer);
        const json = JSON.parse(Buffer.concat(chunks).toString("utf-8"));

        expect(Array.isArray(json.songs)).toBe(true);
        expect(json.songs).toHaveLength(2);
        expect(json.songs.map((s: { name: string }) => s.name).sort()).toEqual(["Africa", "Bohemian Rhapsody"]);
        expect(json.config?.bandName).toBe("Test Band");
        expect(json.bandMembers?.Alice).toBeDefined();
    });

    test("Export shows a toast confirming success", async ({ page, app }) => {
        await app.seed(buildSeed());
        await app.goto();
        await app.waitForReady();
        await new AppShell(page).gotoBand();

        const band = new BandPage(page);
        const downloadPromise = page.waitForEvent("download");
        await band.exportAllButton.click();
        await downloadPromise;

        await expect(new AppShell(page).toast).toContainText(/Exported/);
    });
});

test.describe("Import", () => {
    test("Import button is disabled until a file is selected", async ({ page, app }) => {
        await app.seed(buildSeed());
        await app.goto();
        await app.waitForReady();
        await new AppShell(page).gotoBand();

        const band = new BandPage(page);
        await expect(band.importButton).toBeDisabled();
    });

    test("Importing songs in skip mode adds new songs and leaves existing ones alone", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                songs: {
                    s1: makeSong({ id: "s1", name: "Existing Song", key: "C" }),
                },
            }),
        );
        await app.goto();
        await app.waitForReady();
        await app.waitForSynced();
        const shell = new AppShell(page);
        await shell.gotoBand();

        const band = new BandPage(page);
        await band.setImportPayload({
            songs: [
                { id: "s1", name: "Should NOT Replace", key: "Z" }, // same id — skipped
                { id: "s2", name: "New Song", key: "D" },
            ],
            config: { bandName: "Imported Band", general: {}, show: {}, props: {} },
        });
        await band.setImportMode("skip");
        await band.importButton.click();

        await expect(shell.toast).toContainText(/Imported/);

        await shell.gotoSongs();
        const songs = new SongsPage(page);
        // Existing untouched, new one added
        await expect(songs.songRow("Existing Song")).toBeVisible();
        await expect(songs.songRow("New Song")).toBeVisible();
        await expect(songs.songRow("Should NOT Replace")).toHaveCount(0);
    });

    test("Importing songs in overwrite mode replaces existing songs by id", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                songs: {
                    s1: makeSong({ id: "s1", name: "Old Name", key: "C" }),
                },
            }),
        );
        await app.goto();
        await app.waitForReady();
        // Settle the bootstrap sync before importing: an import racing an
        // in-flight pull of the same doc loses to rs.js's remote-wins
        // conflict handling (real imports never happen mid-bootstrap).
        await app.waitForSynced();
        const shell = new AppShell(page);
        await shell.gotoBand();

        const band = new BandPage(page);
        await band.setImportPayload({
            songs: [{ id: "s1", name: "New Name", key: "G" }],
        });
        await band.setImportMode("overwrite");
        await band.importButton.click();

        await expect(shell.toast).toContainText(/Imported/);
        await shell.gotoSongs();
        const songs = new SongsPage(page);
        await expect(songs.songRow("New Name")).toBeVisible();
        await expect(songs.songRow("Old Name")).toHaveCount(0);
    });

    test("Importing band members brings them in", async ({ page, app }) => {
        await app.seed(buildSeed());
        await app.goto();
        await app.waitForReady();
        const shell = new AppShell(page);
        await shell.gotoBand();

        const band = new BandPage(page);
        await band.setImportPayload({
            songs: [],
            bandMembers: {
                Alice: { name: "Alice", instruments: [], defaultInstrument: "" },
                Bob: { name: "Bob", instruments: [], defaultInstrument: "" },
            },
        });
        await band.importButton.click();

        await expect(shell.toast).toContainText(/Imported/);
        await expect(band.memberRow("Alice")).toBeVisible();
        await expect(band.memberRow("Bob")).toBeVisible();
    });

    test("Importing invalid JSON shows an error toast", async ({ page, app }) => {
        await app.seed(buildSeed());
        await app.goto();
        await app.waitForReady();
        const shell = new AppShell(page);
        await shell.gotoBand();

        const band = new BandPage(page);
        await band.importFileInput.setInputFiles({
            name: "broken.json",
            mimeType: "application/json",
            buffer: Buffer.from("{this is not valid json"),
        });
        await band.importButton.click();
        await expect(shell.toast).toBeVisible();
        // The error is whatever JSON.parse throws — not a fixed string.
    });

    test("Importing JSON with unsupported shape shows an error toast", async ({ page, app }) => {
        await app.seed(buildSeed());
        await app.goto();
        await app.waitForReady();
        const shell = new AppShell(page);
        await shell.gotoBand();

        const band = new BandPage(page);
        // Valid JSON but no `songs` array, no `general/show/props` — unsupported.
        await band.setImportPayload({ random: "payload" });
        await band.importButton.click();
        await expect(shell.toast).toContainText(/Unsupported/);
    });

    test("Importing an array of songs (legacy format) works", async ({ page, app }) => {
        await app.seed(buildSeed());
        await app.goto();
        await app.waitForReady();
        const shell = new AppShell(page);
        await shell.gotoBand();

        const band = new BandPage(page);
        await band.setImportPayload([{ id: "legacy-1", name: "Legacy Song", key: "F" }]);
        await band.importButton.click();

        await expect(shell.toast).toContainText(/Imported/);
        await shell.gotoSongs();
        await expect(new SongsPage(page).songRow("Legacy Song")).toBeVisible();
    });
});

test.describe("Delete all data", () => {
    test("accepting both confirms wipes songs, members, setlists and triggers first-run", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                songs: { s1: makeSong({ id: "s1", name: "Africa" }) },
                members: { Alice: makeMember("Alice") },
                setlists: {
                    "set-1": {
                        id: "set-1",
                        name: "Saved Set",
                        savedAt: "2024-09-15T20:00:00.000Z",
                        songCount: 1,
                        songs: [{ id: "s1", name: "Africa" }],
                        schemaVersion: 2,
                        createdAt: "2024-09-15T20:00:00.000Z",
                        updatedAt: "2024-09-15T20:00:00.000Z",
                    },
                },
            }),
        );
        await app.goto();
        await app.waitForReady();
        const shell = new AppShell(page);
        await shell.gotoBand();

        const band = new BandPage(page);
        await band.confirmDeleteAllData(page);

        // After delete: first-run prompt appears (band name modal)
        await expect(shell.firstRunModal).toBeVisible();

        // The store has cleared everything
        const state = await app.getState();
        expect(state.songs).toEqual([]);
        expect(state.savedSetlists).toEqual([]);
        expect(state.bandMembers).toEqual({});
        expect(state.appConfig).toBeNull();
    });

    test("cancelling the first confirm leaves data intact", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                songs: { s1: makeSong({ id: "s1", name: "Survives" }) },
            }),
        );
        await app.goto();
        await app.waitForReady();
        const shell = new AppShell(page);
        await shell.gotoBand();

        const band = new BandPage(page);
        await band.cancelDeleteAllData(page, 1);

        // No first-run prompt; data still there
        await expect(shell.firstRunModal).toBeHidden();
        await shell.gotoSongs();
        await expect(new SongsPage(page).songRow("Survives")).toBeVisible();
    });

    test("cancelling the second confirm leaves data intact", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                songs: { s1: makeSong({ id: "s1", name: "AlsoSurvives" }) },
            }),
        );
        await app.goto();
        await app.waitForReady();
        const shell = new AppShell(page);
        await shell.gotoBand();

        const band = new BandPage(page);
        await band.cancelDeleteAllData(page, 2);

        await expect(shell.firstRunModal).toBeHidden();
        await shell.gotoSongs();
        await expect(new SongsPage(page).songRow("AlsoSurvives")).toBeVisible();
    });
});
