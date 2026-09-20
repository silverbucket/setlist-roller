import { darkenHex, hexToRgb } from "./utils.js";

// Cache Storage bucket shared with the service worker. The static manifest
// (vite.config.js) points its icons at /app-icon-*.png; a CacheFirst
// runtime route in the generated SW serves those URLs from this cache
// before falling back to the network (which returns the default-orange
// PNGs shipped in /public). The app repaints the cached entries with the
// user's die color below, so an install performed after the app has run
// once mints a launcher icon in the user's color.
//
// Platform notes on how far "dynamic" can actually go:
//   - Chromium/Android bakes the icon into the WebAPK at install time and
//     fetches it through the SW — so the icon matches the die color as of
//     the moment the user installs. Later color changes don't repaint an
//     already-minted launcher icon; that's an OS constraint, not ours.
//   - iOS ignores data: URLs for apple-touch-icon entirely (the previous
//     data-URL approach silently fell back to a page screenshot). The
//     static <link rel="apple-touch-icon" href="/app-icon-180.png"> in
//     index.html gives iOS a real fetchable icon; if Safari's icon fetch
//     routes through the SW it gets the colored one, otherwise the
//     default — either way strictly better than a screenshot.
//   - The favicon and theme-color remain fully live (favicon via
//     App.svelte's data-URL <link>, theme-color via the meta upsert here).
export const ICON_CACHE_NAME = "sr-dynamic-icons";

export function generateDieSvgString(color) {
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">` +
        `<path fill="${color}" d="M256 66L420.5 161 256 256 91.5 161Z"/>` +
        `<path fill="${darkenHex(color, 0.78)}" d="M91.5 161L256 256 256 446 91.5 351Z"/>` +
        `<path fill="${darkenHex(color, 0.62)}" d="M256 256L420.5 161 420.5 351 256 446Z"/>` +
        `<path fill="none" stroke="#000" stroke-width="2.5" stroke-opacity=".1" stroke-linejoin="round" d="M256 66L420.5 161 420.5 351 256 446 91.5 351 91.5 161Z"/>` +
        `<path stroke="#000" stroke-width="2" stroke-opacity=".08" d="M256 256L91.5 161M256 256L420.5 161M256 256L256 446"/>` +
        `<ellipse cx="256" cy="113.5" rx="18" ry="10" fill="#fff"/>` +
        `<ellipse cx="338.25" cy="161" rx="18" ry="10" fill="#fff"/>` +
        `<ellipse cx="256" cy="161" rx="18" ry="10" fill="#fff"/>` +
        `<ellipse cx="173.75" cy="161" rx="18" ry="10" fill="#fff"/>` +
        `<ellipse cx="256" cy="208.5" rx="18" ry="10" fill="#fff"/>` +
        `<ellipse cx="132.6" cy="232" rx="13" ry="16" fill="#ebebeb"/>` +
        `<ellipse cx="173.8" cy="303" rx="13" ry="16" fill="#ebebeb"/>` +
        `<ellipse cx="214.9" cy="374" rx="13" ry="16" fill="#ebebeb"/>` +
        `<ellipse cx="338.3" cy="303" rx="13" ry="16" fill="#d9d9d9"/>` +
        `</svg>`
    );
}

// Transparent "any"-purpose icon: the same die, cropped tight so it fills
// ~90% of the canvas instead of floating in the 512 box's built-in margin.
export function generateAppIconSvgString(color) {
    return generateDieSvgString(color).replace('viewBox="0 0 512 512"', 'viewBox="46 46 420 420"');
}

// Near-black dice would vanish on the dark tile, so they get a light one.
function tileGradientStops(color) {
    const [r, g, b] = hexToRgb(color).split(",").map(Number);
    const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return luminance < 0.12 ? ["#f6f3ec", "#d9d4ca"] : ["#2e2e35", "#141417"];
}

// Opaque tile variant, used for the maskable manifest icon and the
// apple-touch-icon (macOS dock, iOS home screen — both render transparent
// icons badly: shrunk onto a filler square, or on flat black).
//
// The die is drawn at full size: its hexagonal silhouette has a circumradius
// of 190 around the canvas centre, inside the maskable safe zone (a circle
// of radius 0.4 * 512 = 204.8), so no adaptive-icon shape crops the artwork.
// Don't scale it down "to be safe" — that's what left a tiny die on a big
// dark square in the macOS dock. Must stay in lockstep with the static
// /public fallbacks (regenerate with `npm run icons`).
export function generateMaskableDieSvgString(color) {
    const die = generateDieSvgString(color)
        .replace(/<svg[^>]*>/, "")
        .replace("</svg>", "");
    const [top, bottom] = tileGradientStops(color);
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">` +
        `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">` +
        `<stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/>` +
        `</linearGradient></defs>` +
        `<rect width="512" height="512" fill="url(#bg)"/>` +
        die +
        `</svg>`
    );
}

function svgToPngBlob(svgString, size) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext("2d");
            if (!ctx) {
                reject(new Error("Failed to get 2d canvas context"));
                return;
            }
            ctx.drawImage(img, 0, 0, size, size);
            canvas.toBlob((blob) => {
                if (blob) resolve(blob);
                else reject(new Error("Failed to encode icon PNG"));
            }, "image/png");
        };
        img.onerror = () => reject(new Error("Failed to load SVG for PNG conversion"));
        img.src = `data:image/svg+xml,${encodeURIComponent(svgString)}`;
    });
}

function upsertMeta(name, content) {
    let el = document.querySelector(`meta[name="${name}"]`);
    if (!el) {
        el = document.createElement("meta");
        el.name = name;
        document.head.appendChild(el);
    }
    el.content = content;
}

let requestId = 0;

export async function updatePwaIcons(dieColor) {
    const currentRequest = ++requestId;

    upsertMeta("theme-color", dieColor);

    // Cache Storage requires a secure context; without it the static
    // default icons still work, we just skip the recolor.
    if (typeof caches === "undefined") return;

    const die = generateAppIconSvgString(dieColor);
    const maskable = generateMaskableDieSvgString(dieColor);
    const [png180, png192, png512, pngMaskable512] = await Promise.all([
        // Opaque tile: macOS/iOS don't handle transparent touch icons well.
        svgToPngBlob(maskable, 180),
        svgToPngBlob(die, 192),
        svgToPngBlob(die, 512),
        svgToPngBlob(maskable, 512),
    ]);

    if (currentRequest !== requestId) return;

    const cache = await caches.open(ICON_CACHE_NAME);
    if (currentRequest !== requestId) return;

    const put = (path, blob) =>
        cache.put(
            new Request(path),
            new Response(blob, {
                headers: {
                    "Content-Type": "image/png",
                    // The SW serves straight from this cache; the header is
                    // for anything that bypasses it.
                    "Cache-Control": "no-cache",
                },
            }),
        );

    await Promise.all([
        put("/app-icon-180.png", png180),
        put("/app-icon-192.png", png192),
        put("/app-icon-512.png", png512),
        put("/app-icon-maskable-512.png", pngMaskable512),
    ]);
}
