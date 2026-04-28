import { test as base } from "@playwright/test";
import {
    ARMADIETTO_BASE,
    provisionedUser,
    type provisionedUser as provisionedUserFn,
    waitForArmadietto,
} from "./armadietto";

/**
 * Real-backend e2e fixture. Boots against a running armadietto container
 * (see docker-compose.yml at repo root) and exercises the full real
 * remoteStorage stack — webfinger discovery, OAuth, sync. Slower than the
 * fake-repo suite under tests/e2e/, but catches behavior that only shows
 * up against real rs.js + a real RS server (the user-reported swap and
 * refresh symptoms among them).
 *
 * Localhost discovery works because `src/lib/remotestorage.js` swaps in a
 * custom `RemoteStorage.Discover` implementation that bypasses
 * webfinger.js v3's SSRF protection (which blocks all private/loopback
 * lookups by default). Without that swap, every test pointed at the
 * armadietto container would fail with `DiscoveryError` before the OAuth
 * step. See the comment block at the top of remotestorage.js for the full
 * rationale and the upstream tracking link.
 */
export type RealAppContext = {
    /** Provision a fresh user (signup + token in one call). */
    provisionUser: typeof provisionedUserFn;
    /**
     * Pre-seed the known-accounts registry with a user + token so the app
     * cold-boots already connected. Skips the OAuth popup entirely while
     * still using real rs.js + real armadietto.
     */
    seedConnectedAccount: (user: Awaited<ReturnType<typeof provisionedUserFn>>) => Promise<void>;
    /**
     * Add a user to the known-accounts registry without making them the
     * cold-boot active session. Use to populate the TopBar Switch-to list
     * before exercising a swap. Discovery on the swap target is handled
     * by the custom Discover in src/lib/remotestorage.js.
     */
    seedAdditionalAccount: (user: Awaited<ReturnType<typeof provisionedUserFn>>) => Promise<void>;
    /** Navigate to "/" — assumes you've called seedConnectedAccount or
     * intend to drive the connect flow manually. */
    goto: (path?: string) => Promise<void>;
    /** Wait for the app shell to render (post-sync). */
    waitForReady: () => Promise<void>;
    /**
     * Wait for the store to settle into syncState === "synced" — that's
     * the public signal the store flips after the first round completes
     * with no pending body fetches and no in-flight reloads. Use before
     * asserting catalog contents or driving Roll, so the test doesn't
     * race the post-connect onChange burst.
     */
    waitForSynced: (timeoutMs?: number) => Promise<void>;
    /** Read a snapshot of the live store for assertions. */
    getStoreState: () => Promise<{
        connectionStatus: string;
        syncState: string;
        initialSyncComplete: boolean;
        connectAddress: string;
        songs: { id: string; name: string }[];
        appConfig: { bandName?: string } | null;
        generatedSetlist: { songs?: { id: string; name: string }[] } | null;
    } | null>;
};

export const test = base.extend<{ app: RealAppContext }>({
    app: async ({ page }, use) => {
        // One-time wait for armadietto. If the user hasn't run docker
        // compose up the test will fail loudly here rather than time out
        // at the first signup.
        await waitForArmadietto();

        // Flip on the test-mode flag the app reads at startup to expose
        // its internal store on `window.__SR_STORE__`. The real backend
        // path otherwise wouldn't trip the flag (only the fake-repo
        // factory does), and tests need the store handle for assertions
        // and direct callStore() driving.
        await page.addInitScript(() => {
            (window as unknown as { __SR_TEST__?: boolean }).__SR_TEST__ = true;
        });
        // Optional rs.js verbose logging — set SR_RS_DEBUG=1 in the env to
        // tee internal log lines (Discover, Sync, WireClient, ...) to the
        // browser console so they show up in test output. Useful when a
        // real-backend test starts misbehaving in an unfamiliar way.
        if (process.env.SR_RS_DEBUG === "1") {
            await page.addInitScript(() => {
                try {
                    localStorage.setItem("__SR_RS_DEBUG__", "1");
                } catch {
                    /* ignore */
                }
            });
        }

        let hasNavigated = false;

        const ctx: RealAppContext = {
            async provisionUser(prefix = "u") {
                return provisionedUser(prefix);
            },
            async seedConnectedAccount(user) {
                // Inject the known-accounts entry + the rs.js session keys
                // so the app boots in the connected-as-user state. rs.js
                // reads its session from localStorage at construction time,
                // so we have to write before navigating.
                const knownAccountsKey = "setlist-roller-known-accounts";
                const entry = {
                    address: user.address,
                    metadata: { bandName: "" },
                    token: user.token,
                    lastUsed: new Date().toISOString(),
                };
                await page.addInitScript(
                    ({ knownAccountsKey, entry, address, token, base }) => {
                        try {
                            localStorage.setItem(knownAccountsKey, JSON.stringify([entry]));
                            // rs.js's WireClient reads its session from a
                            // single key on construction (see
                            // node_modules/remotestoragejs/src/wireclient.ts:298).
                            // href + token is the minimum needed to flip
                            // `connected = true` and emit "connected" on
                            // the next microtask. storageApi pins the
                            // protocol version so rs.js doesn't need to
                            // re-discover it from webfinger; matching the
                            // string armadietto returns avoids a SyncError
                            // on the first request.
                            const wireSettings = {
                                userAddress: address,
                                href: `${base}/storage/${address.split("@")[0]}`,
                                storageApi: "draft-dejong-remotestorage-10",
                                token,
                                properties: {},
                            };
                            localStorage.setItem("remotestorage:wireclient", JSON.stringify(wireSettings));
                            // backend selector — without this rs.js will
                            // pick the default but log a warning. Pinning
                            // to "remotestorage" is a no-op match.
                            localStorage.setItem("remotestorage:backend", "remotestorage");
                        } catch (e) {
                            console.error("seedConnectedAccount init script failed", e);
                        }
                    },
                    {
                        knownAccountsKey,
                        entry,
                        address: user.address,
                        token: user.token,
                        base: ARMADIETTO_BASE,
                    },
                );
            },
            async seedAdditionalAccount(user) {
                // Append a second user to the known-accounts list. The
                // post-swap discovery against this user is exercised
                // through the custom Discover override in
                // src/lib/remotestorage.js — see that file's header for
                // the localhost/private-address rationale.
                await page.addInitScript(
                    ({ knownAccountsKey, address, token }) => {
                        try {
                            const raw = localStorage.getItem(knownAccountsKey);
                            const list = raw ? JSON.parse(raw) : [];
                            if (!list.find((a: { address: string }) => a.address === address)) {
                                list.push({
                                    address,
                                    metadata: { bandName: "" },
                                    token,
                                    lastUsed: new Date().toISOString(),
                                });
                                localStorage.setItem(knownAccountsKey, JSON.stringify(list));
                            }
                        } catch (e) {
                            console.error("seedAdditionalAccount init script failed", e);
                        }
                    },
                    {
                        knownAccountsKey: "setlist-roller-known-accounts",
                        address: user.address,
                        token: user.token,
                    },
                );
            },
            async goto(path = "/") {
                await page.goto(path);
                hasNavigated = true;
            },
            async waitForReady() {
                if (!hasNavigated) {
                    await page.goto("/");
                    hasNavigated = true;
                }
                await page.locator("nav.bottom-nav").waitFor({ state: "visible", timeout: 30_000 });
            },
            async waitForSynced(timeoutMs = 30_000) {
                // The store flips syncState → "synced" after a settle
                // window once reloadInFlight === 0, pendingBodies === 0,
                // and at least one full sync round has fired sync-done.
                // That's the public signal we want — gates everything
                // that asserts on catalog contents or drives Roll.
                await page.waitForFunction(
                    () => {
                        const s = (window as unknown as { __SR_STORE__?: { syncState?: string } }).__SR_STORE__;
                        return s?.syncState === "synced";
                    },
                    null,
                    { timeout: timeoutMs },
                );
            },
            async getStoreState() {
                return page.evaluate(() => {
                    const s = (window as unknown as { __SR_STORE__?: Record<string, unknown> }).__SR_STORE__;
                    if (!s) return null;
                    return {
                        connectionStatus: s.connectionStatus as string,
                        syncState: s.syncState as string,
                        initialSyncComplete: s.initialSyncComplete as boolean,
                        connectAddress: s.connectAddress as string,
                        songs: JSON.parse(JSON.stringify(s.songs)) as { id: string; name: string }[],
                        appConfig: s.appConfig
                            ? (JSON.parse(JSON.stringify(s.appConfig)) as { bandName?: string })
                            : null,
                        generatedSetlist: s.generatedSetlist
                            ? (JSON.parse(JSON.stringify(s.generatedSetlist)) as {
                                  songs?: { id: string; name: string }[];
                              })
                            : null,
                    };
                });
            },
        };

        await use(ctx);
    },
});

export const expect = test.expect;
