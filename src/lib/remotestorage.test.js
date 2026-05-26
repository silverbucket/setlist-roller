import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const remoteStorageMockState = vi.hoisted(() => ({
    instance: null,
    client: null,
    defaultAuthorize: null,
}));

// Mock the rs.js default export. The constructor returns whatever the
// per-test beforeEach put in `instance`. The constructor function ITSELF
// is what `import RemoteStorage from "remotestoragejs"` resolves to —
// that's also where our custom Discover override lands, so the override
// is observable through this same mock function.
vi.mock("remotestoragejs", () => ({
    default: vi.fn(() => remoteStorageMockState.instance),
}));

import RemoteStorage from "remotestoragejs";
import {
    authorizeWithStandalonePopup,
    buildAuthorizeUrl,
    createRemoteStorageRepository,
    createStandaloneAuthMessageHandler,
    isIosStandaloneAuthContext,
    normalizeStandaloneAuthorizeOptions,
} from "./remotestorage.js";

let originalWindow;

beforeEach(() => {
    const defaultAuthorize = vi.fn();
    // The client is exposed as a stable singleton on the mock state so tests
    // can stub `getAll` / `getObject` / etc. without having to fish the
    // returned object out of `scope.mock.results`. The repository only calls
    // `scope()` once per construction, so a singleton matches real usage.
    const client = {
        declareType: vi.fn(),
        on: vi.fn(),
        removeEventListener: vi.fn(),
        getAll: vi.fn(),
        getObject: vi.fn(),
        storeObject: vi.fn(),
        remove: vi.fn(),
    };
    const remoteStorage = {
        access: {
            claim: vi.fn(),
            setStorageType: vi.fn(),
            scopeParameter: "setlist-roller:rw",
        },
        caching: {
            enable: vi.fn(),
            reset: vi.fn(),
        },
        scope: vi.fn(() => client),
        remote: {
            storageApi: "webdav",
            configure: vi.fn(),
            connected: false,
            userAddress: "",
            token: "",
        },
        authorize: defaultAuthorize,
        on: vi.fn(),
        removeEventListener: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
        startSync: vi.fn(),
        connected: false,
    };

    remoteStorageMockState.instance = remoteStorage;
    remoteStorageMockState.client = client;
    remoteStorageMockState.defaultAuthorize = defaultAuthorize;
    originalWindow = globalThis.window;
});

afterEach(() => {
    vi.restoreAllMocks();
    remoteStorageMockState.instance = null;
    remoteStorageMockState.client = null;
    remoteStorageMockState.defaultAuthorize = null;
    if (typeof originalWindow === "undefined") {
        delete globalThis.window;
    } else {
        globalThis.window = originalWindow;
    }
});

describe("isIosStandaloneAuthContext", () => {
    it("returns false without a browser-like environment", () => {
        expect(isIosStandaloneAuthContext(undefined)).toBe(false);
    });

    it("returns false when not running in standalone mode", () => {
        const env = {
            matchMedia: () => ({ matches: false }),
            navigator: {
                standalone: false,
                userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
                platform: "iPhone",
                maxTouchPoints: 5,
            },
        };
        expect(isIosStandaloneAuthContext(env)).toBe(false);
    });

    it("detects iPhone standalone mode", () => {
        const env = {
            matchMedia: () => ({ matches: true }),
            navigator: {
                standalone: false,
                userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
                platform: "iPhone",
                maxTouchPoints: 5,
            },
        };
        expect(isIosStandaloneAuthContext(env)).toBe(true);
    });

    it("detects iPad-style standalone mode on MacIntel touch devices", () => {
        const env = {
            matchMedia: () => ({ matches: false }),
            navigator: {
                standalone: true,
                userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)",
                platform: "MacIntel",
                maxTouchPoints: 5,
            },
        };
        expect(isIosStandaloneAuthContext(env)).toBe(true);
    });
});

describe("buildAuthorizeUrl", () => {
    it("derives state from the redirect hash and strips it from redirect_uri", () => {
        const url = new URL(
            buildAuthorizeUrl({
                authURL: "https://auth.example.com/oauth",
                redirectUri: "https://app.example.com/#/songs",
                clientId: "https://app.example.com",
                scope: "setlist-roller:rw",
            }),
        );

        expect(url.searchParams.get("state")).toBe("/songs");
        expect(url.searchParams.get("redirect_uri")).toBe("https://app.example.com/");
        expect(url.searchParams.get("response_type")).toBe("token");
        expect(url.searchParams.get("scope")).toBe("setlist-roller:rw");
    });

    it("includes explicit OAuth options when provided", () => {
        const url = new URL(
            buildAuthorizeUrl({
                authURL: "https://auth.example.com/oauth",
                redirectUri: "https://app.example.com/auth-relay.html",
                clientId: "https://app.example.com",
                scope: "setlist-roller:rw",
                response_type: "code",
                state: "attempt-123",
                code_challenge: "challenge",
                code_challenge_method: "S256",
                token_access_type: "offline",
            }),
        );

        expect(url.searchParams.get("response_type")).toBe("code");
        expect(url.searchParams.get("state")).toBe("attempt-123");
        expect(url.searchParams.get("code_challenge")).toBe("challenge");
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        expect(url.searchParams.get("token_access_type")).toBe("offline");
    });
});

describe("normalizeStandaloneAuthorizeOptions", () => {
    it("fills in redirectUri and clientId from the current location", () => {
        const options = normalizeStandaloneAuthorizeOptions(
            { authURL: "https://auth.example.com/oauth", scope: "setlist-roller:rw" },
            {
                location: {
                    origin: "https://app.example.com",
                    pathname: "/app",
                },
            },
        );

        expect(options.redirectUri).toBe("https://app.example.com/app");
        expect(options.clientId).toBe("https://app.example.com");
        expect(options.scope).toBe("setlist-roller:rw");
    });

    it("preserves a trailing slash when the current pathname is root", () => {
        const options = normalizeStandaloneAuthorizeOptions(
            { authURL: "https://auth.example.com/oauth", scope: "setlist-roller:rw" },
            {
                location: {
                    origin: "https://app.example.com",
                    pathname: "/",
                },
            },
        );

        expect(options.redirectUri).toBe("https://app.example.com/");
        expect(options.clientId).toBe("https://app.example.com");
    });

    it("rejects empty or non-string scopes", () => {
        expect(() =>
            normalizeStandaloneAuthorizeOptions(
                { authURL: "https://auth.example.com/oauth", scope: "" },
                {
                    location: {
                        origin: "https://app.example.com",
                        pathname: "/",
                    },
                },
            ),
        ).toThrow("undefined or empty scope");

        expect(() =>
            normalizeStandaloneAuthorizeOptions(
                { authURL: "https://auth.example.com/oauth", scope: null },
                {
                    location: {
                        origin: "https://app.example.com",
                        pathname: "/",
                    },
                },
            ),
        ).toThrow("undefined or empty scope");
    });
});

describe("createStandaloneAuthMessageHandler", () => {
    it("ignores unrelated messages", () => {
        const onSuccess = vi.fn();
        const onError = vi.fn();
        const handler = createStandaloneAuthMessageHandler({
            attemptId: "attempt-1",
            origin: "https://app.example.com",
            onSuccess,
            onError,
        });

        expect(
            handler({
                origin: "https://elsewhere.example.com",
                data: {},
            }),
        ).toBe(false);
        expect(
            handler({
                origin: "https://app.example.com",
                data: { type: "wrong-type", attemptId: "attempt-1" },
            }),
        ).toBe(false);
        expect(
            handler({
                origin: "https://app.example.com",
                data: { type: "setlist-roller-auth-result", attemptId: "attempt-2" },
            }),
        ).toBe(false);
        expect(onSuccess).not.toHaveBeenCalled();
        expect(onError).not.toHaveBeenCalled();
    });

    it("passes successful auth results through", () => {
        const onSuccess = vi.fn();
        const onError = vi.fn();
        const handler = createStandaloneAuthMessageHandler({
            attemptId: "attempt-1",
            origin: "https://app.example.com",
            onSuccess,
            onError,
        });

        expect(
            handler({
                origin: "https://app.example.com",
                data: {
                    type: "setlist-roller-auth-result",
                    attemptId: "attempt-1",
                    params: {
                        access_token: "token-123",
                        state: "/roll",
                    },
                },
            }),
        ).toBe(true);

        expect(onSuccess).toHaveBeenCalledWith({
            accessToken: "token-123",
            state: "/roll",
        });
        expect(onError).not.toHaveBeenCalled();
    });

    it("surfaces auth errors and missing tokens", () => {
        const onSuccess = vi.fn();
        const onError = vi.fn();
        const handler = createStandaloneAuthMessageHandler({
            attemptId: "attempt-1",
            origin: "https://app.example.com",
            onSuccess,
            onError,
        });

        handler({
            origin: "https://app.example.com",
            data: {
                type: "setlist-roller-auth-result",
                attemptId: "attempt-1",
                params: { error: "access_denied" },
            },
        });
        handler({
            origin: "https://app.example.com",
            data: {
                type: "setlist-roller-auth-result",
                attemptId: "attempt-1",
                params: {},
            },
        });

        expect(onSuccess).not.toHaveBeenCalled();
        expect(onError.mock.calls[0][0].message).toContain("access_denied");
        expect(onError.mock.calls[1][0].message).toContain("did not return an access token");
    });
});

describe("authorizeWithStandalonePopup", () => {
    it("configures the token and updates the hash when the relay responds", () => {
        const configure = vi.fn();
        const handlers = new Map();
        const clearInterval = vi.fn();
        const clearTimeout = vi.fn();
        let timeoutCallback;
        const env = {
            location: {
                origin: "https://app.example.com",
                hash: "",
            },
            open: vi.fn(() => ({ closed: false })),
            addEventListener: vi.fn((eventName, handler) => handlers.set(eventName, handler)),
            removeEventListener: vi.fn((eventName) => handlers.delete(eventName)),
            setInterval: vi.fn(() => 1),
            clearInterval,
            setTimeout: vi.fn((callback) => {
                timeoutCallback = callback;
                return 2;
            }),
            clearTimeout,
        };

        authorizeWithStandalonePopup(
            { remote: { configure } },
            {
                authURL: "https://auth.example.com/oauth",
                redirectUri: "https://app.example.com",
                clientId: "https://app.example.com",
                scope: "setlist-roller:rw",
            },
            {
                env,
                emitError: vi.fn(),
            },
        );

        const authUrl = env.open.mock.calls[0][0];
        const redirectUri = new URL(authUrl).searchParams.get("redirect_uri");
        const attemptId = new URL(redirectUri).searchParams.get("attempt");
        handlers.get("message")({
            origin: "https://app.example.com",
            data: {
                type: "setlist-roller-auth-result",
                attemptId,
                params: {
                    access_token: "token-123",
                    state: "/saved",
                },
            },
        });

        expect(configure).toHaveBeenCalledWith({ token: "token-123" });
        expect(env.location.hash).toBe("/saved");
        expect(timeoutCallback).toBeTypeOf("function");
        expect(clearInterval).toHaveBeenCalledWith(1);
        expect(clearTimeout).toHaveBeenCalledWith(2);
    });
});

describe("createRemoteStorageRepository", () => {
    it("delegates standalone auth to the library redirect flow with the app URL", () => {
        globalThis.window = {
            matchMedia: vi.fn(() => ({ matches: true })),
            navigator: {
                standalone: true,
                userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
                platform: "iPhone",
                maxTouchPoints: 5,
            },
            location: {
                origin: "https://app.example.com",
                pathname: "/app",
                hash: "",
            },
            open: vi.fn(() => null),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            setInterval: vi.fn(),
            clearInterval: vi.fn(),
            setTimeout: vi.fn(),
            clearTimeout: vi.fn(),
        };

        const repo = createRemoteStorageRepository();
        const redirectHandler = vi.fn();

        repo.on("standalone-auth-redirect", redirectHandler);

        expect(() =>
            repo.remoteStorage.authorize({
                authURL: "https://auth.example.com/oauth",
            }),
        ).not.toThrow();
        expect(remoteStorageMockState.instance.access.setStorageType).toHaveBeenCalledWith("webdav");
        expect(remoteStorageMockState.defaultAuthorize).toHaveBeenCalledTimes(1);
        expect(remoteStorageMockState.defaultAuthorize).toHaveBeenCalledWith({
            authURL: "https://auth.example.com/oauth",
            scope: "setlist-roller:rw",
            redirectUri: "https://app.example.com/app",
            clientId: "https://app.example.com",
        });
        expect(globalThis.window.open).not.toHaveBeenCalled();
        expect(redirectHandler).toHaveBeenCalledWith({
            userAddress: "",
            redirectUri: "https://app.example.com/app",
        });
    });

    it("surfaces standalone authorization startup failures with a specific message", () => {
        globalThis.window = {
            matchMedia: vi.fn(() => ({ matches: true })),
            navigator: {
                standalone: true,
                userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
                platform: "iPhone",
                maxTouchPoints: 5,
            },
            location: {
                origin: "https://app.example.com",
                pathname: "/",
                hash: "",
            },
            open: vi.fn(() => null),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            setInterval: vi.fn(),
            clearInterval: vi.fn(),
            setTimeout: vi.fn(),
            clearTimeout: vi.fn(),
        };
        remoteStorageMockState.defaultAuthorize.mockImplementation(() => {
            throw new Error("Missing auth URL");
        });

        const repo = createRemoteStorageRepository();
        const errorHandler = vi.fn();

        repo.on("error", errorHandler);

        expect(() => repo.remoteStorage.authorize()).not.toThrow();
        expect(remoteStorageMockState.instance.access.setStorageType).toHaveBeenCalledWith("webdav");
        expect(remoteStorageMockState.defaultAuthorize).toHaveBeenCalledTimes(1);
        expect(errorHandler).toHaveBeenCalledTimes(1);
        expect(errorHandler.mock.calls[0][0].message).toContain("installed app");
        expect(errorHandler.mock.calls[0][0].message).toContain("Missing auth URL");
    });

    it("connects in standalone mode without pre-opening a popup", () => {
        globalThis.window = {
            matchMedia: vi.fn(() => ({ matches: true })),
            navigator: {
                standalone: true,
                userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
                platform: "iPhone",
                maxTouchPoints: 5,
            },
            location: { origin: "https://app.example.com", pathname: "/", hash: "" },
            open: vi.fn(() => null),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            setInterval: vi.fn(),
            clearInterval: vi.fn(),
            setTimeout: vi.fn(),
            clearTimeout: vi.fn(),
        };

        const repo = createRemoteStorageRepository();
        repo.connect("user@example.com");
        expect(globalThis.window.open).not.toHaveBeenCalled();
        expect(remoteStorageMockState.instance.connect).toHaveBeenCalledWith("user@example.com", undefined);
    });

    it("ignores non-string connect tokens", () => {
        const repo = createRemoteStorageRepository();
        repo.connect("user@example.com", { type: "click" });
        expect(remoteStorageMockState.instance.connect).toHaveBeenCalledWith("user@example.com", undefined);
    });

    describe("swap", () => {
        it("connects directly when no prior connection exists", async () => {
            const repo = createRemoteStorageRepository();
            const rs = remoteStorageMockState.instance;
            rs.connected = false;

            await repo.swap("other@example.com", "tok-2");

            expect(rs.disconnect).not.toHaveBeenCalled();
            expect(rs.caching.reset).not.toHaveBeenCalled();
            expect(rs.caching.enable).toHaveBeenCalledWith("/setlist-roller/");
            expect(rs.connect).toHaveBeenCalledWith("other@example.com", "tok-2");
        });

        it("disconnects, resets the cache, then connects when a prior connection exists", async () => {
            const repo = createRemoteStorageRepository();
            const rs = remoteStorageMockState.instance;
            rs.connected = true;

            // Capture the order of operations so we can assert disconnect →
            // resetCache → connect happens in sequence (no library-internal
            // mutations slipped in between).
            const order = [];
            rs.caching.reset.mockImplementation(() => order.push("reset"));
            rs.disconnect.mockImplementation(() => order.push("disconnect"));
            rs.connect.mockImplementation(() => order.push("connect"));

            // Capture the `disconnected` listener so we can fire it.
            let disconnectedHandler;
            rs.on.mockImplementation((event, handler) => {
                if (event === "disconnected") disconnectedHandler = handler;
            });

            const swapPromise = repo.swap("other@example.com", "tok-2");

            // swap() registers the listener and triggers disconnect(), but
            // doesn't proceed to connect() until `disconnected` fires.
            expect(rs.on).toHaveBeenCalledWith("disconnected", expect.any(Function));
            expect(disconnectedHandler).toBeTypeOf("function");
            expect(rs.connect).not.toHaveBeenCalled();

            disconnectedHandler();
            await swapPromise;

            expect(rs.removeEventListener).toHaveBeenCalledWith("disconnected", disconnectedHandler);
            expect(order).toEqual(["reset", "disconnect", "connect"]);
            expect(rs.caching.enable).toHaveBeenLastCalledWith("/setlist-roller/");
            expect(rs.connect).toHaveBeenCalledWith("other@example.com", "tok-2");
        });

        it("does not mutate the rs.js `remote.connected` flag", async () => {
            const repo = createRemoteStorageRepository();
            const rs = remoteStorageMockState.instance;
            rs.connected = true;

            // Make `remote.connected` a getter so any assignment would throw.
            const guard = vi.fn();
            Object.defineProperty(rs.remote, "connected", {
                configurable: true,
                get: () => true,
                set: guard,
            });

            let disconnectedHandler;
            rs.on.mockImplementation((event, handler) => {
                if (event === "disconnected") disconnectedHandler = handler;
            });

            const swapPromise = repo.swap("other@example.com", "tok-2");
            disconnectedHandler();
            await swapPromise;

            expect(guard).not.toHaveBeenCalled();
        });

        it("normalizes non-string tokens to undefined", async () => {
            const repo = createRemoteStorageRepository();
            const rs = remoteStorageMockState.instance;
            rs.connected = false;
            await repo.swap("other@example.com", { type: "click" });
            expect(rs.connect).toHaveBeenCalledWith("other@example.com", undefined);
        });
    });

    // Regression coverage for the cold-start path.
    //
    // rs.js v2.0.0-beta.* documents `client.getAll(path, false)` as a "list
    // ETags only, skip bodies" optimisation. On a cold IndexedDB the listing
    // therefore returns stub entries — `true`, `{}`, or partial objects
    // missing the discriminator field — for items the library knows exist
    // but hasn't fetched yet. Our list* helpers rely on a discriminator
    // field per type (`id` for songs, `savedAt` for setlists, `name` for
    // members) to separate real records from stubs and report the rest as
    // `pending`. These tests pin that contract so a future schema change
    // doesn't silently start counting empty placeholders as real records,
    // which would briefly flash empty UI on first connect to a new device.
    describe("cold-start stub handling", () => {
        it("listSongs treats stub entries as pending bodies", async () => {
            const repo = createRemoteStorageRepository();
            remoteStorageMockState.client.getAll.mockResolvedValue({
                "song-1": { id: "song-1", name: "Real", updatedAt: "2025-01-01T00:00:00Z" },
                "song-2": true,
                "song-3": {},
                "song-4": null,
                "song-5": { name: "Missing id" },
            });

            const result = await repo.listSongs();

            expect(remoteStorageMockState.client.getAll).toHaveBeenCalledWith("songs/", false);
            expect(result.songs).toHaveLength(1);
            expect(result.songs[0].id).toBe("song-1");
            expect(result.pending).toBe(4);
        });

        it("listSongs returns empty + zero pending when getAll has no data", async () => {
            const repo = createRemoteStorageRepository();
            remoteStorageMockState.client.getAll.mockResolvedValue(undefined);
            const result = await repo.listSongs();
            expect(result.songs).toEqual([]);
            expect(result.pending).toBe(0);
        });

        it("listSetlists treats entries without savedAt as pending bodies", async () => {
            const repo = createRemoteStorageRepository();
            remoteStorageMockState.client.getAll.mockResolvedValue({
                "set-1": { id: "set-1", savedAt: "2025-02-01T00:00:00Z", songs: [] },
                "set-2": true,
                "set-3": { id: "set-3" },
            });

            const result = await repo.listSetlists();

            expect(result.setlists).toHaveLength(1);
            expect(result.setlists[0].id).toBe("set-1");
            expect(result.pending).toBe(2);
        });

        it("listSetlists sorts loaded setlists by savedAt descending", async () => {
            const repo = createRemoteStorageRepository();
            remoteStorageMockState.client.getAll.mockResolvedValue({
                a: { id: "a", savedAt: "2025-01-01T00:00:00Z" },
                b: { id: "b", savedAt: "2025-03-01T00:00:00Z" },
                c: { id: "c", savedAt: "2025-02-01T00:00:00Z" },
            });
            const result = await repo.listSetlists();
            expect(result.setlists.map((s) => s.id)).toEqual(["b", "c", "a"]);
            expect(result.pending).toBe(0);
        });

        it("listMembers treats entries without name as pending bodies", async () => {
            const repo = createRemoteStorageRepository();
            remoteStorageMockState.client.getAll.mockResolvedValue({
                Alice: { name: "Alice", instruments: [] },
                Bob: true,
                Carol: {},
                Drew: { instruments: [] },
            });

            const result = await repo.listMembers();

            expect(Object.keys(result.members)).toEqual(["Alice"]);
            expect(result.pending).toBe(3);
        });
    });

    // The cold-start tests above cover what each list* helper does when its
    // own getAll call returns stubs. These tests cover what `loadAll` does
    // when one of the five slices fails outright — the partial-failure path
    // that motivated switching from Promise.all to Promise.allSettled.
    describe("loadAll partial-failure handling", () => {
        function configureClient({ songs, setlists, members, config, bootstrap }) {
            const { client } = remoteStorageMockState;
            client.getAll.mockImplementation((path) => {
                if (path === "songs/") return songs;
                if (path === "setlists/") return setlists;
                if (path === "members/") return members;
                return Promise.resolve({});
            });
            client.getObject.mockImplementation((path) => {
                if (path === "settings/app-config") return config;
                if (path === "meta/bootstrap") return bootstrap;
                return Promise.resolve(null);
            });
        }

        it("returns successfully-loaded slices and an empty errors map on full success", async () => {
            const repo = createRemoteStorageRepository();
            configureClient({
                songs: Promise.resolve({
                    "s-1": { id: "s-1", name: "Song", updatedAt: "2025-01-01T00:00:00Z" },
                }),
                setlists: Promise.resolve({}),
                members: Promise.resolve({ Alice: { name: "Alice" } }),
                config: Promise.resolve({ bandName: "Tunesmith" }),
                bootstrap: Promise.resolve(null),
            });

            const result = await repo.loadAll();

            expect(result.songs).toHaveLength(1);
            // getConfig normalizes the raw record (defaults, schemaVersion);
            // the test only cares that the user-provided field round-trips.
            expect(result.config).toMatchObject({ bandName: "Tunesmith" });
            expect(result.setlists).toEqual([]);
            expect(result.members).toEqual({ Alice: { name: "Alice" } });
            expect(result.bootstrap).toBeNull();
            expect(result.errors).toEqual({});
        });

        it("does not short-circuit when a single slice rejects", async () => {
            const repo = createRemoteStorageRepository();
            configureClient({
                songs: Promise.resolve({
                    "s-1": { id: "s-1", name: "Song", updatedAt: "2025-01-01T00:00:00Z" },
                }),
                setlists: Promise.resolve({}),
                members: Promise.reject(new Error("network down")),
                config: Promise.resolve({ bandName: "Tunesmith" }),
                bootstrap: Promise.resolve(null),
            });

            const result = await repo.loadAll();

            expect(result.songs).toHaveLength(1);
            expect(result.setlists).toEqual([]);
            // getConfig normalizes the raw record (defaults, schemaVersion);
            // the test only cares that the user-provided field round-trips.
            expect(result.config).toMatchObject({ bandName: "Tunesmith" });
            expect(result.members).toBeUndefined();
            expect(result.errors.members).toBeInstanceOf(Error);
            expect(result.errors.members.message).toContain("network down");
            expect(result.errors.config).toBeUndefined();
        });

        it("distinguishes a missing config from a failed config read", async () => {
            const repo = createRemoteStorageRepository();
            configureClient({
                songs: Promise.resolve({}),
                setlists: Promise.resolve({}),
                members: Promise.resolve({}),
                config: Promise.reject(new Error("403")),
                bootstrap: Promise.resolve(null),
            });

            const result = await repo.loadAll();

            expect(result.config).toBeUndefined();
            expect(result.errors.config).toBeInstanceOf(Error);
            expect(result.errors.config.message).toBe("403");
        });

        it("forwards onStep messages for both successes and failures", async () => {
            const repo = createRemoteStorageRepository();
            configureClient({
                songs: Promise.resolve({}),
                setlists: Promise.resolve({}),
                members: Promise.reject(new Error("boom")),
                config: Promise.resolve(null),
                bootstrap: Promise.resolve(null),
            });

            const onStep = vi.fn();
            await repo.loadAll({ onStep });

            const messages = onStep.mock.calls.map(([m]) => m);
            expect(messages).toContain("Loading band members");
            expect(messages.some((m) => m.startsWith("Could not load members"))).toBe(true);
        });

        it("counts pending bodies only from successful slices", async () => {
            const repo = createRemoteStorageRepository();
            configureClient({
                songs: Promise.resolve({
                    "s-1": true,
                    "s-2": { id: "s-2", name: "Song", updatedAt: "2025-01-01T00:00:00Z" },
                }),
                setlists: Promise.resolve({ "set-1": true, "set-2": true }),
                members: Promise.reject(new Error("offline")),
                config: Promise.resolve(null),
                bootstrap: Promise.resolve(null),
            });

            const result = await repo.loadAll();

            // 1 stub from songs + 2 stubs from setlists; members rejected,
            // so its pending count contributes nothing rather than NaN.
            expect(result.pendingBodies).toBe(3);
        });
    });
});

describe("custom RemoteStorage.Discover override", () => {
    // The override is installed at module-load time when remotestorage.js
    // runs `RemoteStorage.Discover = customDiscover`. We assert against
    // the mocked rs.js export — same object the override mutated.
    function makeFetchStub(impl) {
        const stub = vi.fn(impl);
        globalThis.fetch = stub;
        return stub;
    }

    function jsonResponse(body, { ok = true, status = 200 } = {}) {
        return {
            ok,
            status,
            json: async () => body,
        };
    }

    const VALID_WEBFINGER = {
        links: [
            {
                rel: "remotestorage",
                href: "https://storage.example.com/me",
                type: "draft-dejong-remotestorage-10",
                properties: {
                    "http://remotestorage.io/spec/version": "draft-dejong-remotestorage-10",
                    "http://tools.ietf.org/html/rfc6749#section-4.2": "https://storage.example.com/oauth/me",
                },
            },
        ],
    };

    let originalFetch;
    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it("resolves user@host with an acct: webfinger resource", async () => {
        const fetchStub = makeFetchStub(() => Promise.resolve(jsonResponse(VALID_WEBFINGER)));
        const info = await RemoteStorage.Discover("nick@example.com");
        expect(fetchStub).toHaveBeenCalledTimes(1);
        const url = fetchStub.mock.calls[0][0];
        // Public host ⇒ https. Resource is encoded `acct:nick@example.com`.
        expect(url).toBe(
            `https://example.com/.well-known/webfinger?resource=${encodeURIComponent("acct:nick@example.com")}`,
        );
        expect(info.href).toBe("https://storage.example.com/me");
        expect(info.authURL).toBe("https://storage.example.com/oauth/me");
        expect(info.storageApi).toBe("draft-dejong-remotestorage-10");
    });

    it("resolves URL-form input (rs.js prefixes bare hosts upstream) with the URL itself as the webfinger resource", async () => {
        // rs.js's `connect("5apps.com")` rewrites the address to
        // `"https://5apps.com"` before calling Discover, so this is the
        // shape Discover actually receives. The previous override
        // rejected anything without `@` outright; this test pins the
        // fix.
        const fetchStub = makeFetchStub(() => Promise.resolve(jsonResponse(VALID_WEBFINGER)));
        await RemoteStorage.Discover("https://5apps.com");
        const url = fetchStub.mock.calls[0][0];
        expect(url).toBe(`https://5apps.com/.well-known/webfinger?resource=${encodeURIComponent("https://5apps.com")}`);
    });

    it("uses http (not https) for localhost-style private hosts to avoid TLS-required failures in dev", async () => {
        const fetchStub = makeFetchStub(() => Promise.resolve(jsonResponse(VALID_WEBFINGER)));
        await RemoteStorage.Discover("user@localhost:8000");
        expect(fetchStub.mock.calls[0][0]).toMatch(/^http:\/\/localhost:8000\/\.well-known\/webfinger/);
    });

    it("uses http for 127.0.0.1 too — RFC1918 / loopback, never TLS in practice", async () => {
        const fetchStub = makeFetchStub(() => Promise.resolve(jsonResponse(VALID_WEBFINGER)));
        await RemoteStorage.Discover("user@127.0.0.1:8000");
        expect(fetchStub.mock.calls[0][0]).toMatch(/^http:\/\/127\.0\.0\.1:8000/);
    });

    it("rejects with a non-DiscoveryError when the webfinger HTTP response is non-2xx", async () => {
        // The error class doesn't matter for the user-facing state machine —
        // rs.js's connect() catches our rejection and emits its own
        // `RemoteStorage.DiscoveryError("No storage information found...")`,
        // which the app's error handler treats as fatal and unwinds the
        // connecting state via repo.disconnect(). What matters here is
        // that we DO reject (i.e. don't swallow the failure into a
        // resolved Promise).
        makeFetchStub(() => Promise.resolve(jsonResponse({}, { ok: false, status: 404 })));
        await expect(RemoteStorage.Discover("user@example.com")).rejects.toThrow(/WebFinger failed: 404/);
    });

    it("rejects when the webfinger JSON has no remoteStorage link", async () => {
        makeFetchStub(() => Promise.resolve(jsonResponse({ links: [{ rel: "avatar", href: "x" }] })));
        await expect(RemoteStorage.Discover("user@example.com")).rejects.toThrow(/No remoteStorage link/);
    });

    it("rejects when the input has neither @ nor :// (defensive — rs.js prefixes upstream so this shouldn't happen, but if a caller bypasses connect()…)", async () => {
        // No fetch stub — should reject before any network call.
        const fetchStub = makeFetchStub(() => {
            throw new Error("fetch should not be called");
        });
        // Bare hosts go through the URL-form branch (resource = `https://${address}`),
        // so the rejection here is for the case where URL parsing fails. We
        // test that path with input the URL constructor refuses to parse.
        await expect(RemoteStorage.Discover("https://")).rejects.toThrow(/Invalid user address/);
        expect(fetchStub).not.toHaveBeenCalled();
    });
});
