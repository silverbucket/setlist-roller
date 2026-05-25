export const CONFIG_SECTIONS = [
    {
        id: "position-preferences",
        title: "Position Preferences",
        intro: "Control which song types the generator avoids at key positions. Violations add a scoring penalty — they're strong preferences, not hard blocks.",
        fields: [
            {
                path: "general.order.first",
                rule: ["cover", false],
                label: "Prefer non-cover opener",
                type: "order-rule",
                description:
                    "When on, the generator avoids starting the set with a cover song. Turn off if your catalog is all covers.",
            },
            {
                path: "general.order.first",
                rule: ["instrumental", false],
                label: "Prefer non-instrumental opener",
                type: "order-rule",
                description: "When on, the generator avoids starting the set with an instrumental.",
            },
            {
                path: "general.order.second",
                rule: ["cover", false],
                label: "Prefer non-cover at position 2",
                type: "order-rule",
                description:
                    "When on, the generator avoids placing a cover song second. Leaving this off prevents it from locking the opener when your catalog has few originals.",
            },
            {
                path: "general.order.second",
                rule: ["instrumental", false],
                label: "Prefer non-instrumental at position 2",
                type: "order-rule",
                description: "When on, the generator avoids placing an instrumental second.",
            },
        ],
    },
    {
        id: "identity",
        title: "Band Identity",
        fields: [
            {
                path: "bandName",
                label: "Band name",
                type: "text",
                description: "Shown in the app header.",
            },
        ],
    },
    {
        id: "weights",
        title: "Transition Costs",
        intro: "Higher values make the generator try harder to avoid that kind of change between songs.",
        fields: [
            {
                path: "general.weighting.tuning",
                label: "Tuning change",
                type: "number",
                min: 0,
                max: 50,
                description:
                    "How much to avoid switching tunings. At 0 the generator doesn't care; at 10+ it will group songs by tuning aggressively.",
            },
            {
                path: "general.weighting.capo",
                label: "Capo movement",
                type: "number",
                min: 0,
                max: 50,
                description: "Cost per capo step moved. A jump from capo 0 to capo 3 costs 3× this value.",
            },
            {
                path: "general.weighting.instrument",
                label: "Instrument swap",
                type: "number",
                min: 0,
                max: 50,
                description:
                    "How much to avoid making someone put down one instrument and pick up another between songs.",
            },
            {
                path: "general.weighting.technique",
                label: "Technique change",
                type: "number",
                min: 0,
                max: 50,
                description:
                    "How much to avoid switching playing technique (e.g. fingerpicks to clawhammer) between songs.",
            },
            {
                path: "general.weighting.keyFlow",
                label: "Key distance",
                type: "number",
                min: 0,
                max: 50,
                description:
                    "How much to prefer smooth key transitions between songs (circle of fifths proximity). Only applies when 'Smooth key flow' is enabled on the roll screen.",
            },
        ],
    },
    {
        id: "props",
        title: "Transition Rules",
        intro: "Hard limits on how quickly changes can happen. Unlike costs (which are preferences), these are enforced strictly.",
        fields: [
            {
                path: "props.tuning.minStreak",
                label: "Tuning min streak",
                type: "number",
                min: 0,
                max: 20,
                description:
                    "Once a tuning is set, the generator must play at least this many songs before switching. Set to 0 to allow changes at any time.",
            },
            {
                path: "props.tuning.allowChangeOnLastSong",
                label: "Tuning can change on closer",
                type: "boolean",
                description:
                    "Let the closing song break the tuning streak rule. Useful so the closer isn't locked out of a great song.",
            },
            {
                path: "props.capo.minStreak",
                label: "Capo min streak",
                type: "number",
                min: 0,
                max: 20,
                description: "Minimum songs to stay at a capo position before moving it.",
            },
            {
                path: "props.capo.allowChangeOnLastSong",
                label: "Capo can change on closer",
                type: "boolean",
                description: "Let the closing song ignore the capo streak rule.",
            },
            {
                path: "props.instruments.minStreak",
                label: "Instrument min streak",
                type: "number",
                min: 0,
                max: 20,
                description: "Minimum songs before a member can swap to a different instrument.",
            },
            {
                path: "props.instruments.allowChangeOnLastSong",
                label: "Instrument swap on closer",
                type: "boolean",
                description: "Let the closing song break the instrument streak rule.",
            },
            {
                path: "props.picking.minStreak",
                label: "Technique min streak",
                type: "number",
                min: 0,
                max: 20,
                description: "Minimum songs before a playing technique change is allowed.",
            },
            {
                path: "props.picking.allowChangeOnLastSong",
                label: "Technique can change on closer",
                type: "boolean",
                description: "Let the closing song ignore the technique streak rule.",
            },
        ],
    },
];
