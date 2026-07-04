import { clone, deepMerge, nowIso, sortByName, uid } from "./utils.js";

export const SCHEMA_VERSION = 2;

const DEFAULT_CONFIG_TEMPLATE = {
    general: {
        count: 9,
        beamWidth: 512,
        limits: {
            covers: -1,
            instrumentals: -1,
        },
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
        weighting: {
            tuning: 4,
            capo: 2,
            instrument: 3,
            technique: 1,
            keyFlow: 2,
            positionMiss: 8,
        },
        randomness: {
            variantJitter: 1.5,
            stateJitter: 2.5,
            finalChoicePool: 12,
            temperature: 0.85,
            shuffleCatalog: true,
            songBias: 3,
            beamChoicePoolMultiplier: 6,
            beamTemperature: 2.0,
            maxStatesPerLastSong: 24,
            blockShuffleTemperature: 1.4,
        },
    },
    show: {},
    props: {
        tuning: {
            kind: "instrumentField",
            field: "tuning",
            minStreak: 1,
            allowChangeOnLastSong: true,
        },
        capo: {
            kind: "instrumentDelta",
            field: "capo",
            minStreak: 1,
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
};

export const DEFAULT_APP_CONFIG = createDefaultAppConfig();

export function normalizeMemberRecord(memberConfig) {
    const instruments = Array.isArray(memberConfig?.instruments)
        ? memberConfig.instruments
              .map((instrument) => ({
                  name: instrument?.name || "",
                  tunings: Array.isArray(instrument?.tunings) ? instrument.tunings.filter(Boolean) : [],
                  defaultTuning: instrument?.defaultTuning || "",
                  techniques: Array.isArray(instrument?.techniques) ? instrument.techniques.filter(Boolean) : [],
                  defaultTechnique: instrument?.defaultTechnique || "",
              }))
              .filter((instrument) => instrument.name)
        : [];

    return {
        instruments,
        defaultInstrument: memberConfig?.defaultInstrument || "",
    };
}

export function createDefaultAppConfig({ bandName = "", seedConfig = DEFAULT_CONFIG_TEMPLATE } = {}) {
    const timestamp = nowIso();
    const baseConfig = clone(seedConfig);
    baseConfig.show = baseConfig.show || {};
    delete baseConfig.show.members;
    delete baseConfig.band?.members;

    return {
        bandName,
        schemaVersion: SCHEMA_VERSION,
        createdAt: timestamp,
        updatedAt: timestamp,
        ui: { dieColor: null },
        ...baseConfig,
    };
}

export function blankSong() {
    const timestamp = nowIso();
    return {
        id: uid("song"),
        name: "",
        cover: false,
        instrumental: false,
        notGoodOpener: false,
        notGoodCloser: false,
        unpracticed: false,
        key: "",
        notes: "",
        schemaVersion: SCHEMA_VERSION,
        createdAt: timestamp,
        updatedAt: timestamp,
        members: {},
    };
}

function normalizeSongMembers(members) {
    const normalized = {};
    for (const [name, setup] of Object.entries(members || {})) {
        const instruments = (Array.isArray(setup?.instruments) ? setup.instruments : []).map((option) => ({
            name: option?.name || "",
            tuning: (Array.isArray(option?.tuning) ? option.tuning : option?.tuning ? [option.tuning] : []).filter(
                Boolean,
            ),
            capo: Number(option?.capo) || 0,
            // "none" was a legacy sentinel meaning "explicitly no technique";
            // an empty array now carries that meaning (technique is optional).
            picking: (Array.isArray(option?.picking) ? option.picking : option?.picking ? [option.picking] : []).filter(
                (technique) => technique && technique !== "none",
            ),
        }));
        normalized[name] = { instruments };
    }
    return normalized;
}

export function normalizeSongRecord(song) {
    const timestamp = song.createdAt || nowIso();
    return {
        id: String(song.id),
        name: song.name || "",
        cover: Boolean(song.cover),
        instrumental: Boolean(song.instrumental),
        notGoodOpener: Boolean(song.notGoodOpener),
        notGoodCloser: Boolean(song.notGoodCloser),
        unpracticed: Boolean(song.unpracticed),
        key: song.key || "",
        notes: song.notes || "",
        schemaVersion: song.schemaVersion || SCHEMA_VERSION,
        createdAt: song.createdAt || timestamp,
        updatedAt: song.updatedAt || timestamp,
        members: normalizeSongMembers(song.members),
    };
}

/**
 * A member's default rig, shaped like a song member entry: the default
 * instrument with its default tuning and technique. This is what a member
 * plays on any song that doesn't override them. Returns null for members
 * with no instruments configured (they're just listed — nothing for the
 * roller to schedule).
 */
export function memberDefaultRig(memberConfig) {
    const instruments = memberConfig?.instruments || [];
    if (instruments.length === 0) return null;
    const defaultName = memberConfig.defaultInstrument || instruments[0].name;
    const instrument = instruments.find((i) => i.name === defaultName) || instruments[0];
    return {
        instruments: [
            {
                name: instrument.name,
                tuning: instrument.defaultTuning ? [instrument.defaultTuning] : [],
                capo: 0,
                picking: instrument.defaultTechnique ? [instrument.defaultTechnique] : [],
            },
        ],
    };
}

/**
 * Resolve a song's effective member setups: explicit song overrides win,
 * every other band member inherits their default rig. Songs therefore only
 * need to store deviations — a member with no special needs never appears
 * in song data at all. Members that exist only on the song (removed from
 * the band config since) keep their stored setups.
 */
export function resolveSongMembers(song, bandMembers) {
    const resolved = {};
    for (const [name, config] of Object.entries(bandMembers || {})) {
        const override = song?.members?.[name];
        if (override && (override.instruments || []).length > 0) {
            resolved[name] = override;
        } else {
            const rig = memberDefaultRig(config);
            if (rig) resolved[name] = rig;
        }
    }
    for (const [name, setup] of Object.entries(song?.members || {})) {
        if (!(name in resolved) && (setup?.instruments || []).length > 0) {
            resolved[name] = setup;
        }
    }
    return resolved;
}

/**
 * True when a song's member entry is exactly the member's default rig —
 * such entries are redundant (inheritance produces the same result) and
 * get squashed out of the song at save time.
 */
export function rigEqualsDefault(setup, memberConfig) {
    const rig = memberDefaultRig(memberConfig);
    if (!rig) return false;
    const options = setup?.instruments || [];
    if (options.length !== 1) return false;
    const actual = options[0];
    const expected = rig.instruments[0];
    const sortedEqual = (a, b) => JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort());
    return (
        actual.name === expected.name &&
        (Number(actual.capo) || 0) === 0 &&
        sortedEqual(actual.tuning, expected.tuning) &&
        sortedEqual(actual.picking, expected.picking)
    );
}

export function normalizeAppConfig(config) {
    if (!config) {
        return null;
    }

    const timestamp = config.createdAt || nowIso();

    const normalized = deepMerge(createDefaultAppConfig({ bandName: config.bandName || "" }), {
        ...clone(config),
        bandName: config.bandName || "",
        schemaVersion: config.schemaVersion || SCHEMA_VERSION,
        createdAt: config.createdAt || timestamp,
        updatedAt: config.updatedAt || timestamp,
    });
    // Members are now stored as individual files; strip from config
    delete normalized.band?.members;
    delete normalized.show?.members;
    delete normalized.catalog;

    // Validate ui.dieColor if present
    normalized.ui =
        normalized.ui && typeof normalized.ui === "object" && !Array.isArray(normalized.ui)
            ? normalized.ui
            : { dieColor: null };
    if (normalized.ui.dieColor != null && !/^#[0-9a-fA-F]{6}$/.test(normalized.ui.dieColor)) {
        normalized.ui.dieColor = null;
    }

    return normalized;
}

export function sortSongs(list) {
    return sortByName(list.map((song) => normalizeSongRecord(song)));
}
