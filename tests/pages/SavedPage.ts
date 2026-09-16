import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Saved screen — draft and performed setlists with view, edit, load, and
 * delete actions, plus the print modal.
 */
export class SavedPage {
    readonly page: Page;
    readonly screen: Locator;
    readonly emptyState: Locator;
    readonly savedCards: Locator;
    readonly modal: Locator;
    readonly modalContent: Locator;
    readonly modalActions: Locator;
    readonly modalCloseButton: Locator;
    readonly printButton: Locator;
    readonly loadToRollButton: Locator;

    constructor(page: Page) {
        this.page = page;
        this.screen = page.locator(".saved-screen");
        this.emptyState = this.screen.locator(".empty-state");
        this.savedCards = this.screen.locator(".saved-card");
        this.modal = page.locator(".modal-sheet");
        // The scrollable region holding the song list. Action buttons live
        // outside this element so they stay pinned while the list scrolls.
        this.modalContent = this.modal.locator(".modal-content");
        this.modalActions = this.modal.locator(".modal-actions");
        this.modalCloseButton = this.modal.getByRole("button", { name: "Close" });
        this.printButton = this.modal.getByRole("button", { name: /Print/ });
        this.loadToRollButton = this.modal.getByRole("button", { name: /Edit setlist|Use as new draft/ });
    }

    cardByName(name: string): Locator {
        return this.savedCards.filter({ hasText: name });
    }

    async openCard(name: string) {
        await this.cardByName(name).click();
        await expect(this.modal).toBeVisible();
    }

    async closeCard() {
        await this.modalCloseButton.click();
        await expect(this.modal).toBeHidden();
    }

    async loadToRoll(name: string) {
        await this.openCard(name);
        await this.loadToRollButton.click();
    }

    async startEdit(name: string) {
        await this.cardByName(name).getByRole("button", { name: "Edit" }).click();
    }

    /**
     * Once the edit form is open, the card no longer renders the original
     * name as visible text (it lives inside an input value). Tests should
     * locate the only-open edit form instead of trying to find by name.
     */
    private editingCard(): Locator {
        return this.savedCards.filter({ has: this.page.locator(".edit-form") });
    }

    async saveEdit(_name: string) {
        await this.editingCard().getByRole("button", { name: "Save" }).click();
    }

    async cancelEdit(_name: string) {
        await this.editingCard().getByRole("button", { name: "Cancel" }).click();
    }

    async fillEditName(_originalName: string, newName: string) {
        await this.editingCard().locator("input.edit-input").first().fill(newName);
    }

    async loadSavedFromCard(name: string) {
        await this.cardByName(name)
            .getByRole("button", { name: /Open|Use as draft/ })
            .click();
    }

    async markPerformed(name: string, date: string, venue?: string) {
        await this.cardByName(name).getByRole("button", { name: "Mark performed" }).click();
        const dialog = this.page.getByRole("dialog", { name: "Mark as performed?" });
        await dialog.getByLabel("Show date").fill(date);
        if (venue) await dialog.getByLabel(/Venue/).fill(venue);
        await dialog.getByRole("button", { name: "Mark as performed" }).click();
    }

    async deletePerformed(name: string) {
        await this.cardByName(name).getByRole("button", { name: "Remove" }).click();
        const dialog = this.page.getByRole("alertdialog", { name: "Delete performed setlist?" });
        await expect(dialog).toContainText("part of your show history");
        await dialog.getByRole("button", { name: "Delete permanently" }).click();
    }

    async deleteSaved(name: string) {
        const card = this.cardByName(name);
        // First click reveals confirm; second commits.
        await card.getByRole("button", { name: "Remove" }).click();
        await card.getByRole("button", { name: "Delete?" }).click();
    }

    async cancelDelete(name: string) {
        const card = this.cardByName(name);
        await card.getByRole("button", { name: "Remove" }).click();
        await card.getByRole("button", { name: "No" }).click();
    }
}
