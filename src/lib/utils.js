export function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

export function deepMerge(left = {}, right = {}) {
    const base = clone(left);

    Object.keys(right).forEach((key) => {
        const leftValue = base[key];
        const rightValue = right[key];

        // Skip undefined right-hand values so they don't clobber the left
        // (otherwise a partial override silently erases defaults).
        if (rightValue === undefined) return;

        if (
            leftValue &&
            rightValue &&
            typeof leftValue === "object" &&
            typeof rightValue === "object" &&
            !Array.isArray(leftValue) &&
            !Array.isArray(rightValue)
        ) {
            base[key] = deepMerge(leftValue, rightValue);
            return;
        }

        base[key] = clone(rightValue);
    });

    return base;
}

export function toArray(value) {
    if (Array.isArray(value)) {
        return value.slice();
    }
    if (value === undefined || value === null || value === "") {
        return [];
    }
    return [value];
}

export function setByPath(target, path, value) {
    const parts = Array.isArray(path) ? path : String(path).split(".");
    const root = clone(target);
    let cursor = root;

    for (let index = 0; index < parts.length - 1; index += 1) {
        const key = parts[index];
        if (
            cursor[key] === undefined ||
            cursor[key] === null ||
            typeof cursor[key] !== "object" ||
            Array.isArray(cursor[key])
        ) {
            cursor[key] = {};
        }
        cursor = cursor[key];
    }

    cursor[parts[parts.length - 1]] = value;
    return root;
}

export function getByPath(target, path, fallback = undefined) {
    const parts = Array.isArray(path) ? path : String(path).split(".");
    let cursor = target;

    for (let index = 0; index < parts.length; index += 1) {
        const key = parts[index];
        if (cursor === undefined || cursor === null) {
            return fallback;
        }
        cursor = cursor[key];
    }

    return cursor === undefined ? fallback : cursor;
}

export function parseDelimitedList(value) {
    return String(value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

export function formatDelimitedList(value) {
    return toArray(value).join(", ");
}

export function titleForBand(bandName) {
    const clean = String(bandName || "").trim();
    return clean ? `${clean} — Setlist Roller` : "Setlist Roller";
}

export function uid(prefix = "id") {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
        return globalThis.crypto.randomUUID();
    }
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function nowIso() {
    return new Date().toISOString();
}

export function sortByName(list) {
    return list.slice().sort((left, right) => {
        return String(left.name || "").localeCompare(String(right.name || ""));
    });
}

export function randomFrom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

export function tryParseJson(text, fallback) {
    try {
        return JSON.parse(text);
    } catch (error) {
        // Silent in production — corrupt JSON usually means stale/foreign data
        // we can safely fall back from. Surface in dev so a real bug doesn't
        // hide behind the catch.
        if (import.meta.env?.DEV) {
            console.warn("[utils] tryParseJson failed", error, {
                textPreview: typeof text === "string" ? text.slice(0, 80) : text,
            });
        }
        return fallback;
    }
}

export const DEFAULT_DIE_COLOR = "#e15b37";

// Parse a #rrggbb string into [r, g, b]. Falls back to DEFAULT_DIE_COLOR
// for any invalid input so callers don't have to guard.
function parseHex(hex) {
    const source = typeof hex === "string" && /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : DEFAULT_DIE_COLOR;
    return [parseInt(source.slice(1, 3), 16), parseInt(source.slice(3, 5), 16), parseInt(source.slice(5, 7), 16)];
}

function toHexByte(v) {
    return Math.min(255, Math.max(0, Math.round(v)))
        .toString(16)
        .padStart(2, "0");
}

export function hexToRgb(hex) {
    const [r, g, b] = parseHex(hex);
    return `${r}, ${g}, ${b}`;
}

export function hexToRgba(hex, alpha) {
    const [r, g, b] = parseHex(hex);
    const a = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export function darkenHex(hex, factor) {
    const f = Number.isFinite(factor) ? Math.min(1, Math.max(0, factor)) : 1;
    const [r, g, b] = parseHex(hex);
    return `#${toHexByte(r * f)}${toHexByte(g * f)}${toHexByte(b * f)}`;
}
