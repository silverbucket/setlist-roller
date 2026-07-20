import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Roll screen — the dice, song count stepper, settings drawer, generated
 * setlist, and the "lock / save" actions.
 */
export class RollPage {
    readonly page: Page;
    readonly screen: Locator;
    readonly rollButton: Locator;
    readonly settingsDrawer: Locator;
    readonly settingsToggle: Locator;
    readonly varietySlider: Locator;
    readonly maxCoversInput: Locator;
    readonly maxInstrumentalsInput: Locator;
    readonly maxCoversNoLimit: Locator;
    readonly maxInstrumentalsNoLimit: Locator;
    readonly seedInput: Locator;
    readonly keyFlowToggle: Locator;
    readonly setlistSongs: Locator;
    readonly anxietyValue: Locator;
    readonly anxietyHint: Locator;
    readonly addSongButton: Locator;
    readonly lockButton: Locator;
    readonly lockedBadge: Locator;
    readonly savedBadge: Locator;
    readonly saveToHitsButton: Locator;
    readonly onboardingCard: Locator;
    readonly idleNudge: Locator;
    readonly confirmDialog: Locator;
    readonly addSongDialog: Locator;
    readonly addSongSearch: Locator;

    constructor(page: Page) {
        this.page = page;
        this.screen = page.locator(".roll-screen");
        this.rollButton = this.screen.getByRole("button", { name: "Roll setlist" });
        this.settingsDrawer = this.screen.locator(".settings-drawer");
        this.settingsToggle = this.screen.locator(".settings-toggle");
        this.varietySlider = this.screen.locator(".variety-slider");
        this.maxCoversInput = this.screen.getByLabel("Max covers");
        this.maxInstrumentalsInput = this.screen.getByLabel("Max instrumentals");
        // The "No limit" checkboxes have no aria-label so we walk by parent.
        this.maxCoversNoLimit = this.screen
            .locator(".adv-field")
            .filter({ hasText: "Max covers" })
            .locator(".no-limit-toggle input");
        this.maxInstrumentalsNoLimit = this.screen
            .locator(".adv-field")
            .filter({ hasText: "Max instrumentals" })
            .locator(".no-limit-toggle input");
        this.seedInput = this.screen
            .locator('input[type="number"]')
            .filter({ hasNot: page.locator(".adv-field input") })
            .last();
        this.keyFlowToggle = this.screen.locator("label").filter({ hasText: "Smooth key flow" });
        this.setlistSongs = this.screen.locator(".song-list .song-card");
        this.anxietyValue = this.screen.locator(".roadie-val");
        this.anxietyHint = this.screen.locator(".roadie-hint");
        this.addSongButton = this.screen.getByRole("button", { name: "+ Add song" });
        this.lockButton = this.screen.getByRole("button", { name: /Lock it in/ });
        this.lockedBadge = this.screen.locator(".locked-badge");
        this.savedBadge = this.screen.locator(".saved-badge");
        this.saveToHitsButton = this.screen.getByRole("button", { name: "Save to Greatest Hits" });
        this.onboardingCard = this.screen.locator(".onboarding-card");
        this.idleNudge = this.screen.locator(".idle-nudge");
        this.confirmDialog = page.locator(".confirm-dialog");
        this.addSongDialog = page.locator(".add-song-dialog");
        this.addSongSearch = this.addSongDialog.getByPlaceholder("Search songs...");
    }

    async setSongCount(count: number) {
        // NumberStepper is fiddly to drive via clicks at high values, so we
        // call the store directly. The UI re-renders from the same state.
        await this.page.evaluate((c) => {
            const s = (
                window as unknown as {
                    __SR_STORE__?: { updateGenerationField?: (field: string, value: unknown) => void };
                }
            ).__SR_STORE__;
            s?.updateGenerationField?.("count", c);
        }, count);
    }

    async openSettings() {
        // The drawer is a <details> element; clicking the summary toggles it.
        const isOpen = await this.settingsDrawer.evaluate((el: HTMLDetailsElement) => el.open);
        if (!isOpen) await this.settingsToggle.click();
    }

    async closeSettings() {
        const isOpen = await this.settingsDrawer.evaluate((el: HTMLDetailsElement) => el.open);
        if (isOpen) await this.settingsToggle.click();
    }

    async clickRoll() {
        await this.rollButton.click();
    }

    async waitForRollResult() {
        // The "Lock it in" button only appears once a setlist is rendered.
        await expect(this.lockButton.or(this.lockedBadge)).toBeVisible({ timeout: 15_000 });
    }

    async setSeed(seed: number) {
        await this.openSettings();
        // Switch to the Chaos tab if the constraints tab is active.
        await this.activateTab("chaos");
        const seedField = this.screen.locator("label").filter({ hasText: "Seed" }).locator('input[type="number"]');
        await seedField.fill(String(seed));
    }

    async activateTab(tab: "constraints" | "chaos") {
        const buttons = this.screen.locator(".settings-tab");
        if ((await buttons.count()) === 0) return; // no constraints to tab between
        const label = tab === "constraints" ? "Demands" : "Shape the Set";
        await buttons.filter({ hasText: label }).click();
    }

    async lockSetlist() {
        await this.lockButton.click();
    }

    async saveSetlist() {
        await this.saveToHitsButton.click();
    }

    async addExistingSong(songName: string) {
        await this.addSongButton.click();
        await expect(this.addSongDialog).toBeVisible();
        await this.addSongSearch.fill(songName);
        await this.addSongDialog.getByRole("button", { name: songName, exact: false }).first().click();
    }

    async pinBeforeRoll(songName: string) {
        await this.screen.getByRole("button", { name: "+ Pin songs before rolling" }).click();
        await expect(this.addSongDialog).toBeVisible();
        await this.addSongSearch.fill(songName);
        await this.addSongDialog.getByRole("button", { name: songName, exact: false }).first().click();
    }

    pinButton(songName: string) {
        return this.setlistSongs.filter({ hasText: songName }).getByRole("button", { name: `Pin ${songName}` });
    }

    async closeAddSongDialog() {
        // Use the dialog's Cancel button — clicking the overlay backdrop is
        // unreliable since the dialog can intercept clicks.
        await this.addSongDialog.getByRole("button", { name: "Cancel" }).click();
    }

    async getSetlistSongCount(): Promise<number> {
        return this.setlistSongs.count();
    }

    async getSetlistSongNames(): Promise<string[]> {
        return this.setlistSongs.locator(".song-name").allInnerTexts();
    }

    async expectFreshRollDialog() {
        await expect(this.confirmDialog).toBeVisible();
    }

    async confirmFreshRoll() {
        await this.confirmDialog.getByRole("button", { name: "Fresh roll" }).click();
    }

    async confirmOptimizeOrder() {
        await this.confirmDialog.getByRole("button", { name: "Optimize order" }).click();
    }

    async cancelRoll() {
        await this.confirmDialog.getByRole("button", { name: "Keep it" }).click();
    }

    /**
     * Click Roll. If a fresh-roll dialog appears (because the setlist is
     * locked), choose "Fresh roll". If not, the click goes straight through
     * to a normal generation.
     */
    async confirmOrFresh() {
        await this.clickRoll();
        if (await this.confirmDialog.isVisible().catch(() => false)) {
            await this.confirmFreshRoll();
        }
    }
}
