import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Builds the project and inspects the generated sw.js. Catches a vite-plugin-pwa
// or Workbox bump that silently re-includes auth-relay.html in the precache —
// caching the OAuth relay would break rs.js's redirect flow. See issue #80.
let outDir;
let swJs;

beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), "sr-precache-"));
    await build({
        logLevel: "silent",
        build: { outDir, write: true, emptyOutDir: true },
    });
    swJs = await readFile(join(outDir, "sw.js"), "utf8");
}, 60_000);

afterAll(async () => {
    if (outDir) await rm(outDir, { recursive: true, force: true });
});

describe("workbox precache (built sw.js)", () => {
    it("does not include auth-relay.html (auth-relay.js may be precached)", () => {
        const m = swJs.match(/precacheAndRoute\(\[([\s\S]*?)\]/);
        expect(m, "precache array missing from sw.js").toBeTruthy();
        // Tolerate quoted/unquoted keys and either quote style from the emitter,
        // and require a non-empty match so the tripwire can't pass vacuously.
        const urls = [...m[1].matchAll(/["']?url["']?\s*:\s*["']([^"']+)["']/g)].map((x) => x[1]);
        expect(urls, "no precache URLs extracted from sw.js").not.toHaveLength(0);
        expect(urls.some((u) => u.endsWith("auth-relay.js"))).toBe(true);
        expect(urls.every((u) => !u.endsWith("auth-relay.html"))).toBe(true);
    });

    it("keeps a navigate-fallback denylist for auth-relay.html", () => {
        // The denylist stops the SPA navigate-fallback from serving index.html
        // for /auth-relay.html. The exact spacing/quoting depends on Workbox's
        // emitter, so just assert the substring appears under a denylist key.
        expect(swJs).toMatch(/denylist\s*:\s*\[[^\]]*auth-relay/);

        const denylistStart = swJs.indexOf("denylist:");
        expect(denylistStart, "denylist config missing from sw.js").toBeGreaterThan(-1);
        const bracketStart = swJs.indexOf("[", denylistStart);
        const bracketEnd = swJs.indexOf("]", bracketStart);
        const denylistLiteral = swJs.slice(bracketStart + 1, bracketEnd);
        expect(denylistLiteral, "auth-relay denylist regex missing from sw.js").toContain("auth-relay");
        const denylist = new RegExp(denylistLiteral.slice(1, -1));

        // OAuth callbacks arrive with query or hash fragments attached.
        for (const path of ["/auth-relay.html", "/auth-relay.html?code=abc", "/auth-relay.html#access_token=xyz"]) {
            expect(denylist.test(path), `denylist should exclude ${path}`).toBe(true);
        }
        expect(denylist.test("/index.html")).toBe(false);
    });
});
