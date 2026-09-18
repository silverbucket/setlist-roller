import { normalizeTechniqueValue, techniqueDisplay } from "./technique-utils.js";

/**
 * Change kinds, ordered by how disruptive they are on stage. Tuning comes
 * first because retuning is the slowest and easiest change to miss.
 */
export const CHANGE_KINDS = ["tuning", "instrument", "capo", "technique"];

const KIND_ORDER = Object.fromEntries(CHANGE_KINDS.map((kind, i) => [kind, i]));

function sortByKind(changes) {
    return changes.slice().sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

/**
 * Compute what a band member has to change between two consecutive songs.
 *
 * @param {object} curr  performance entry for the current song
 * @param {object|null|undefined} prev  performance entry for the previous song
 * @returns {{ kind: string, label: string }[]}
 */
export function memberChanges(curr, prev) {
    if (!curr) return [];
    const changes = [];
    // A member who sat out the previous song (no prev) still needs to know
    // which instrument to pick up, so a missing prev counts as a change.
    if (curr.instrument && (!prev || curr.instrument !== prev.instrument)) {
        changes.push({ kind: "instrument", label: curr.instrument });
    }
    if (curr.tuning && (!prev || curr.tuning !== prev.tuning)) {
        changes.push({ kind: "tuning", label: curr.tuning });
    }
    if (!prev || curr.capo !== prev.capo) {
        if (curr.capo) changes.push({ kind: "capo", label: `capo ${curr.capo}` });
        else if (prev?.capo) changes.push({ kind: "capo", label: "capo off" });
    }
    const currTech = normalizeTechniqueValue(curr.picking);
    const prevTech = prev ? normalizeTechniqueValue(prev.picking) : "";
    if (currTech && currTech !== prevTech) {
        const tech = techniqueDisplay(curr.picking);
        if (tech) changes.push({ kind: "technique", label: tech });
    }
    return sortByKind(changes);
}

/**
 * Describe a member's full setup for the opening song of a set.
 *
 * @param {object} perf
 * @returns {{ kind: string, label: string }[]}
 */
export function memberSetup(perf) {
    if (!perf) return [];
    const parts = [];
    if (perf.instrument) parts.push({ kind: "instrument", label: perf.instrument });
    if (perf.tuning) parts.push({ kind: "tuning", label: perf.tuning });
    if (perf.capo) parts.push({ kind: "capo", label: `capo ${perf.capo}` });
    const tech = techniqueDisplay(perf.picking);
    if (tech) parts.push({ kind: "technique", label: tech });
    return parts;
}

/**
 * Per-member change lines for a song, relative to the song before it.
 * For the first song (no prevSong) this returns each member's starting
 * setup with `isSetup: true`.
 *
 * @param {object} song
 * @param {object|null|undefined} prevSong
 * @returns {{ member: string, changes: { kind: string, label: string }[], isSetup?: boolean }[]}
 */
export function songChangeLines(song, prevSong) {
    if (!song?.performance) return [];
    const lines = [];
    for (const [member, perf] of Object.entries(song.performance)) {
        if (prevSong) {
            const changes = memberChanges(perf, prevSong.performance?.[member]);
            if (changes.length > 0) lines.push({ member, changes });
        } else {
            const changes = memberSetup(perf);
            if (changes.length > 0) lines.push({ member, changes, isSetup: true });
        }
    }
    return lines;
}

/**
 * True when any member has to retune going into this song.
 */
export function needsTuningChange(song, prevSong) {
    if (!prevSong) return false;
    return songChangeLines(song, prevSong).some((line) => line.changes.some((c) => c.kind === "tuning"));
}
