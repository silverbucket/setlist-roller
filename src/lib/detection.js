/**
 * Shared change detection for setlist transitions.
 *
 * Single source of truth used by both the generator (beam search + finalization)
 * and the anxiety scoring module.
 */

// ---------------------------------------------------------------------------
// Value normalization
// ---------------------------------------------------------------------------

export function normalizeValue(value) {
    if (value === undefined || value === null) return "";
    if (Array.isArray(value)) return value.slice().sort().join(",");
    return String(value);
}

export function displayValue(value) {
    if (value === undefined || value === null || value === "") return "default";
    if (Array.isArray(value)) return value.length === 0 ? "default" : value.join(", ");
    return String(value);
}

// ---------------------------------------------------------------------------
// Full detection (with notes — used for finalization / display)
// ---------------------------------------------------------------------------

/**
 * Detect instrument set changes (member's instrument itself changed,
 * or member appeared/disappeared).
 *
 * @param {object} prevPerf - previous song's performance map
 * @param {object} nextPerf - next song's performance map
 * @returns {{ changed: boolean, magnitude: number, notes: string[] }}
 */
export function detectInstrumentSetChange(prevPerf, nextPerf) {
    const members = new Set([...Object.keys(prevPerf), ...Object.keys(nextPerf)]);
    const notes = [];
    const byMember = {};
    let magnitude = 0;

    for (const member of Array.from(members).sort()) {
        const prev = prevPerf[member];
        const next = nextPerf[member];

        if (!prev || !next) {
            magnitude += 1;
            byMember[member] = 1;
            notes.push(`${member} instrument on/off`);
            continue;
        }
        if (prev.instrument !== next.instrument) {
            magnitude += 1;
            byMember[member] = 1;
            notes.push(`${member} instrument ${prev.instrument} -> ${next.instrument}`);
        }
    }

    return { changed: magnitude > 0, magnitude, notes, byMember };
}

/**
 * Detect value changes for a given field across all members present in
 * EITHER song. Members only in one song are skipped (instrument set
 * change handles the on/off transition).
 *
 * @param {object} prevPerf - previous song's performance map
 * @param {object} nextPerf - next song's performance map
 * @param {string} field - the field to compare (e.g. "tuning", "capo", "picking")
 * @param {boolean} scaleByDelta - if true, magnitude = numeric difference; else 1 per change
 * @returns {{ changed: boolean, magnitude: number, notes: string[] }}
 */
export function detectFieldChange(prevPerf, nextPerf, field, scaleByDelta) {
    const allMembers = new Set([...Object.keys(prevPerf), ...Object.keys(nextPerf)]);
    const notes = [];
    const byMember = {};
    let magnitude = 0;

    for (const member of Array.from(allMembers).sort()) {
        const prev = prevPerf[member];
        const next = nextPerf[member];

        // Member only in one song — skip field comparison
        if (!prev || !next) continue;

        const prevValue = prev[field];
        const nextValue = next[field];

        const left = normalizeValue(prevValue);
        const right = normalizeValue(nextValue);

        if (left === right) continue;

        const amount = scaleByDelta ? Math.abs((Number(prevValue) || 0) - (Number(nextValue) || 0)) : 1;
        if (!amount) continue;

        magnitude += amount;
        byMember[member] = amount;
        notes.push(`${member} ${field} ${displayValue(prevValue)} -> ${displayValue(nextValue)}`);
    }

    return { changed: magnitude > 0, magnitude, notes, byMember };
}

// ---------------------------------------------------------------------------
// Lite detection (no notes — used during beam search for speed)
// ---------------------------------------------------------------------------

/**
 * Lite version of detectInstrumentSetChange — returns { changed, magnitude } only.
 */
export function detectInstrumentSetChangeLite(prevPerf, nextPerf) {
    let magnitude = 0;
    const byMember = {};
    const prevKeys = Object.keys(prevPerf);
    const nextKeys = Object.keys(nextPerf);

    for (let i = 0; i < prevKeys.length; i++) {
        const m = prevKeys[i];
        if (!nextPerf[m]) {
            magnitude += 1;
            byMember[m] = 1;
            continue;
        }
        if (prevPerf[m].instrument !== nextPerf[m].instrument) {
            magnitude += 1;
            byMember[m] = 1;
        }
    }
    for (let i = 0; i < nextKeys.length; i++) {
        if (!prevPerf[nextKeys[i]]) {
            magnitude += 1;
            byMember[nextKeys[i]] = 1;
        }
    }

    return { changed: magnitude > 0, magnitude, byMember };
}

/**
 * Lite version of detectFieldChange — returns { changed, magnitude } only.
 */
export function detectFieldChangeLite(prevPerf, nextPerf, field, scaleByDelta) {
    let magnitude = 0;
    const byMember = {};
    const prevKeys = Object.keys(prevPerf);

    // Check members in prev
    for (let i = 0; i < prevKeys.length; i++) {
        const member = prevKeys[i];
        if (!nextPerf[member]) continue; // member only in prev — skip
        const prevValue = prevPerf[member][field];
        const nextValue = nextPerf[member][field];
        const left = normalizeValue(prevValue);
        const right = normalizeValue(nextValue);
        if (left === right) continue;
        const amount = scaleByDelta ? Math.abs((Number(prevValue) || 0) - (Number(nextValue) || 0)) : 1;
        if (!amount) continue;
        magnitude += amount;
        byMember[member] = amount;
    }

    // Members only in next (not in prev) are skipped for field changes
    // (instrument set change handles on/off).

    return { changed: magnitude > 0, magnitude, byMember };
}

// ---------------------------------------------------------------------------
// Prop kind inference
// ---------------------------------------------------------------------------

export function inferPropKind(propName) {
    if (propName === "instruments") return "instrumentSet";
    if (propName === "capo") return "instrumentDelta";
    return "instrumentField";
}
