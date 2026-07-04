import { describe, expect, it } from "vitest";
import { memberDefaultRig, normalizeSongRecord, resolveSongMembers, rigEqualsDefault } from "./defaults.js";

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
