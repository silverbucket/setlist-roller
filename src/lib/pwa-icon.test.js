import { describe, expect, it } from "vitest";
import { generateAppIconSvgString, generateMaskableDieSvgString } from "./pwa-icon.js";
import { DEFAULT_DIE_COLOR } from "./utils.js";

const DARK_TILE = ["#2e2e35", "#141417"];
const LIGHT_TILE = ["#f6f3ec", "#d9d4ca"];

function expectTileGradient(svg, [top, bottom]) {
    expect(svg).toContain(`stop-color="${top}"`);
    expect(svg).toContain(`stop-color="${bottom}"`);
}

describe("generateAppIconSvgString", () => {
    it("crops the die tight instead of leaving the full 512 canvas margin", () => {
        const svg = generateAppIconSvgString(DEFAULT_DIE_COLOR);
        expect(svg).toContain('viewBox="46 46 420 420"');
        expect(svg).not.toContain('viewBox="0 0 512 512"');
    });
});

describe("generateMaskableDieSvgString", () => {
    it("draws the die at full size on the opaque tile (no safe-zone shrink)", () => {
        const svg = generateMaskableDieSvgString(DEFAULT_DIE_COLOR);
        expect(svg).toContain('viewBox="0 0 512 512"');
        expect(svg).not.toContain('transform="translate');
        expect(svg).not.toContain("scale(0.7)");
        expect(svg).toContain('d="M256 66L420.5 161 256 256 91.5 161Z"');
    });

    it("uses the dark gradient tile for the default die color", () => {
        expectTileGradient(generateMaskableDieSvgString(DEFAULT_DIE_COLOR), DARK_TILE);
    });

    it("uses the light gradient tile for near-black dice", () => {
        expectTileGradient(generateMaskableDieSvgString("#1a1a1a"), LIGHT_TILE);
        expectTileGradient(generateMaskableDieSvgString("#1e1e1e"), LIGHT_TILE);
    });

    it("uses the dark gradient tile once luminance clears the contrast threshold", () => {
        expectTileGradient(generateMaskableDieSvgString("#1f1f1f"), DARK_TILE);
    });
});
