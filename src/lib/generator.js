import { computeAnxiety, scoreAnxietyPressure } from "./anxiety.js";
import {
    detectFieldChange,
    detectFieldChangeLite,
    detectInstrumentSetChange,
    detectInstrumentSetChangeLite,
    inferPropKind,
} from "./detection.js";
import { scoreKeyTransition } from "./keys.js";
import { deepMerge, toArray } from "./utils.js";

function clampInteger(value, fallback, minimum) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) {
        return fallback;
    }
    return Math.max(minimum, parsed);
}

function normalizeLimitField(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) {
        return fallback;
    }
    return parsed < 0 ? -1 : parsed;
}

function clampFloat(value, fallback, minimum) {
    const parsed = Number.parseFloat(value);
    if (Number.isNaN(parsed)) {
        return fallback;
    }
    return Math.max(minimum, parsed);
}

function clampUnit(value) {
    return Math.max(0, Math.min(1, value));
}

function merge(left, right) {
    return Object.assign({}, left, right);
}

function createRng(seed) {
    let state = seed >>> 0 || 1;
    return function nextRandom() {
        state += 0x6d2b79f5;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function normalizeSeed(seed) {
    if (seed === undefined || seed === null || seed === "" || seed === 0 || seed === "0") {
        return Math.floor(Date.now() + Math.random() * 1000000);
    }
    const parsed = Number.parseInt(seed, 10);
    if (!Number.isNaN(parsed)) return parsed >>> 0;
    let hashed = 0;
    for (const char of String(seed)) {
        hashed = (hashed << 5) - hashed + char.charCodeAt(0);
        hashed |= 0;
    }
    return hashed >>> 0;
}

function cartesianProduct(groups) {
    return groups.reduce(
        (product, group) => {
            const result = [];
            product.forEach((base) => {
                group.forEach((entry) => {
                    result.push(base.concat(entry));
                });
            });
            return result;
        },
        [[]],
    );
}

function zeroMap(keys) {
    return keys.reduce((result, key) => {
        result[key] = 0;
        return result;
    }, {});
}

function compareStates(left, right) {
    const leftRank = left.rankScore === undefined ? left.score : left.rankScore;
    const rightRank = right.rankScore === undefined ? right.score : right.rankScore;
    if (leftRank !== rightRank) {
        return leftRank - rightRank;
    }
    // Use numeric tiebreaker instead of expensive string join + localeCompare
    return (left._tiebreaker || 0) - (right._tiebreaker || 0);
}

class SongsCatalog {
    constructor(list = []) {
        this._songs = list;
    }

    all() {
        return this._songs;
    }

    expandVariants(song, showConstraints = {}) {
        const members = song.members || {};
        const entries = Object.entries(members).sort(([left], [right]) => {
            return left.localeCompare(right);
        });

        if (!entries.length) {
            return [this._buildVariant(song, {})];
        }

        const options = entries.map(([memberName, memberSetup]) => {
            const instruments = this._normalizeInstrumentOptions(memberSetup, showConstraints.members?.[memberName]);

            if (!instruments.length) {
                return [];
            }

            return instruments.flatMap((instrumentSetup) => {
                const tunings = toArray(instrumentSetup.tuning);
                const tuningOptions = tunings.length ? tunings : [null];
                return tuningOptions.map((tuning) => ({
                    member: memberName,
                    instrument: instrumentSetup.name || instrumentSetup.instrument,
                    tuning,
                    capo: instrumentSetup.capo || 0,
                    picking: instrumentSetup.picking || [],
                }));
            });
        });

        if (options.some((group) => !group.length)) {
            return [];
        }

        return cartesianProduct(options).map((combo) => {
            const performance = {};

            combo.forEach((entry) => {
                performance[entry.member] = {
                    instrument: entry.instrument,
                    tuning: entry.tuning,
                    capo: entry.capo,
                    picking: entry.picking,
                };
            });

            return this._buildVariant(song, performance);
        });
    }

    _normalizeInstrumentOptions(memberSetup, memberConstraints) {
        const allowedInstruments = toArray(memberConstraints?.allowedInstruments);
        const allowedTunings = memberConstraints?.allowedTunings || {};
        const options = Array.isArray(memberSetup.instruments)
            ? memberSetup.instruments.slice()
            : memberSetup.instrument
              ? [memberSetup.instrument]
              : [];

        return options
            .filter((option) => {
                const instrumentName = option.name || option.instrument;
                const optionTunings = toArray(option.tuning);

                if (allowedInstruments.length && allowedInstruments.indexOf(instrumentName) < 0) {
                    return false;
                }

                if (!allowedTunings[instrumentName]) {
                    return true;
                }

                const validTunings = toArray(allowedTunings[instrumentName]);
                if (!optionTunings.length) {
                    return true;
                }

                return optionTunings.some((tuning) => validTunings.indexOf(tuning) >= 0);
            })
            .map((option) => {
                const instrumentName = option.name || option.instrument;
                const constrainedOption = { ...option };

                if (allowedTunings[instrumentName]) {
                    const validTunings = toArray(allowedTunings[instrumentName]);
                    const optionTunings = toArray(option.tuning);
                    const filteredTunings = optionTunings.filter((tuning) => validTunings.indexOf(tuning) >= 0);

                    if (filteredTunings.length) {
                        constrainedOption.tuning = filteredTunings;
                    }
                }

                return constrainedOption;
            });
    }

    _buildVariant(song, performance) {
        return {
            id: String(song.id),
            name: song.name,
            cover: Boolean(song.cover),
            instrumental: Boolean(song.instrumental),
            notGoodOpener: Boolean(song.notGoodOpener),
            notGoodCloser: Boolean(song.notGoodCloser),
            playPriority: song.playPriority || "normal",
            energy: Math.max(1, Math.min(5, Number(song.energy) || 3)),
            positionPreference: song.positionPreference || "anywhere",
            key: song.key || null,
            notes: song.notes || "",
            performance,
        };
    }
}

class SetList {
    constructor(songs, config, options = {}) {
        this._config = config || {};
        this._songs = new SongsCatalog(songs);
        this._propNames = Object.keys(this._config.props || {});
        this._propConfig = this._config.props || {};
        this._weights = merge(DEFAULT_WEIGHTS, this._config.general?.weighting || {});
        this._options = this._normalizeOptions(options);
        this._pinnedPositions = new Map(
            (this._options.pinnedSongs || [])
                .filter((pin) => Number.isInteger(pin.position) && pin.position > 0)
                .map((pin) => [pin.position, String(pin.id)]),
        );
        this._pinnedPositionById = new Map(
            Array.from(this._pinnedPositions.entries()).map(([position, id]) => [id, position]),
        );
        const smoothnessScale =
            { smooth: 1.75, balanced: 1, adventurous: 0.35 }[this._options.transitionSmoothness] ?? 1;
        ["tuning", "capo", "instrument", "technique", "keyFlow"].forEach((key) => {
            this._weights[key] = (this._weights[key] || 0) * smoothnessScale;
        });
        this._keyFlowEnabled = Boolean(this._options.keyFlow);
        this._show = deepMerge(this._config.show || {}, this._options.show || {});
        this._seed = this._normalizeSeed(this._options.seed);
        this._rng = createRng(this._seed);
        this._randomness = merge(DEFAULT_RANDOMNESS, this._config.general?.randomness || {});
        this._randomness = merge(this._randomness, this._options.randomness || {});
        this._chaosLevel = clampUnit((clampFloat(this._randomness.temperature, 0.85, 0.01) - 0.3) / 1.7);
        if (this._options.fixedSongIds) {
            const idSet = new Set(this._options.fixedSongIds);
            this._catalog = this._songs.all().filter((s) => idSet.has(s.id));
            this._count = this._catalog.length;
        } else {
            this._catalog = this._songs.all().filter((song) => {
                return this._songs.expandVariants(song, this._show).length > 0;
            });
            this._count = Math.min(this._options.count, this._catalog.length);
        }
        this._songBiasById = this._buildSongBiases(this._catalog);
        this._minConstraints = this._buildMinConstraints();
        this._minimumGroups = this._buildMinimumGroups();
        this._list = [];
        this._summary = {
            score: 0,
            covers: 0,
            instrumentals: 0,
            changes: zeroMap(this._propNames),
        };
        this._build();
    }

    _normalizeOptions(options) {
        if (typeof options === "number") {
            options = { count: options };
        }

        const limits = this._config.general?.limits || {};
        const normalized = merge(
            {
                count: this._config.general?.count || 15,
                beamWidth: this._config.general?.beamWidth || 20,
                maxCovers: limits.covers ?? -1,
                maxInstrumentals: limits.instrumentals ?? -1,
            },
            options || {},
        );

        normalized.count = clampInteger(normalized.count, this._config.general?.count || 15, 1);
        normalized.beamWidth = clampInteger(normalized.beamWidth, this._config.general?.beamWidth || 20, 1);
        normalized.maxCovers = normalizeLimitField(normalized.maxCovers, limits.covers ?? -1);
        normalized.maxInstrumentals = normalizeLimitField(normalized.maxInstrumentals, limits.instrumentals ?? -1);
        normalized.show = deepMerge(this._config.show || {}, normalized.show || {});
        return normalized;
    }

    _normalizeSeed(seed) {
        return normalizeSeed(seed);
    }

    _randomJitter(amount) {
        const magnitude = clampFloat(amount, 0, 0);
        if (!magnitude) {
            return 0;
        }
        return (this._rng() - 0.5) * 2 * magnitude;
    }

    _shuffle(items) {
        const list = items.slice();
        for (let index = list.length - 1; index > 0; index -= 1) {
            const swapIndex = Math.floor(this._rng() * (index + 1));
            const temp = list[index];
            list[index] = list[swapIndex];
            list[swapIndex] = temp;
        }
        return list;
    }

    _buildSongBiases(songs) {
        const magnitude = clampFloat(this._randomness.songBias, 3, 0);
        return songs.reduce((result, song) => {
            const preferenceBias = this._options.selectionPhase ? this._selectionPreference(song) : 0;
            result[song.id] = preferenceBias + this._randomJitter(magnitude);
            return result;
        }, {});
    }

    _selectionPreference(song) {
        const rotation = this._options.rotation || "balanced";
        const scores = {
            hits: { must: -100, prefer: -16, normal: 2, rest: 30 },
            balanced: { must: -100, prefer: -8, normal: 0, rest: 24 },
            deep: { must: -100, prefer: -2, normal: -4, rest: 16 },
        }[rotation];
        return scores?.[song.playPriority || "normal"] ?? 0;
    }

    _songBias(songId) {
        return this._songBiasById[songId] || 0;
    }

    _chaosAdjustment(prevItem, nextVariant) {
        // The legacy Variety control used temperature to reward or punish
        // awkward transitions. Modern rolls separate selection variety from
        // transition smoothness, so temperature only explores alternatives.
        if (this._options.selectionVariety !== undefined) return 0;
        const centeredChaos = this._chaosLevel * 2 - 1;
        if (!prevItem || centeredChaos === 0) {
            return 0;
        }

        const pressure = scoreAnxietyPressure(prevItem, nextVariant, this._propNames, this._propConfig, this._weights);
        if (!pressure.changed) {
            return centeredChaos > 0 ? centeredChaos * 1.5 : 0;
        }

        return -(pressure.weightedScore + 1.5) * centeredChaos;
    }

    _scoreKeyFlow(prevItem, nextVariant, prevDir) {
        if (!this._keyFlowEnabled || !prevItem) return { score: 0, dir: prevDir };
        return scoreKeyTransition(prevItem.key, nextVariant.key, prevDir, this._weights.keyFlow ?? 2);
    }

    /**
     * Pre-compute minimum instrument/tuning constraints from show config.
     * Returns { instruments: [{member, instrument, min}], tunings: [{member, instrument, tuning, min}] }
     */
    _buildMinConstraints() {
        const constraints = { instruments: [], tunings: [] };
        const showMembers = this._show.members || {};

        for (const [memberName, memberShow] of Object.entries(showMembers)) {
            const allowed = memberShow.allowedInstruments || [];
            if (allowed.length >= 2) {
                const min = memberShow.minSongsPerInstrument ?? 2;
                for (const inst of allowed) {
                    constraints.instruments.push({
                        member: memberName,
                        instrument: inst,
                        min,
                    });
                }
            }

            const allowedTunings = memberShow.allowedTunings || {};
            const minPerTuning = memberShow.minSongsPerTuning || {};
            for (const [instName, tunings] of Object.entries(allowedTunings)) {
                if (tunings.length >= 2) {
                    const min = minPerTuning[instName] ?? 2;
                    for (const tuning of tunings) {
                        constraints.tunings.push({
                            member: memberName,
                            instrument: instName,
                            tuning,
                            min,
                        });
                    }
                }
            }
        }

        return constraints;
    }

    _buildMinimumGroups() {
        const instrumentGroups = Object.values(
            this._minConstraints.instruments.reduce((result, constraint) => {
                const groupId = `instrument:${constraint.member}`;
                if (!result[groupId]) {
                    result[groupId] = {
                        id: groupId,
                        weight: this._weights.instrument ?? 3,
                        constraints: [],
                    };
                }
                result[groupId].constraints.push(constraint);
                return result;
            }, {}),
        );
        const tuningGroups = Object.values(
            this._minConstraints.tunings.reduce((result, constraint) => {
                const groupId = `tuning:${constraint.member}:${constraint.instrument}`;
                if (!result[groupId]) {
                    result[groupId] = {
                        id: groupId,
                        weight: this._weights.tuning ?? 4,
                        constraints: [],
                    };
                }
                result[groupId].constraints.push(constraint);
                return result;
            }, {}),
        );

        return instrumentGroups.concat(tuningGroups).map((group) => {
            const keys = group.constraints.map((constraint) => {
                if ("tuning" in constraint) {
                    return `${constraint.member}:${constraint.instrument}:${constraint.tuning}`;
                }
                return `${constraint.member}:${constraint.instrument}`;
            });
            return {
                ...group,
                keys,
                keyToIndex: keys.reduce((result, key, index) => {
                    result[key] = index;
                    return result;
                }, {}),
            };
        });
    }

    /**
     * Count instrument/tuning usage from a variant's performance.
     */
    _updateUsageCounts(counts, variant) {
        const next = {
            instruments: { ...counts.instruments },
            tunings: { ...counts.tunings },
        };
        const perf = variant.performance || {};
        for (const [member, setup] of Object.entries(perf)) {
            const instKey = `${member}:${setup.instrument}`;
            next.instruments[instKey] = (next.instruments[instKey] || 0) + 1;
            if (setup.tuning) {
                const tuningKey = `${member}:${setup.instrument}:${setup.tuning}`;
                next.tunings[tuningKey] = (next.tunings[tuningKey] || 0) + 1;
            }
        }
        return next;
    }

    /**
     * Score penalty for unmet minimum constraints. Returns a positive number
     * when we're falling behind on meeting minimums.
     * Returns Infinity if it's mathematically impossible to meet them.
     */
    _buildMinimumPotentialContext(catalog, variantCache) {
        const requiredInstrumentKeys = new Set(
            this._minConstraints.instruments.map((constraint) => {
                return `${constraint.member}:${constraint.instrument}`;
            }),
        );
        const requiredTuningKeys = new Set(
            this._minConstraints.tunings.map((constraint) => {
                return `${constraint.member}:${constraint.instrument}:${constraint.tuning}`;
            }),
        );
        const totals = { instruments: {}, tunings: {} };
        const groupCapabilitiesBySongId = {};
        const bySongId = {};

        for (let index = 0; index < catalog.length; index += 1) {
            const song = catalog[index];
            const variants = variantCache.get(song.id) || [];
            const instrumentKeys = new Set();
            const tuningKeys = new Set();

            for (let variantIndex = 0; variantIndex < variants.length; variantIndex += 1) {
                const performance = variants[variantIndex].performance || {};
                for (const [member, setup] of Object.entries(performance)) {
                    const instrumentKey = `${member}:${setup.instrument}`;
                    if (requiredInstrumentKeys.has(instrumentKey)) {
                        instrumentKeys.add(instrumentKey);
                    }

                    if (setup.tuning) {
                        const tuningKey = `${member}:${setup.instrument}:${setup.tuning}`;
                        if (requiredTuningKeys.has(tuningKey)) {
                            tuningKeys.add(tuningKey);
                        }
                    }
                }
            }

            bySongId[song.id] = {
                instruments: Array.from(instrumentKeys),
                tunings: Array.from(tuningKeys),
            };
            groupCapabilitiesBySongId[song.id] = this._minimumGroups.reduce((result, group) => {
                const capabilityIndexes = [];
                for (let keyIndex = 0; keyIndex < group.keys.length; keyIndex += 1) {
                    const key = group.keys[keyIndex];
                    if (instrumentKeys.has(key) || tuningKeys.has(key)) {
                        capabilityIndexes.push(group.keyToIndex[key]);
                    }
                }
                if (capabilityIndexes.length) {
                    result[group.id] = capabilityIndexes;
                }
                return result;
            }, {});

            bySongId[song.id].instruments.forEach((key) => {
                totals.instruments[key] = (totals.instruments[key] || 0) + 1;
            });
            bySongId[song.id].tunings.forEach((key) => {
                totals.tunings[key] = (totals.tunings[key] || 0) + 1;
            });
        }

        return { bySongId, totals, groupCapabilitiesBySongId };
    }

    _consumeRemainingPotentialCounts(remainingPotentialCounts, songId) {
        const next = {
            instruments: { ...remainingPotentialCounts.instruments },
            tunings: { ...remainingPotentialCounts.tunings },
        };
        const capabilities = this._minimumPotentialBySongId[songId] || {
            instruments: [],
            tunings: [],
        };

        capabilities.instruments.forEach((key) => {
            next.instruments[key] = Math.max(0, (next.instruments[key] || 0) - 1);
        });
        capabilities.tunings.forEach((key) => {
            next.tunings[key] = Math.max(0, (next.tunings[key] || 0) - 1);
        });

        return next;
    }

    _remainingGroupCapabilities(state, consumedSongId, groupId) {
        const capabilities = [];
        for (let index = 0; index < this._catalog.length; index += 1) {
            const song = this._catalog[index];
            if (song.id === consumedSongId || state.usedIds[song.id]) {
                continue;
            }

            const capability = this._minimumGroupCapabilitiesBySongId?.[song.id]?.[groupId];
            if (capability?.length) {
                capabilities.push(capability);
            }
        }
        return capabilities;
    }

    _canSatisfyGroupDeficits(deficits, remainingCapabilities, remainingSlots) {
        const totalNeeded = deficits.reduce((sum, deficit) => sum + deficit, 0);
        if (!totalNeeded) {
            return true;
        }
        if (totalNeeded > remainingSlots) {
            return false;
        }
        if (remainingCapabilities.length < totalNeeded) {
            return false;
        }

        const slotsByKeyIndex = deficits.map(() => []);
        let totalSlots = 0;
        deficits.forEach((deficit, keyIndex) => {
            for (let count = 0; count < deficit; count += 1) {
                slotsByKeyIndex[keyIndex].push(totalSlots);
                totalSlots += 1;
            }
        });

        const slotToSongIndex = new Array(totalSlots).fill(-1);
        const tryAssign = (songIndex, seenSlots) => {
            const songCapabilities = remainingCapabilities[songIndex];
            for (let capabilityIndex = 0; capabilityIndex < songCapabilities.length; capabilityIndex += 1) {
                const keyIndex = songCapabilities[capabilityIndex];
                const slotIndexes = slotsByKeyIndex[keyIndex];
                for (let slotIndex = 0; slotIndex < slotIndexes.length; slotIndex += 1) {
                    const slot = slotIndexes[slotIndex];
                    if (seenSlots[slot]) {
                        continue;
                    }
                    seenSlots[slot] = true;
                    const assignedSongIndex = slotToSongIndex[slot];
                    if (assignedSongIndex === -1 || tryAssign(assignedSongIndex, seenSlots)) {
                        slotToSongIndex[slot] = songIndex;
                        return true;
                    }
                }
            }
            return false;
        };

        let matched = 0;
        for (let songIndex = 0; songIndex < remainingCapabilities.length; songIndex += 1) {
            const seenSlots = new Array(totalSlots).fill(false);
            if (tryAssign(songIndex, seenSlots)) {
                matched += 1;
                if (matched === totalNeeded) {
                    return true;
                }
            }
        }

        return false;
    }

    _scoreMinimumPenalty(
        state,
        songId,
        position,
        usageCounts,
        remainingPotentialCounts,
        remainingGroupCapabilitiesById = null,
    ) {
        const remainingSlots = this._count - position;
        let penalty = 0;

        for (const c of this._minConstraints.instruments) {
            const key = `${c.member}:${c.instrument}`;
            const have = usageCounts.instruments[key] || 0;
            const deficit = c.min - have;
            const possible = Math.min(remainingPotentialCounts.instruments[key] || 0, remainingSlots);
            if (deficit > 0 && deficit > possible) {
                return Infinity; // impossible to meet
            }
            if (deficit > 0) {
                const slack = Math.max(0, possible - deficit);
                penalty += deficit * (this._weights.instrument ?? 3) * (1 + 1 / (slack + 1));
            }
        }

        for (const c of this._minConstraints.tunings) {
            const key = `${c.member}:${c.instrument}:${c.tuning}`;
            const have = usageCounts.tunings[key] || 0;
            const deficit = c.min - have;
            const possible = Math.min(remainingPotentialCounts.tunings[key] || 0, remainingSlots);
            if (deficit > 0 && deficit > possible) {
                return Infinity;
            }
            if (deficit > 0) {
                const slack = Math.max(0, possible - deficit);
                penalty += deficit * (this._weights.tuning ?? 4) * (1 + 1 / (slack + 1));
            }
        }

        for (let groupIndex = 0; groupIndex < this._minimumGroups.length; groupIndex += 1) {
            const group = this._minimumGroups[groupIndex];
            const deficits = group.constraints.map((constraint) => {
                const key =
                    "tuning" in constraint
                        ? `${constraint.member}:${constraint.instrument}:${constraint.tuning}`
                        : `${constraint.member}:${constraint.instrument}`;
                const usageBucket = "tuning" in constraint ? usageCounts.tunings : usageCounts.instruments;
                return Math.max(0, constraint.min - (usageBucket[key] || 0));
            });
            const totalNeeded = deficits.reduce((sum, deficit) => sum + deficit, 0);
            if (!totalNeeded) {
                continue;
            }

            if (
                !this._canSatisfyGroupDeficits(
                    deficits,
                    remainingGroupCapabilitiesById?.[group.id] ??
                        this._remainingGroupCapabilities(state, songId, group.id),
                    remainingSlots,
                )
            ) {
                return Infinity;
            }
        }

        return penalty;
    }

    _initialState() {
        return {
            // Linked list: head points to { item, prev } chain
            head: null,
            length: 0,
            usedIds: Object.create(null),
            score: 0,
            coverCount: 0,
            instrumentalCount: 0,
            lastItem: null,
            firstSongId: null,
            rankScore: 0,
            _tiebreaker: 0,
            propChangeCounts: zeroMap(this._propNames),
            propStreaks: zeroMap(this._propNames),
            changeTotals: zeroMap(this._propNames),
            usageCounts: { instruments: {}, tunings: {} },
            remainingPotentialCounts: {
                instruments: {
                    ...(this._minimumPotentialTotals?.instruments || {}),
                },
                tunings: { ...(this._minimumPotentialTotals?.tunings || {}) },
            },
            keyFifthsDir: 0,
        };
    }

    // Reconstruct items array from linked list
    _collectItems(state) {
        const items = new Array(state.length);
        let node = state.head;
        for (let i = state.length - 1; i >= 0; i--) {
            items[i] = node.item;
            node = node.prev;
        }
        return items;
    }

    _build() {
        const catalog = this._randomness.shuffleCatalog ? this._shuffle(this._catalog) : this._catalog.slice();

        // Pre-expand and cache all variants once
        const variantCache = new Map();
        for (let i = 0; i < catalog.length; i++) {
            variantCache.set(catalog[i].id, this._songs.expandVariants(catalog[i], this._show));
        }
        this._variantCache = variantCache;
        const minimumPotentialContext = this._buildMinimumPotentialContext(catalog, variantCache);
        this._minimumPotentialBySongId = minimumPotentialContext.bySongId;
        this._minimumPotentialTotals = minimumPotentialContext.totals;
        this._minimumGroupCapabilitiesBySongId = minimumPotentialContext.groupCapabilitiesBySongId;
        this._minimumsRelaxed = false;
        this._openerFilterRelaxed = false;
        this._closerFilterRelaxed = false;
        let states = [this._initialState()];

        for (let position = 1; position <= this._count; position += 1) {
            const nextStates = [];
            const fallbackStates = [];

            const expand = (relaxPositionFilter) => {
                for (let si = 0; si < states.length; si++) {
                    const state = states[si];
                    for (let ci = 0; ci < catalog.length; ci++) {
                        const song = catalog[ci];
                        if (state.usedIds[song.id]) {
                            continue;
                        }
                        const pinnedId = this._pinnedPositions.get(position);
                        const songPinnedAt = this._pinnedPositionById.get(song.id);
                        if ((pinnedId && song.id !== pinnedId) || (songPinnedAt && songPinnedAt !== position)) {
                            continue;
                        }

                        const result = this._buildNextState(state, song, position, relaxPositionFilter);
                        if (!result) {
                            continue;
                        }
                        if (result.feasibleState) {
                            nextStates.push(result.feasibleState);
                        }
                        if (result.fallbackState) {
                            fallbackStates.push(result.fallbackState);
                        }
                    }
                }
            };

            expand(false);

            const isEdgeSlot = position === 1 || position === this._count;
            if (isEdgeSlot && !nextStates.length && !fallbackStates.length) {
                if (position === 1) {
                    this._openerFilterRelaxed = true;
                }
                if (position === this._count) {
                    this._closerFilterRelaxed = true;
                }
                expand(true);
            }

            const pool = nextStates.length ? nextStates : fallbackStates;
            if (!pool.length) {
                break;
            }
            if (!nextStates.length && fallbackStates.length) {
                this._minimumsRelaxed = true;
            }

            pool.sort(compareStates);
            states = this._selectBeamStates(pool);
        }

        const best = this._pickFinalState(states);
        const bestItems = this._collectItems(best);
        const finalized = this._finalizeItems(bestItems);
        this._list = finalized.items;
        this._summary = finalized.summary;
    }

    _selectBeamStates(nextStates) {
        if (nextStates.length <= this._options.beamWidth) {
            return nextStates.slice();
        }

        const multiplier = clampInteger(this._randomness.beamChoicePoolMultiplier, 6, 1);
        const poolSize = Math.min(nextStates.length, this._options.beamWidth * multiplier);
        const pool = nextStates.slice(0, poolSize);
        const selected = [];
        const lastSongCounts = {};
        const firstSongCounts = {};
        const temperature = clampFloat(this._randomness.beamTemperature, 1.1, 0.01);
        const maxStatesPerLastSong = clampInteger(this._randomness.maxStatesPerLastSong, 24, 1);

        while (pool.length && selected.length < this._options.beamWidth) {
            const bestRank = pool[0].rankScore === undefined ? pool[0].score : pool[0].rankScore;
            const weights = pool.map((state) => {
                const rank = state.rankScore === undefined ? state.score : state.rankScore;
                return Math.exp(-(rank - bestRank) / temperature);
            });
            const total = weights.reduce((sum, weight) => sum + weight, 0);
            let target = this._rng() * total;
            let chosenIndex = pool.length - 1;

            for (let index = 0; index < pool.length; index += 1) {
                target -= weights[index];
                if (target <= 0) {
                    chosenIndex = index;
                    break;
                }
            }

            const chosen = pool.splice(chosenIndex, 1)[0];
            const lastSongId = chosen.lastItem ? chosen.lastItem.id : "none";
            const lastUsed = lastSongCounts[lastSongId] || 0;

            if (lastUsed >= maxStatesPerLastSong) {
                continue;
            }

            const firstSongId = chosen.firstSongId || "none";
            const firstUsed = firstSongCounts[firstSongId] || 0;

            if (firstUsed >= maxStatesPerLastSong) {
                continue;
            }

            lastSongCounts[lastSongId] = lastUsed + 1;
            firstSongCounts[firstSongId] = firstUsed + 1;
            selected.push(chosen);
        }

        if (selected.length < this._options.beamWidth) {
            const selectedSet = new Set(selected);
            for (let i = 0; i < nextStates.length && selected.length < this._options.beamWidth; i++) {
                if (!selectedSet.has(nextStates[i])) {
                    selected.push(nextStates[i]);
                }
            }
        }

        return selected.sort(compareStates);
    }

    _pickFinalState(states) {
        if (!states.length) {
            return this._initialState();
        }

        const ordered = states.slice().sort((left, right) => {
            if (left.score !== right.score) {
                return left.score - right.score;
            }
            return compareStates(left, right);
        });
        const poolSize = clampInteger(this._randomness.finalChoicePool, 12, 1);
        const pool = ordered.slice(0, poolSize);

        if (pool.length === 1) {
            return pool[0];
        }

        const bestScore = pool[0].score;
        const temperature = clampFloat(this._randomness.temperature, 0.85, 0.01);
        const weights = pool.map((state) => {
            return Math.exp(-(state.score - bestScore) / temperature);
        });
        const total = weights.reduce((sum, weight) => sum + weight, 0);
        let target = this._rng() * total;

        for (let index = 0; index < pool.length; index += 1) {
            target -= weights[index];
            if (target <= 0) {
                return pool[index];
            }
        }

        return pool[pool.length - 1];
    }

    _finalizeItems(items) {
        let state = this._initialState();
        const finalizedItems = [];

        items.forEach((item, index) => {
            const position = index + 1;
            const variant = {
                id: item.id,
                name: item.name,
                cover: item.cover,
                instrumental: item.instrumental,
                energy: item.energy,
                positionPreference: item.positionPreference,
                key: item.key,
                notes: item.notes || "",
                performance: item.performance,
            };
            const prevItem = finalizedItems[finalizedItems.length - 1] || null;
            const propTransition = this._scoreConfiguredProps(prevItem, variant);
            const nextPropState = this._advancePropState(state, propTransition.changes, prevItem);
            const positionScore = this._scorePosition(variant, position);
            const transitionScore = propTransition.score;
            const keyFlow = this._scoreKeyFlow(prevItem, variant, state.keyFifthsDir);
            const incrementalScore = transitionScore + positionScore.score + this._songBias(variant.id) + keyFlow.score;

            const finalized = {
                id: variant.id,
                name: variant.name,
                cover: variant.cover,
                instrumental: variant.instrumental,
                key: variant.key,
                notes: variant.notes,
                performance: variant.performance,
                position,
                incrementalScore,
                cumulativeScore: state.score + incrementalScore,
                transitionNotes: propTransition.notes,
                positionNotes: positionScore.notes,
                contextNotes: [],
                propChanges: propTransition.changes,
            };

            finalizedItems.push(finalized);
            state = {
                items: finalizedItems.slice(),
                usedIds: merge(state.usedIds, { [variant.id]: true }),
                score: state.score + incrementalScore,
                rankScore: state.score + incrementalScore,
                coverCount: state.coverCount + Number(Boolean(variant.cover)),
                instrumentalCount: state.instrumentalCount + Number(Boolean(variant.instrumental)),
                propChangeCounts: nextPropState.propChangeCounts,
                propStreaks: nextPropState.propStreaks,
                changeTotals: nextPropState.changeTotals,
                keyFifthsDir: keyFlow.dir,
            };
        });

        const anxiety = computeAnxiety(finalizedItems, this._config);

        return {
            items: finalizedItems,
            summary: {
                score: state.score,
                covers: state.coverCount,
                instrumentals: state.instrumentalCount,
                changes: state.changeTotals,
                anxiety,
                minimumsRelaxed: Boolean(this._minimumsRelaxed),
                openerFilterRelaxed: Boolean(this._openerFilterRelaxed),
                closerFilterRelaxed: Boolean(this._closerFilterRelaxed),
            },
        };
    }

    _buildNextState(state, song, position, relaxPositionFilter = false) {
        const isPinnedHere = this._pinnedPositions.get(position) === song.id;
        if (!relaxPositionFilter && !this._options.selectionPhase && !isPinnedHere) {
            if (position === 1 && song.notGoodOpener) {
                return null;
            }
            if (position === this._count && song.notGoodCloser) {
                return null;
            }
        }

        const nextCoverCount = state.coverCount + (song.cover ? 1 : 0);
        const nextInstrumentalCount = state.instrumentalCount + (song.instrumental ? 1 : 0);

        if (this._options.maxCovers >= 0 && nextCoverCount > this._options.maxCovers) {
            return null;
        }
        if (this._options.maxInstrumentals >= 0 && nextInstrumentalCount > this._options.maxInstrumentals) {
            return null;
        }

        const bestVariant = this._findBestVariant(state, song, position);
        if (!bestVariant.feasible && !bestVariant.fallback) {
            return null;
        }

        const buildState = (variantState) => {
            if (!variantState) {
                return null;
            }

            const newScore = state.score + variantState.incrementalScore;
            const usedIds = Object.create(state.usedIds);
            usedIds[song.id] = true;

            return {
                head: { item: variantState.item, prev: state.head },
                length: state.length + 1,
                usedIds,
                score: newScore,
                coverCount: nextCoverCount,
                instrumentalCount: nextInstrumentalCount,
                lastItem: variantState.item,
                firstSongId: state.firstSongId || song.id,
                rankScore: newScore + this._randomJitter(this._randomness.stateJitter),
                _tiebreaker: this._rng(),
                propChangeCounts: variantState.propChangeCounts,
                propStreaks: variantState.propStreaks,
                changeTotals: variantState.changeTotals,
                usageCounts: variantState.usageCounts,
                remainingPotentialCounts: variantState.remainingPotentialCounts,
                keyFifthsDir: variantState.keyFifthsDir ?? 0,
            };
        };

        return {
            feasibleState: buildState(bestVariant.feasible),
            fallbackState: buildState(bestVariant.fallback),
        };
    }

    _findBestVariant(state, song, position) {
        const prevItem = state.lastItem;
        let best = null;
        let bestScore = Infinity;
        // Fallback: track best variant even if minimums are impossible
        let fallback = null;
        let fallbackScore = Infinity;

        const variants = this._variantCache.get(song.id);
        const nextRemainingPotentialCounts = this._consumeRemainingPotentialCounts(
            state.remainingPotentialCounts,
            song.id,
        );
        let remainingGroupCapabilitiesById = null;
        for (let vi = 0; vi < variants.length; vi++) {
            const variant = variants[vi];
            const propTransition = this._scoreConfiguredPropsLite(prevItem, variant);
            const isPinnedHere = this._pinnedPositions.get(position) === song.id;
            if (!isPinnedHere && !this._isAllowedByPropRules(state, propTransition.changes, prevItem, position)) {
                continue;
            }

            const nextPropState = this._advancePropState(state, propTransition.changes, prevItem);
            const nextUsageCounts = this._updateUsageCounts(state.usageCounts, variant);
            if (!remainingGroupCapabilitiesById && this._minimumGroups.length) {
                remainingGroupCapabilitiesById = Object.create(null);
                for (let groupIndex = 0; groupIndex < this._minimumGroups.length; groupIndex += 1) {
                    const group = this._minimumGroups[groupIndex];
                    remainingGroupCapabilitiesById[group.id] = this._remainingGroupCapabilities(
                        state,
                        song.id,
                        group.id,
                    );
                }
            }
            const minimumPenalty = this._scoreMinimumPenalty(
                state,
                song.id,
                position,
                nextUsageCounts,
                nextRemainingPotentialCounts,
                remainingGroupCapabilitiesById,
            );

            const positionScore = this._scorePositionLite(variant, position);
            const transitionScore = propTransition.score;
            const chaosAdjustment = this._chaosAdjustment(prevItem, variant);
            const keyFlow = this._scoreKeyFlow(prevItem, variant, state.keyFifthsDir);

            if (minimumPenalty === Infinity) {
                // Track as fallback in case all variants are impossible
                const fbScore =
                    transitionScore + positionScore + this._songBias(variant.id) + chaosAdjustment + keyFlow.score;
                if (fbScore < fallbackScore) {
                    fallbackScore = fbScore;
                    fallback = {
                        propChangeCounts: nextPropState.propChangeCounts,
                        propStreaks: nextPropState.propStreaks,
                        changeTotals: nextPropState.changeTotals,
                        usageCounts: nextUsageCounts,
                        remainingPotentialCounts: nextRemainingPotentialCounts,
                        incrementalScore: fbScore,
                        keyFifthsDir: keyFlow.dir,
                        item: variant,
                    };
                }
                continue;
            }

            const incrementalScore =
                transitionScore +
                positionScore +
                this._songBias(variant.id) +
                minimumPenalty +
                chaosAdjustment +
                keyFlow.score;
            const exploratoryScore = incrementalScore + this._randomJitter(this._randomness.variantJitter);

            if (exploratoryScore < bestScore) {
                bestScore = exploratoryScore;
                best = {
                    propChangeCounts: nextPropState.propChangeCounts,
                    propStreaks: nextPropState.propStreaks,
                    changeTotals: nextPropState.changeTotals,
                    usageCounts: nextUsageCounts,
                    remainingPotentialCounts: nextRemainingPotentialCounts,
                    incrementalScore,
                    keyFifthsDir: keyFlow.dir,
                    item: variant,
                };
            }
        }

        return {
            feasible: best,
            fallback,
        };
    }

    // Lite version: returns { score, changes } without building notes arrays
    _scoreConfiguredPropsLite(prevItem, nextVariant) {
        const changes = {};
        let score = 0;

        for (let i = 0; i < this._propNames.length; i++) {
            const propName = this._propNames[i];
            const change = this._detectPropChangeLite(prevItem, nextVariant, propName, this._propConfig[propName]);
            changes[propName] = change;
            if (change.changed) {
                score += change.magnitude * this._getPropWeight(propName);
            }
        }

        return { score, changes };
    }

    _detectPropChangeLite(prevItem, nextVariant, propName, rule) {
        if (!prevItem) {
            return { changed: false, magnitude: 0 };
        }
        const prevPerf = prevItem.performance;
        const nextPerf = nextVariant.performance;
        const kind = rule.kind || inferPropKind(propName);
        if (kind === "instrumentSet") {
            return detectInstrumentSetChangeLite(prevPerf, nextPerf);
        }
        if (kind === "instrumentDelta") {
            return detectFieldChangeLite(prevPerf, nextPerf, rule.field || propName, true);
        }
        return detectFieldChangeLite(prevPerf, nextPerf, rule.field || propName, false);
    }

    // Lite position scoring: returns just the numeric score
    _scorePositionLite(song, position) {
        if (this._options.selectionPhase) return 0;
        let score = 0;
        const orderLabel = this._findOrderLabel(position);
        const orderRules = this._config.general?.order?.[orderLabel] || [];

        for (let i = 0; i < orderRules.length; i++) {
            const [name, expected] = orderRules[i];
            const accepted = Array.isArray(expected) ? expected : [expected];
            const actual = song[name] === undefined ? false : song[name];
            if (accepted.indexOf(actual) < 0) {
                score += this._weights.positionMiss;
            }
        }

        score += this._scoreMusicalPosition(song, position);

        return score;
    }

    _targetEnergy(position) {
        if (!this._options.setShape) {
            return null;
        }
        const progress = this._count <= 1 ? 1 : (position - 1) / (this._count - 1);
        if (this._options.setShape === "big-ends") {
            return 5 - 3 * Math.sin(Math.PI * progress);
        }
        if (this._options.setShape === "alternating") {
            return position % 2 === 1 ? 4.5 : 2.5;
        }
        if (this._options.setShape === "lively") {
            return 4.5;
        }
        if (this._options.setShape === "none") {
            return null;
        }
        return 2.5 + 2.5 * progress;
    }

    _scoreMusicalPosition(song, position) {
        let score = 0;
        const targetEnergy = this._targetEnergy(position);
        if (targetEnergy !== null) {
            score += Math.abs((song.energy || 3) - targetEnergy) * 1.5;
        }

        const preference = song.positionPreference || "anywhere";
        if (preference === "anywhere") return score;
        const progress = this._count <= 1 ? 1 : (position - 1) / (this._count - 1);
        const matches =
            (preference === "opener" && position === 1) ||
            (preference === "closer" && position === this._count) ||
            (preference === "early" && progress <= 0.34) ||
            (preference === "middle" && progress > 0.25 && progress < 0.75) ||
            (preference === "late" && progress >= 0.66);
        return score + (matches ? -4 : 5);
    }

    _scoreConfiguredProps(prevItem, nextVariant) {
        const changes = {};
        const notes = [];
        let score = 0;

        this._propNames.forEach((propName) => {
            const change = this._detectPropChange(prevItem, nextVariant, propName, this._propConfig[propName]);
            changes[propName] = change;
            if (change.changed) {
                score += change.magnitude * this._getPropWeight(propName);
                Array.prototype.push.apply(notes, change.notes);
            }
        });

        return { score, notes, changes };
    }

    _detectPropChange(prevItem, nextVariant, propName, rule) {
        if (!prevItem) {
            return { changed: false, magnitude: 0, notes: [] };
        }

        const prevPerf = prevItem.performance;
        const nextPerf = nextVariant.performance;
        const kind = rule.kind || inferPropKind(propName);

        if (kind === "instrumentSet") {
            return detectInstrumentSetChange(prevPerf, nextPerf);
        }
        if (kind === "instrumentDelta") {
            return detectFieldChange(prevPerf, nextPerf, rule.field || propName, true);
        }
        return detectFieldChange(prevPerf, nextPerf, rule.field || propName, false);
    }

    _getPropWeight(propName) {
        const rule = this._propConfig[propName] || {};
        const weightKey = rule.weightKey || propName;
        return this._weights[weightKey] || 0;
    }

    _isAllowedByPropRules(state, propChanges, prevItem, position) {
        const isLastSong = position === this._count;

        for (let index = 0; index < this._propNames.length; index += 1) {
            const propName = this._propNames[index];
            const rule = this._propConfig[propName] || {};
            const change = propChanges[propName];

            if (!change.changed || !prevItem) {
                continue;
            }
            // maxChanges is always enforced, even on the last song
            if (rule.maxChanges !== undefined && state.propChangeCounts[propName] >= rule.maxChanges) {
                return false;
            }
            // allowChangeOnLastSong only bypasses minStreak, not maxChanges
            if (isLastSong && rule.allowChangeOnLastSong) {
                continue;
            }
            if (rule.minStreak !== undefined && state.propStreaks[propName] < rule.minStreak) {
                return false;
            }
        }

        return true;
    }

    _advancePropState(state, propChanges, prevItem) {
        const propChangeCounts = { ...state.propChangeCounts };
        const propStreaks = { ...state.propStreaks };
        const changeTotals = { ...state.changeTotals };

        for (let i = 0; i < this._propNames.length; i++) {
            const propName = this._propNames[i];
            const change = propChanges[propName];
            if (!prevItem) {
                propStreaks[propName] = 1;
                continue;
            }

            if (change.changed) {
                propChangeCounts[propName] += 1;
                propStreaks[propName] = 1;
                changeTotals[propName] += change.magnitude;
                continue;
            }

            propStreaks[propName] += 1;
        }

        return {
            propChangeCounts,
            propStreaks,
            changeTotals,
        };
    }

    _scorePosition(song, position) {
        const notes = [];
        let score = 0;
        const orderLabel = this._findOrderLabel(position);
        const orderRules = this._config.general?.order?.[orderLabel] || [];

        orderRules.forEach(([name, expected]) => {
            const accepted = Array.isArray(expected) ? expected : [expected];
            const actual = song[name] === undefined ? false : song[name];

            if (accepted.indexOf(actual) < 0) {
                score += this._weights.positionMiss;
                notes.push(`${orderLabel} wants ${name}=${accepted.join("/")}`);
            }
        });

        score += this._scoreMusicalPosition(song, position);

        return { score, notes };
    }

    _findOrderLabel(position) {
        if (position === 1) {
            return "first";
        }
        if (position === 2) {
            return "second";
        }
        if (position === this._count - 1) {
            return "penultimate";
        }
        if (position === this._count) {
            return "last";
        }
        return undefined;
    }

    toJSON() {
        return {
            options: this._options,
            seed: this._seed,
            summary: this._summary,
            songs: this._list,
        };
    }
}

const DEFAULT_WEIGHTS = {
    positionMiss: 8,
};

const DEFAULT_RANDOMNESS = {
    variantJitter: 1.5,
    stateJitter: 2.5,
    finalChoicePool: 12,
    temperature: 0.85,
    shuffleCatalog: true,
    songBias: 3,
    beamChoicePoolMultiplier: 4,
    beamTemperature: 2.0,
    maxStatesPerLastSong: 8,
    blockShuffleTemperature: 1.4,
};

export function generateSetlist(songs, config, options = {}) {
    const usesSelectionPreferences =
        options.selectionVariety !== undefined || options.rotation !== undefined || options.setShape !== undefined;
    const selectedSongs =
        options.fixedSongIds || !usesSelectionPreferences ? songs : selectSongPool(songs, options, config);
    const generator = new SetList(selectedSongs, config, {
        ...options,
        count: Math.min(options.count ?? config?.general?.count ?? 15, selectedSongs.length),
    });
    return generator.toJSON();
}

function selectSongPool(songs, options = {}, config = {}) {
    const count = Math.min(
        Math.max(1, Number.parseInt(options.count, 10) || config?.general?.count || 15),
        songs.length,
    );
    if (songs.length <= count) return songs.slice();

    const pinnedIds = new Set((options.pinnedSongs || []).map((pin) => String(pin.id)));
    const pinnedSongs = songs.filter((song) => pinnedIds.has(String(song.id))).slice(0, count);
    const remainingCount = count - pinnedSongs.length;
    if (remainingCount <= 0) return pinnedSongs;
    const remainingSongs = songs.filter((song) => !pinnedIds.has(String(song.id)));

    const variety = clampUnit((options.selectionVariety === undefined ? 50 : Number(options.selectionVariety)) / 100);
    const selectionOptions = {
        ...options,
        count: remainingCount,
        keyFlow: false,
        setShape: "none",
        transitionSmoothness: "adventurous",
        selectionPhase: true,
        pinnedSongs: [],
        randomness: {
            ...(options.randomness || {}),
            songBias: 1 + variety * 12,
            temperature: 0.35 + variety * 1.65,
            stateJitter: variety * 3,
            variantJitter: variety * 1.5,
        },
    };
    const selectedIds = new Set(
        new SetList(remainingSongs, config, selectionOptions).toJSON().songs.map((song) => song.id),
    );
    pinnedSongs.forEach((song) => {
        selectedIds.add(String(song.id));
    });
    return songs.filter((song) => selectedIds.has(String(song.id)));
}

export function scoreFixedOrder(fixedSongs, config, options = {}) {
    const weights = Object.assign({}, DEFAULT_WEIGHTS, config?.general?.weighting || {});
    const propNames = Object.keys(config?.props || {});
    const propConfig = config?.props || {};
    const keyFlowEnabled = Boolean(options.keyFlow);

    function getPropWeight(propName) {
        const rule = propConfig[propName] || {};
        const weightKey = rule.weightKey || propName;
        return weights[weightKey] || 0;
    }

    function scorePropTransition(prevItem, nextItem) {
        if (!prevItem) {
            const changes = {};
            for (const p of propNames) changes[p] = { changed: false, magnitude: 0, notes: [] };
            return { score: 0, notes: [], changes };
        }

        const prevPerf = prevItem.performance || {};
        const nextPerf = nextItem.performance || {};
        const changes = {};
        const notes = [];
        let score = 0;

        for (const propName of propNames) {
            const rule = propConfig[propName] || {};
            const kind = rule.kind || inferPropKind(propName);
            let change;

            if (kind === "instrumentSet") {
                change = detectInstrumentSetChange(prevPerf, nextPerf);
            } else if (kind === "instrumentDelta") {
                change = detectFieldChange(prevPerf, nextPerf, rule.field || propName, true);
            } else {
                change = detectFieldChange(prevPerf, nextPerf, rule.field || propName, false);
            }

            changes[propName] = change;
            if (change.changed) {
                score += change.magnitude * getPropWeight(propName);
                notes.push(...change.notes);
            }
        }

        return { score, notes, changes };
    }

    const keyFlowWeight = weights.keyFlow ?? 2;

    const items = [];
    let totalScore = 0;
    let coverCount = 0;
    let instrumentalCount = 0;
    let keyDir = 0;

    fixedSongs.forEach((song, index) => {
        const prevItem = items[items.length - 1] || null;
        const propTransition = scorePropTransition(prevItem, song);
        const keyFlow =
            keyFlowEnabled && prevItem
                ? scoreKeyTransition(prevItem.key, song.key, keyDir, keyFlowWeight)
                : { score: 0, dir: keyDir };
        keyDir = keyFlow.dir;

        const incrementalScore = propTransition.score + keyFlow.score;
        totalScore += incrementalScore;
        coverCount += Number(Boolean(song.cover));
        instrumentalCount += Number(Boolean(song.instrumental));

        items.push({
            id: song.id,
            name: song.name,
            cover: song.cover,
            instrumental: song.instrumental,
            key: song.key,
            notes: song.notes || "",
            performance: song.performance,
            position: index + 1,
            incrementalScore,
            cumulativeScore: totalScore,
            transitionNotes: propTransition.notes,
            positionNotes: [],
            contextNotes: [],
            propChanges: propTransition.changes,
        });
    });

    const anxiety = computeAnxiety(items, config);

    return {
        songs: items,
        summary: {
            score: totalScore,
            covers: coverCount,
            instrumentals: instrumentalCount,
            anxiety,
        },
    };
}

export function buildDefaultPerformance(song, showConstraints = {}) {
    const catalog = new SongsCatalog([song]);
    const variants = catalog.expandVariants(song, showConstraints);
    if (!variants.length) return {};
    return variants[0].performance || {};
}
