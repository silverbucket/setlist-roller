import RemoteStorage from "remotestoragejs";
import { createDefaultAppConfig, normalizeAppConfig, normalizeSongRecord, sortSongs } from "./defaults.js";
import { clone, nowIso } from "./utils.js";

// Re-enable WebFinger lookups against localhost / private-IP RS servers.
//
// webfinger.js v3 (a transitive dep of remotestoragejs >=2.0.0-beta.9) added an
// `allow_private_addresses` config flag that defaults to `false`. With it off,
// `WebFinger#resolveAndValidateHost` throws `private or internal addresses are
// not allowed` BEFORE any HTTP request fires for any host that matches its
// private/localhost regex. rs.js's `Discover` constructs WebFinger without the
// flag, so `rs.connect("user@localhost:8000")` (and any private-LAN address)
// fails synchronously with a `DiscoveryError` and the app sits on
// "Connecting…" forever — that's exactly the user-reported regression after
// the beta.8 → beta.9 upgrade in PR #87.
//
// We can't fix this by monkey-patching `webfinger.js` from our app: rs.js's
// published bundle inlines its own copy, so the `WebFinger` class we'd patch
// from `import WebFinger from 'webfinger.js'` is a different class than the
// one rs.js's `Discover` instantiates. Instead we replace `RemoteStorage.Discover`
// outright — `connect()` calls `RemoteStorage.Discover(userAddress)` (see
// `src/remotestorage.ts` in rs.js), so swapping the static gets us in front of
// every lookup. Our replacement does the same WebFinger lookup with raw `fetch`,
// which is gated by browser CORS already — the v3 SSRF protection is a
// server-side concern that doesn't apply here.
//
// Track removal at remotestorage/remotestorage.js#1384 — once rs.js sets
// `allow_private_addresses: true` (or exposes it as a constructor option), the
// hack goes away. Adapted from inbox-rs PR #105.
{
    const RS_LINK_RELS = new Set(["remotestorage", "http://tools.ietf.org/id/draft-dejong-remotestorage"]);
    const AUTH_URL_PROPS = ["http://tools.ietf.org/html/rfc6749#section-4.2", "auth-endpoint"];

    // Hosts we treat as plain HTTP (no TLS) when building the webfinger URL.
    // Anything in this list is also a `webfinger.js` "private" host, which
    // is exactly the case we're working around. Public hosts go through
    // HTTPS as the spec requires.
    const PLAIN_HTTP_HOST_RE = /^(localhost|127\.[0-9.]+|\[?::1\]?|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/;

    const customDiscover = (userAddress) => {
        const at = userAddress.lastIndexOf("@");
        if (at < 0) return Promise.reject(new Error("Invalid user address"));
        const host = userAddress.slice(at + 1);
        const hostNoPort = host.split(":")[0];
        const scheme = PLAIN_HTTP_HOST_RE.test(host) || PLAIN_HTTP_HOST_RE.test(hostNoPort) ? "http" : "https";
        const url = `${scheme}://${host}/.well-known/webfinger?resource=acct:${encodeURIComponent(userAddress)}`;

        return fetch(url).then(async (resp) => {
            if (!resp.ok) throw new Error(`WebFinger failed: ${resp.status}`);
            const data = await resp.json();
            const link = Array.isArray(data?.links)
                ? data.links.find((l) => l?.rel && RS_LINK_RELS.has(l.rel))
                : undefined;
            if (!link?.href) throw new Error("No remoteStorage link in WebFinger response");
            const properties = link.properties ?? {};
            const storageApi =
                (typeof link.type === "string" ? link.type : undefined) ??
                (typeof properties["http://remotestorage.io/spec/version"] === "string"
                    ? properties["http://remotestorage.io/spec/version"]
                    : undefined);
            let authURL;
            for (const key of AUTH_URL_PROPS) {
                const v = properties[key];
                if (typeof v === "string") {
                    authURL = v;
                    break;
                }
            }
            return { href: link.href, storageApi, authURL, properties };
        });
    };

    // Preserve `RemoteStorage.Discover.DiscoveryError` — rs.js's connect path
    // throws `new RemoteStorage.DiscoveryError(...)`, and the static type also
    // surfaces it as `Discover.DiscoveryError`.
    const original = RemoteStorage.Discover;
    customDiscover.DiscoveryError = original?.DiscoveryError;
    RemoteStorage.Discover = customDiscover;
}

const APP_SCOPE = "setlist-roller";
const TYPES = {
    song: "setlist-roller-song",
    preset: "setlist-roller-preset",
    config: "setlist-roller-config",
    meta: "setlist-roller-meta",
    setlist: "setlist-roller-setlist",
    member: "setlist-roller-member",
};

const OBJECT_SCHEMA = {
    type: "object",
    additionalProperties: true,
};

const AUTH_MESSAGE_TYPE = "setlist-roller-auth-result";
const AUTH_POPUP_TIMEOUT_MS = 180000;
const AUTH_POPUP_FEATURES = "popup=yes,width=480,height=720";
const STANDALONE_AUTH_FAILURE_MESSAGE =
    "Authorization did not start correctly in the installed app. If iOS opened login in Safari, close it and retry, or sign in via Safari instead of the home-screen app.";
const REMOTE_STORAGE_EVENTS = new Set([
    "ready",
    "authing",
    "connecting",
    "connected",
    "disconnected",
    "not-connected",
    "conflict",
    "error",
    "features-loaded",
    "sync-interval-change",
    "sync-started",
    "sync-req-done",
    "sync-done",
    "wire-busy",
    "wire-done",
    "network-offline",
    "network-online",
]);

export function isIosStandaloneAuthContext(env = globalThis.window) {
    if (!env) return false;
    const displayStandalone = env.matchMedia?.("(display-mode: standalone)")?.matches ?? false;
    const legacyStandalone = env.navigator?.standalone === true;
    if (!displayStandalone && !legacyStandalone) return false;
    const ua = env.navigator?.userAgent || "";
    const isiPadLike = env.navigator?.platform === "MacIntel" && env.navigator?.maxTouchPoints > 1;
    return /iPad|iPhone|iPod/.test(ua) || isiPadLike;
}

export function buildAuthorizeUrl(options) {
    const redirect = new URL(options.redirectUri);
    const state = options.state ?? (redirect.hash ? redirect.hash.substring(1) : "");
    const responseType = options.response_type || "token";
    const url = new URL(options.authURL);
    url.searchParams.set("redirect_uri", options.redirectUri.replace(/#.*$/, ""));
    url.searchParams.set("scope", options.scope);
    url.searchParams.set("client_id", options.clientId);
    for (const [key, value] of Object.entries({
        state,
        response_type: responseType,
        code_challenge: options.code_challenge,
        code_challenge_method: options.code_challenge_method,
        token_access_type: options.token_access_type,
    })) {
        if (value) url.searchParams.set(key, value);
    }
    return url.toString();
}

export function normalizeStandaloneAuthorizeOptions(options, env = globalThis.window) {
    const authorizeOptions = { ...(options ?? {}) };
    if (typeof authorizeOptions.scope !== "string" || authorizeOptions.scope.trim() === "") {
        throw new Error("Cannot authorize due to undefined or empty scope; did you forget to access.claim()?");
    }
    if (typeof authorizeOptions.redirectUri === "undefined") {
        if (!env?.location?.origin) {
            throw new Error("Standalone authorization requires a browser location.");
        }
        let redirectUri = env.location.origin;
        if (env.location.pathname) {
            redirectUri += env.location.pathname;
        }
        authorizeOptions.redirectUri = redirectUri;
    }
    if (typeof authorizeOptions.clientId === "undefined") {
        authorizeOptions.clientId = new URL(authorizeOptions.redirectUri).origin;
    }
    return authorizeOptions;
}

function normalizeBearerToken(token) {
    return typeof token === "string" && token.length > 0 ? token : undefined;
}

export function createStandaloneAuthMessageHandler({ attemptId, origin, onSuccess, onError }) {
    return (event) => {
        if (event.origin !== origin) return false;
        const payload = event.data;
        if (payload?.type !== AUTH_MESSAGE_TYPE || payload?.attemptId !== attemptId) return false;

        const params = payload.params || {};
        if (params.error) {
            onError(new Error(`Authorization failed: ${params.error}`));
            return true;
        }
        if (!params.access_token) {
            onError(new Error("Authorization did not return an access token."));
            return true;
        }

        onSuccess({
            accessToken: params.access_token,
            state: params.state || "",
        });
        return true;
    };
}

export function authorizeWithStandalonePopup(
    remoteStorage,
    options,
    {
        env = globalThis.window,
        popup: providedPopup = null,
        emitError = (error) => {
            throw error;
        },
    } = {},
) {
    if (!env) {
        throw new Error("Standalone authorization requires a browser window.");
    }

    const attemptId = globalThis.crypto?.randomUUID?.() || `auth-${Date.now()}`;
    const redirectUri = `${env.location.origin}/auth-relay.html?attempt=${encodeURIComponent(attemptId)}`;
    const authUrl = buildAuthorizeUrl({
        ...options,
        redirectUri,
        clientId: options.clientId || env.location.origin,
    });

    const popup =
        providedPopup && !providedPopup.closed ? providedPopup : env.open(authUrl, "_blank", AUTH_POPUP_FEATURES);
    if (!popup) {
        throw new Error("Authorization popup was blocked.");
    }
    if (popup === providedPopup) {
        try {
            popup.location.replace(authUrl);
        } catch {
            popup.location.href = authUrl;
        }
    }

    let finished = false;
    let closePoll = null;
    let timeoutId = null;

    const cleanup = () => {
        env.removeEventListener("message", onMessage);
        if (closePoll) env.clearInterval(closePoll);
        if (timeoutId) env.clearTimeout(timeoutId);
    };

    const fail = (message) => {
        if (finished) return;
        finished = true;
        cleanup();
        emitError(new Error(message));
    };

    const onMessage = createStandaloneAuthMessageHandler({
        attemptId,
        origin: env.location.origin,
        onSuccess: ({ accessToken, state }) => {
            if (finished) return;
            finished = true;
            cleanup();
            remoteStorage.remote.configure({ token: accessToken });
            if (state) {
                env.location.hash = state;
            }
        },
        onError: (error) => {
            if (finished) return;
            finished = true;
            cleanup();
            emitError(error);
        },
    });

    env.addEventListener("message", onMessage);

    closePoll = env.setInterval(() => {
        if (!popup.closed || finished) return;
        fail("Authorization window was closed before login finished.");
    }, 500);

    timeoutId = env.setTimeout(() => {
        fail("Authorization timed out before the app received a token.");
    }, AUTH_POPUP_TIMEOUT_MS);
}

export function createRemoteStorageRepository() {
    const remoteStorage = new RemoteStorage({
        changeEvents: {
            local: true,
            remote: true,
            conflict: true,
            window: false,
        },
        logging: typeof window !== "undefined" && window.localStorage?.getItem("__SR_RS_DEBUG__") === "1",
    });

    const localEventHandlers = new Map();
    function emitLocal(eventName, payload) {
        const handlers = localEventHandlers.get(eventName);
        if (!handlers) return;
        for (const handler of handlers) {
            handler(payload);
        }
    }

    remoteStorage.access.claim(APP_SCOPE, "rw");
    remoteStorage.caching.enable(`/${APP_SCOPE}/`);

    const client = remoteStorage.scope(`/${APP_SCOPE}/`);
    client.declareType(TYPES.song, OBJECT_SCHEMA);
    client.declareType(TYPES.preset, OBJECT_SCHEMA);
    client.declareType(TYPES.config, OBJECT_SCHEMA);
    client.declareType(TYPES.meta, OBJECT_SCHEMA);
    client.declareType(TYPES.setlist, OBJECT_SCHEMA);
    client.declareType(TYPES.member, OBJECT_SCHEMA);

    const defaultAuthorize = remoteStorage.authorize.bind(remoteStorage);
    remoteStorage.authorize = (options) => {
        if (isIosStandaloneAuthContext()) {
            try {
                remoteStorage.access.setStorageType(remoteStorage.remote.storageApi);
                const authorizeOptions = normalizeStandaloneAuthorizeOptions({
                    ...(options ?? {}),
                    scope: options?.scope ?? remoteStorage.access.scopeParameter,
                });
                emitLocal("standalone-auth-redirect", {
                    userAddress: remoteStorage.remote?.userAddress || "",
                    redirectUri: authorizeOptions.redirectUri,
                });
                defaultAuthorize(authorizeOptions);
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                emitLocal("error", new Error(`${STANDALONE_AUTH_FAILURE_MESSAGE} ${reason}`));
            }
            return;
        }
        defaultAuthorize(options);
    };

    return {
        remoteStorage,
        client,

        connect(userAddress, token) {
            const normalizedToken = normalizeBearerToken(token);
            // Re-enable caching in case it was reset by a previous disconnect.
            remoteStorage.caching.enable(`/${APP_SCOPE}/`);
            remoteStorage.connect(userAddress, normalizedToken);
        },

        disconnect() {
            // Reset the local cache before disconnecting to prevent data leaking to the next account
            remoteStorage.caching.reset();
            remoteStorage.disconnect();
        },

        /**
         * Switch to a different account: disconnect cleanly, reset the local
         * cache so the previous account's data can't leak, then connect.
         * Resolves once `connect()` has been issued — callers should still
         * wait for the `connected` event for sync.
         */
        async swap(userAddress, token) {
            if (remoteStorage.connected) {
                await new Promise((resolve) => {
                    let settled = false;
                    const finish = () => {
                        if (settled) return;
                        settled = true;
                        clearTimeout(timer);
                        remoteStorage.removeEventListener("disconnected", handler);
                        resolve();
                    };
                    const handler = () => finish();
                    // Safety net: if rs.js never fires `disconnected` (already
                    // mid-disconnect, library hiccup), don't strand the user.
                    const timer = setTimeout(finish, 3000);
                    remoteStorage.on("disconnected", handler);
                    remoteStorage.caching.reset();
                    remoteStorage.disconnect();
                });
            }
            remoteStorage.caching.enable(`/${APP_SCOPE}/`);
            remoteStorage.connect(userAddress, normalizeBearerToken(token));
        },

        async sync() {
            if (!remoteStorage.connected) {
                return;
            }
            await remoteStorage.startSync();
        },

        /**
         * Read/adjust rs.js's foreground sync polling interval. The library
         * enforces 2000–3 600 000 ms; setSyncInterval throws outside that.
         */
        getSyncInterval() {
            return remoteStorage.getSyncInterval();
        },
        setSyncInterval(ms) {
            remoteStorage.setSyncInterval(ms);
        },

        /**
         * Wait until remote data has actually arrived in the local cache.
         * Resolves after a sync-done fires with no remaining tasks (meaning
         * all rounds are complete), or after a safety timeout.
         */
        syncAndWait() {
            return new Promise((resolve) => {
                const timeout = setTimeout(cleanup, 15000);
                function cleanup() {
                    clearTimeout(timeout);
                    remoteStorage.removeEventListener("sync-done", handler);
                    resolve();
                }
                function handler(e) {
                    // sync-done with completed=true means all rounds finished
                    if (e?.completed) {
                        cleanup();
                    }
                    // else: more rounds pending, keep waiting
                }
                remoteStorage.on("sync-done", handler);
            });
        },

        on(eventName, handler) {
            if (REMOTE_STORAGE_EVENTS.has(eventName)) {
                remoteStorage.on(eventName, handler);
            }
            if (!localEventHandlers.has(eventName)) {
                localEventHandlers.set(eventName, new Set());
            }
            localEventHandlers.get(eventName).add(handler);
            return () => {
                if (REMOTE_STORAGE_EVENTS.has(eventName)) {
                    remoteStorage.removeEventListener(eventName, handler);
                }
                localEventHandlers.get(eventName)?.delete(handler);
            };
        },

        onChange(handler) {
            client.on("change", handler);
            return () => client.removeEventListener("change", handler);
        },

        isConnected() {
            return remoteStorage.connected;
        },

        getUserAddress() {
            return remoteStorage.remote?.userAddress || "";
        },

        getToken() {
            return remoteStorage.remote?.token || "";
        },

        async loadAll({ onStep } = {}) {
            // Each slice loads independently so a single failed read (network
            // hiccup, 5xx on a folder, malformed body) doesn't blank the UI.
            // We use Promise.allSettled instead of Promise.all and surface
            // failures through the returned `errors` map; the caller decides
            // what to keep, what to warn about, and what to retry.
            const slices = [
                [
                    "songs",
                    () =>
                        this.listSongs().then((result) => {
                            onStep?.(
                                `Loaded ${result.songs.length} songs${result.pending ? ` (${result.pending} pending)` : ""}`,
                            );
                            return result;
                        }),
                ],
                [
                    "config",
                    () =>
                        this.getConfig().then((config) => {
                            onStep?.(config ? "Loaded settings" : "No settings found yet");
                            return config;
                        }),
                ],
                [
                    "bootstrap",
                    () =>
                        this.getBootstrapMeta().then((bootstrap) => {
                            onStep?.(bootstrap ? "Loaded bootstrap info" : "No bootstrap info found");
                            return bootstrap;
                        }),
                ],
                [
                    "setlists",
                    () =>
                        this.listSetlists().then((result) => {
                            onStep?.(
                                `Loaded ${result.setlists.length} saved setlists${result.pending ? ` (${result.pending} pending)` : ""}`,
                            );
                            return result;
                        }),
                ],
                [
                    "members",
                    () =>
                        this.listMembers().then((result) => {
                            onStep?.(
                                `Loaded ${Object.keys(result.members || {}).length} band members${result.pending ? ` (${result.pending} pending)` : ""}`,
                            );
                            return result;
                        }),
                ],
            ];

            onStep?.("Loading songs");
            onStep?.("Loading settings");
            onStep?.("Loading bootstrap info");
            onStep?.("Loading saved setlists");
            onStep?.("Loading band members");

            const settled = await Promise.allSettled(slices.map(([, run]) => run()));

            const values = {};
            const errors = {};
            settled.forEach((outcome, i) => {
                const [name] = slices[i];
                if (outcome.status === "fulfilled") {
                    values[name] = outcome.value;
                } else {
                    const reason = outcome.reason instanceof Error ? outcome.reason : new Error(String(outcome.reason));
                    errors[name] = reason;
                    onStep?.(`Could not load ${name}: ${reason.message}`);
                }
            });

            // pendingBodies: total documents whose bodies haven't yet arrived
            // from the remote. rs.js's getAll(path, false) returns stub
            // entries (`true` / `{}` / object without id) for items it knows
            // exist (folder ETag) but whose bodies are not yet in the local
            // cache. As long as this is > 0, more onChange events will fire
            // and the UI is not yet in a settled state. Slices that rejected
            // contribute 0 — we'll find out about their bodies on the next
            // successful load.
            const pendingBodies =
                (values.songs?.pending || 0) + (values.setlists?.pending || 0) + (values.members?.pending || 0);

            return {
                songs: values.songs?.songs,
                config: values.config,
                bootstrap: values.bootstrap,
                setlists: values.setlists?.setlists,
                members: values.members?.members,
                pendingBodies,
                errors,
            };
        },

        async listSongs() {
            const items = await client.getAll("songs/", false);
            const all = Object.values(items || {});
            const records = [];
            let pending = 0;
            for (const item of all) {
                if (item && typeof item === "object" && item.id) {
                    records.push(item);
                } else {
                    pending += 1;
                }
            }
            return {
                songs: sortSongs(records.map((song) => normalizeSongRecord(song))),
                pending,
            };
        },

        async putSong(song) {
            const normalized = normalizeSongRecord({
                ...clone(song),
                updatedAt: nowIso(),
            });
            await client.storeObject(TYPES.song, `songs/${normalized.id}`, normalized);
            return normalized;
        },

        async deleteSong(songId) {
            await client.remove(`songs/${songId}`);
        },

        async deleteConfig() {
            await client.remove("settings/app-config");
        },

        async getConfig() {
            const result = await client.getObject("settings/app-config");
            return normalizeAppConfig(result);
        },

        async getRawConfig() {
            return await client.getObject("settings/app-config");
        },

        async ensureConfig(bandName) {
            const existing = await this.getConfig();
            if (existing) {
                return existing;
            }

            const config = createDefaultAppConfig({ bandName });
            await this.putConfig(config);
            return config;
        },

        async putConfig(config) {
            const normalized = normalizeAppConfig({
                ...clone(config),
                updatedAt: nowIso(),
            });
            await client.storeObject(TYPES.config, "settings/app-config", normalized);
            return normalized;
        },

        async getBootstrapMeta() {
            const result = await client.getObject("meta/bootstrap");
            return result || null;
        },

        async putBootstrapMeta(meta) {
            const nextMeta = {
                ...clone(meta),
                updatedAt: nowIso(),
            };
            await client.storeObject(TYPES.meta, "meta/bootstrap", nextMeta);
            return nextMeta;
        },

        // ---- setlists ----
        async listSetlists() {
            const items = await client.getAll("setlists/", false);
            // Same stub-tolerant treatment as listSongs. Setlists must have a
            // `savedAt` to sort; missing/non-object entries are pending bodies.
            const all = Object.values(items || {});
            const records = [];
            let pending = 0;
            for (const item of all) {
                if (item && typeof item === "object" && item.savedAt) {
                    records.push(item);
                } else {
                    pending += 1;
                }
            }
            records.sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || ""));
            return { setlists: records, pending };
        },

        async putSetlist(setlist) {
            const doc = { ...clone(setlist), updatedAt: nowIso() };
            await client.storeObject(TYPES.setlist, `setlists/${doc.id}`, doc);
            return doc;
        },

        async deleteSetlist(setlistId) {
            await client.remove(`setlists/${setlistId}`);
        },

        // ---- members ----
        async listMembers() {
            const items = await client.getAll("members/", false);
            // A real member doc has `name`; stubs / empty placeholders count
            // as pending bodies and surface in the sync indicator.
            const result = {};
            let pending = 0;
            for (const [key, value] of Object.entries(items || {})) {
                if (value && typeof value === "object" && value.name) {
                    result[value.name || key] = value;
                } else {
                    pending += 1;
                }
            }
            return { members: result, pending };
        },

        async putMember(name, data) {
            const doc = { ...clone(data), name, updatedAt: nowIso() };
            await client.storeObject(TYPES.member, `members/${name}`, doc);
            return doc;
        },

        async deleteMember(name) {
            await client.remove(`members/${name}`);
        },
    };
}
