// Regenerates the static default-colour icon fallbacks in /public from the
// same SVG generators the app uses at runtime (src/lib/pwa-icon.js), so the
// two can't drift. Requires `rsvg-convert` (brew install librsvg).
//
//   npm run icons
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateAppIconSvgString, generateMaskableDieSvgString } from "../src/lib/pwa-icon.js";
import { DEFAULT_DIE_COLOR } from "../src/lib/utils.js";

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const any = generateAppIconSvgString(DEFAULT_DIE_COLOR);
const tile = generateMaskableDieSvgString(DEFAULT_DIE_COLOR);

const targets = [
    ["app-icon-180.png", tile, 180],
    ["app-icon-192.png", any, 192],
    ["app-icon-512.png", any, 512],
    ["app-icon-maskable-512.png", tile, 512],
];

for (const [name, svg, size] of targets) {
    execFileSync("rsvg-convert", ["-w", String(size), "-h", String(size), "-o", `${publicDir}${name}`], {
        input: svg,
    });
    console.log(`wrote public/${name} (${size}x${size})`);
}
