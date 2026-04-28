import { seedRemoteConfig, seedRemoteSongs } from "./fixtures/armadietto";
import { expect, test } from "./fixtures/test-fixtures";

/**
 * The full-fat real-backend integration test the user-reported regression
 * exposed a need for. Each existing real-backend spec only goes as far as
 * "we got into the app shell" — that's a weak guarantee. The deeper claim
 * we want to pin is:
 *
 *   1. After connect, sync says "synced".
 *   2. The catalog contains exactly the songs the server has.
 *   3. Roll succeeds and the generated setlist is non-empty.
 *   4. A subsequent forced re-sync DOES NOT clear the generated setlist.
 *   5. Swap is fast (snapshot path covers the gap before remote arrives).
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
function setlistIds(state: { generatedSetlist: { songs?: { id: string }[] } | null } | null): string[] {
    return (state?.generatedSetlist?.songs ?? []).map((s) => s.id);
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
        let state = await app.getStoreState();
        expect(state?.syncState).toBe("synced");
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
        await expect
            .poll(async () => (await app.getStoreState())?.generatedSetlist?.songs?.length ?? 0)
            .toBeGreaterThan(0);

        state = await app.getStoreState();
        const rolledIdsBefore = setlistIds(state);
        expect(rolledIdsBefore.length).toBeGreaterThan(0);
        // Every song in the rolled setlist must come from A's catalog.
        const aIds = new Set(A_SONGS.map((s) => s.id));
        for (const id of rolledIdsBefore) {
            expect(aIds.has(id), `rolled setlist song ${id} not in A's catalog`).toBe(true);
        }

        // ---- Phase 4: forced re-sync MUST NOT clear the rolled setlist ----
        // retrySync triggers reloadAll, which is the path the user would
        // hit on any onChange burst. The roll is in-memory only and not
        // backed by the cache, so a naive "blank state then repopulate"
        // reload would drop it. This is the exact regression to guard.
        await page.evaluate(() => {
            const s = (window as unknown as { __SR_STORE__?: { retrySync?: () => Promise<void> } }).__SR_STORE__;
            return s?.retrySync?.();
        });
        await app.waitForSynced();
        state = await app.getStoreState();
        const rolledIdsAfter = setlistIds(state);
        expect(rolledIdsAfter, "rolled setlist was dropped by re-sync").toEqual(rolledIdsBefore);

        // ---- Phase 5: swap to user-B (snapshot-fast) ----
        const tStart = Date.now();
        await page.locator("header.top-bar").getByRole("button", { name: "Menu" }).click();
        await page.locator(".dropdown-item--account").filter({ hasText: userB.address }).click();
        await app.waitForReady();
        // The snapshot path (when restoreSnapshot returns true) lands in
        // the app shell instantly; even on the cold-cache no-snapshot
        // path the swap should be sub-10s against a local backend.
        // We've never had a snapshot for B in this test, so this is the
        // cold path — keep the bound generous but still snappy.
        const tShellVisible = Date.now();
        expect(
            tShellVisible - tStart,
            `swap took ${tShellVisible - tStart}ms — slower than the 10s budget`,
        ).toBeLessThan(10_000);

        // ---- Phase 6: post-swap, every Phase 2-4 check holds for B ----
        await app.waitForSynced();
        state = await app.getStoreState();
        expect(state?.syncState).toBe("synced");
        expect(state?.appConfig?.bandName).toBe("Band B");
        expect(names(state)).toEqual(B_SONGS.map((s) => s.name).sort());
        expect(names(state)).not.toContain("Africa"); // A's data must NOT leak.

        // Roll on B.
        await expect(rollButton).toBeEnabled();
        await rollButton.click();
        await expect
            .poll(async () => (await app.getStoreState())?.generatedSetlist?.songs?.length ?? 0)
            .toBeGreaterThan(0);
        state = await app.getStoreState();
        const bRolledBefore = setlistIds(state);
        const bIds = new Set(B_SONGS.map((s) => s.id));
        for (const id of bRolledBefore) {
            expect(bIds.has(id), `rolled setlist song ${id} not in B's catalog`).toBe(true);
        }
        // Forced re-sync still doesn't clobber the roll on B.
        await page.evaluate(() => {
            const s = (window as unknown as { __SR_STORE__?: { retrySync?: () => Promise<void> } }).__SR_STORE__;
            return s?.retrySync?.();
        });
        await app.waitForSynced();
        state = await app.getStoreState();
        expect(setlistIds(state)).toEqual(bRolledBefore);
    });
});
