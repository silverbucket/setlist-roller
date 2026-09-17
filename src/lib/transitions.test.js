import { describe, expect, it } from "vitest";
import { memberChanges, memberSetup, needsTuningChange, songChangeLines } from "./transitions.js";

const std = { instrument: "Tele", tuning: "Standard", capo: 0, picking: "none" };

describe("memberChanges", () => {
    it("returns nothing when the setup is unchanged", () => {
        expect(memberChanges(std, std)).toEqual([]);
    });

    it("tags each kind of change and puts tuning first", () => {
        const next = { instrument: "Strat", tuning: "Drop D", capo: 2, picking: "fingerpick" };
        expect(memberChanges(next, std)).toEqual([
            { kind: "tuning", label: "Drop D" },
            { kind: "instrument", label: "Strat" },
            { kind: "capo", label: "capo 2" },
            { kind: "technique", label: "fingerpick" },
        ]);
    });

    it("reports capo removal", () => {
        expect(memberChanges({ ...std, capo: 0 }, { ...std, capo: 3 })).toEqual([{ kind: "capo", label: "capo off" }]);
    });

    it("does not report an instrument when there is no previous song", () => {
        expect(memberChanges(std, null)).toEqual([{ kind: "tuning", label: "Standard" }]);
    });

    it("ignores technique changes to none", () => {
        expect(memberChanges({ ...std, picking: "none" }, { ...std, picking: "fingerpick" })).toEqual([]);
    });
});

describe("memberSetup", () => {
    it("lists every populated field", () => {
        expect(memberSetup({ instrument: "Tele", tuning: "DADGAD", capo: 1, picking: ["slide"] })).toEqual([
            { kind: "instrument", label: "Tele" },
            { kind: "tuning", label: "DADGAD" },
            { kind: "capo", label: "capo 1" },
            { kind: "technique", label: "slide" },
        ]);
    });
});

describe("songChangeLines / needsTuningChange", () => {
    const a = { performance: { Nick: std, Sam: { ...std, instrument: "Bass" } } };
    const b = { performance: { Nick: { ...std, tuning: "Drop D" }, Sam: { ...std, instrument: "Bass" } } };

    it("only lists members who change something", () => {
        expect(songChangeLines(b, a)).toEqual([{ member: "Nick", changes: [{ kind: "tuning", label: "Drop D" }] }]);
    });

    it("marks the opening song as setup", () => {
        const lines = songChangeLines(a, null);
        expect(lines).toHaveLength(2);
        expect(lines.every((l) => l.isSetup)).toBe(true);
    });

    it("flags tuning changes", () => {
        expect(needsTuningChange(b, a)).toBe(true);
        expect(needsTuningChange(a, b)).toBe(true);
        expect(needsTuningChange(b, b)).toBe(false);
        expect(needsTuningChange(a, null)).toBe(false);
    });
});
