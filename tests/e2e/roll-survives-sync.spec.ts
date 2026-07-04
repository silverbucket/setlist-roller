import { seedRemoteConfig, seedRemoteSongs } from "../fixtures/armadietto";
import { expect, test } from "../fixtures/test-fixtures";

/**
 * The full-fat real-backend integration test the user-reported regression
 * exposed a need for. Each existing real-backend spec only goes as far as
 * "we got into the app shell" — that's a weak guarantee. The deeper claim
 * we want to pin is:
 *
 *   1. After connect, sync settles.
 *   2. The catalog contains exactly the songs the server has.
 *   3. Roll succeeds and the generated setlist is non-empty.
 *   4. A subsequent forced re-sync DOES NOT clear the generated setlist.
 *   5. Swap is fast (the per-account mirror covers the gap before remote
 *      data arrives).
 *   6. Every property above holds on the swapped-to account.
 *
 * The test seeds two armadietto users with disjoint catalogs by PUTing
 * directly to the storage API before the app ever boots — that way rs.js
 * sees real data on the server during its very first sync round, and
 * cross-account isolation is something we can actually assert on.
 */

const A_SONGS = [
    { id: "song-a-001", name: "Africa" },
    { id: "song-a-002", name: "Bohemian Rhapsody" },
    { id: "song-a-003", name: "Creep" },
    { id: "song-a-004", name: "Dust in the Wind" },
    { id: "song-a-005", name: "Enter Sandman" },
    { id: "song-a-006", name: "Free Bird" },
];
const B_SONGS = [
    { id: "song-b-101", name: "Hotel California" },
    { id: "song-b-102", name: "Imagine" },
    { id: "song-b-103", name: "Jolene" },
    { id: "song-b-104", name: "Karma Police" },
    { id: "song-b-105", name: "Layla" },
    { id: "song-b-106", name: "Mr. Brightside" },
];

function names(state: { songs: { name: string }[] } | null): string[] {
    return (state?.songs ?? []).map((s) => s.name).sort();
}
function setlistIds(state: { generatedSetlist: { songs?: { songId: string }[] } | null } | null): string[] {
    return (state?.generatedSetlist?.songs ?? []).map((s) => s.songId);
}

test.describe("Real backend — roll survives sync, swap retains roll-readiness", () => {
    test("end-to-end: catalog → roll → re-sync no-clobber → swap → same checks", async ({ page, app }) => {
        // ---- Phase 1: provision + seed both users ON the real server ----
        const userA = await app.provisionUser("rsa");
        const userB = await app.provisionUser("rsb");
        await Promise.all([
            seedRemoteSongs(userA, A_SONGS),
            seedRemoteConfig(userA, "Band A"),
            seedRemoteSongs(userB, B_SONGS),
            seedRemoteConfig(userB, "Band B"),
        ]);

        // Cold-boot connected as A. seedConnectedAccount writes the rs.js
        // session keys so the page boots straight into the app shell;
        // seedAdditionalAccount stages B in the known-accounts list so
        // the TopBar Switch-to entry will be there once we get to phase 5.
        await app.seedConnectedAccount(userA);
        await app.seedAdditionalAccount(userB);

        await app.goto();
        await app.waitForReady();

        // ---- Phase 2: sync settles, catalog matches the server ----
        await app.waitForSynced();
        let state = await app.getState();
        expect(state?.initialSyncDone).toBe(true);
        expect(state?.appConfig?.bandName).toBe("Band A");
        expect(names(state)).toEqual(A_SONGS.map((s) => s.name).sort());
        // Sanity: B's data is NOT visible to A.
        expect(names(state)).not.toContain("Hotel California");

        // ---- Phase 3: Roll button works against the real catalog ----
        const rollButton = page.getByRole("button", { name: "Roll setlist" });
        await expect(rollButton).toBeEnabled();
        await rollButton.click();
        // Generation runs in a Web Worker — poll the store until the
        // setlist materialises rather than waiting on a fixed delay.
        await expect.poll(async () => (await app.getState())?.generatedSetlist?.songs?.length ?? 0).toBeGreaterThan(0);

        state = await app.getState();
        const rolledIdsBefore = setlistIds(state);
        expect(rolledIdsBefore.length).toBeGreaterThan(0);
        // Every song in the rolled setlist must come from A's catalog.
        const aIds = new Set(A_SONGS.map((s) => s.id));
        for (const id of rolledIdsBefore) {
            expect(aIds.has(id), `rolled setlist song ${id} not in A's catalog`).toBe(true);
        }

        // ---- Phase 4: forced re-sync MUST NOT clear the rolled setlist ----
        // Force a full rs.js sync cycle — the path the user hits on any
        // background poll. The roll is in-memory only and not backed by
        // remote documents, so any regression back toward "blank state
        // then repopulate" sync handling would drop it.
        await page.evaluate(() => {
            const r = (window as unknown as { __SR_REPO__?: { sync?: () => Promise<void> } }).__SR_REPO__;
            return r?.sync?.();
        });
        await app.waitForSynced();
        state = await app.getState();
        const rolledIdsAfter = setlistIds(state);
        expect(rolledIdsAfter, "rolled setlist was dropped by re-sync").toEqual(rolledIdsBefore);

        // ---- Phase 5: swap to user-B (snapshot-fast) ----
        const tStart = Date.now();
        await page.locator("header.top-bar").getByRole("button", { name: "Menu" }).click();
        await page.locator(".dropdown-item--account").filter({ hasText: userB.address }).click();
        // The app shell never unmounts during a v3 swap, so "ready" is
        // instant — the meaningful signal is the store switching accounts.
        // Waiting on it also stops waitForSynced from sampling A's already-
        // settled sync state before the swap has begun.
        await expect
            .poll(async () => (await app.getState())?.currentUserAddress, { timeout: 10_000 })
            .toBe(userB.address);
        await app.waitForReady();
        // Switching hydrates the target's local mirror instantly; B has
        // never been visited in this test, so this is the cold path (empty
        // mirror, catalog streams in) — keep the bound generous but snappy.
        const tShellVisible = Date.now();
        expect(
            tShellVisible - tStart,
            `swap took ${tShellVisible - tStart}ms — slower than the 10s budget`,
        ).toBeLessThan(10_000);

        // ---- Phase 6: post-swap, every Phase 2-4 check holds for B ----
        await app.waitForSynced();
        state = await app.getState();
        expect(state?.initialSyncDone).toBe(true);
        expect(state?.appConfig?.bandName).toBe("Band B");
        expect(names(state)).toEqual(B_SONGS.map((s) => s.name).sort());
        expect(names(state)).not.toContain("Africa"); // A's data must NOT leak.

        // Roll on B.
        await expect(rollButton).toBeEnabled();
        await rollButton.click();
        await expect.poll(async () => (await app.getState())?.generatedSetlist?.songs?.length ?? 0).toBeGreaterThan(0);
        state = await app.getState();
        const bRolledBefore = setlistIds(state);
        const bIds = new Set(B_SONGS.map((s) => s.id));
        for (const id of bRolledBefore) {
            expect(bIds.has(id), `rolled setlist song ${id} not in B's catalog`).toBe(true);
        }
        // Forced re-sync still doesn't clobber the roll on B.
        await page.evaluate(() => {
            const r = (window as unknown as { __SR_REPO__?: { sync?: () => Promise<void> } }).__SR_REPO__;
            return r?.sync?.();
        });
        await app.waitForSynced();
        state = await app.getState();
        expect(setlistIds(state)).toEqual(bRolledBefore);
    });
});
