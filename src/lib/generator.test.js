import { describe, expect, it, vi } from "vitest";
import { buildDefaultPerformance, generateSetlist, scoreFixedOrder } from "./generator.js";

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
                minStreak: 2,
                allowChangeOnLastSong: true,
            },
            capo: {
                kind: "instrumentDelta",
                field: "capo",
                minStreak: 2,
                allowChangeOnLastSong: true,
            },
            instruments: {
                kind: "instrumentSet",
                weightKey: "instrument",
                minStreak: 2,
                allowChangeOnLastSong: true,
            },
            picking: {
                kind: "instrumentField",
                field: "picking",
                weightKey: "technique",
                minStreak: 1,
                allowChangeOnLastSong: true,
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

function anxietyPressureCatalog() {
    return Array.from({ length: 9 }, (_, songIndex) =>
        makeSong(`Pressure ${songIndex + 1}`, {
            id: `pressure-${songIndex + 1}`,
            members: {
                mark: {
                    instruments: [
                        {
                            name: "guitar",
                            tuning: ["Standard"],
                            capo: 0,
                            picking: [],
                        },
                        {
                            name: "guitar",
                            tuning: ["DADDAD"],
                            capo: 0,
                            picking: [],
                        },
                        {
                            name: "mandolin",
                            tuning: ["Standard"],
                            capo: 0,
                            picking: [],
                        },
                    ],
                },
                nick: {
                    instruments: [
                        {
                            name: "banjo",
                            tuning: ["Open G"],
                            capo: 0,
                            picking: ["picking"],
                        },
                        {
                            name: "banjo",
                            tuning: ["Open D"],
                            capo: 0,
                            picking: ["clawhammer"],
                        },
                        {
                            name: "guitar",
                            tuning: ["Standard"],
                            capo: 2,
                            picking: ["picking"],
                        },
                    ],
                },
            },
        }),
    );
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

    it("user-configured order rules keep covers rare in first two positions", () => {
        // order.first and order.second both include ["cover", false], so covers
        // incur a positionMiss penalty in slots 1–2. They should appear there
        // only occasionally across a range of seeds, not in the majority of runs.
        const songs = [
            makeSong("Cover 1", { cover: true }),
            makeSong("Cover 2", { cover: true }),
            ...simpleCatalog(13).map((s, i) => ({
                ...s,
                id: `other-${i}`,
                name: `Other ${i + 1}`,
            })),
        ];
        const config = makeConfig();
        let coverEarly = 0;
        for (let seed = 1; seed <= 20; seed++) {
            const result = generateSetlist(songs, config, deterministicOptions({ count: 10, seed }));
            if (result.songs[0]?.cover || result.songs[1]?.cover) coverEarly++;
        }
        expect(coverEarly).toBeLessThanOrEqual(5);
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
// Constraint enforcement — minStreak
// ===================================================================
describe("generateSetlist — minStreak enforcement", () => {
    it("respects tuning minStreak=2 (no back-to-back tuning changes)", () => {
        const songs = twoTuningCatalog(15);
        const config = makeConfig();
        // Run across multiple seeds
        for (let seed = 1; seed <= 5; seed++) {
            const result = generateSetlist(songs, config, deterministicOptions({ count: 10, seed }));
            let consecutive = 0;
            for (let i = 1; i < result.songs.length; i++) {
                if (result.songs[i].propChanges.tuning?.changed) {
                    consecutive++;
                    // With minStreak=2, two consecutive changes should not happen
                    expect(consecutive).toBeLessThanOrEqual(1);
                } else {
                    consecutive = 0;
                }
            }
        }
    });
});

// ===================================================================
// Bug #6 regression: maxChanges enforced on last song
// ===================================================================
describe("generateSetlist — maxChanges on last song", () => {
    it("maxChanges is enforced even when allowChangeOnLastSong is true", () => {
        const songs = twoTuningCatalog(10);
        const config = makeConfig({
            props: {
                tuning: {
                    kind: "instrumentField",
                    field: "tuning",
                    minStreak: 1,
                    maxChanges: 1,
                    allowChangeOnLastSong: true,
                },
            },
        });

        for (let seed = 1; seed <= 10; seed++) {
            const result = generateSetlist(songs, config, deterministicOptions({ count: 5, seed }));
            const tuningChanges = result.songs.filter((s) => s.propChanges.tuning?.changed).length;
            expect(tuningChanges).toBeLessThanOrEqual(1);
        }
    });
});

// ===================================================================
// minSongsPerInstrument enforcement
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

describe("generateSetlist — chaos slider anxiety bias", () => {
    it("keeps low chaos calmer and high chaos much more anxious on a transition-heavy catalog", () => {
        const songs = anxietyPressureCatalog();
        const config = makeConfig();
        const seeds = [1, 2, 3, 4, 5, 6];
        const lowScores = [];
        const highScores = [];

        for (const seed of seeds) {
            const low = generateSetlist(
                songs,
                config,
                deterministicOptions({
                    count: songs.length,
                    seed,
                    randomness: {
                        shuffleCatalog: false,
                        songBias: 0,
                        variantJitter: 0,
                        stateJitter: 0,
                        temperature: 0.3,
                        finalChoicePool: 1,
                    },
                }),
            );
            const high = generateSetlist(
                songs,
                config,
                deterministicOptions({
                    count: songs.length,
                    seed,
                    randomness: {
                        shuffleCatalog: false,
                        songBias: 0,
                        variantJitter: 0,
                        stateJitter: 0,
                        temperature: 2.0,
                        finalChoicePool: 1,
                    },
                }),
            );

            lowScores.push(low.summary.anxiety.scaled);
            highScores.push(high.summary.anxiety.scaled);
        }

        const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

        expect(average(lowScores)).toBeLessThanOrEqual(3);
        expect(average(highScores)).toBeGreaterThanOrEqual(7);
        expect(Math.min(...highScores)).toBeGreaterThan(Math.max(...lowScores));
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
        expect(result.songs[1].incrementalScore).toBe(4); // weight 4
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
// Regression: cascading P1/P2 lock (opener predictability)
//
// When order.second prefers non-cover songs AND minStreak≥2 forces P2
// into the same tuning cluster as P1, having a single non-cover song
// in one cluster creates a structural lock: the generator exploits the
// P2 cover bonus by always choosing that cluster at P1, collapsing the
// opener to a single song.
// ===================================================================
describe("generateSetlist — cascading P1/P2 lock regression", () => {
    /** Build a catalog that replicates the structural conditions of the bug:
     *  - one non-cover, notGoodOpener song in tuning-A ("Anchor")
     *  - one eligible opener in tuning-A ("Only Opener A")
     *  - several eligible openers in tuning-B ("Opener B 1..N")
     *  With the buggy config (cover pref at P2 + minStreak=2), "Only Opener A"
     *  dominates near-100% of rolls because Anchor gives tuning-A a 10-pt P2 bonus
     *  and minStreak locks P1 into the same cluster.
     */
    function buildLockCatalog(memberName = "nick") {
        const tuningA = [{ name: "banjo", tuning: ["double"], capo: 2, picking: [] }];
        const tuningB = [{ name: "banjo", tuning: ["standard"], capo: 0, picking: [] }];
        const members = (instruments) => ({ [memberName]: { instruments } });

        return [
            // The only non-cover song — lives in tuning-A, not a good opener
            makeSong("Anchor", { cover: false, notGoodOpener: true, members: members(tuningA) }),
            // The only eligible opener in tuning-A — becomes dominant under the bug
            makeSong("Only Opener A", { cover: true, members: members(tuningA) }),
            // Several eligible openers in tuning-B
            ...Array.from({ length: 8 }, (_, i) =>
                makeSong(`Opener B ${i + 1}`, { cover: true, members: members(tuningB) }),
            ),
            // Filler songs to pad the setlist
            ...Array.from({ length: 4 }, (_, i) =>
                makeSong(`Filler ${i + 1}`, { cover: true, members: members(tuningB) }),
            ),
        ];
    }

    it("with cover pref at P2 and minStreak=2, opener collapses onto a single song", () => {
        const songs = buildLockCatalog();
        const buggyConfig = makeConfig({
            general: {
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
            },
            props: {
                tuning: { kind: "instrumentField", field: "tuning", minStreak: 2, allowChangeOnLastSong: true },
                capo: { kind: "instrumentDelta", field: "capo", minStreak: 2, allowChangeOnLastSong: true },
            },
        });

        const openerCounts = {};
        for (let seed = 1; seed <= 30; seed++) {
            const result = generateSetlist(songs, buggyConfig, {
                count: 9,
                seed,
                beamWidth: 128,
                randomness: { temperature: 1.7, shuffleCatalog: false, songBias: 0, variantJitter: 0, stateJitter: 0 },
            });
            const opener = result.songs[0]?.name;
            openerCounts[opener] = (openerCounts[opener] || 0) + 1;
        }
        const dominance = (openerCounts["Only Opener A"] || 0) / 30;
        // Under the buggy config the structural lock should be clearly visible
        expect(dominance).toBeGreaterThan(0.7);
    });

    it("with no cover pref at P2 and minStreak=1, opener does not collapse onto a single song", () => {
        const songs = buildLockCatalog();
        const fixedConfig = makeConfig({
            general: {
                order: {
                    first: [
                        ["notGoodOpener", false],
                        ["cover", false],
                        ["instrumental", false],
                    ],
                    second: [],
                    penultimate: [],
                    last: [["notGoodCloser", false]],
                },
            },
            props: {
                tuning: { kind: "instrumentField", field: "tuning", minStreak: 1, allowChangeOnLastSong: true },
                capo: { kind: "instrumentDelta", field: "capo", minStreak: 1, allowChangeOnLastSong: true },
            },
        });

        const openerCounts = {};
        for (let seed = 1; seed <= 30; seed++) {
            const result = generateSetlist(songs, fixedConfig, {
                count: 9,
                seed,
                beamWidth: 128,
                // songBias must be non-zero so that different seeds actually produce
                // different openers; the structural lock test above shows that without
                // the bug the bias alone is sufficient to vary selection.
                randomness: { temperature: 1.7, shuffleCatalog: false, songBias: 3, variantJitter: 0, stateJitter: 0 },
            });
            const opener = result.songs[0]?.name;
            openerCounts[opener] = (openerCounts[opener] || 0) + 1;
        }
        const uniqueOpeners = Object.keys(openerCounts).length;
        const maxDominance = Math.max(...Object.values(openerCounts)) / 30;
        // Should see multiple different openers, none dominating heavily
        expect(uniqueOpeners).toBeGreaterThanOrEqual(3);
        expect(maxDominance).toBeLessThanOrEqual(0.5);
    });
});

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
