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
            keyFlow: 2,
            positionMiss: 8,
            earlyCover: 2,
            earlyInstrumental: 2,
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
        members: song.members || {},
    };
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
