import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const AUTH_RELAY_HTML = join(import.meta.dirname, "public/auth-relay.html");
const AUTH_RELAY_JS = join(import.meta.dirname, "public/auth-relay.js");

function stripHtmlComments(html) {
    return html.replace(/<!--[\s\S]*?-->/g, "");
}

describe("auth-relay.html hardening", () => {
    it("has no inline scripts (only external auth-relay.js)", async () => {
        const html = await readFile(AUTH_RELAY_HTML, "utf8");
        const cleaned = stripHtmlComments(html);
        const inlineScripts = [...cleaned.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)].filter(
            (m) => !/\bsrc\s*=/i.test(m[1]),
        );
        expect(inlineScripts).toHaveLength(0);
        expect(cleaned).toMatch(/<script\s+src="\/auth-relay\.js"><\/script>/);
    });

    it("carries a strict CSP meta with script-src 'self' and no inline allowances", async () => {
        const html = await readFile(AUTH_RELAY_HTML, "utf8");
        const m = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
        expect(m, "CSP meta tag missing from auth-relay.html").toBeTruthy();
        const policy = m[1];
        expect(policy).toContain("script-src 'self'");
        expect(policy).not.toMatch(/script-src[^;]*'unsafe-inline'/);
        expect(policy).not.toMatch(/script-src[^;]*sha256-/);
        expect(policy).toContain("default-src 'none'");
    });

    it("posts OAuth results via postMessage from the external script", async () => {
        const js = await readFile(AUTH_RELAY_JS, "utf8");
        expect(js).toContain("setlist-roller-auth-result");
        expect(js).toContain("postMessage");
        expect(js).toContain("window.opener");
    });
});
