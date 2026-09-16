import { describe, expect, it } from "vitest";
import { CONFIG_SECTIONS } from "./config-meta.js";

describe("config-meta", () => {
    it("exposes props.tuning.returnPenalty in Transition Rules", () => {
        const propsSection = CONFIG_SECTIONS.find((section) => section.id === "props");
        expect(propsSection).toBeDefined();

        const field = propsSection.fields.find((entry) => entry.path === "props.tuning.returnPenalty");
        expect(field).toMatchObject({
            label: "Tuning return penalty",
            type: "number",
            min: 0,
            max: 10,
        });
        expect(field.description).toMatch(/set to 0/i);
    });
});
