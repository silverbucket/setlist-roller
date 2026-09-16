import { describe, expect, it, vi } from "vitest";
import { buildDefaultPerformance, generateSetlist, normalizeSongMix, scoreFixedOrder } from "./generator.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeSong(name, opts = {}) {
    return {
        id: opts.id || name.toLowerCase().replace(/\s+/g, "-"),
        name,
        cover: opts.cover || false,
        instrumental: opts.instrumental || false,
        notGoodOpener: opts.notGoodOpener || false,
        notGoodCloser: opts.notGoodCloser || false,
        unpracticed: false,
        key: opts.key ?? "G",
        schemaVersion: 1,
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
        members: opts.members || {},
    };
}

function makeConfig(overrides = {}) {
    return {
        general: {
            count: 15,
            beamWidth: 512,
            limits: { covers: 2, instrumentals: 2 },
            order: {
                first: [
                    ["notGoodOpener", false],
                    ["cover", false],
                    ["instrumental", false],
                ],
                second: [
                    ["cover", false],
                    ["instrumental", false],
                ],
                penultimate: [],
                last: [["notGoodCloser", false]],
            },
            weighting: {
                tuning: 4,
                capo: 2,
                instrument: 3,
                technique: 1,
                positionMiss: 8,
            },
            randomness: {
                variantJitter: 1.5,
                stateJitter: 1,
                finalChoicePool: 12,
                temperature: 0.85,
                shuffleCatalog: true,
                songBias: 3,
                beamChoicePoolMultiplier: 6,
                beamTemperature: 1.1,
                maxStatesPerLastSong: 24,
                blockShuffleTemperature: 1.4,
            },
            ...overrides.general,
        },
        props: overrides.props || {
            tuning: {
                kind: "instrumentField",
                field: "tuning",
            },
            capo: {
                kind: "instrumentDelta",
                field: "capo",
            },
            instruments: {
                kind: "instrumentSet",
                weightKey: "instrument",
            },
            picking: {
                kind: "instrumentField",
                field: "picking",
                weightKey: "technique",
            },
        },
        show: overrides.show || { members: {} },
        band: overrides.band || { members: {} },
    };
}

/** Fixed-seed deterministic options for reproducible tests */
function deterministicOptions(overrides = {}) {
    return {
        count: overrides.count || 10,
        seed: overrides.seed || 42,
        beamWidth: overrides.beamWidth || 64,
        randomness: {
            shuffleCatalog: false,
            songBias: 0,
            variantJitter: 0,
            stateJitter: 0,
            temperature: 0.85,
            finalChoicePool: 1,
            ...overrides.randomness,
        },
        show: overrides.show || {},
        ...overrides,
    };
}

/** Generate a catalog of simple songs (no members) */
function simpleCatalog(count) {
    return Array.from({ length: count }, (_, i) => makeSong(`Song ${i + 1}`));
}

/** Generate songs where a member alternates instruments */
function twoInstrumentCatalog(count, memberName = "nick") {
    return Array.from({ length: count }, (_, i) => {
        const instruments = [
            { name: "guitar", tuning: ["Standard"], capo: 0, picking: [] },
            { name: "banjo", tuning: ["Open G"], capo: 0, picking: [] },
        ];
        return makeSong(`Song ${i + 1}`, {
            members: {
                [memberName]: { instruments },
            },
        });
    });
}

/** Generate songs where a member has two tunings on one instrument */
function twoTuningCatalog(count, memberName = "nick") {
    return Array.from({ length: count }, (_, i) =>
        makeSong(`Song ${i + 1}`, {
            members: {
                [memberName]: {
                    instruments: [
                        {
                            name: "guitar",
                            tuning: ["Standard", "DADGAD"],
                            capo: 0,
                            picking: [],
                        },
                    ],
                },
            },
        }),
    );
}

/** Generate a catalog where only the first two songs can satisfy the alternate instrument */
function scarceInstrumentCatalog(memberName = "nick") {
    return [
        makeSong("Song A", {
            members: {
                [memberName]: {
                    instruments: [
                        {
                            name: "guitar",
                            tuning: ["Standard"],
                            capo: 0,
                            picking: [],
                        },
                        {
                            name: "banjo",
                            tuning: ["Open G"],
                            capo: 0,
                            picking: [],
                        },
                    ],
                },
            },
        }),
        makeSong("Song B", {
            members: {
                [memberName]: {
                    instruments: [
                        {
                            name: "guitar",
                            tuning: ["Standard"],
                            capo: 0,
                            picking: [],
                        },
                        {
                            name: "banjo",
                            tuning: ["Open G"],
                            capo: 0,
                            picking: [],
                        },
                    ],
                },
            },
        }),
        ...Array.from({ length: 4 }, (_, i) =>
            makeSong(`Song ${String.fromCharCode(67 + i)}`, {
                members: {
                    [memberName]: {
                        instruments: [
                            {
                                name: "guitar",
                                tuning: ["Standard"],
                                capo: 0,
                                picking: [],
                            },
                        ],
                    },
                },
            }),
        ),
    ];
}

/** Generate a catalog where only the first two songs can satisfy the alternate tuning */
function scarceTuningCatalog(memberName = "nick") {
    return [
        makeSong("Song A", {
            members: {
                [memberName]: {
                    instruments: [
                        {
                            name: "guitar",
                            tuning: ["Standard", "DADGAD"],
                            capo: 0,
                            picking: [],
                        },
                    ],
                },
            },
        }),
        makeSong("Song B", {
            members: {
                [memberName]: {
                    instruments: [
                        {
                            name: "guitar",
                            tuning: ["Standard", "DADGAD"],
                            capo: 0,
                            picking: [],
                        },
                    ],
                },
            },
        }),
        ...Array.from({ length: 4 }, (_, i) =>
            makeSong(`Song ${String.fromCharCode(67 + i)}`, {
                members: {
                    [memberName]: {
                        instruments: [
                            {
                                name: "guitar",
                                tuning: ["Standard"],
                                capo: 0,
                                picking: [],
                            },
                        ],
                    },
                },
            }),
        ),
    ];
}

function overlappingInstrumentCatalog(memberName = "nick", instrumentCount = 32) {
    const instrumentNames = Array.from({ length: instrumentCount }, (_, index) => `instrument-${index + 1}`);
    const sharedTuning = ["Standard"];

    return [
        makeSong("Flexible Song", {
            members: {
                [memberName]: {
                    instruments: instrumentNames.map((name) => ({
                        name,
                        tuning: sharedTuning,
                        capo: 0,
                        picking: [],
                    })),
                },
            },
        }),
        ...Array.from({ length: instrumentCount - 1 }, (_, index) =>
            makeSong(`Fixed Song ${index + 1}`, {
                members: {
                    [memberName]: {
                        instruments: [
                            {
                                name: instrumentNames[0],
                                tuning: sharedTuning,
                                capo: 0,
                                picking: [],
                            },
                        ],
                    },
                },
            }),
        ),
    ];
}

// ===================================================================
// Basic generation
// ===================================================================
describe("generateSetlist — basics", () => {
    it("returns the correct number of songs", () => {
        const songs = simpleCatalog(20);
        const result = generateSetlist(songs, makeConfig(), deterministicOptions({ count: 10 }));
        expect(result.songs).toHaveLength(10);
    });

    it("clamps to catalog size when count exceeds available songs", () => {
        const songs = simpleCatalog(5);
        const result = generateSetlist(songs, makeConfig(), deterministicOptions({ count: 15 }));
        expect(result.songs).toHaveLength(5);
    });

    it("handles empty catalog", () => {
        const result = generateSetlist([], makeConfig(), deterministicOptions({ count: 10 }));
        expect(result.songs).toHaveLength(0);
    });

    it("handles single song", () => {
        const result = generateSetlist([makeSong("Only")], makeConfig(), deterministicOptions({ count: 1 }));
        expect(result.songs).toHaveLength(1);
        expect(result.songs[0].name).toBe("Only");
    });

    it("each song appears at most once", () => {
        const songs = simpleCatalog(15);
        const result = generateSetlist(songs, makeConfig(), deterministicOptions({ count: 15 }));
        const ids = result.songs.map((s) => s.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("includes summary with score, covers, instrumentals, anxiety", () => {
        const songs = simpleCatalog(10);
        const result = generateSetlist(songs, makeConfig(), deterministicOptions({ count: 5 }));
        expect(result.summary).toBeDefined();
        expect(typeof result.summary.score).toBe("number");
        expect(typeof result.summary.covers).toBe("number");
        expect(typeof result.summary.instrumentals).toBe("number");
        expect(result.summary.anxiety).toBeDefined();
        expect(typeof result.summary.anxiety.scaled).toBe("number");
    });
});

// ===================================================================
// Determinism
// ===================================================================
describe("generateSetlist — programming preferences", () => {
    it("charges the default per-member tuning cost when weighting config is partial", () => {
        const songs = [
            makeSong("Standard", {
                members: {
                    nick: { instruments: [{ name: "guitar", tuning: ["Standard"], capo: 0, picking: [] }] },
                },
            }),
            makeSong("Drop D", {
                members: {
                    nick: { instruments: [{ name: "guitar", tuning: ["Drop D"], capo: 0, picking: [] }] },
                },
            }),
        ];
        const config = makeConfig({ general: { weighting: { positionMiss: 8 } } });

        const result = generateSetlist(songs, config, {
            ...deterministicOptions({ count: 2 }),
            fixedSongIds: songs.map((song) => song.id),
            setShape: "none",
        });

        // tuning weight 4 × "minimize" multiplier 1.5
        expect(result.summary.score).toBe(6);
    });

    it("always includes explicitly pinned songs", () => {
        const songs = simpleCatalog(8);
        songs[7].playPriority = "rest";

        const result = generateSetlist(songs, makeConfig(), {
            ...deterministicOptions({ count: 4, seed: 42 }),
            songMix: "hits",
            pinnedSongs: [{ id: songs[7].id, position: null }],
        });

        expect(result.songs.map((song) => song.id)).toContain(songs[7].id);
    });

    it("keeps a floating pin when a fixed-position pin takes the last slot", () => {
        // A two-song set: the floating pin can't open (notGoodOpener) and
        // the closer slot is reserved. The only way to honour both pins is
        // to relax the opener filter for the floating one — dropping it
        // in favour of a free song is not an option.
        const songs = simpleCatalog(6);
        songs[3].notGoodOpener = true;
        for (let seed = 1; seed <= 6; seed++) {
            const result = generateSetlist(songs, makeConfig(), {
                ...deterministicOptions({ count: 2, seed }),
                pinnedSongs: [
                    { id: songs[3].id, position: null },
                    { id: songs[0].id, position: 2 },
                ],
            });
            expect(result.songs.map((song) => song.id)).toEqual([songs[3].id, songs[0].id]);
        }
    });

    it("keeps pinned songs at their positions while rerolling the rest", () => {
        const songs = simpleCatalog(10);
        const options = {
            ...deterministicOptions({ count: 6, seed: 21 }),
            songMix: "balanced",
            pinnedSongs: [
                { id: songs[2].id, position: 2 },
                { id: songs[7].id, position: 5 },
            ],
        };

        const first = generateSetlist(songs, makeConfig(), options);
        const second = generateSetlist(songs, makeConfig(), { ...options, seed: 99 });

        expect(first.songs[1].id).toBe(songs[2].id);
        expect(first.songs[4].id).toBe(songs[7].id);
        expect(second.songs[1].id).toBe(songs[2].id);
        expect(second.songs[4].id).toBe(songs[7].id);
        expect(second.songs.map((song) => song.id)).not.toEqual(first.songs.map((song) => song.id));
    });

    it("selects must-play and preferred songs before normal songs", () => {
        const songs = [makeSong("Must", { id: "must" }), makeSong("Prefer", { id: "prefer" }), ...simpleCatalog(8)];
        songs[0].playPriority = "must";
        songs[1].playPriority = "prefer";

        const result = generateSetlist(songs, makeConfig(), {
            ...deterministicOptions({ count: 4, seed: 42 }),
            songMix: "balanced",
        });
        const ids = result.songs.map((song) => song.id);

        expect(ids).toContain("must");
        expect(ids).toContain("prefer");
    });

    it("rests a song when enough normal songs are available", () => {
        const songs = simpleCatalog(6);
        songs[0].playPriority = "rest";

        const result = generateSetlist(songs, makeConfig(), {
            ...deterministicOptions({ count: 4, seed: 42 }),
            songMix: "balanced",
        });

        expect(result.songs.map((song) => song.id)).not.toContain(songs[0].id);
    });

    it("builds from lower energy to higher energy", () => {
        const songs = Array.from({ length: 5 }, (_, index) => {
            const song = makeSong(`Energy ${index + 1}`);
            song.energy = index + 1;
            return song;
        });

        const result = generateSetlist(songs, makeConfig({ props: {} }), {
            ...deterministicOptions({ count: 5, seed: 42 }),
            fixedSongIds: songs.map((song) => song.id),
            setShape: "build",
        });

        expect(result.songs[0].name).toBe("Energy 1");
        expect(result.songs.at(-1).name).toBe("Energy 5");
    });

    it("honors explicit opener and closer preferences", () => {
        const songs = simpleCatalog(5);
        songs[1].positionPreference = "opener";
        songs[3].positionPreference = "closer";

        const result = generateSetlist(songs, makeConfig({ props: {} }), {
            ...deterministicOptions({ count: 5, seed: 42 }),
            fixedSongIds: songs.map((song) => song.id),
            setShape: "none",
        });

        expect(result.songs[0].id).toBe(songs[1].id);
        expect(result.songs.at(-1).id).toBe(songs[3].id);
    });
});

describe("generateSetlist — determinism", () => {
    it("same seed produces identical output", () => {
        const songs = simpleCatalog(20);
        const config = makeConfig();
        const opts = deterministicOptions({ count: 10, seed: 777 });
        const r1 = generateSetlist(songs, config, opts);
        const r2 = generateSetlist(songs, config, opts);
        expect(r1.songs.map((s) => s.id)).toEqual(r2.songs.map((s) => s.id));
    });

    it("different seeds produce different output (high probability)", () => {
        const songs = simpleCatalog(20);
        const config = makeConfig();
        const r1 = generateSetlist(songs, config, deterministicOptions({ count: 10, seed: 1 }));
        const r2 = generateSetlist(songs, config, deterministicOptions({ count: 10, seed: 2 }));
        // With 20 songs picking 10, different seeds should almost certainly differ
        const ids1 = r1.songs.map((s) => s.id).join(",");
        const ids2 = r2.songs.map((s) => s.id).join(",");
        expect(ids1).not.toBe(ids2);
    });

    it("treats seed=0 as random to match the Roll UI intent", () => {
        const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
        const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.25);

        try {
            const songs = simpleCatalog(8);
            const result = generateSetlist(songs, makeConfig(), deterministicOptions({ count: 5, seed: 0 }));
            expect(result.seed).toBe(251000);
        } finally {
            nowSpy.mockRestore();
            randomSpy.mockRestore();
        }
    });
});

// ===================================================================
// Cover / Instrumental limits
// ===================================================================
describe("generateSetlist — cover and instrumental limits", () => {
    it("respects maxCovers", () => {
        const songs = Array.from({ length: 10 }, (_, i) => makeSong(`Song ${i + 1}`, { cover: true }));
        const result = generateSetlist(songs, makeConfig(), deterministicOptions({ count: 10, maxCovers: 2 }));
        const covers = result.songs.filter((s) => s.cover);
        expect(covers.length).toBeLessThanOrEqual(2);
    });

    it("respects maxInstrumentals", () => {
        const songs = Array.from({ length: 10 }, (_, i) => makeSong(`Song ${i + 1}`, { instrumental: true }));
        const result = generateSetlist(songs, makeConfig(), deterministicOptions({ count: 10, maxInstrumentals: 1 }));
        const instrumentals = result.songs.filter((s) => s.instrumental);
        expect(instrumentals.length).toBeLessThanOrEqual(1);
    });

    it("maxCovers=-1 means no limit", () => {
        const songs = Array.from({ length: 10 }, (_, i) => makeSong(`Song ${i + 1}`, { cover: true }));
        const result = generateSetlist(songs, makeConfig(), deterministicOptions({ count: 10, maxCovers: -1 }));
        expect(result.songs.length).toBe(10);
    });

    it("maxInstrumentals=-1 means no limit", () => {
        const songs = Array.from({ length: 10 }, (_, i) => makeSong(`Song ${i + 1}`, { instrumental: true }));
        const result = generateSetlist(songs, makeConfig(), deterministicOptions({ count: 10, maxInstrumentals: -1 }));
        expect(result.songs.length).toBe(10);
    });

    it("NaN maxCovers falls back to config default", () => {
        const songs = Array.from({ length: 10 }, (_, i) => makeSong(`Song ${i + 1}`, { cover: true }));
        const config = makeConfig({
            general: { limits: { covers: 1, instrumentals: -1 } },
        });
        const result = generateSetlist(songs, config, deterministicOptions({ count: 10, maxCovers: NaN }));
        const covers = result.songs.filter((s) => s.cover);
        expect(covers.length).toBeLessThanOrEqual(1);
    });

    it("maxCovers=0 means no covers allowed", () => {
        const songs = [
            ...Array.from({ length: 5 }, (_, i) => makeSong(`Cover ${i + 1}`, { cover: true })),
            ...Array.from({ length: 5 }, (_, i) => makeSong(`Original ${i + 1}`)),
        ];
        const result = generateSetlist(songs, makeConfig(), deterministicOptions({ count: 5, maxCovers: 0 }));
        expect(result.songs.filter((s) => s.cover).length).toBe(0);
    });

    it("maxInstrumentals=0 means no instrumentals allowed", () => {
        const songs = [
            ...Array.from({ length: 5 }, (_, i) => makeSong(`Inst ${i + 1}`, { instrumental: true })),
            ...Array.from({ length: 5 }, (_, i) => makeSong(`Vocal ${i + 1}`)),
        ];
        const result = generateSetlist(songs, makeConfig(), deterministicOptions({ count: 5, maxInstrumentals: 0 }));
        expect(result.songs.filter((s) => s.instrumental).length).toBe(0);
    });

    it("all covers with maxCovers=1 produces exactly 1 song", () => {
        const songs = Array.from({ length: 5 }, (_, i) => makeSong(`Cover ${i + 1}`, { cover: true }));
        const result = generateSetlist(songs, makeConfig(), deterministicOptions({ count: 5, maxCovers: 1 }));
        expect(result.songs.length).toBe(1);
    });
});

// ===================================================================
// Position rules
// ===================================================================
describe("generateSetlist — position rules", () => {
    it("never places notGoodOpener in first position (across seeds)", () => {
        const songs = [
            makeSong("Opener", { notGoodOpener: true }),
            ...simpleCatalog(14).map((s, i) => ({
                ...s,
                id: `other-${i}`,
                name: `Other ${i + 1}`,
            })),
        ];
        const config = makeConfig();
        let openerFirst = 0;
        for (let seed = 1; seed <= 20; seed++) {
            const result = generateSetlist(songs, config, deterministicOptions({ count: 10, seed }));
            if (result.songs[0]?.name === "Opener") openerFirst++;
            expect(result.summary.openerFilterRelaxed).toBe(false);
        }
        expect(openerFirst).toBe(0);
    });

    it("never places notGoodCloser in last position (across seeds)", () => {
        const songs = [
            makeSong("Closer", { notGoodCloser: true }),
            ...simpleCatalog(14).map((s, i) => ({
                ...s,
                id: `other-${i}`,
                name: `Other ${i + 1}`,
            })),
        ];
        const config = makeConfig();
        let closerLast = 0;
        for (let seed = 1; seed <= 20; seed++) {
            const result = generateSetlist(songs, config, deterministicOptions({ count: 10, seed }));
            const last = result.songs[result.songs.length - 1];
            if (last?.name === "Closer") closerLast++;
            expect(result.summary.closerFilterRelaxed).toBe(false);
        }
        expect(closerLast).toBe(0);
    });

    it("relaxes opener filter and flags summary when every song is notGoodOpener", () => {
        const songs = simpleCatalog(10).map((s, i) => ({
            ...s,
            id: `flagged-${i}`,
            name: `Flagged ${i + 1}`,
            notGoodOpener: true,
        }));
        const result = generateSetlist(songs, makeConfig(), deterministicOptions({ count: 10, seed: 1 }));
        expect(result.songs.length).toBe(10);
        expect(result.summary.openerFilterRelaxed).toBe(true);
        expect(result.summary.closerFilterRelaxed).toBe(false);
    });

    it("relaxes closer filter and flags summary when every song is notGoodCloser", () => {
        const songs = simpleCatalog(10).map((s, i) => ({
            ...s,
            id: `flagged-${i}`,
            name: `Flagged ${i + 1}`,
            notGoodCloser: true,
        }));
        const result = generateSetlist(songs, makeConfig(), deterministicOptions({ count: 10, seed: 1 }));
        expect(result.songs.length).toBe(10);
        expect(result.summary.closerFilterRelaxed).toBe(true);
        expect(result.summary.openerFilterRelaxed).toBe(false);
    });

    it("order.first cover rule records a position miss note when cover must be opener", () => {
        // With an all-cover catalog the opener is always a cover.
        // The order.first ["cover", false] rule must fire and produce a
        // positionNotes entry — a deterministic check that the rule is applied.
        const songs = simpleCatalog(6).map((s) => ({ ...s, cover: true }));
        const config = makeConfig();
        config.general.limits.covers = -1; // no cover cap so songs fill all slots

        const result = generateSetlist(songs, config, deterministicOptions({ count: 4, seed: 1 }));
        expect(result.songs[0].cover).toBe(true);
        expect(result.songs[0].positionNotes.some((n) => n.includes("cover"))).toBe(true);
    });
});

// ===================================================================
// Variant expansion
// ===================================================================
describe("generateSetlist — variant expansion", () => {
    it("song with no members has one variant (empty performance)", () => {
        const result = generateSetlist([makeSong("Simple")], makeConfig(), deterministicOptions({ count: 1 }));
        expect(result.songs[0].performance).toEqual({});
    });

    it("song with one member and one instrument gets that performance", () => {
        const songs = [
            makeSong("Tune", {
                members: {
                    nick: {
                        instruments: [
                            {
                                name: "banjo",
                                tuning: ["Open G"],
                                capo: 0,
                                picking: ["clawhammer"],
                            },
                        ],
                    },
                },
            }),
        ];
        const result = generateSetlist(songs, makeConfig(), deterministicOptions({ count: 1 }));
        const perf = result.songs[0].performance;
        expect(perf.nick).toBeDefined();
        expect(perf.nick.instrument).toBe("banjo");
        expect(perf.nick.tuning).toBe("Open G");
    });

    it("filters variants by allowedInstruments", () => {
        const songs = twoInstrumentCatalog(5);
        const config = makeConfig({
            show: {
                members: {
                    nick: { allowedInstruments: ["guitar"] },
                },
            },
        });
        const result = generateSetlist(songs, config, deterministicOptions({ count: 5 }));
        // All songs should use guitar since banjo is filtered out
        for (const song of result.songs) {
            expect(song.performance.nick.instrument).toBe("guitar");
        }
    });

    it("song with all instruments filtered out is excluded from catalog", () => {
        const songs = [
            makeSong("Only Banjo", {
                members: {
                    nick: {
                        instruments: [
                            {
                                name: "banjo",
                                tuning: ["Open G"],
                                capo: 0,
                                picking: [],
                            },
                        ],
                    },
                },
            }),
            makeSong("Filler"),
        ];
        const config = makeConfig({
            show: {
                members: {
                    nick: { allowedInstruments: ["guitar"] }, // banjo not allowed
                },
            },
        });
        const result = generateSetlist(songs, config, deterministicOptions({ count: 2 }));
        // Only Banjo should be excluded since its only instrument is filtered
        expect(result.songs.map((s) => s.name)).not.toContain("Only Banjo");
    });
});

// ===================================================================
// Detection correctness (via generator output)
// ===================================================================
describe("generateSetlist — change detection", () => {
    it("detects tuning changes in transition notes", () => {
        const songs = [
            makeSong("Song A", {
                members: {
                    nick: {
                        instruments: [
                            {
                                name: "guitar",
                                tuning: ["Standard"],
                                capo: 0,
                                picking: [],
                            },
                        ],
                    },
                },
            }),
            makeSong("Song B", {
                members: {
                    nick: {
                        instruments: [
                            {
                                name: "guitar",
                                tuning: ["DADGAD"],
                                capo: 0,
                                picking: [],
                            },
                        ],
                    },
                },
            }),
        ];
        const result = generateSetlist(songs, makeConfig(), deterministicOptions({ count: 2 }));
        // One of the songs should have tuning in transition notes
        const allNotes = result.songs.flatMap((s) => s.transitionNotes);
        expect(allNotes.some((n) => n.includes("tuning"))).toBe(true);
    });

    it("array picking order does NOT cause false change detection", () => {
        // Both songs have same techniques, just different array ordering
        const songs = [
            makeSong("Song A", {
                members: {
                    nick: {
                        instruments: [
                            {
                                name: "guitar",
                                tuning: ["Standard"],
                                capo: 0,
                                picking: ["slide", "picking"],
                            },
                        ],
                    },
                },
            }),
            makeSong("Song B", {
                members: {
                    nick: {
                        instruments: [
                            {
                                name: "guitar",
                                tuning: ["Standard"],
                                capo: 0,
                                picking: ["picking", "slide"],
                            },
                        ],
                    },
                },
            }),
        ];
        const result = generateSetlist(songs, makeConfig(), deterministicOptions({ count: 2 }));
        // Second song should have no picking change
        const song2 = result.songs[1];
        expect(song2.propChanges.picking.changed).toBe(false);
    });

    it("detects member appearing as instrument set change", () => {
        const songs = [
            makeSong("Song A", { members: {} }),
            makeSong("Song B", {
                members: {
                    nick: {
                        instruments: [
                            {
                                name: "banjo",
                                tuning: ["Open G"],
                                capo: 0,
                                picking: [],
                            },
                        ],
                    },
                },
            }),
        ];
        const result = generateSetlist(songs, makeConfig(), deterministicOptions({ count: 2 }));
        const song2 = result.songs[1];
        expect(song2.propChanges.instruments.changed).toBe(true);
    });

    it("detects member disappearing as instrument set change", () => {
        const songs = [
            makeSong("Song A", {
                members: {
                    nick: {
                        instruments: [
                            {
                                name: "banjo",
                                tuning: ["Open G"],
                                capo: 0,
                                picking: [],
                            },
                        ],
                    },
                },
            }),
            makeSong("Song B", { members: {} }),
        ];
        const result = generateSetlist(songs, makeConfig(), deterministicOptions({ count: 2 }));
        const song2 = result.songs[1];
        expect(song2.propChanges.instruments.changed).toBe(true);
    });

    it("capo change magnitude reflects numeric delta", () => {
        const songs = [
            makeSong("Song A", {
                members: {
                    nick: {
                        instruments: [
                            {
                                name: "guitar",
                                tuning: ["Standard"],
                                capo: 0,
                                picking: [],
                            },
                        ],
                    },
                },
            }),
            makeSong("Song B", {
                members: {
                    nick: {
                        instruments: [
                            {
                                name: "guitar",
                                tuning: ["Standard"],
                                capo: 3,
                                picking: [],
                            },
                        ],
                    },
                },
            }),
        ];
        const result = generateSetlist(songs, makeConfig(), deterministicOptions({ count: 2 }));
        const song2 = result.songs[1];
        expect(song2.propChanges.capo.changed).toBe(true);
        expect(song2.propChanges.capo.magnitude).toBe(3);
    });
});

// ===================================================================
// ===================================================================
describe("generateSetlist — minSongsPerInstrument", () => {
    it("both instruments appear at least min times with sufficient catalog", () => {
        const songs = twoInstrumentCatalog(15);
        const config = makeConfig();
        const opts = deterministicOptions({
            count: 10,
            show: {
                members: {
                    nick: {
                        allowedInstruments: ["guitar", "banjo"],
                        minSongsPerInstrument: 2,
                    },
                },
            },
        });

        let bothMet = 0;
        for (let seed = 1; seed <= 10; seed++) {
            const result = generateSetlist(songs, config, { ...opts, seed });
            const guitarCount = result.songs.filter((s) => s.performance.nick?.instrument === "guitar").length;
            const banjoCount = result.songs.filter((s) => s.performance.nick?.instrument === "banjo").length;
            if (guitarCount >= 2 && banjoCount >= 2) bothMet++;
        }
        // Should meet minimums most of the time
        expect(bothMet).toBeGreaterThanOrEqual(7);
    });

    it("still produces a result when minimums are impossible", () => {
        // Only 3 songs but min=5 per instrument
        const songs = twoInstrumentCatalog(3);
        const config = makeConfig();
        const opts = deterministicOptions({
            count: 3,
            show: {
                members: {
                    nick: {
                        allowedInstruments: ["guitar", "banjo"],
                        minSongsPerInstrument: 5,
                    },
                },
            },
        });
        const result = generateSetlist(songs, config, opts);
        // Should still produce some result even if minimums can't be met
        expect(result.songs.length).toBeGreaterThan(0);
    });

    it("instrument switch actually happens in the setlist", () => {
        const songs = twoInstrumentCatalog(10);
        const config = makeConfig();
        const opts = deterministicOptions({
            count: 8,
            show: {
                members: {
                    nick: {
                        allowedInstruments: ["guitar", "banjo"],
                        minSongsPerInstrument: 3,
                    },
                },
            },
        });

        let hasBoth = 0;
        for (let seed = 1; seed <= 10; seed++) {
            const result = generateSetlist(songs, config, { ...opts, seed });
            const instruments = new Set(result.songs.map((s) => s.performance.nick?.instrument));
            if (instruments.has("guitar") && instruments.has("banjo")) hasBoth++;
        }
        expect(hasBoth).toBeGreaterThanOrEqual(8);
    });

    it("treats the requirement as hard when a satisfying set exists", () => {
        const songs = scarceInstrumentCatalog();
        const config = makeConfig();
        const opts = deterministicOptions({
            count: 4,
            show: {
                members: {
                    nick: {
                        allowedInstruments: ["guitar", "banjo"],
                        minSongsPerInstrument: 2,
                    },
                },
            },
        });

        for (let seed = 1; seed <= 10; seed++) {
            const result = generateSetlist(songs, config, { ...opts, seed });
            const counts = result.songs.reduce((acc, song) => {
                const instrument = song.performance.nick?.instrument;
                acc[instrument] = (acc[instrument] || 0) + 1;
                return acc;
            }, {});

            expect(counts.guitar).toBe(2);
            expect(counts.banjo).toBe(2);
            expect(result.summary.minimumsRelaxed).toBe(false);
        }
    });

    it("falls back to best effort only when the requirement is impossible", () => {
        const songs = [
            makeSong("Song A", {
                members: {
                    nick: {
                        instruments: [
                            {
                                name: "guitar",
                                tuning: ["Standard"],
                                capo: 0,
                                picking: [],
                            },
                            {
                                name: "banjo",
                                tuning: ["Open G"],
                                capo: 0,
                                picking: [],
                            },
                        ],
                    },
                },
            }),
            ...Array.from({ length: 3 }, (_, i) =>
                makeSong(`Song ${i + 2}`, {
                    members: {
                        nick: {
                            instruments: [
                                {
                                    name: "guitar",
                                    tuning: ["Standard"],
                                    capo: 0,
                                    picking: [],
                                },
                            ],
                        },
                    },
                }),
            ),
        ];
        const config = makeConfig();
        const result = generateSetlist(
            songs,
            config,
            deterministicOptions({
                count: 4,
                show: {
                    members: {
                        nick: {
                            allowedInstruments: ["guitar", "banjo"],
                            minSongsPerInstrument: 2,
                        },
                    },
                },
            }),
        );

        expect(result.songs).toHaveLength(4);
        expect(result.summary.minimumsRelaxed).toBe(true);
    });

    it("handles large overlapping instrument groups without overflow and relaxes impossible minimums", () => {
        const songs = overlappingInstrumentCatalog();
        const allowedInstruments = songs[0].members.nick.instruments.map((instrument) => instrument.name);
        const config = makeConfig({
            general: {
                weighting: {
                    tuning: 4,
                    capo: 2,
                    instrument: 0,
                    technique: 1,
                    positionMiss: 8,
                    earlyCover: 2,
                    earlyInstrumental: 2,
                },
            },
        });

        const result = generateSetlist(
            songs,
            config,
            deterministicOptions({
                count: allowedInstruments.length,
                show: {
                    members: {
                        nick: {
                            allowedInstruments,
                            minSongsPerInstrument: 1,
                        },
                    },
                },
            }),
        );

        expect(result.songs).toHaveLength(allowedInstruments.length);
        expect(result.summary.minimumsRelaxed).toBe(true);
    });
});

// ===================================================================
// minSongsPerTuning enforcement
// ===================================================================
describe("generateSetlist — minSongsPerTuning", () => {
    it("both tunings appear at least min times with sufficient catalog", () => {
        const songs = twoTuningCatalog(15);
        const config = makeConfig();
        const opts = deterministicOptions({
            count: 10,
            show: {
                members: {
                    nick: {
                        allowedTunings: { guitar: ["Standard", "DADGAD"] },
                        minSongsPerTuning: { guitar: 2 },
                    },
                },
            },
        });

        let bothMet = 0;
        for (let seed = 1; seed <= 10; seed++) {
            const result = generateSetlist(songs, config, { ...opts, seed });
            const standardCount = result.songs.filter((s) => s.performance.nick?.tuning === "Standard").length;
            const dadgadCount = result.songs.filter((s) => s.performance.nick?.tuning === "DADGAD").length;
            if (standardCount >= 2 && dadgadCount >= 2) bothMet++;
        }
        expect(bothMet).toBeGreaterThanOrEqual(7);
    });

    it("treats tuning minimums as hard when a satisfying set exists", () => {
        const songs = scarceTuningCatalog();
        const config = makeConfig();
        const opts = deterministicOptions({
            count: 4,
            show: {
                members: {
                    nick: {
                        allowedTunings: { guitar: ["Standard", "DADGAD"] },
                        minSongsPerTuning: { guitar: 2 },
                    },
                },
            },
        });

        for (let seed = 1; seed <= 10; seed++) {
            const result = generateSetlist(songs, config, { ...opts, seed });
            const counts = result.songs.reduce((acc, song) => {
                const tuning = song.performance.nick?.tuning;
                acc[tuning] = (acc[tuning] || 0) + 1;
                return acc;
            }, {});

            expect(counts.Standard).toBe(2);
            expect(counts.DADGAD).toBe(2);
            expect(result.summary.minimumsRelaxed).toBe(false);
        }
    });
});

// ===================================================================
// Per-member gear changes (Demands → "Changes between songs")
// ===================================================================
describe("generateSetlist — per-member gear changes", () => {
    function countMemberChanges(result, memberName) {
        let changes = 0;
        for (let i = 1; i < result.songs.length; i++) {
            const prev = result.songs[i - 1].performance[memberName];
            const next = result.songs[i].performance[memberName];
            if (prev && next && prev.tuning !== next.tuning) changes++;
        }
        return changes;
    }

    /** Two members, each with their own independent tuning assignment. */
    function twoMemberCatalog(size) {
        const tunings = ["Standard", "Drop D", "DADGAD"];
        return Array.from({ length: size }, (_, i) =>
            makeSong(`Duo ${i + 1}`, {
                id: `duo-${i + 1}`,
                members: {
                    nick: { instruments: [{ name: "guitar", tuning: [tunings[i % 3]], capo: 0, picking: [] }] },
                    mark: {
                        instruments: [
                            { name: "guitar", tuning: [tunings[Math.floor(i / 3) % 3]], capo: 0, picking: [] },
                        ],
                    },
                },
            }),
        );
    }

    function roll(show, seed) {
        return generateSetlist(twoMemberCatalog(27), makeConfig(), {
            ...deterministicOptions({ count: 9, seed }),
            setShape: "none",
            show,
        });
    }

    it("scores a member's changes by their own level", () => {
        const songs = [
            makeSong("Standard", {
                members: { nick: { instruments: [{ name: "guitar", tuning: ["Standard"], capo: 0, picking: [] }] } },
            }),
            makeSong("Drop D", {
                members: { nick: { instruments: [{ name: "guitar", tuning: ["Drop D"], capo: 0, picking: [] }] } },
            }),
        ];
        const score = (gearChanges) =>
            generateSetlist(songs, makeConfig(), {
                ...deterministicOptions({ count: 2 }),
                fixedSongIds: songs.map((song) => song.id),
                setShape: "none",
                show: { members: { nick: { gearChanges } } },
            }).summary.score;

        expect(score("free")).toBe(0);
        expect(score("minimize")).toBe(6);
        expect(score("avoid")).toBe(24);
        expect(score(undefined)).toBe(6);
    });

    it("a member set to avoid changes far less than one who doesn't care", () => {
        let avoidChanges = 0;
        let freeChanges = 0;
        for (let seed = 1; seed <= 10; seed++) {
            const result = roll({ members: { nick: { gearChanges: "avoid" }, mark: { gearChanges: "free" } } }, seed);
            avoidChanges += countMemberChanges(result, "nick");
            freeChanges += countMemberChanges(result, "mark");
        }
        expect(avoidChanges).toBeLessThanOrEqual(10);
        expect(freeChanges).toBeGreaterThan(avoidChanges * 2);
    });

    it("swapping the levels swaps who gets protected", () => {
        let nickChanges = 0;
        let markChanges = 0;
        for (let seed = 1; seed <= 10; seed++) {
            const result = roll({ members: { nick: { gearChanges: "free" }, mark: { gearChanges: "avoid" } } }, seed);
            nickChanges += countMemberChanges(result, "nick");
            markChanges += countMemberChanges(result, "mark");
        }
        expect(markChanges).toBeLessThanOrEqual(10);
        expect(nickChanges).toBeGreaterThan(markChanges * 2);
    });

    it("selects songs with grouping in mind, not just orders them", () => {
        // 27 songs, 9 per tuning for nick: an "avoid" roll of 9 should be
        // able to stay in one or two tunings rather than sampling all three.
        for (let seed = 1; seed <= 6; seed++) {
            const result = roll({ members: { nick: { gearChanges: "avoid" }, mark: { gearChanges: "free" } } }, seed);
            expect(countMemberChanges(result, "nick")).toBeLessThanOrEqual(1);
        }
    });

    it("ignores legacy general.weighting from older configs", () => {
        const songs = [
            makeSong("Standard", {
                members: { nick: { instruments: [{ name: "guitar", tuning: ["Standard"], capo: 0, picking: [] }] } },
            }),
            makeSong("Drop D", {
                members: { nick: { instruments: [{ name: "guitar", tuning: ["Drop D"], capo: 0, picking: [] }] } },
            }),
        ];
        const legacy = makeConfig({ general: { weighting: { tuning: 0 } } });
        const options = {
            ...deterministicOptions({ count: 2 }),
            fixedSongIds: songs.map((song) => song.id),
            setShape: "none",
            show: { members: { nick: { gearChanges: "avoid" } } },
        };
        expect(generateSetlist(songs, legacy, options).summary.score).toBe(24);
        const fixed = songs.map((song, index) => ({
            ...song,
            performance: {
                nick: { instrument: "guitar", tuning: index === 0 ? "Standard" : "Drop D", capo: 0, picking: [] },
            },
        }));
        expect(scoreFixedOrder(fixed, legacy, { show: options.show }).summary.score).toBe(24);
    });

    it("scoreFixedOrder applies the same per-member levels", () => {
        const songs = twoTuningCatalog(2).map((song, index) => ({
            ...song,
            performance: {
                nick: { instrument: "guitar", tuning: index === 0 ? "Standard" : "Drop D", capo: 0, picking: [] },
            },
        }));
        const avoid = scoreFixedOrder(songs, makeConfig(), { show: { members: { nick: { gearChanges: "avoid" } } } });
        const free = scoreFixedOrder(songs, makeConfig(), { show: { members: { nick: { gearChanges: "free" } } } });
        expect(avoid.summary.score).toBe(24);
        expect(free.summary.score).toBe(0);
    });

    it("across seeds, avoid and minimize incur far fewer tuning changes than free", { timeout: 15_000 }, () => {
        const tunings = ["Standard", "Drop D", "DADGAD"];
        const songs = Array.from({ length: 36 }, (_, i) =>
            makeSong(`Song ${i + 1}`, {
                id: `mix-${i + 1}`,
                members: {
                    nick: {
                        instruments: [{ name: "guitar", tuning: [tunings[i % 3]], capo: 0, picking: [] }],
                    },
                },
            }),
        );

        const countTuningChanges = (gearChanges) => {
            let total = 0;
            for (let seed = 1; seed <= 20; seed++) {
                const result = generateSetlist(songs, makeConfig(), {
                    ...deterministicOptions({ count: 12, seed }),
                    setShape: "none",
                    show: { members: { nick: { gearChanges } } },
                });
                for (let i = 1; i < result.songs.length; i++) {
                    const prev = result.songs[i - 1].performance.nick;
                    const next = result.songs[i].performance.nick;
                    if (prev && next && prev.tuning !== next.tuning) total++;
                }
            }
            return total;
        };

        const avoid = countTuningChanges("avoid");
        const minimize = countTuningChanges("minimize");
        const free = countTuningChanges("free");

        expect(avoid).toBeLessThanOrEqual(minimize);
        expect(minimize).toBeLessThan(free / 2);
    });
});

// ===================================================================
// Song mix
// ===================================================================
describe("generateSetlist — song mix", () => {
    it("greatest hits leans on preferred songs, dig deeper reaches past them", () => {
        const songs = simpleCatalog(12);
        for (let i = 0; i < 4; i++) songs[i].playPriority = "prefer";
        const preferredIds = new Set(songs.slice(0, 4).map((song) => song.id));

        const count = (songMix) => {
            let picked = 0;
            for (let seed = 1; seed <= 8; seed++) {
                const result = generateSetlist(songs, makeConfig(), {
                    ...deterministicOptions({ count: 4, seed }),
                    songMix,
                });
                picked += result.songs.filter((song) => preferredIds.has(song.id)).length;
            }
            return picked;
        };

        expect(count("hits")).toBeGreaterThan(count("deep"));
    });

    it("inherited object names are not valid mixes", () => {
        expect(normalizeSongMix("constructor")).toBe("balanced");
        expect(normalizeSongMix("toString")).toBe("balanced");
        expect(normalizeSongMix("hits")).toBe("hits");
    });

    it("unknown mixes fall back to balanced", () => {
        const songs = simpleCatalog(6);
        const a = generateSetlist(songs, makeConfig(), {
            ...deterministicOptions({ count: 4, seed: 3 }),
            songMix: "bogus",
        });
        const b = generateSetlist(songs, makeConfig(), {
            ...deterministicOptions({ count: 4, seed: 3 }),
            songMix: "balanced",
        });
        expect(a.songs.map((song) => song.id)).toEqual(b.songs.map((song) => song.id));
    });

    it("surprise me explores the catalog more than greatest hits", () => {
        const songs = simpleCatalog(20);
        for (let i = 0; i < 10; i++) songs[i].playPriority = "prefer";

        const uniqueSongs = (songMix) => {
            const seen = new Set();
            for (let seed = 1; seed <= 20; seed++) {
                generateSetlist(songs, makeConfig(), {
                    count: 6,
                    seed,
                    beamWidth: 64,
                    songMix,
                    randomness: {
                        shuffleCatalog: false,
                        variantJitter: 0,
                        stateJitter: 0,
                        temperature: 0.85,
                        finalChoicePool: 8,
                    },
                }).songs.forEach((song) => {
                    seen.add(song.id);
                });
            }
            return seen.size;
        };

        expect(uniqueSongs("surprise")).toBeGreaterThan(uniqueSongs("hits"));
    });
});

describe("generateSetlist — legacy config knobs", () => {
    it("ignores stale per-prop transition knobs from older configs", () => {
        const songs = twoTuningCatalog(6);
        const withKnobs = makeConfig({
            props: {
                tuning: { kind: "instrumentField", field: "tuning", minStreak: 99, returnPenalty: 99 },
                capo: { kind: "instrumentDelta", field: "capo" },
                instruments: { kind: "instrumentSet", weightKey: "instrument" },
                picking: { kind: "instrumentField", field: "picking", weightKey: "technique" },
            },
        });
        const options = {
            ...deterministicOptions({ count: 4, seed: 7 }),
            fixedSongIds: songs.map((song) => song.id),
            setShape: "none",
        };

        const withLegacy = generateSetlist(songs, withKnobs, options);
        const baseline = generateSetlist(songs, makeConfig(), options);

        expect(withLegacy.songs.map((song) => song.id)).toEqual(baseline.songs.map((song) => song.id));
        expect(withLegacy.summary.score).toBe(baseline.summary.score);
    });
});

// ===================================================================
// scoreFixedOrder
// ===================================================================
describe("scoreFixedOrder", () => {
    const config = makeConfig();

    it("returns correct structure", () => {
        const songs = [
            {
                id: "1",
                name: "A",
                performance: {
                    nick: {
                        instrument: "guitar",
                        tuning: "Standard",
                        capo: 0,
                        picking: [],
                    },
                },
            },
            {
                id: "2",
                name: "B",
                performance: {
                    nick: {
                        instrument: "guitar",
                        tuning: "DADGAD",
                        capo: 0,
                        picking: [],
                    },
                },
            },
        ];
        const result = scoreFixedOrder(songs, config);
        expect(result.songs).toHaveLength(2);
        expect(result.summary).toBeDefined();
        expect(result.summary.anxiety).toBeDefined();
    });

    it("scores identical songs as 0", () => {
        const perf = {
            nick: {
                instrument: "guitar",
                tuning: "Standard",
                capo: 0,
                picking: [],
            },
        };
        const songs = [
            { id: "1", name: "A", performance: perf },
            { id: "2", name: "B", performance: perf },
            { id: "3", name: "C", performance: perf },
        ];
        const result = scoreFixedOrder(songs, config);
        expect(result.summary.score).toBe(0);
    });

    it("detects tuning change with correct weight", () => {
        const songs = [
            {
                id: "1",
                name: "A",
                performance: {
                    nick: {
                        instrument: "guitar",
                        tuning: "Standard",
                        capo: 0,
                        picking: [],
                    },
                },
            },
            {
                id: "2",
                name: "B",
                performance: {
                    nick: {
                        instrument: "guitar",
                        tuning: "DADGAD",
                        capo: 0,
                        picking: [],
                    },
                },
            },
        ];
        const result = scoreFixedOrder(songs, config);
        expect(result.songs[1].propChanges.tuning.changed).toBe(true);
        expect(result.songs[1].incrementalScore).toBe(6); // weight 4 × default "minimize" 1.5
    });

    it("uses shared detection (array order independence)", () => {
        const songs = [
            {
                id: "1",
                name: "A",
                performance: {
                    nick: {
                        instrument: "guitar",
                        tuning: "Standard",
                        capo: 0,
                        picking: ["slide", "picking"],
                    },
                },
            },
            {
                id: "2",
                name: "B",
                performance: {
                    nick: {
                        instrument: "guitar",
                        tuning: "Standard",
                        capo: 0,
                        picking: ["picking", "slide"],
                    },
                },
            },
        ];
        const result = scoreFixedOrder(songs, config);
        expect(result.songs[1].propChanges.picking.changed).toBe(false);
    });

    it("includes anxiety in summary", () => {
        const songs = [
            {
                id: "1",
                name: "A",
                performance: {
                    nick: {
                        instrument: "guitar",
                        tuning: "Standard",
                        capo: 0,
                        picking: [],
                    },
                },
            },
            {
                id: "2",
                name: "B",
                performance: {
                    nick: {
                        instrument: "banjo",
                        tuning: "Open G",
                        capo: 0,
                        picking: ["clawhammer"],
                    },
                },
            },
        ];
        const result = scoreFixedOrder(songs, config);
        expect(result.summary.anxiety.scaled).toBeGreaterThan(0);
    });

    it("detects member appearing/disappearing", () => {
        const songs = [
            {
                id: "1",
                name: "A",
                performance: {
                    nick: {
                        instrument: "banjo",
                        tuning: "Open G",
                        capo: 0,
                        picking: [],
                    },
                },
            },
            { id: "2", name: "B", performance: {} },
            {
                id: "3",
                name: "C",
                performance: {
                    nick: {
                        instrument: "banjo",
                        tuning: "Open G",
                        capo: 0,
                        picking: [],
                    },
                },
            },
        ];
        const result = scoreFixedOrder(songs, config);
        // nick disappears in song 2
        expect(result.songs[1].propChanges.instruments.changed).toBe(true);
        // nick reappears in song 3
        expect(result.songs[2].propChanges.instruments.changed).toBe(true);
    });

    it("includes key flow scoring when options.keyFlow is true", () => {
        const perf = {
            nick: {
                instrument: "guitar",
                tuning: "Standard",
                capo: 0,
                picking: [],
            },
        };
        const songs = [
            { id: "1", name: "A", key: "C", performance: perf },
            { id: "2", name: "B", key: "F#", performance: perf },
        ];
        const withFlow = scoreFixedOrder(songs, config, { keyFlow: true });
        const withoutFlow = scoreFixedOrder(songs, config, { keyFlow: false });

        // Key flow should add penalty for distant keys (C to F# = tritone = distance 6)
        expect(withFlow.summary.score).toBeGreaterThan(withoutFlow.summary.score);
    });
});

// ===================================================================
// Edge cases
// ===================================================================
describe("generateSetlist — edge cases", () => {
    it("generates with no props configured", () => {
        const songs = simpleCatalog(10);
        const config = makeConfig({ props: {} });
        const result = generateSetlist(songs, config, deterministicOptions({ count: 5 }));
        expect(result.songs).toHaveLength(5);
        expect(result.summary.score).toBe(0);
    });

    it("handles songs where every song has cover=true and instrumental=true", () => {
        const songs = Array.from({ length: 5 }, (_, i) =>
            makeSong(`Song ${i + 1}`, { cover: true, instrumental: true }),
        );
        const result = generateSetlist(
            songs,
            makeConfig(),
            deterministicOptions({
                count: 5,
                maxCovers: 5,
                maxInstrumentals: 5,
            }),
        );
        expect(result.songs.length).toBeGreaterThan(0);
    });

    it("handles mixed catalog — some songs with members, some without", () => {
        const songs = [
            makeSong("With Members", {
                members: {
                    nick: {
                        instruments: [
                            {
                                name: "guitar",
                                tuning: ["Standard"],
                                capo: 0,
                                picking: [],
                            },
                        ],
                    },
                },
            }),
            makeSong("Without Members"),
            makeSong("Also Without"),
        ];
        const result = generateSetlist(songs, makeConfig(), deterministicOptions({ count: 3 }));
        expect(result.songs).toHaveLength(3);
    });
});

// ---------------------------------------------------------------------------
// fixedSongIds
// ---------------------------------------------------------------------------

describe("generateSetlist — excludedSongIds", () => {
    const catalog = Array.from({ length: 8 }, (_, i) => makeSong(`Song ${i + 1}`));

    it("never selects excluded songs", () => {
        const excludedSongIds = ["song-1", "song-2", "song-3"];
        const result = generateSetlist(catalog, makeConfig(), deterministicOptions({ count: 4, excludedSongIds }));

        expect(result.songs).toHaveLength(4);
        expect(result.songs.map((song) => song.id)).not.toEqual(expect.arrayContaining(excludedSongIds));
    });

    it("clamps the result to the remaining catalog", () => {
        const result = generateSetlist(
            catalog,
            makeConfig(),
            deterministicOptions({ count: 6, excludedSongIds: catalog.slice(0, 6).map((song) => song.id) }),
        );

        expect(result.songs.map((song) => song.id).sort()).toEqual(["song-7", "song-8"]);
    });
});

describe("generateSetlist — fixedSongIds", () => {
    const catalog = Array.from({ length: 10 }, (_, i) => makeSong(`Song ${i + 1}`));

    it("restricts output to exactly the fixed song IDs", () => {
        const fixedIds = ["song-2", "song-5", "song-7"];
        const result = generateSetlist(
            catalog,
            makeConfig(),
            deterministicOptions({
                count: 3,
                fixedSongIds: fixedIds,
            }),
        );
        expect(result.songs).toHaveLength(3);
        const resultIds = result.songs.map((s) => s.id).sort();
        expect(resultIds).toEqual([...fixedIds].sort());
    });

    it("ignores count option and uses all fixed songs", () => {
        const fixedIds = ["song-1", "song-3", "song-4", "song-6"];
        const result = generateSetlist(
            catalog,
            makeConfig(),
            deterministicOptions({
                count: 2,
                fixedSongIds: fixedIds,
            }),
        );
        expect(result.songs).toHaveLength(4);
    });

    it("includes songs that would be filtered without fixedSongIds", () => {
        // Without fixedSongIds, song-8 through song-10 would be in the pool.
        // With fixedSongIds, only the specified subset is used.
        const fixedIds = ["song-1", "song-2"];
        const result = generateSetlist(
            catalog,
            makeConfig(),
            deterministicOptions({
                count: 10,
                fixedSongIds: fixedIds,
            }),
        );
        expect(result.songs).toHaveLength(2);
        const resultIds = result.songs.map((s) => s.id).sort();
        expect(resultIds).toEqual([...fixedIds].sort());
    });
});

// ---------------------------------------------------------------------------
// buildDefaultPerformance
// ---------------------------------------------------------------------------

describe("buildDefaultPerformance", () => {
    it("returns performance for a song with members", () => {
        const song = makeSong("Tune", {
            members: {
                nick: {
                    instruments: [
                        {
                            name: "guitar",
                            tuning: ["Standard"],
                            capo: 0,
                            picking: ["pick"],
                        },
                    ],
                },
            },
        });
        const perf = buildDefaultPerformance(song);
        expect(perf).toHaveProperty("nick");
        expect(perf.nick.instrument).toBe("guitar");
        expect(perf.nick.tuning).toBe("Standard");
    });

    it("returns empty object for song with no members", () => {
        const song = makeSong("Simple");
        const perf = buildDefaultPerformance(song);
        expect(perf).toEqual({});
    });

    it("returns empty object when show constraints filter all instruments", () => {
        const song = makeSong("Filtered", {
            members: {
                nick: {
                    instruments: [
                        {
                            name: "banjo",
                            tuning: ["Open G"],
                            capo: 0,
                            picking: [],
                        },
                    ],
                },
            },
        });
        const perf = buildDefaultPerformance(song, {
            members: { nick: { allowedInstruments: ["guitar"] } },
        });
        expect(perf).toEqual({});
    });
});

describe("generateSetlist — key flow", () => {
    function _makeKeySongs() {
        const members = {
            alice: {
                instruments: [
                    {
                        name: "guitar",
                        tuning: ["Standard"],
                        capo: 0,
                        picking: ["flatpick"],
                    },
                ],
            },
        };
        return [
            makeSong("Song C", { key: "C", members }),
            makeSong("Song G", { key: "G", members }),
            makeSong("Song D", { key: "D", members }),
            makeSong("Song Am", { key: "Am", members }),
            makeSong("Song F", { key: "F", members }),
            makeSong("Song F#", { key: "F#", members }),
            makeSong("Song Bb", { key: "Bb", members }),
            makeSong("Song E", { key: "E", members }),
            makeSong("Song A", { key: "A", members }),
        ];
    }

    it("with keyFlow enabled, close keys score lower than distant keys (fixed order)", () => {
        const members = {
            alice: {
                instruments: [
                    {
                        name: "guitar",
                        tuning: ["Standard"],
                        capo: 0,
                        picking: ["flatpick"],
                    },
                ],
            },
        };
        const songsClose = [
            makeSong("S1", { key: "C", members }),
            makeSong("S2", { key: "G", members }),
            makeSong("S3", { key: "D", members }),
        ];
        const songsFar = [
            makeSong("S1", { key: "C", members }),
            makeSong("S2", { key: "F#", members }),
            makeSong("S3", { key: "B", members }),
        ];
        const config = makeConfig({
            general: { count: 3, weighting: { keyFlow: 4 } },
        });
        const ids = ["s1", "s2", "s3"];
        const opts = { seed: 42, keyFlow: true, count: 3, fixedSongIds: ids };

        const closeResult = generateSetlist(songsClose, config, opts);
        const farResult = generateSetlist(songsFar, config, opts);

        // Close keys should have a lower score (less penalty) than distant keys
        expect(closeResult.summary.score).toBeLessThan(farResult.summary.score);
    });

    it("with keyFlow disabled, key distance has no effect on score", () => {
        const members = {
            alice: {
                instruments: [
                    {
                        name: "guitar",
                        tuning: ["Standard"],
                        capo: 0,
                        picking: ["flatpick"],
                    },
                ],
            },
        };
        const songsClose = [
            makeSong("S1", { key: "C", members }),
            makeSong("S2", { key: "G", members }),
            makeSong("S3", { key: "D", members }),
        ];
        const songsFar = [
            makeSong("S1", { key: "C", members }),
            makeSong("S2", { key: "F#", members }),
            makeSong("S3", { key: "B", members }),
        ];
        const config = makeConfig({ general: { count: 3 } });
        const ids = ["s1", "s2", "s3"];
        const opts = { seed: 42, keyFlow: false, count: 3, fixedSongIds: ids };

        const closeResult = generateSetlist(songsClose, config, opts);
        const farResult = generateSetlist(songsFar, config, opts);

        // Scores should be the same since key flow is disabled
        expect(closeResult.summary.score).toBe(farResult.summary.score);
    });

    it("songs without keys are scored neutrally when key flow is enabled", () => {
        const members = {
            alice: {
                instruments: [
                    {
                        name: "guitar",
                        tuning: ["Standard"],
                        capo: 0,
                        picking: ["flatpick"],
                    },
                ],
            },
        };
        const songsWithKeys = [
            makeSong("S1", { key: "C", members }),
            makeSong("S2", { key: "F#", members }),
            makeSong("S3", { key: "C", members }),
        ];
        const songsNoKeys = [
            makeSong("S1", { key: "", members }),
            makeSong("S2", { key: "", members }),
            makeSong("S3", { key: "", members }),
        ];
        const config = makeConfig({
            general: { count: 3, weighting: { keyFlow: 4 } },
        });
        const ids = ["s1", "s2", "s3"];
        const opts = { seed: 42, keyFlow: true, count: 3, fixedSongIds: ids };

        const withKeys = generateSetlist(songsWithKeys, config, opts);
        const withoutKeys = generateSetlist(songsNoKeys, config, opts);

        // Songs without keys should have no key penalty
        expect(withoutKeys.summary.score).toBeLessThanOrEqual(withKeys.summary.score);
    });

    it("penalizes direction reversals on the circle of fifths", () => {
        const members = {
            alice: {
                instruments: [
                    {
                        name: "guitar",
                        tuning: ["Standard"],
                        capo: 0,
                        picking: ["flatpick"],
                    },
                ],
            },
        };
        const perf = {
            alice: {
                instrument: "guitar",
                tuning: "Standard",
                capo: 0,
                picking: "flatpick",
            },
        };
        // Progressive: C → G → D → A (all clockwise on circle of fifths)
        const progressive = [
            { ...makeSong("S1", { key: "C", members }), performance: perf },
            { ...makeSong("S2", { key: "G", members }), performance: perf },
            { ...makeSong("S3", { key: "D", members }), performance: perf },
            { ...makeSong("S4", { key: "A", members }), performance: perf },
        ];
        // Zigzag: C → G → F → D (reverses direction: clockwise then counterclockwise then clockwise)
        const zigzag = [
            { ...makeSong("S1", { key: "C", members }), performance: perf },
            { ...makeSong("S2", { key: "G", members }), performance: perf },
            { ...makeSong("S3", { key: "F", members }), performance: perf },
            { ...makeSong("S4", { key: "D", members }), performance: perf },
        ];
        const config = makeConfig({
            general: { count: 4, weighting: { keyFlow: 4 } },
        });

        const progResult = scoreFixedOrder(progressive, config, {
            keyFlow: true,
        });
        const zigResult = scoreFixedOrder(zigzag, config, { keyFlow: true });

        // Progressive should score lower (better) than zigzag due to no direction reversals
        expect(progResult.summary.score).toBeLessThan(zigResult.summary.score);
    });
});

// ---------------------------------------------------------------------------
// Notes pass-through
// ---------------------------------------------------------------------------
describe("notes field", () => {
    it("round-trips through generateSetlist", () => {
        const songs = simpleCatalog(5);
        songs[0].notes = "Start with a bang";
        songs[2].notes = "Slow it down here";
        const config = makeConfig({ general: { count: 5 } });
        const result = generateSetlist(songs, config, deterministicOptions({ count: 5 }));
        const withNotes = result.songs.filter((s) => s.notes);
        expect(withNotes.length).toBe(2);
        expect(result.songs.find((s) => s.name === "Song 1").notes).toBe("Start with a bang");
        expect(result.songs.find((s) => s.name === "Song 3").notes).toBe("Slow it down here");
    });

    it("round-trips through scoreFixedOrder", () => {
        const songs = simpleCatalog(3).map((s, i) => ({
            ...s,
            notes: i === 1 ? "Middle note" : "",
            performance: {},
        }));
        const config = makeConfig({ general: { count: 3 } });
        const result = scoreFixedOrder(songs, config);
        expect(result.songs[1].notes).toBe("Middle note");
        expect(result.songs[0].notes).toBe("");
    });
});

// ===================================================================
// Regression: opener predictability
//
// A single non-cover song in one tuning cluster must not turn the
// opener into a foregone conclusion.
// ===================================================================
describe("generateSetlist — opener diversity", () => {
    it("does not collapse opener onto a single song when one tuning is in the minority", () => {
        // 5 songs in Drop D tuning (key of D), 15 songs in Standard tuning (various keys)
        const dropDSongs = Array.from({ length: 5 }, (_, i) =>
            makeSong(`Drop Song ${i + 1}`, {
                key: "D",
                members: {
                    nick: {
                        instruments: [{ name: "guitar", tuning: ["Drop D"], capo: 0, picking: [] }],
                    },
                },
            }),
        );
        const standardSongs = Array.from({ length: 15 }, (_, i) =>
            makeSong(`Standard Song ${i + 1}`, {
                key: ["G", "A", "C", "E", "F", "Bb", "Eb", "Ab", "B", "F#", "Bm", "Em", "Am", "Dm", "Cm"][i],
                members: {
                    nick: {
                        instruments: [{ name: "guitar", tuning: ["Standard"], capo: 0, picking: [] }],
                    },
                },
            }),
        );
        const songs = [...dropDSongs, ...standardSongs];
        const config = makeConfig();

        const keyCounts = {};
        const seeds = 30;
        for (let seed = 1; seed <= seeds; seed++) {
            const result = generateSetlist(songs, config, {
                count: 9,
                seed,
                beamWidth: 64,
                randomness: { temperature: 1.6 },
            });
            const key = result.songs[0]?.key || "unknown";
            keyCounts[key] = (keyCounts[key] || 0) + 1;
        }
        const maxCount = Math.max(...Object.values(keyCounts));
        // No single key should dominate the opener across 30 seeds
        expect(maxCount / seeds).toBeLessThanOrEqual(0.6);
    });

    it("key flow does not bias opener selection toward central keys", () => {
        // D is central on the circle of fifths for guitar keys — it should not dominate
        // the opener even with key flow enabled
        const keys = ["D", "D", "D", "G", "G", "G", "A", "A", "E", "E", "C", "C", "F", "Bb", "F#"];
        const songs = keys.map((key, i) => makeSong(`Song ${i + 1}`, { key, members: {} }));
        const config = makeConfig();

        const keyCounts = {};
        const seeds = 30;
        for (let seed = 1; seed <= seeds; seed++) {
            const result = generateSetlist(songs, config, {
                count: 9,
                seed,
                beamWidth: 64,
                keyFlow: true,
                randomness: { temperature: 1.2 },
            });
            const key = result.songs[0]?.key || "unknown";
            keyCounts[key] = (keyCounts[key] || 0) + 1;
        }
        const dCount = keyCounts.D || 0;
        // D is 3/15 = 20% of catalog, should not appear as opener more than 50%
        expect(dCount / seeds).toBeLessThanOrEqual(0.5);
    });
});

describe("generateSetlist — keep apart", () => {
    it("never seats two keep-apart songs next to each other (across seeds)", () => {
        const songs = [
            makeSong("Alpha"),
            makeSong("Beta"),
            makeSong("Gamma"),
            makeSong("Delta"),
            makeSong("Epsilon"),
            makeSong("Zeta"),
        ];
        songs[0].keepApartFrom = ["beta"];
        songs[1].keepApartFrom = ["alpha"];
        const config = makeConfig({ general: { count: 6 } });
        for (let seed = 1; seed <= 40; seed += 1) {
            const result = generateSetlist(songs, config, { seed, count: 6 });
            const ids = result.songs.map((s) => s.id);
            expect(ids).toHaveLength(6);
            for (let i = 1; i < ids.length; i += 1) {
                const pair = [ids[i - 1], ids[i]].sort().join("|");
                expect(pair).not.toBe("alpha|beta");
            }
            expect(result.summary.keepApartRelaxed).toBe(false);
        }
    });

    it("honours a one-sided keepApartFrom record", () => {
        const songs = [makeSong("Alpha"), makeSong("Beta"), makeSong("Gamma"), makeSong("Delta")];
        songs[0].keepApartFrom = ["beta"];
        const config = makeConfig({ general: { count: 4 } });
        for (let seed = 1; seed <= 30; seed += 1) {
            const ids = generateSetlist(songs, config, { seed, count: 4 }).songs.map((s) => s.id);
            for (let i = 1; i < ids.length; i += 1) {
                expect([ids[i - 1], ids[i]].sort().join("|")).not.toBe("alpha|beta");
            }
        }
    });

    it("relaxes and flags the summary when the rule cannot be satisfied", () => {
        const songs = [makeSong("Alpha"), makeSong("Beta")];
        songs[0].keepApartFrom = ["beta"];
        songs[1].keepApartFrom = ["alpha"];
        const result = generateSetlist(songs, makeConfig({ general: { count: 2 } }), { seed: 3, count: 2 });
        expect(result.songs).toHaveLength(2);
        expect(result.summary.keepApartRelaxed).toBe(true);
        expect(result.songs.every((s) => s.keepApartConflict)).toBe(true);
    });
});

describe("scoreFixedOrder — keep apart", () => {
    it("marks adjacent conflicting songs and counts pairs", () => {
        const songs = [makeSong("Alpha"), makeSong("Beta"), makeSong("Gamma")];
        songs[0].keepApartFrom = ["beta"];
        songs[1].keepApartFrom = ["alpha"];
        const result = scoreFixedOrder(songs, makeConfig());
        expect(result.summary.keepApartConflicts).toBe(1);
        expect(result.songs.map((s) => s.keepApartConflict)).toEqual([true, true, false]);
    });

    it("does not flag conflicting songs that are not adjacent", () => {
        const songs = [makeSong("Alpha"), makeSong("Gamma"), makeSong("Beta")];
        songs[0].keepApartFrom = ["beta"];
        const result = scoreFixedOrder(songs, makeConfig());
        expect(result.summary.keepApartConflicts).toBe(0);
        expect(result.songs.some((s) => s.keepApartConflict)).toBe(false);
    });

    it("flags conflicts from a one-sided keepApartFrom list", () => {
        const songs = [makeSong("Alpha"), makeSong("Beta")];
        songs[0].keepApartFrom = ["beta"];
        const result = scoreFixedOrder(songs, makeConfig());
        expect(result.summary.keepApartConflicts).toBe(1);
        expect(result.songs.map((s) => s.keepApartConflict)).toEqual([true, true]);
    });
});

describe("generateSetlist — keep apart regression", () => {
    it("only enforces direct keep-apart pairs, not transitive separation", () => {
        // Alpha↔Gamma and Gamma↔Beta are kept apart; Alpha↔Beta is not.
        // Pin Alpha and Beta adjacent so the contract is asserted directly
        // rather than hoping some seed happens to produce that adjacency.
        const songs = [makeSong("Alpha"), makeSong("Gamma"), makeSong("Beta"), makeSong("Delta"), makeSong("Epsilon")];
        songs[0].keepApartFrom = ["gamma"];
        songs[1].keepApartFrom = ["beta"];
        const config = makeConfig({ general: { count: 5 } });
        for (let seed = 1; seed <= 10; seed += 1) {
            const result = generateSetlist(songs, config, {
                seed,
                count: 5,
                pinnedSongs: [
                    { id: "alpha", position: 1 },
                    { id: "beta", position: 2 },
                ],
            });
            const ids = result.songs.map((s) => s.id);
            expect(ids.slice(0, 2)).toEqual(["alpha", "beta"]);
            expect(result.summary.keepApartRelaxed).toBe(false);
            for (let i = 1; i < ids.length; i += 1) {
                const pair = [ids[i - 1], ids[i]].sort().join("|");
                expect(pair).not.toBe("alpha|gamma");
                expect(pair).not.toBe("beta|gamma");
            }
        }
    });

    it("respects keep-apart against a caller-supplied preceding song (append seam)", () => {
        const songs = [makeSong("Beta"), makeSong("Gamma"), makeSong("Delta")];
        songs[0].keepApartFrom = ["alpha"];
        const config = makeConfig({ general: { count: 3 } });
        for (let seed = 1; seed <= 20; seed += 1) {
            const result = generateSetlist(songs, config, {
                seed,
                count: 3,
                precedingSong: { id: "alpha", keepApartFrom: ["beta"] },
            });
            expect(result.songs[0].id).not.toBe("beta");
            expect(result.songs).toHaveLength(3);
        }
    });

    it("honours a one-sided preceding-song record", () => {
        const songs = [makeSong("Beta"), makeSong("Gamma"), makeSong("Delta")];
        const config = makeConfig({ general: { count: 3 } });
        for (let seed = 1; seed <= 20; seed += 1) {
            const result = generateSetlist(songs, config, {
                seed,
                count: 3,
                precedingSong: { id: "alpha", keepApartFrom: ["beta"] },
            });
            expect(result.songs[0].id).not.toBe("beta");
        }
    });

    it("flags conflicts when pinned positions force keep-apart songs adjacent", () => {
        const songs = [makeSong("Alpha"), makeSong("Beta"), makeSong("Gamma"), makeSong("Delta")];
        songs[0].keepApartFrom = ["beta"];
        songs[1].keepApartFrom = ["alpha"];
        const result = generateSetlist(songs, makeConfig({ general: { count: 4 } }), {
            seed: 1,
            count: 4,
            pinnedSongs: [
                { id: "alpha", position: 1 },
                { id: "beta", position: 2 },
            ],
        });
        expect(result.songs[0].id).toBe("alpha");
        expect(result.songs[1].id).toBe("beta");
        expect(result.summary.keepApartRelaxed).toBe(true);
        expect(result.songs[0].keepApartConflict).toBe(true);
        expect(result.songs[1].keepApartConflict).toBe(true);
    });

    it("counts multiple adjacent conflict pairs in a relaxed setlist", () => {
        const songs = [makeSong("Alpha"), makeSong("Beta"), makeSong("Gamma"), makeSong("Delta")];
        songs[0].keepApartFrom = ["beta"];
        songs[1].keepApartFrom = ["alpha"];
        songs[2].keepApartFrom = ["delta"];
        songs[3].keepApartFrom = ["gamma"];
        const result = generateSetlist(songs, makeConfig({ general: { count: 4 } }), {
            seed: 9,
            count: 4,
            pinnedSongs: [
                { id: "alpha", position: 1 },
                { id: "beta", position: 2 },
                { id: "gamma", position: 3 },
                { id: "delta", position: 4 },
            ],
        });
        expect(result.summary.keepApartRelaxed).toBe(true);
        expect(result.songs.filter((s) => s.keepApartConflict)).toHaveLength(4);
    });
});
