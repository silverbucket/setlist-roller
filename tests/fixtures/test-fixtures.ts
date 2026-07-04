import { test as base, type Page } from "@playwright/test";
import {
    ARMADIETTO_BASE,
    provisionedUser,
    seedRemoteBootstrap,
    seedRemoteConfig,
    seedRemoteMembers,
    seedRemoteSetlists,
    seedRemoteSongs,
    waitForArmadietto,
} from "./armadietto";

/**
 * E2E fixture. Boots against a running armadietto container (see
 * docker-compose.yml at the repo root) — no fake repo. Every test in
 * tests/e2e/ exercises the real rs.js + real OAuth + real sync stack
 * against a real RS server, so behavior that only shows up against
 * real machinery (session persistence, cache reset on swap,
 * DiscoveryError paths, the user-reported swap regression) is covered.
 *
 * Localhost discovery works because src/lib/remotestorage.js swaps in a
 * custom RemoteStorage.Discover that bypasses webfinger.js v3's
 * private-address protection. Without that swap every test pointed at
 * the armadietto container would fail with DiscoveryError before the
 * OAuth step. See the comment block at the top of remotestorage.js for
 * the full rationale and the upstream tracking link.
 *
 * Test isolation: each `app.seed()` call provisions a fresh random
 * user via armadietto's signup endpoint, so test runs don't collide
 * even when armadietto's data volume is reused across reruns. Tests
 * that omit `app.seed()` (or pass a spec without `autoConnectAs`)
 * cold-boot into the connect screen.
 */

/**
 * Loose row shapes the spec files use to build seed data. Kept open
 * with `[key: string]: unknown` because tests routinely seed partial /
 * extended shapes (anxiety summaries, instrument lists, etc.) without
 * wanting the full app types.
 */
export type SeedSong = { id: string; name?: string; [key: string]: unknown };
export type SeedSetlist = { id: string; name?: string; [key: string]: unknown };
export type SeedMember = { name: string; [key: string]: unknown };

/**
 * Shape of the snapshot we read out of the running store via `getState()`.
 * The fields below are JSON-cloned from the live `$state` runes, so
 * anything we want to assert against has to be listed here.
 */
export type AppStateSnapshot = {
    connectionStatus: string;
    activeView: string;
    syncState: string;
    initialSyncDone: boolean;
    currentUserAddress: string;
    songs: { id: string; name: string; [key: string]: unknown }[];
    savedSetlists: unknown[];
    bandMembers: Record<string, unknown>;
    appConfig: Record<string, unknown> | null;
    generatedSetlist: Record<string, unknown> | null;
    setlistLocked: boolean;
    setlistSaved: boolean;
    showFirstRunPrompt: boolean;
    toastMessages: unknown[];
};

/**
 * The seeded-state shape tests pass to `app.seed()`. Same shape as the
 * old fake-repo `FakeRepoSeed` so the spec-file body is unchanged
 * across the migration.
 */
export type AppSeed = {
    /**
     * Truthy ⇒ provision a user and cold-boot connected as them. The
     * actual address used is a freshly-provisioned random one — the
     * value here is treated as a boolean trigger because real users
     * have to be signup'd against armadietto. Tests that need to
     * assert on the connected address should read it from `getState`.
     * Falsy / omitted ⇒ cold-boot to the connect screen.
     */
    autoConnectAs?: string;
    songs?: Record<string, Record<string, unknown>>;
    setlists?: Record<string, Record<string, unknown>>;
    members?: Record<string, Record<string, unknown>>;
    config?: Record<string, unknown>;
    bootstrap?: Record<string, unknown>;
    /**
     * Per-user seed buckets — kept for source-compat with the small
     * number of tests that use it. Tests can supply data for multiple
     * users when exercising swap flows; each bucket is provisioned
     * + seeded as a separate armadietto user.
     */
    users?: Record<string, Omit<AppSeed, "users" | "autoConnectAs">>;
};

export type SeededUsers = {
    /** The auto-connect user, when the seed sets `autoConnectAs` or carries top-level data. Null on cold-boot specs. */
    primary: Awaited<ReturnType<typeof provisionedUser>> | null;
    /** Per-user buckets keyed by the same key the seed used. Tests that exercise swap flows pull addresses out of here. */
    users: Record<string, Awaited<ReturnType<typeof provisionedUser>>>;
};

export type AppContext = {
    /**
     * Provision a user (when autoConnectAs is set) and PUT the seeded
     * data to armadietto BEFORE the app boots. Must be called before
     * goto(). Calling goto() without a prior seed cold-boots the app
     * onto the connect screen. Returns the provisioned user records
     * so tests that need addresses or tokens can read them — most
     * tests ignore the return.
     */
    seed: (seed: AppSeed) => Promise<SeededUsers>;
    /**
     * Stage rs.js session keys for an already-provisioned user so the
     * page cold-boots connected as them. Lower-level than `seed()` —
     * use when the test owns user provisioning (e.g. swap suites that
     * need both users' addresses up front).
     */
    seedConnectedAccount: (user: Awaited<ReturnType<typeof provisionedUser>>) => Promise<void>;
    /** Navigate to "/" with whatever seed was last applied. */
    goto: (path?: string) => Promise<void>;
    /**
     * Wait until the app shell is rendered. For seeded tests this is
     * the canonical "we are in the app" gate; for cold-boot tests
     * don't call this (the connect screen never renders bottom-nav).
     */
    waitForReady: () => Promise<void>;
    /**
     * Wait until sync has settled: either the transient "synced"
     * confirmation is showing, or the account's initial sync has
     * completed and the state has already faded back to "idle" (a
     * background re-sync with no changes never re-flips to "synced").
     * Use before asserting catalog contents so the test doesn't race
     * the post-connect change-event burst.
     */
    waitForSynced: (timeoutMs?: number) => Promise<void>;
    /** Read the current store state out of the running app. */
    getState: () => Promise<AppStateSnapshot | null>;
    /** Drive the store directly — useful for setup that bypasses the UI. */
    callStore: <T = unknown>(name: string, ...args: unknown[]) => Promise<T>;
    /**
     * Stage an additional account in the known-accounts registry.
     * Used by swap tests that need a Switch-to entry available in the
     * TopBar dropdown without going through the Add Account flow.
     */
    seedAdditionalAccount: (user: Awaited<ReturnType<typeof provisionedUser>>) => Promise<void>;
    /**
     * Provision a fresh real user against armadietto and return its
     * signup credentials + OAuth token. Lower-level escape hatch for
     * tests that need direct control over the user lifecycle (e.g. the
     * swap suite).
     */
    provisionUser: (prefix?: string) => Promise<Awaited<ReturnType<typeof provisionedUser>>>;
};

/**
 * Provision a user, seed all the user's data, and wire up the rs.js
 * session-storage keys so the app cold-boots connected. Returns the
 * provisioned user record (including address + token) so the caller
 * can use it for follow-up assertions or swap tests.
 */
async function provisionAndSeed(
    bucket: { songs?: object; setlists?: object; members?: object; config?: object; bootstrap?: object },
    prefix = "u",
) {
    const user = await provisionedUser(prefix);
    const tasks: Promise<unknown>[] = [];
    if (bucket.songs && Object.keys(bucket.songs).length > 0) {
        tasks.push(seedRemoteSongs(user, bucket.songs as Record<string, Record<string, unknown>>));
    }
    if (bucket.setlists && Object.keys(bucket.setlists).length > 0) {
        tasks.push(seedRemoteSetlists(user, bucket.setlists as Record<string, Record<string, unknown>>));
    }
    if (bucket.members && Object.keys(bucket.members).length > 0) {
        tasks.push(seedRemoteMembers(user, bucket.members as Record<string, Record<string, unknown>>));
    }
    if (bucket.config) {
        tasks.push(seedRemoteConfig(user, (bucket.config as { bandName?: string }).bandName ?? "Test Band"));
    }
    if (bucket.bootstrap) {
        tasks.push(seedRemoteBootstrap(user, bucket.bootstrap as Record<string, unknown>));
    }
    await Promise.all(tasks);
    return user;
}

export const test = base.extend<{ app: AppContext }>({
    app: async ({ page }, use) => {
        // One-time wait for armadietto. If the user hasn't run
        // `npm run armadietto:up` the test fails loudly here instead of
        // timing out at the first signup.
        await waitForArmadietto();

        // Flip on the test-mode flag the app reads at startup to
        // expose its internal store on `window.__SR_STORE__`. Tests
        // need the store handle for state assertions and direct
        // callStore() driving.
        await page.addInitScript(() => {
            (window as unknown as { __SR_TEST__?: boolean }).__SR_TEST__ = true;
        });

        // Optional rs.js verbose logging — set SR_RS_DEBUG=1 in the env
        // to tee internal log lines (Discover, Sync, WireClient, ...) to
        // the browser console so they show up in test output. Useful
        // when a test starts misbehaving in an unfamiliar way.
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

        const ctx: AppContext = {
            async seed(seed: AppSeed) {
                // Per-user seeding. The default path (top-level
                // songs/setlists/members on the seed) goes into the
                // auto-connected user's bucket. The `users` map lets
                // swap tests provision multiple users in one call.
                const userBuckets = seed.users ?? {};
                const wantAutoConnect = !!seed.autoConnectAs;
                const topLevelHasData =
                    !!seed.songs || !!seed.setlists || !!seed.members || !!seed.config || !!seed.bootstrap;

                // Provision and seed the auto-connect user, if any.
                let primaryUser: Awaited<ReturnType<typeof provisionedUser>> | null = null;
                if (wantAutoConnect || topLevelHasData) {
                    primaryUser = await provisionAndSeed(
                        {
                            songs: seed.songs,
                            setlists: seed.setlists,
                            members: seed.members,
                            config: seed.config,
                            bootstrap: seed.bootstrap,
                        },
                        "primary",
                    );
                }

                // Provision + seed each named secondary user.
                const secondaryByKey: Record<string, Awaited<ReturnType<typeof provisionedUser>>> = {};
                for (const [key, bucket] of Object.entries(userBuckets)) {
                    const u = await provisionAndSeed(bucket, key.replace(/[^a-z0-9]/gi, "").slice(0, 6) || "sec");
                    secondaryByKey[key] = u;
                }

                if (!primaryUser && wantAutoConnect) {
                    // autoConnectAs was set but no top-level data and
                    // no users — provision an empty primary so the
                    // auto-connect actually happens.
                    primaryUser = await provisionedUser("primary");
                }

                // Stage rs.js's session keys so the page cold-boots
                // connected as the primary user. Secondaries land in
                // the known-accounts registry only — visible in the
                // TopBar Switch-to list, not auto-connected.
                const secondaries = Object.values(secondaryByKey);
                if (primaryUser) {
                    await stageSession(page, primaryUser, secondaries);
                } else if (secondaries.length > 0) {
                    // No primary, but secondaries exist — write only
                    // known-accounts so the connect screen shows them
                    // in Recent. Tests that drive Recent-click flows
                    // hit this path.
                    await stageKnownAccountsOnly(page, secondaries);
                }

                return { primary: primaryUser, users: secondaryByKey };
            },
            async seedConnectedAccount(user) {
                await stageSession(page, user, []);
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
                await page.waitForFunction(
                    () => {
                        const s = (
                            window as unknown as { __SR_STORE__?: { syncState?: string; initialSyncDone?: boolean } }
                        ).__SR_STORE__;
                        return s?.syncState === "synced" || (s?.initialSyncDone === true && s?.syncState === "idle");
                    },
                    null,
                    { timeout: timeoutMs },
                );
            },
            async getState() {
                return page.evaluate(() => {
                    const s = (window as unknown as { __SR_STORE__?: Record<string, unknown> }).__SR_STORE__;
                    if (!s) return null;
                    return {
                        connectionStatus: s.connectionStatus as string,
                        activeView: s.activeView as string,
                        syncState: s.syncState as string,
                        initialSyncDone: s.initialSyncDone as boolean,
                        currentUserAddress: s.currentUserAddress as string,
                        songs: JSON.parse(JSON.stringify(s.songs)),
                        savedSetlists: JSON.parse(JSON.stringify(s.savedSetlists)),
                        bandMembers: JSON.parse(JSON.stringify(s.bandMembers)),
                        appConfig: JSON.parse(JSON.stringify(s.appConfig || null)),
                        generatedSetlist: s.generatedSetlist ? JSON.parse(JSON.stringify(s.generatedSetlist)) : null,
                        setlistLocked: s.setlistLocked as boolean,
                        setlistSaved: s.setlistSaved as boolean,
                        showFirstRunPrompt: s.showFirstRunPrompt as boolean,
                        toastMessages: JSON.parse(JSON.stringify(s.toastMessages)),
                    };
                });
            },
            async callStore<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
                return page.evaluate(
                    ({ name, args }) => {
                        const s = (window as unknown as { __SR_STORE__?: Record<string, unknown> }).__SR_STORE__;
                        if (!s) throw new Error("Store not available");
                        const fn = s[name];
                        if (typeof fn !== "function") throw new Error(`Store has no method '${name}'`);
                        return (fn as (...a: unknown[]) => unknown).call(s, ...args);
                    },
                    { name, args },
                ) as Promise<T>;
            },
            async seedAdditionalAccount(user) {
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
            async provisionUser(prefix = "u") {
                return provisionedUser(prefix);
            },
        };

        await use(ctx);
    },
});

/** Inject the rs.js wireclient session + known-accounts entries before navigation. */
async function stageSession(
    page: Page,
    primary: Awaited<ReturnType<typeof provisionedUser>>,
    secondaries: Awaited<ReturnType<typeof provisionedUser>>[],
): Promise<void> {
    const knownAccountsKey = "setlist-roller-known-accounts";
    const lastUsed = new Date().toISOString();
    const accounts = [
        { address: primary.address, metadata: { bandName: "" }, token: primary.token, lastUsed },
        ...secondaries.map((u) => ({
            address: u.address,
            metadata: { bandName: "" },
            token: u.token,
            lastUsed,
        })),
    ];
    await page.addInitScript(
        ({
            knownAccountsKey,
            accounts,
            primary,
            base,
        }: {
            knownAccountsKey: string;
            accounts: unknown[];
            primary: { address: string; token: string };
            base: string;
        }) => {
            try {
                localStorage.setItem(knownAccountsKey, JSON.stringify(accounts));
                // rs.js's WireClient reads its session from a single
                // key on construction (node_modules/remotestoragejs/src/wireclient.ts:298).
                // href + token is the minimum needed to flip
                // `connected = true` and emit "connected" on the next
                // microtask. storageApi pins the protocol version so
                // rs.js doesn't need to re-discover it from webfinger;
                // matching the string armadietto returns avoids a
                // SyncError on the first request.
                const wireSettings = {
                    userAddress: primary.address,
                    href: `${base}/storage/${primary.address.split("@")[0]}`,
                    storageApi: "draft-dejong-remotestorage-10",
                    token: primary.token,
                    properties: {},
                };
                localStorage.setItem("remotestorage:wireclient", JSON.stringify(wireSettings));
                // backend selector — without this rs.js picks the
                // default but logs a warning. Pinning to "remotestorage"
                // is a no-op match.
                localStorage.setItem("remotestorage:backend", "remotestorage");
            } catch (e) {
                console.error("stageSession init script failed", e);
            }
        },
        { knownAccountsKey, accounts, primary, base: ARMADIETTO_BASE },
    );
}

/** Write only the known-accounts list — for tests that drive Recent-click flows. */
async function stageKnownAccountsOnly(page: Page, users: Awaited<ReturnType<typeof provisionedUser>>[]): Promise<void> {
    const knownAccountsKey = "setlist-roller-known-accounts";
    const lastUsed = new Date().toISOString();
    const accounts = users.map((u) => ({
        address: u.address,
        metadata: { bandName: "" },
        token: u.token,
        lastUsed,
    }));
    await page.addInitScript(
        ({ knownAccountsKey, accounts }: { knownAccountsKey: string; accounts: unknown[] }) => {
            try {
                localStorage.setItem(knownAccountsKey, JSON.stringify(accounts));
            } catch (e) {
                console.error("stageKnownAccountsOnly init script failed", e);
            }
        },
        { knownAccountsKey, accounts },
    );
}

export const expect = test.expect;

/**
 * Convenience builder for a fully-formed seeded "user" with a band,
 * members and songs. Same shape as the old fake-repo `buildSeed` so
 * spec files migrate without touching the seed-construction code.
 */
export function buildSeed(overrides: Partial<AppSeed> = {}): AppSeed {
    const baseConfig = {
        bandName: "Test Band",
        schemaVersion: 2,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        ui: { dieColor: null },
        general: {
            count: 9,
            beamWidth: 512,
            limits: { covers: -1, instrumentals: -1 },
            order: {
                first: [
                    ["notGoodOpener", false],
                    ["cover", false],
                    ["instrumental", false],
                ],
                second: [
                    ["cover", false],
                    ["instrumental", false],
                ],
                penultimate: [],
                last: [["notGoodCloser", false]],
            },
            weighting: {
                tuning: 4,
                capo: 2,
                instrument: 3,
                technique: 1,
                keyFlow: 2,
                positionMiss: 8,
                earlyCover: 2,
                earlyInstrumental: 2,
            },
            randomness: {
                variantJitter: 1.5,
                stateJitter: 1,
                finalChoicePool: 12,
                temperature: 0.85,
                shuffleCatalog: true,
                songBias: 3,
                beamChoicePoolMultiplier: 6,
                beamTemperature: 1.1,
                maxStatesPerLastSong: 24,
                blockShuffleTemperature: 1.4,
            },
        },
        show: {},
        props: {
            tuning: { kind: "instrumentField", field: "tuning", minStreak: 2, allowChangeOnLastSong: true },
            capo: { kind: "instrumentDelta", field: "capo", minStreak: 2, allowChangeOnLastSong: true },
            instruments: {
                kind: "instrumentSet",
                weightKey: "instrument",
                minStreak: 2,
                allowChangeOnLastSong: true,
            },
            picking: {
                kind: "instrumentField",
                field: "picking",
                weightKey: "technique",
                minStreak: 1,
                allowChangeOnLastSong: true,
            },
        },
    };

    return {
        autoConnectAs: "test@example.com",
        config: baseConfig,
        bootstrap: { schemaVersion: 2, createdAt: "2024-01-01T00:00:00.000Z" },
        songs: {},
        setlists: {},
        members: {},
        ...overrides,
    };
}

let songCounter = 0;
export function makeSong(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    songCounter += 1;
    const id = (overrides.id as string | undefined) || `song-${songCounter}`;
    const name = (overrides.name as string | undefined) || `Song ${songCounter}`;
    return {
        id,
        name,
        cover: false,
        instrumental: false,
        notGoodOpener: false,
        notGoodCloser: false,
        unpracticed: false,
        key: "",
        notes: "",
        schemaVersion: 2,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        members: {},
        ...overrides,
    };
}

export function makeMember(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        name,
        instruments: [],
        defaultInstrument: "",
        updatedAt: "2024-01-01T00:00:00.000Z",
        ...overrides,
    };
}
