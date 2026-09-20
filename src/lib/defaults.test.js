import { describe, expect, it } from "vitest";
import {
    DEFAULT_APP_CONFIG,
    memberDefaultRig,
    memberHasVariableSetup,
    normalizeAppConfig,
    normalizeGearChanges,
    normalizeSongRecord,
    resolveSongMembers,
    rigEqualsDefault,
    songsReferencingKeepApart,
    syncKeepApartLinks,
} from "./defaults.js";

describe("default app config", () => {
    it("has no per-prop transition knobs (tolerance is set per member when rolling)", () => {
        for (const rule of Object.values(DEFAULT_APP_CONFIG.props)) {
            expect(rule.minStreak).toBeUndefined();
            expect(rule.returnPenalty).toBeUndefined();
            expect(rule.allowChangeOnLastSong).toBeUndefined();
        }
    });

    it("keeps stale transition knobs from older configs without reviving them as defaults", () => {
        const normalized = normalizeAppConfig({
            bandName: "Test Band",
            props: { tuning: { returnPenalty: 5, minStreak: 3 } },
        });
        expect(normalized.props.tuning.returnPenalty).toBe(5);
        expect(normalized.props.tuning.minStreak).toBe(3);
        expect(normalized.props.capo.minStreak).toBeUndefined();
    });

    it("normalizes gear-change levels", () => {
        expect(normalizeGearChanges("avoid")).toBe("avoid");
        expect(normalizeGearChanges("free")).toBe("free");
        expect(normalizeGearChanges("bogus")).toBe("minimize");
        expect(normalizeGearChanges(undefined)).toBe("minimize");
    });
});

const NICK = {
    instruments: [
        {
            name: "Guitar",
            tunings: ["Standard", "Drop D"],
            defaultTuning: "Standard",
            techniques: ["Pick", "Fingers"],
            defaultTechnique: "Pick",
        },
        { name: "Banjo", tunings: [], defaultTuning: "", techniques: [], defaultTechnique: "" },
    ],
    defaultInstrument: "Guitar",
};

describe("memberDefaultRig", () => {
    it("builds the default instrument with default tuning and technique", () => {
        expect(memberDefaultRig(NICK)).toEqual({
            instruments: [{ name: "Guitar", tuning: ["Standard"], capo: 0, picking: ["Pick"] }],
        });
    });

    it("falls back to the first instrument when no default is set", () => {
        const rig = memberDefaultRig({ instruments: [{ name: "Bass", tunings: [], defaultTuning: "" }] });
        expect(rig.instruments[0]).toMatchObject({ name: "Bass", tuning: [], picking: [] });
    });

    it("returns null for members with no instruments", () => {
        expect(memberDefaultRig({ instruments: [] })).toBeNull();
        expect(memberDefaultRig(undefined)).toBeNull();
    });
});

describe("resolveSongMembers", () => {
    const band = { Nick: NICK, Sam: { instruments: [], defaultInstrument: "" } };

    it("inherits the default rig for members without an override", () => {
        const resolved = resolveSongMembers({ members: {} }, band);
        expect(resolved.Nick.instruments[0]).toMatchObject({ name: "Guitar", tuning: ["Standard"] });
        // Sam has no gear configured — nothing to schedule, no entry.
        expect(resolved.Sam).toBeUndefined();
    });

    it("explicit overrides win over the default rig", () => {
        const override = { instruments: [{ name: "Banjo", tuning: [], capo: 2, picking: [] }] };
        const resolved = resolveSongMembers({ members: { Nick: override } }, band);
        expect(resolved.Nick).toBe(override);
    });

    it("empty overrides fall back to the default rig", () => {
        const resolved = resolveSongMembers({ members: { Nick: { instruments: [] } } }, band);
        expect(resolved.Nick.instruments[0].name).toBe("Guitar");
    });

    it("keeps song-only members that left the band config", () => {
        const ghost = { instruments: [{ name: "Theremin", tuning: [], capo: 0, picking: [] }] };
        const resolved = resolveSongMembers({ members: { Alumni: ghost } }, band);
        expect(resolved.Alumni).toBe(ghost);
    });
});

describe("memberHasVariableSetup", () => {
    const band = {
        Nick: {
            instruments: [{ name: "Banjo", tunings: ["D"], defaultTuning: "D", techniques: [] }],
            defaultInstrument: "Banjo",
        },
    };

    it("detects capo-only song changes for a member with one instrument and tuning", () => {
        const songs = [
            { members: {} },
            { members: { Nick: { instruments: [{ name: "Banjo", tuning: ["D"], capo: 2, picking: [] }] } } },
        ];
        expect(memberHasVariableSetup(songs, band, "Nick")).toBe(true);
    });

    it("is false when every song resolves to the same setup", () => {
        expect(memberHasVariableSetup([{ members: {} }, { members: {} }], band, "Nick")).toBe(false);
    });
});

describe("rigEqualsDefault", () => {
    it("matches an entry identical to the default rig", () => {
        const setup = { instruments: [{ name: "Guitar", tuning: ["Standard"], capo: 0, picking: ["Pick"] }] };
        expect(rigEqualsDefault(setup, NICK)).toBe(true);
    });

    it("rejects deviations in tuning, capo, technique, or option count", () => {
        expect(
            rigEqualsDefault(
                { instruments: [{ name: "Guitar", tuning: ["Drop D"], capo: 0, picking: ["Pick"] }] },
                NICK,
            ),
        ).toBe(false);
        expect(
            rigEqualsDefault(
                { instruments: [{ name: "Guitar", tuning: ["Standard"], capo: 3, picking: ["Pick"] }] },
                NICK,
            ),
        ).toBe(false);
        expect(
            rigEqualsDefault({ instruments: [{ name: "Guitar", tuning: ["Standard"], capo: 0, picking: [] }] }, NICK),
        ).toBe(false);
        expect(
            rigEqualsDefault(
                {
                    instruments: [
                        { name: "Guitar", tuning: ["Standard"], capo: 0, picking: ["Pick"] },
                        { name: "Banjo", tuning: [], capo: 0, picking: [] },
                    ],
                },
                NICK,
            ),
        ).toBe(false);
    });

    it("never matches for members without instruments", () => {
        expect(rigEqualsDefault({ instruments: [] }, { instruments: [] })).toBe(false);
    });
});

describe("normalizeSongRecord — member setups", () => {
    it("adds safe programming defaults to legacy songs", () => {
        const song = normalizeSongRecord({ id: "legacy", name: "Legacy" });

        expect(song.playPriority).toBe("normal");
        expect(song.energy).toBe(3);
        expect(song.positionPreference).toBe("anywhere");
    });

    it("normalizes invalid programming metadata", () => {
        const song = normalizeSongRecord({
            id: "odd",
            playPriority: "always-ish",
            energy: 99,
            positionPreference: "encore",
        });

        expect(song.playPriority).toBe("normal");
        expect(song.energy).toBe(5);
        expect(song.positionPreference).toBe("anywhere");
    });

    it("strips the legacy 'none' technique sentinel", () => {
        const song = normalizeSongRecord({
            id: "s1",
            members: { Nick: { instruments: [{ name: "Guitar", tuning: "Standard", picking: ["none"] }] } },
        });
        expect(song.members.Nick.instruments[0]).toEqual({
            name: "Guitar",
            tuning: ["Standard"],
            capo: 0,
            picking: [],
        });
    });

    it("coerces scalar tunings/pickings to arrays and numbers capo", () => {
        const song = normalizeSongRecord({
            id: "s2",
            members: { Nick: { instruments: [{ name: "Guitar", tuning: "Drop D", capo: "4", picking: "Pick" }] } },
        });
        expect(song.members.Nick.instruments[0]).toEqual({
            name: "Guitar",
            tuning: ["Drop D"],
            capo: 4,
            picking: ["Pick"],
        });
    });
});

describe("keepApartFrom", () => {
    it("normalizes to a deduplicated string list without self-reference", () => {
        const song = normalizeSongRecord({ id: "a", name: "A", keepApartFrom: ["b", "b", "a", 7, "", null] });
        expect(song.keepApartFrom).toEqual(["b", "7"]);
        expect(normalizeSongRecord({ id: "a", name: "A" }).keepApartFrom).toEqual([]);
    });

    it("syncKeepApartLinks adds and removes back-references", () => {
        const catalog = [
            { id: "a", name: "A", keepApartFrom: ["b"] },
            { id: "b", name: "B", keepApartFrom: ["a"] },
            { id: "c", name: "C", keepApartFrom: [] },
        ];
        const touched = syncKeepApartLinks({ id: "a", keepApartFrom: ["c"] }, catalog);
        expect(touched.map((s) => [s.id, s.keepApartFrom])).toEqual([
            ["b", []],
            ["c", ["a"]],
        ]);
    });

    it("songsReferencingKeepApart scrubs a deleted id", () => {
        const catalog = [
            { id: "a", name: "A", keepApartFrom: ["b", "c"] },
            { id: "c", name: "C", keepApartFrom: [] },
        ];
        const touched = songsReferencingKeepApart("b", catalog);
        expect(touched).toHaveLength(1);
        expect(touched[0].keepApartFrom).toEqual(["c"]);
    });

    it("syncKeepApartLinks returns nothing when links are already symmetric", () => {
        const catalog = [
            { id: "a", name: "A", keepApartFrom: ["b"] },
            { id: "b", name: "B", keepApartFrom: ["a"] },
        ];
        expect(syncKeepApartLinks({ id: "a", keepApartFrom: ["b"] }, catalog)).toEqual([]);
    });

    it("songsReferencingKeepApart scrubs every song that referenced the deleted id", () => {
        const catalog = [
            { id: "a", name: "A", keepApartFrom: ["gone"] },
            { id: "b", name: "B", keepApartFrom: ["gone", "c"] },
            { id: "c", name: "C", keepApartFrom: ["b"] },
        ];
        const touched = songsReferencingKeepApart("gone", catalog);
        expect(touched.map((s) => [s.id, s.keepApartFrom])).toEqual([
            ["a", []],
            ["b", ["c"]],
        ]);
    });
});

describe("normalizeAppConfig — ui.dieColor", () => {
    it("keeps a valid #rrggbb string", () => {
        expect(normalizeAppConfig({ ui: { dieColor: "#AbCdEf" } }).ui.dieColor).toBe("#AbCdEf");
    });

    it("nulls malformed and non-string values", () => {
        for (const dieColor of ["red", "#fff", 123456, ["#aabbcc"], { hex: "#aabbcc" }, true]) {
            expect(normalizeAppConfig({ ui: { dieColor } }).ui.dieColor).toBeNull();
        }
    });
});
