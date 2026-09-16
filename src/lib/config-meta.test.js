import { describe, expect, it } from "vitest";
import { CONFIG_SECTIONS } from "./config-meta.js";

describe("config-meta", () => {
    it("only exposes position preferences and band identity", () => {
        expect(CONFIG_SECTIONS.map((section) => section.id)).toEqual(["position-preferences", "identity"]);
    });

    it("no longer exposes transition costs or per-prop transition rules", () => {
        const paths = CONFIG_SECTIONS.flatMap((section) => section.fields.map((field) => field.path));
        expect(paths.some((path) => path.startsWith("general.weighting"))).toBe(false);
        expect(paths.some((path) => path.startsWith("props."))).toBe(false);
    });
});
