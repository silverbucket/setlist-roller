import { describe, expect, it } from "vitest";
import { accentForTheme, DEFAULT_DIE_COLOR } from "./utils.js";

function luminance(hex) {
    const [r, g, b] = [1, 3, 5].map((i) => {
        const c = parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

const DARK_SURFACE = "#1a1e26";
const LIGHT_SURFACE = "#ffffff";

describe("accentForTheme", () => {
    it("leaves colours that are already legible untouched", () => {
        expect(accentForTheme(DEFAULT_DIE_COLOR, "light")).toBe(DEFAULT_DIE_COLOR);
        expect(accentForTheme(DEFAULT_DIE_COLOR, "dark")).toBe(DEFAULT_DIE_COLOR);
        expect(accentForTheme("#3b82f6", "dark")).toBe("#3b82f6");
    });

    it("lightens a near-black die colour on the dark theme", () => {
        const accent = accentForTheme("#1a1a1a", "dark");
        expect(accent).not.toBe("#1a1a1a");
        expect(contrast(accent, DARK_SURFACE)).toBeGreaterThanOrEqual(4.5);
    });

    it("darkens a near-white die colour on the light theme", () => {
        const accent = accentForTheme("#fafafa", "light");
        expect(contrast(accent, LIGHT_SURFACE)).toBeGreaterThanOrEqual(3);
    });

    it("keeps every colour legible on both themes", () => {
        for (const hex of ["#000000", "#ffffff", "#1d4ed8", "#9f1239", "#eab308", "#84cc16", "#475569"]) {
            expect(contrast(accentForTheme(hex, "dark"), DARK_SURFACE)).toBeGreaterThanOrEqual(4.5);
            expect(contrast(accentForTheme(hex, "light"), LIGHT_SURFACE)).toBeGreaterThanOrEqual(3);
        }
    });

    it("falls back to the default colour for malformed input", () => {
        expect(accentForTheme("nope", "light")).toBe(DEFAULT_DIE_COLOR);
    });
});
