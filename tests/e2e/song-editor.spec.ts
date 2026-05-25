import type { SeedSong } from "../fixtures/test-fixtures";
import { buildSeed, expect, makeMember, makeSong, test } from "../fixtures/test-fixtures";
import { AppShell } from "../pages/AppShell";
import { SongEditorPage } from "../pages/SongEditorPage";
import { SongsPage } from "../pages/SongsPage";

/**
 * Song editor — the overlay that opens when adding or editing a song.
 * Covers basics (name/key/notes/chips), members/instruments/tunings/
 * techniques, duplicate, delete with confirmation.
 */
test.describe("Song editor — basics", () => {
    test("create a song with name, key, and notes", { tag: ["@smoke"] }, async ({ page, app }) => {
        await app.seed(buildSeed());
        await app.goto();
        await new AppShell(page).gotoSongs();

        const songs = new SongsPage(page);
        const editor = new SongEditorPage(page);
        await songs.clickAdd();
        await editor.waitForVisible();

        await editor.fillName("Sunday Morning");
        await editor.selectKey("D");
        await editor.fillNotes("Capo on 2");
        await editor.save();

        await songs.expectSongVisible("Sunday Morning");
        const state = await app.getState();
        const created = state.songs.find((s: SeedSong) => s.name === "Sunday Morning");
        expect(created).toBeTruthy();
        expect(created.key).toBe("D");
        expect(created.notes).toBe("Capo on 2");
    });

    test("editing a song persists changes after closing/reopening", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                songs: { x: makeSong({ id: "x", name: "Original" }) },
            }),
        );
        await app.goto();
        await new AppShell(page).gotoSongs();

        const songs = new SongsPage(page);
        const editor = new SongEditorPage(page);
        await songs.openSong("Original");
        await editor.waitForVisible();
        await editor.fillName("Renamed");
        await editor.selectKey("Em");
        await editor.save();

        await songs.expectSongVisible("Renamed");
        // Re-open to verify it stuck
        await songs.openSong("Renamed");
        await expect(editor.nameInput).toHaveValue("Renamed");
        await expect(editor.keySelect).toHaveValue("Em");
    });

    test("Back button closes the editor without saving (changes discarded)", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                songs: { x: makeSong({ id: "x", name: "Stable" }) },
            }),
        );
        await app.goto();
        await new AppShell(page).gotoSongs();

        const songs = new SongsPage(page);
        const editor = new SongEditorPage(page);
        await songs.openSong("Stable");
        await editor.waitForVisible();
        await editor.fillName("Changed In Memory");
        await editor.close();

        // Original is still in the list — Back does NOT save the change.
        await songs.expectSongVisible("Stable");
        await songs.expectSongHidden("Changed In Memory");
    });

    test("toggling Cover and Instrumental chips updates the song flags", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                songs: { x: makeSong({ id: "x", name: "Toggle Me" }) },
            }),
        );
        await app.goto();
        await new AppShell(page).gotoSongs();

        const songs = new SongsPage(page);
        const editor = new SongEditorPage(page);
        await songs.openSong("Toggle Me");
        await editor.waitForVisible();
        await editor.toggleChip("Cover");
        await editor.toggleChip("Instrumental");
        await editor.save();

        const state = await app.getState();
        const song = state.songs.find((s: SeedSong) => s.name === "Toggle Me");
        expect(song.cover).toBe(true);
        expect(song.instrumental).toBe(true);
    });

    test("toggling 'Not a good opener / closer' updates flags", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                songs: { x: makeSong({ id: "x", name: "Mid-set Only" }) },
            }),
        );
        await app.goto();
        await new AppShell(page).gotoSongs();

        const songs = new SongsPage(page);
        const editor = new SongEditorPage(page);
        await songs.openSong("Mid-set Only");
        await editor.waitForVisible();
        await editor.toggleChip("Not a good opener");
        await editor.toggleChip("Not a good closer");
        await editor.save();

        const state = await app.getState();
        const song = state.songs.find((s: SeedSong) => s.name === "Mid-set Only");
        expect(song.notGoodOpener).toBe(true);
        expect(song.notGoodCloser).toBe(true);
    });

    test("Unpracticed chip surfaces the warning pill on the songs list", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                songs: { x: makeSong({ id: "x", name: "Brand New Tune" }) },
            }),
        );
        await app.goto();
        await new AppShell(page).gotoSongs();

        const songs = new SongsPage(page);
        const editor = new SongEditorPage(page);
        await songs.openSong("Brand New Tune");
        await editor.waitForVisible();
        await editor.toggleChip("Unpracticed");
        await editor.save();

        await expect(songs.songRow("Brand New Tune").locator(".pill.warn")).toContainText("unpracticed");
    });
});

test.describe("Song editor — duplicate", () => {
    test("duplicate creates a copy and switches to editing it", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                songs: {
                    x: makeSong({ id: "x", name: "Duplicatable", key: "G", notes: "fingerpicked" }),
                },
            }),
        );
        await app.goto();
        await new AppShell(page).gotoSongs();

        const songs = new SongsPage(page);
        const editor = new SongEditorPage(page);
        await songs.openSong("Duplicatable");
        await editor.waitForVisible();
        await editor.duplicate();

        // After duplicate the editor stays open and shows the new title (often
        // "<name> (copy)"). Save and check the catalog has 2 entries.
        await expect(editor.overlay).toBeVisible();
        await editor.save();

        const state = await app.getState();
        expect(state.songs.length).toBe(2);
        // Both should share the same key and notes.
        const keys = state.songs.map((s: SeedSong) => s.key as string).sort();
        expect(keys).toEqual(["G", "G"]);
    });
});

test.describe("Song editor — delete confirmation", () => {
    test("deleting a song requires a 'Yes, delete' confirmation", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                songs: { x: makeSong({ id: "x", name: "Doomed" }) },
            }),
        );
        await app.goto();
        await new AppShell(page).gotoSongs();

        const songs = new SongsPage(page);
        const editor = new SongEditorPage(page);
        await songs.openSong("Doomed");
        await editor.waitForVisible();
        await editor.confirmDelete();

        await songs.expectSongHidden("Doomed");
        await expect(songs.heading).toContainText("Songs (0)");
    });

    test("Cancel preserves the song", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                songs: { x: makeSong({ id: "x", name: "Saved" }) },
            }),
        );
        await app.goto();
        await new AppShell(page).gotoSongs();

        const songs = new SongsPage(page);
        const editor = new SongEditorPage(page);
        await songs.openSong("Saved");
        await editor.waitForVisible();
        await editor.cancelDelete();
        // Editor still open; close and check the song is still there.
        await editor.close();
        await songs.expectSongVisible("Saved");
    });
});

test.describe("Song editor — members & instruments", () => {
    test("can add an existing band member to a song", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                members: {
                    Alice: makeMember("Alice", { instruments: [{ name: "Guitar" }] }),
                },
                songs: { x: makeSong({ id: "x", name: "Add Alice" }) },
            }),
        );
        await app.goto();
        await new AppShell(page).gotoSongs();

        const songs = new SongsPage(page);
        const editor = new SongEditorPage(page);
        await songs.openSong("Add Alice");
        await editor.waitForVisible();
        await editor.addMemberByName("Alice");

        // The member section should now appear with Alice listed.
        await expect(editor.memberSection("Alice")).toBeVisible();
        await editor.save();

        const state = await app.getState();
        const song = state.songs.find((s: SeedSong) => s.name === "Add Alice");
        expect(song.members.Alice).toBeTruthy();
    });

    test("can add a new ad-hoc member from the editor", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                songs: { x: makeSong({ id: "x", name: "Solo Tune" }) },
            }),
        );
        await app.goto();
        await new AppShell(page).gotoSongs();

        const songs = new SongsPage(page);
        const editor = new SongEditorPage(page);
        await songs.openSong("Solo Tune");
        await editor.waitForVisible();
        // No existing members — only the "+ New member" button appears
        await editor.addNewMember();
        // A member card with empty name should now be visible
        await expect(editor.overlay.locator(".member-card")).toHaveCount(1);
    });
});
