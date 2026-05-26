import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Band screen — band name, members, advanced config, data import/export,
 * account management. Has three sub-views: main, advanced, member-edit.
 */
export class BandPage {
    readonly page: Page;
    readonly screen: Locator;

    // Main view
    readonly bandNameInput: Locator;
    readonly newMemberInput: Locator;
    readonly addMemberButton: Locator;
    readonly memberRows: Locator;
    readonly statSongsCount: Locator;
    readonly statInstrumentTypes: Locator;
    readonly advancedConfigLink: Locator;
    readonly exportAllButton: Locator;
    readonly importFileInput: Locator;
    readonly importModeSelect: Locator;
    readonly importButton: Locator;
    readonly deleteAllButton: Locator;
    readonly disconnectButton: Locator;
    readonly footer: Locator;

    // Member-edit subview
    readonly memberBackButton: Locator;
    readonly memberEditTitle: Locator;
    readonly memberNameInput: Locator;
    readonly defaultInstrumentSelect: Locator;
    readonly removeMemberButton: Locator;
    readonly newInstrumentInput: Locator;
    readonly addInstrumentButton: Locator;

    // Advanced subview
    readonly advancedTitle: Locator;
    readonly saveSettingsButton: Locator;

    constructor(page: Page) {
        this.page = page;
        this.screen = page.locator(".band-screen");
        this.bandNameInput = this.screen.locator("input.band-name-input");
        this.newMemberInput = this.screen.getByPlaceholder("New member name...");
        this.addMemberButton = this.screen
            .locator(".section-block")
            .filter({ has: page.getByRole("heading", { name: "Members" }) })
            .getByRole("button", { name: "Add" });
        this.memberRows = this.screen.locator(".member-row");
        this.statSongsCount = this.screen.locator(".stat-box").filter({ hasText: "songs" }).locator(".stat-value");
        this.statInstrumentTypes = this.screen
            .locator(".stat-box")
            .filter({ hasText: "instrument types" })
            .locator(".stat-value");
        this.advancedConfigLink = this.screen.locator(".link-card");
        this.exportAllButton = this.screen.getByRole("button", { name: "Export All" });
        this.importFileInput = this.screen.locator('input[type="file"]');
        this.importModeSelect = this.screen.locator("select").filter({ hasText: /Skip existing/ });
        this.importButton = this.screen.getByRole("button", { name: "Import" });
        this.deleteAllButton = this.screen.getByRole("button", { name: "Delete All Data" });
        this.disconnectButton = this.screen.getByRole("button", { name: "Disconnect" });
        this.footer = this.screen.locator(".app-footer");

        // Member edit subview
        this.memberBackButton = this.screen.getByRole("button", { name: /\u2190 Back/ }).first();
        this.memberEditTitle = this.screen.getByRole("heading", { name: "Edit Member" });
        // Note: the member name field appears in both subviews; scope by .sub-header sibling.
        this.memberNameInput = this.screen.locator(".card").first().locator('input[type="text"]').first();
        this.defaultInstrumentSelect = this.screen.locator(".card").first().locator("select").first();
        this.removeMemberButton = this.screen.getByRole("button", { name: "Remove member" });
        this.newInstrumentInput = this.screen.getByPlaceholder("New instrument...");
        this.addInstrumentButton = this.screen
            .locator(".section-block")
            .filter({ has: page.getByRole("heading", { name: "Instruments" }) })
            .getByRole("button", { name: "Add" });

        // Advanced subview
        this.advancedTitle = this.screen.getByRole("heading", { name: "Advanced Config" });
        this.saveSettingsButton = this.screen.getByRole("button", { name: "Save Settings" });
    }

    async setBandName(name: string) {
        await this.bandNameInput.click();
        await this.bandNameInput.fill(name);
        await this.bandNameInput.blur();
    }

    async addMember(name: string) {
        await this.newMemberInput.fill(name);
        await this.addMemberButton.click();
    }

    memberRow(name: string): Locator {
        return this.memberRows.filter({ hasText: name });
    }

    async openMemberEdit(name: string) {
        await this.memberRow(name).click();
        await expect(this.memberEditTitle).toBeVisible();
    }

    async backToMain() {
        await this.memberBackButton.click();
    }

    async addInstrumentToMember(name: string) {
        await this.newInstrumentInput.fill(name);
        await this.addInstrumentButton.click();
    }

    instrumentCard(instrumentName: string): Locator {
        return this.screen.locator(".instrument-card").filter({ hasText: instrumentName });
    }

    async expandInstrument(instrumentName: string) {
        // Cards are <details> — click summary to toggle
        const card = this.instrumentCard(instrumentName);
        const isOpen = await card.evaluate((el: HTMLDetailsElement) => el.open);
        if (!isOpen) await card.locator("summary").click();
    }

    async openAdvancedConfig() {
        await this.advancedConfigLink.click();
        await expect(this.advancedTitle).toBeVisible();
    }

    async pickDieColor(color: string) {
        await this.screen.getByRole("button", { name: `Set die color to ${color}` }).click();
    }

    async resetDieColor() {
        await this.screen.getByRole("button", { name: "Reset to default color" }).click();
    }

    async expectMemberPresent(name: string) {
        await expect(this.memberRow(name)).toBeVisible();
    }

    async expectMemberAbsent(name: string) {
        await expect(this.memberRow(name)).toHaveCount(0);
    }

    /**
     * Delete-all is gated behind TWO sequential window.confirm dialogs, so
     * tests need to register both handlers before clicking the button.
     */
    async confirmDeleteAllData(page: Page) {
        let dialogsSeen = 0;
        const onDialog = (d: import("@playwright/test").Dialog) => {
            dialogsSeen += 1;
            d.accept();
        };
        page.on("dialog", onDialog);
        try {
            await this.deleteAllButton.click();
            // Wait until both confirms have appeared. Using a short poll
            // because dialogs fire on a microtask after click.
            await expect.poll(() => dialogsSeen, { timeout: 5_000 }).toBe(2);
        } finally {
            page.off("dialog", onDialog);
        }
    }

    /**
     * Click delete-all but cancel one of the confirms — used to verify the
     * abort path doesn't wipe data.
     */
    async cancelDeleteAllData(page: Page, atStep: 1 | 2 = 1) {
        let dialogsSeen = 0;
        const onDialog = (d: import("@playwright/test").Dialog) => {
            dialogsSeen += 1;
            if (dialogsSeen === atStep) d.dismiss();
            else d.accept();
        };
        page.on("dialog", onDialog);
        try {
            await this.deleteAllButton.click();
            await expect.poll(() => dialogsSeen, { timeout: 5_000 }).toBeGreaterThanOrEqual(atStep);
        } finally {
            // Allow a beat for any trailing dialog before unsubscribing.
            await page.waitForTimeout(100);
            page.off("dialog", onDialog);
        }
    }

    /**
     * Set the import file from a JSON-serializable payload. Wraps
     * setInputFiles so the test doesn't need to know the file API specifics.
     */
    async setImportPayload(payload: unknown, fileName = "import.json") {
        await this.importFileInput.setInputFiles({
            name: fileName,
            mimeType: "application/json",
            buffer: Buffer.from(JSON.stringify(payload)),
        });
    }

    async setImportMode(mode: "skip" | "overwrite") {
        const value = mode === "skip" ? "skip" : "overwrite";
        await this.importModeSelect.selectOption(value);
    }
}
