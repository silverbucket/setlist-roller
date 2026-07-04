// Applies the persisted theme before first paint to avoid a flash of the
// wrong theme (FOITC). Loaded as a blocking external script (not inline) so
// the Content-Security-Policy can stay `script-src 'self'` with no inline
// allowances or hashes.
// SYNC: key + resolution logic duplicated from src/lib/theme.svelte.js.
try {
    const preference = localStorage.getItem("setlist-roller-theme") || "system";
    const effective =
        preference === "dark"
            ? "dark"
            : preference === "light"
              ? "light"
              : window.matchMedia("(prefers-color-scheme: dark)").matches
                ? "dark"
                : "light";
    document.documentElement.dataset.theme = effective;
} catch (_e) {
    /* storage unavailable — default theme applies */
}
