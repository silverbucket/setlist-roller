import { buildSeed, expect, makeMember, makeSong, test } from "../fixtures/test-fixtures";
import { AppShell } from "../pages/AppShell";
import { BandPage } from "../pages/BandPage";

/**
 * Band screen — band name, members, advanced config, data import/export,
 * and account management.
 */
test.describe("Band screen — band name", { tag: ["@smoke"] }, () => {
    test("editing the band name updates the top bar title", async ({ page, app }) => {
        await app.seed(buildSeed());
        await app.goto();
        const shell = new AppShell(page);
        await shell.gotoBand();

        const band = new BandPage(page);
        await band.setBandName("Renamed Band");
        // Band name is reflected in the top bar
        await expect(shell.bandTitle).toContainText("Renamed Band");
    });

    test("Band name persists after navigating away and back", async ({ page, app }) => {
        await app.seed(buildSeed());
        await app.goto();
        const shell = new AppShell(page);
        await shell.gotoBand();

        const band = new BandPage(page);
        await band.setBandName("Persistent Crew");
        await shell.gotoRoll();
        await shell.gotoBand();
        await expect(band.bandNameInput).toHaveValue("Persistent Crew");
    });
});

test.describe("Band screen — members", () => {
    test("empty state shown when no members exist", async ({ page, app }) => {
        await app.seed(buildSeed());
        await app.goto();
        await new AppShell(page).gotoBand();

        const band = new BandPage(page);
        await expect(band.screen.locator(".empty-state")).toContainText("No members yet");
    });

    test("can add a member; appears in the list", { tag: ["@smoke"] }, async ({ page, app }) => {
        await app.seed(buildSeed());
        await app.goto();
        await new AppShell(page).gotoBand();

        const band = new BandPage(page);
        await band.addMember("Alice");
        // Adding a member drops straight into their edit view (the next
        // step is always "add their instruments")...
        await expect(band.memberEditTitle).toBeVisible();
        // ...and Back shows them in the members list.
        await band.memberBackButton.click();
        await band.expectMemberPresent("Alice");
    });

    test("seeded members render in the list", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                members: {
                    Alice: makeMember("Alice", { instruments: [{ name: "Guitar" }] }),
                    Bob: makeMember("Bob", { instruments: [{ name: "Bass" }] }),
                },
            }),
        );
        await app.goto();
        await new AppShell(page).gotoBand();

        const band = new BandPage(page);
        await band.expectMemberPresent("Alice");
        await band.expectMemberPresent("Bob");
        await expect(band.memberRow("Alice")).toContainText("Guitar");
    });

    test("clicking a member opens member-edit subview", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                members: { Alice: makeMember("Alice") },
            }),
        );
        await app.goto();
        await new AppShell(page).gotoBand();

        const band = new BandPage(page);
        await band.openMemberEdit("Alice");
        await expect(band.memberEditTitle).toBeVisible();
    });

    test("can rename a member from the edit subview", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                members: { Alice: makeMember("Alice") },
            }),
        );
        await app.goto();
        await new AppShell(page).gotoBand();

        const band = new BandPage(page);
        await band.openMemberEdit("Alice");
        await band.memberNameInput.fill("Allison");
        await band.memberNameInput.blur();
        await band.backToMain();

        await band.expectMemberPresent("Allison");
        await band.expectMemberAbsent("Alice");
    });

    test("can remove a member from the edit subview", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                members: { Alice: makeMember("Alice") },
            }),
        );
        await app.goto();
        await new AppShell(page).gotoBand();

        const band = new BandPage(page);
        await band.openMemberEdit("Alice");
        // The store calls window.confirm — auto-accept it.
        page.once("dialog", (d) => d.accept());
        await band.removeMemberButton.click();
        await band.expectMemberAbsent("Alice");
    });
});

test.describe("Band screen — instruments", () => {
    test("can add an instrument to a member from member-edit", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                members: { Alice: makeMember("Alice") },
            }),
        );
        await app.goto();
        await new AppShell(page).gotoBand();

        const band = new BandPage(page);
        await band.openMemberEdit("Alice");
        await band.addInstrumentToMember("Mandolin");
        // Wait for the instrument card to appear, then verify
        await expect(band.instrumentCard("Mandolin")).toBeVisible();
    });

    test("seeded instruments render with correct details", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                members: {
                    Alice: makeMember("Alice", {
                        instruments: [
                            {
                                name: "Guitar",
                                defaultTuning: "EADGBE",
                                tunings: ["EADGBE", "DADGAD"],
                                techniques: ["fingerpick", "strum"],
                                defaultTechnique: "strum",
                            },
                        ],
                    }),
                },
            }),
        );
        await app.goto();
        await new AppShell(page).gotoBand();

        const band = new BandPage(page);
        await band.openMemberEdit("Alice");
        await expect(band.instrumentCard("Guitar")).toBeVisible();
        await band.expandInstrument("Guitar");
        // Tunings and techniques chips should appear in the instrument body
        const card = band.instrumentCard("Guitar");
        await expect(card.locator(".removable-chip").filter({ hasText: "EADGBE" })).toBeVisible();
        await expect(card.locator(".removable-chip").filter({ hasText: "DADGAD" })).toBeVisible();
        await expect(card.locator(".removable-chip").filter({ hasText: "fingerpick" })).toBeVisible();
    });
});

test.describe("Band screen — stats", () => {
    test("songs count and instrument types match seeded data", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                members: {
                    Alice: makeMember("Alice", { instruments: [{ name: "Guitar" }] }),
                    Bob: makeMember("Bob", { instruments: [{ name: "Bass" }, { name: "Synth" }] }),
                },
                songs: {
                    a: makeSong({ id: "a", name: "One" }),
                    b: makeSong({ id: "b", name: "Two" }),
                    c: makeSong({ id: "c", name: "Three" }),
                },
            }),
        );
        await app.goto();
        await new AppShell(page).gotoBand();

        const band = new BandPage(page);
        await expect(band.statSongsCount).toHaveText("3");
        // Guitar + Bass + Synth = 3 instrument types
        await expect(band.statInstrumentTypes).toHaveText("3");
    });
});

test.describe("Band screen — advanced config", () => {
    test("clicking config card opens advanced subview", async ({ page, app }) => {
        await app.seed(buildSeed());
        await app.goto();
        await new AppShell(page).gotoBand();

        const band = new BandPage(page);
        await band.openAdvancedConfig();
        await expect(band.advancedTitle).toBeVisible();
        // No explicit save button anymore — edits autosave (debounced).
        await expect(band.autosaveHint).toBeVisible();
    });

    test("Back button from advanced returns to main view", async ({ page, app }) => {
        await app.seed(buildSeed());
        await app.goto();
        await new AppShell(page).gotoBand();

        const band = new BandPage(page);
        await band.openAdvancedConfig();
        await band.memberBackButton.click();
        await expect(band.bandNameInput).toBeVisible();
    });
});

test.describe("Band screen — die color", () => {
    test("clicking a swatch updates the persisted die color in store", async ({ page, app }) => {
        await app.seed(buildSeed());
        await app.goto();
        await app.waitForReady();
        await app.waitForSynced();
        await new AppShell(page).gotoBand();

        const band = new BandPage(page);
        // Click the orange swatch (#f97316)
        await band.pickDieColor("#f97316");
        // Read store state to verify
        const state = await app.getState();
        expect(state.appConfig.ui.dieColor).toBe("#f97316");
    });

    test("reset button clears the die color override", async ({ page, app }) => {
        await app.seed(
            buildSeed({
                config: {
                    bandName: "Test Band",
                    schemaVersion: 2,
                    createdAt: "2024-01-01T00:00:00.000Z",
                    updatedAt: "2024-01-01T00:00:00.000Z",
                    ui: { dieColor: "#ef4444" },
                },
            }),
        );
        await app.goto();
        await app.waitForReady();
        await new AppShell(page).gotoBand();

        const band = new BandPage(page);
        await band.resetDieColor();
        const state = await app.getState();
        expect(state.appConfig.ui.dieColor).toBeNull();
    });
});

test.describe("Band screen — account section", () => {
    test("disconnect button is visible when connected", async ({ page, app }) => {
        await app.seed(buildSeed());
        await app.goto();
        await new AppShell(page).gotoBand();

        const band = new BandPage(page);
        await expect(band.disconnectButton).toBeVisible();
    });

    test("connected address is shown in account section", async ({ page, app }) => {
        // The seed return gives us the freshly-provisioned address;
        // arbitrary "alice@example.com"-style strings can't work here
        // because the account has to exist on armadietto.
        const { primary } = await app.seed(buildSeed());
        await app.goto();
        await new AppShell(page).gotoBand();

        const band = new BandPage(page);
        await expect(band.screen.locator(".connect-address")).toContainText(primary?.address ?? "");
    });
});

test.describe("Band screen — footer", () => {
    test("app footer is rendered with version and links", async ({ page, app }) => {
        await app.seed(buildSeed());
        await app.goto();
        await new AppShell(page).gotoBand();

        const band = new BandPage(page);
        await expect(band.footer).toBeVisible();
        await expect(band.footer).toContainText("Setlist Roller");
        await expect(band.footer.getByRole("link", { name: "GitHub" })).toBeVisible();
    });
});
