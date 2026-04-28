/**
 * Helpers for the real-backend e2e suite. Talks directly to armadietto's
 * HTTP endpoints to provision users and mint OAuth tokens, so tests can
 * either:
 *   - Drive the full discovery + popup OAuth flow in the browser
 *     (`oauthPopupConsent`), or
 *   - Bypass the popup and connect with a pre-issued token via
 *     `repo.connect(addr, token)` (`mintToken`) — still exercises real
 *     rs.js sync against a real RS server, just without the UI dance.
 *
 * Adapted from the inbox-rs project's docker setup; the OAuth helpers are
 * specific to armadietto's HTML form flow and don't generalize to other
 * RS servers without tweaking the field names.
 */
import type { Page, Request } from "@playwright/test";

/**
 * The armadietto host:port — kept in one place so a port change is one edit.
 *
 * Defaults to `127.0.0.1:8000` rather than `localhost:8000` because
 * setlist-roller's `isValidConnectAddress` regex requires a dot in the host
 * (it's a heuristic to reject obvious typos before webfinger discovery).
 * `127.0.0.1` has dots, `localhost` does not. armadietto answers identically
 * on either, so this is a cosmetic switch.
 */
export const ARMADIETTO_HOST = process.env.SR_RS_HOST || "127.0.0.1:8000";
export const ARMADIETTO_BASE = `http://${ARMADIETTO_HOST}`;

/**
 * Wait until armadietto answers a GET /. Polls every 250 ms up to 30 s.
 * Tests should call this once in a top-level beforeAll to avoid a flaky
 * first-request race against a still-booting container.
 */
export async function waitForArmadietto(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
        try {
            const resp = await fetch(`${ARMADIETTO_BASE}/`);
            if (resp.ok) return;
            lastError = new Error(`status ${resp.status}`);
        } catch (error) {
            lastError = error;
        }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`armadietto never came up at ${ARMADIETTO_BASE}: ${String(lastError)}`);
}

/**
 * Generate a fresh random username/password pair. Tests use one per test so
 * the in-memory state of armadietto stays isolated even when the volume is
 * reused across test runs (the data dir is mounted, so usernames persist).
 */
export function randomUser(prefix = "u"): { username: string; password: string; address: string } {
    const suffix = Math.random().toString(36).slice(2, 10);
    const username = `${prefix}${suffix}`;
    return {
        username,
        password: `p${suffix}-Aa1!`,
        address: `${username}@${ARMADIETTO_HOST}`,
    };
}

/**
 * Create a user via armadietto's `/signup` form-post endpoint. Idempotent:
 * a 409 / "user exists" response is treated as success because tests that
 * re-use a username (e.g. across reruns with the volume kept) shouldn't
 * fail just because the second signup is a no-op.
 */
export async function signupUser(username: string, password: string): Promise<void> {
    const body = new URLSearchParams({
        username,
        email: `${username}@example.com`,
        password,
    }).toString();
    const resp = await fetch(`${ARMADIETTO_BASE}/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
    });
    if (resp.status === 201 || resp.status === 200) return;
    // Older armadietto returns 409, newer returns 400 with HTML — accept both
    // as "already exists" if the body mentions the username.
    if (resp.status === 409) return;
    const text = await resp.text();
    if (resp.status === 400 && text.toLowerCase().includes("exist")) return;
    throw new Error(`armadietto signup failed (${resp.status}): ${text.slice(0, 200)}`);
}

/**
 * Mint an OAuth token directly via armadietto's `/oauth` POST. Skips the
 * popup entirely — useful for tests that want to land in the connected
 * state without exercising the UI flow. The redirect_uri matches the dev
 * server's origin so a hypothetical follow-up popup would still redirect
 * to the right place.
 */
export async function mintToken(
    username: string,
    password: string,
    {
        redirectUri = "http://localhost:4173/",
        scope = "setlist-roller:rw",
    }: { redirectUri?: string; scope?: string } = {},
): Promise<string> {
    const body = new URLSearchParams({
        client_id: new URL(redirectUri).origin,
        redirect_uri: redirectUri,
        response_type: "token",
        scope,
        username,
        password,
        allow: "Allow",
        state: "",
    }).toString();
    // armadietto responds with a 302 whose Location is `redirect_uri#access_token=…`.
    // Don't follow the redirect — we want to read it.
    const resp = await fetch(`${ARMADIETTO_BASE}/oauth`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        redirect: "manual",
    });
    if (resp.status !== 302) {
        const text = await resp.text();
        throw new Error(`armadietto /oauth POST returned ${resp.status}: ${text.slice(0, 200)}`);
    }
    const location = resp.headers.get("location");
    if (!location) throw new Error("armadietto /oauth POST returned 302 without Location header");
    const hashIdx = location.indexOf("#");
    if (hashIdx === -1) throw new Error(`armadietto /oauth redirect missing fragment: ${location}`);
    const fragment = new URLSearchParams(location.substring(hashIdx + 1));
    const token = fragment.get("access_token");
    if (!token) throw new Error(`armadietto /oauth redirect had no access_token: ${location}`);
    return token;
}

/**
 * Provision a fresh test user and mint a token. Returned bundle is what
 * tests need to drive `repo.connect(addr, token)` directly.
 */
export async function provisionedUser(prefix = "u") {
    const user = randomUser(prefix);
    await signupUser(user.username, user.password);
    const token = await mintToken(user.username, user.password);
    return { ...user, token };
}

/**
 * Drive the OAuth popup that rs.js opens during `connect(addr)` (no token).
 * Pass to `Promise.all([page.waitForEvent("popup"), …])` style tests.
 *
 * The popup loads armadietto's password prompt page (the `client_id` /
 * `redirect_uri` come pre-filled because rs.js already POST-discovered the
 * username). We fill the password and click Allow; the popup self-closes
 * after armadietto redirects to the app's redirect_uri with the token.
 */
export async function oauthPopupConsent(popup: Page, password: string): Promise<void> {
    await popup.waitForLoadState("domcontentloaded");
    await popup.locator('input[name="password"]').fill(password);
    await Promise.all([
        popup.waitForEvent("close").catch(() => undefined),
        popup.locator('button[name="allow"]').click(),
    ]);
}

/**
 * Returns true while a Playwright request is pointed at armadietto's
 * storage scope. Useful for `page.waitForRequest(isStorageRequest)`-style
 * synchronization on a real-server test.
 */
export function isStorageRequest(req: Request): boolean {
    const url = req.url();
    return url.startsWith(`${ARMADIETTO_BASE}/storage/`);
}

/**
 * Build the absolute storage URL for a path inside the app's
 * `/setlist-roller/` scope. `path` is the segment after the scope —
 * e.g. `songs/abc-123` or `settings/app-config`.
 */
function storageUrl(username: string, path: string): string {
    return `${ARMADIETTO_BASE}/storage/${username}/setlist-roller/${path}`;
}

/**
 * PUT a JSON document to the user's storage at the given path. The
 * content-type matches what rs.js's `storeObject` writes
 * (`application/json; charset=UTF-8`) so on the round-trip rs.js sees
 * a doc indistinguishable from one its own client wrote.
 */
async function putDoc(username: string, token: string, path: string, doc: unknown): Promise<void> {
    const resp = await fetch(storageUrl(username, path), {
        method: "PUT",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify(doc),
    });
    if (resp.status !== 200 && resp.status !== 201 && resp.status !== 204) {
        const text = await resp.text();
        throw new Error(`armadietto PUT ${path} returned ${resp.status}: ${text.slice(0, 200)}`);
    }
}

/** Schema-version we're seeding — matches `SCHEMA_VERSION` in src/lib/defaults.js. */
const SCHEMA_VERSION = 2;

/**
 * Pre-seed an armadietto user with songs by PUTing each doc to the
 * storage backend directly. Bypasses the app entirely — these docs
 * appear on the server before the user even connects, which lets a
 * test verify the cold-load → first-sync → catalog populated round
 * trip end-to-end. The seeded shape matches `normalizeSongRecord` in
 * src/lib/defaults.js so the app accepts the doc verbatim instead of
 * fixing up missing fields.
 */
export async function seedRemoteSongs(
    user: { username: string; token: string },
    songs: { id: string; name: string; key?: string }[],
): Promise<void> {
    const now = new Date().toISOString();
    for (const seed of songs) {
        const doc = {
            "@context": "http://remotestorage.io/spec/modules/setlist-roller/song",
            id: seed.id,
            name: seed.name,
            cover: false,
            instrumental: false,
            notGoodOpener: false,
            notGoodCloser: false,
            unpracticed: false,
            key: seed.key || "",
            notes: "",
            schemaVersion: SCHEMA_VERSION,
            createdAt: now,
            updatedAt: now,
            members: {},
        };
        await putDoc(user.username, user.token, `songs/${seed.id}`, doc);
    }
}

/**
 * Pre-seed an armadietto user with a band-config doc. Without one the
 * app cold-loads into first-run, which masks every catalog/roll
 * assertion that follows — so any roll-related real-backend test
 * needs this AND `seedRemoteSongs` to land BEFORE the connect.
 */
export async function seedRemoteConfig(user: { username: string; token: string }, bandName: string): Promise<void> {
    const now = new Date().toISOString();
    const config = {
        "@context": "http://remotestorage.io/spec/modules/setlist-roller/config",
        bandName,
        schemaVersion: SCHEMA_VERSION,
        createdAt: now,
        updatedAt: now,
        ui: { dieColor: null },
        general: {},
        show: {},
        props: {},
    };
    await putDoc(user.username, user.token, "settings/app-config", config);
}
