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
];
