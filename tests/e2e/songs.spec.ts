import { buildSeed, expect, makeMember, makeSong, test } from "../fixtures/test-fixtures";
import { AppShell } from "../pages/AppShell";
import { SongEditorPage } from "../pages/SongEditorPage";
import { SongsPage } from "../pages/SongsPage";

/**
 * Songs catalog screen — list, search, filter (type/status/key), empty
 * states. The detailed editor flows live in `song-editor.spec.ts`.
 */
test.describe("Songs catalog — empty states", { tag: ["@smoke"] }, () => {
    test("empty catalog shows 'Crickets...' empty state", async ({ page, app }) => {
        await app.seed(buildSeed());
        await app.goto();
        const shell = new AppShell(page);
        await shell.gotoSongs();

        const songs = new SongsPage(page);
        await expect(songs.emptyTitle).toContainText("Crickets...");
        await expect(songs.heading).toContainText("Songs (0)");
    });

    test("non-matching search shows 'Nope, nothing' state", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                songs: { "song-1": makeSong({ id: "song-1", name: "Stairway" }) },
            }),
        );
        await app.goto();
        const shell = new AppShell(page);
        await shell.gotoSongs();

        const songs = new SongsPage(page);
        await songs.search("xyznope");
        await expect(songs.emptyTitle).toContainText("Nope");
    });
});

test.describe("Songs catalog — list & count", { tag: ["@smoke"] }, () => {
    test("renders all seeded songs sorted by name", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                songs: {
                    a: makeSong({ id: "a", name: "Brown Eyed Girl" }),
                    b: makeSong({ id: "b", name: "Africa" }),
                    c: makeSong({ id: "c", name: "Creep" }),
                },
            }),
        );
        await app.goto();
        await new AppShell(page).gotoSongs();

        const songs = new SongsPage(page);
        await expect(songs.heading).toContainText("Songs (3)");
        const names = await songs.getVisibleSongNames();
        expect(names).toEqual(["Africa", "Brown Eyed Girl", "Creep"]);
    });

    test("count updates when a new song is added via UI", async ({ page, app }) => {
        await app.seed(buildSeed());
        await app.goto();
        await new AppShell(page).gotoSongs();

        const songs = new SongsPage(page);
        const editor = new SongEditorPage(page);
        await songs.clickAdd();
        await editor.waitForVisible();
        await editor.fillName("My New Song");
        await editor.save();
        await expect(songs.heading).toContainText("Songs (1)");
        await songs.expectSongVisible("My New Song");
    });

    test("clicking a song row opens the editor for that song", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                songs: { x: makeSong({ id: "x", name: "Edit Me" }) },
            }),
        );
        await app.goto();
        await new AppShell(page).gotoSongs();

        const songs = new SongsPage(page);
        const editor = new SongEditorPage(page);
        await songs.openSong("Edit Me");
        await editor.waitForVisible();
        await expect(editor.nameInput).toHaveValue("Edit Me");
    });
});

test.describe("Songs catalog — search", () => {
    test.beforeEach(async ({ app }) => {
        await app.seed(
            buildSeed({
                songs: {
                    a: makeSong({ id: "a", name: "Wonderwall" }),
                    b: makeSong({ id: "b", name: "Wonderful Tonight" }),
                    c: makeSong({ id: "c", name: "Yesterday" }),
                },
            }),
        );
    });

    test("matches by name substring (case-insensitive)", async ({ page, app }) => {
        await app.goto();
        await app.waitForSynced();
        await new AppShell(page).gotoSongs();

        const songs = new SongsPage(page);
        await songs.search("wonder");
        const names = await songs.getVisibleSongNames();
        expect(names).toEqual(["Wonderful Tonight", "Wonderwall"]);
        await songs.expectSongHidden("Yesterday");
    });

    test("clearing search restores full list", async ({ page, app }) => {
        await app.goto();
        await app.waitForSynced();
        await new AppShell(page).gotoSongs();

        const songs = new SongsPage(page);
        await songs.search("wonder");
        await songs.clearSearch();
        const names = await songs.getVisibleSongNames();
        expect(names.length).toBe(3);
    });
});

test.describe("Songs catalog — type filter", () => {
    test("Originals/Covers/Instrumentals filter the list", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                songs: {
                    o: makeSong({ id: "o", name: "Original Song" }),
                    c: makeSong({ id: "c", name: "Cover Song", cover: true }),
                    i: makeSong({ id: "i", name: "Inst Song", instrumental: true }),
                },
            }),
        );
        await app.goto();
        await app.waitForSynced();
        await new AppShell(page).gotoSongs();

        const songs = new SongsPage(page);

        await songs.clickFilterChip("Originals");
        // Originals = not-cover. The instrumental is technically also an
        // original (covers are tracked separately).
        let names = await songs.getVisibleSongNames();
        expect(names).toContain("Original Song");
        expect(names).toContain("Inst Song");
        expect(names).not.toContain("Cover Song");

        await songs.clickFilterChip("Covers");
        names = await songs.getVisibleSongNames();
        expect(names).toEqual(["Cover Song"]);

        await songs.clickFilterChip("Instrumentals");
        names = await songs.getVisibleSongNames();
        expect(names).toEqual(["Inst Song"]);

        await songs.clickFilterChip("All");
        names = await songs.getVisibleSongNames();
        expect(names.length).toBe(3);
    });
});

test.describe("Songs catalog — status filters", () => {
    test("Unpracticed chip toggles to show only unpracticed songs", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                members: { Alice: makeMember("Alice", { instruments: [{ name: "Guitar" }] }) },
                songs: {
                    a: makeSong({
                        id: "a",
                        name: "Practiced",
                        members: { Alice: { instruments: [{ name: "Guitar" }] } },
                    }),
                    b: makeSong({
                        id: "b",
                        name: "Needs Work",
                        unpracticed: true,
                        members: { Alice: { instruments: [{ name: "Guitar" }] } },
                    }),
                },
            }),
        );
        await app.goto();
        await new AppShell(page).gotoSongs();

        const songs = new SongsPage(page);
        await songs.clickStatusFilter("Unpracticed");
        const names = await songs.getVisibleSongNames();
        expect(names).toEqual(["Needs Work"]);
    });

    test("Incomplete chip surfaces songs with broken overrides", async ({ page, app }) => {
        // Under the inheritance model, a song with NO member entries is
        // fully valid (everyone plays their usual setup). Incomplete now
        // means an explicit override that's broken — an unnamed instrument.
        await app.seed(
            buildSeed({
                members: { Alice: makeMember("Alice", { instruments: [{ name: "Guitar" }] }) },
                songs: {
                    ok: makeSong({ id: "ok", name: "Complete", members: {} }),
                    inc: makeSong({
                        id: "inc",
                        name: "Half-baked",
                        members: { Alice: { instruments: [{ name: "", tuning: [], capo: 0, picking: [] }] } },
                    }),
                },
            }),
        );
        await app.goto();
        await new AppShell(page).gotoSongs();

        const songs = new SongsPage(page);
        // Only show the chip if there are incomplete songs.
        await songs.clickStatusFilter("Incomplete");
        const names = await songs.getVisibleSongNames();
        expect(names).toContain("Half-baked");
        expect(names).not.toContain("Complete");
    });
});

test.describe("Songs catalog — key filter", () => {
    test("Key chips filter to songs that match", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                songs: {
                    c: makeSong({ id: "c", name: "C Major Song", key: "C" }),
                    d: makeSong({ id: "d", name: "D Major Song", key: "D" }),
                    e: makeSong({ id: "e", name: "E Minor Song", key: "Em" }),
                },
            }),
        );
        await app.goto();
        await new AppShell(page).gotoSongs();

        const songs = new SongsPage(page);
        await songs.clickKeyFilter("C");
        let names = await songs.getVisibleSongNames();
        expect(names).toEqual(["C Major Song"]);

        await songs.clickKeyFilter("D");
        names = await songs.getVisibleSongNames();
        // C and D both selected — both should appear.
        expect(names).toEqual(["C Major Song", "D Major Song"]);

        await songs.keyFilterClear.click();
        names = await songs.getVisibleSongNames();
        expect(names.length).toBe(3);
    });

    test("key filter section hidden when no songs have a key", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                songs: { x: makeSong({ id: "x", name: "Keyless" }) },
            }),
        );
        await app.goto();
        await new AppShell(page).gotoSongs();

        const songs = new SongsPage(page);
        await expect(songs.screen.locator(".key-filter-section")).toHaveCount(0);
    });
});

test.describe("Songs catalog — pills & badges", () => {
    test("cover and instrumental pills appear on song rows", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                songs: {
                    c: makeSong({ id: "c", name: "Covering", cover: true }),
                    i: makeSong({ id: "i", name: "Inst", instrumental: true }),
                    u: makeSong({ id: "u", name: "Untouched", unpracticed: true }),
                },
            }),
        );
        await app.goto();
        await new AppShell(page).gotoSongs();

        const songs = new SongsPage(page);
        await expect(songs.songRow("Covering").locator(".pill")).toContainText("cover");
        await expect(songs.songRow("Inst").locator(".pill")).toContainText("instrumental");
        await expect(songs.songRow("Untouched").locator(".pill.warn")).toContainText("unpracticed");
    });

    test("songs without a name show 'Untitled'", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                songs: { x: makeSong({ id: "x", name: "" }) },
            }),
        );
        await app.goto();
        await new AppShell(page).gotoSongs();

        const songs = new SongsPage(page);
        await expect(songs.screen.locator(".song-name")).toContainText("Untitled");
    });
});
