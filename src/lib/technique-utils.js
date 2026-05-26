/**
 * Normalise a technique value for comparison.
 * Filters out falsy values and "none", sorts, and joins with commas.
 *
 * @param {string|string[]} value
 * @returns {string}
 */
export function normalizeTechniqueValue(value) {
    if (!Array.isArray(value)) return String(value || "");
    return value.filter((technique) => technique && technique !== "none").slice().sort().join(",");
}

/**
 * Format a technique value for display.
 * Returns null when there is nothing meaningful to show.
 *
 * @param {string|string[]} value
 * @returns {string|null}
 */
export function techniqueDisplay(value) {
    if (!Array.isArray(value)) return value || null;
    const normalized = value.filter((technique) => technique && technique !== "none").slice().sort();
    return normalized.length ? normalized.join(", ") : null;
}
