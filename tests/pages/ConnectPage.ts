import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Connection screen — the first thing users see before connecting their
 * remoteStorage account. Driven from `App.svelte` when
 * `connectionStatus === "disconnected"`.
 */
export class ConnectPage {
    readonly page: Page;
    readonly heading: Locator;
    readonly addressInput: Locator;
    readonly connectButton: Locator;
    readonly errorText: Locator;
    readonly recentAccountsLabel: Locator;

    constructor(page: Page) {
        this.page = page;
        this.heading = page.getByRole("heading", { level: 1 });
        this.addressInput = page.getByPlaceholder("you@example.com");
        this.connectButton = page.getByRole("button", { name: /^Connect|Connecting/ });
        this.errorText = page.locator(".error-text");
        this.recentAccountsLabel = page.getByText("Recent", { exact: true });
    }

    async waitForVisible() {
        await expect(this.addressInput).toBeVisible();
    }

    async fillAddress(address: string) {
        await this.addressInput.fill(address);
    }

    async submit() {
        await this.connectButton.click();
    }

    async connect(address: string) {
        await this.fillAddress(address);
        await this.submit();
    }

    /**
     * Drive the full OAuth redirect flow against armadietto: type the
     * address, click Connect, fill the password on armadietto's auth
     * page, click Allow, and wait for the 302 redirect back to the app
     * with the access_token in the URL hash. After this resolves, the
     * caller can `await app.waitForReady()` and assert on the in-app
     * state. The user must already be provisioned (signup'd) — see
     * `app.provisionUser()`.
     */
    async connectViaOAuth(user: { address: string; password: string }) {
        await this.fillAddress(user.address);
        await Promise.all([this.page.waitForURL(/\/oauth\//, { timeout: 15_000 }), this.connectButton.click()]);
        await this.page.locator('input[name="password"]').fill(user.password);
        await Promise.all([
            this.page.waitForURL((u) => u.toString().includes("#access_token="), { timeout: 15_000 }),
            this.page.locator('button[name="allow"]').click(),
        ]);
    }

    recentAccountByAddress(address: string): Locator {
        return this.page.locator(".recent-account").filter({
            has: this.page.getByText(address, { exact: true }),
        });
    }

    async forgetAccount(address: string) {
        await this.recentAccountByAddress(address).getByRole("button", { name: "Forget account" }).click();
        // Forgetting now asks via the in-app confirm modal (#67).
        const modal = this.page.locator(".confirm-backdrop .modal");
        await modal.getByRole("button", { name: "Forget" }).click();
        await modal.waitFor({ state: "hidden" });
    }
}
