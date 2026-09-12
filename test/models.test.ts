import { describe, expect, it } from "vitest";
import {
	canonicalModel,
	modelByCanonical,
	modelPattern,
	recommendedModel,
	resolveModelReference,
	validateThinkingLevel,
} from "../src/models.ts";
import { ROLES } from "../src/types.ts";
import { models, supportedLevels } from "./helpers.ts";

describe("model resolution", () => {
	it("uses canonical provider/model identifiers including custom IDs with colons", () => {
		expect(canonicalModel(models[3])).toBe("custom/worker:exact");
		expect(modelByCanonical(models, "custom/worker:exact")).toBe(models[3]);
	});

	it("reads Pi-native bare IDs and thinking suffixes without confusing colons in model IDs", () => {
		expect(resolveModelReference(models, "gpt-5.6-sol")?.model).toBe(models[0]);
		expect(resolveModelReference(models, "openai/gpt-5.6-sol:high")).toEqual({
			model: models[0],
			embeddedThinkingLevel: "high",
		});
		expect(resolveModelReference(models, "custom/worker:exact")).toEqual({ model: models[3] });
		expect(resolveModelReference(models, "custom/worker:exact:xhigh")).toEqual({
			model: models[3],
			embeddedThinkingLevel: "xhigh",
		});
		expect(modelPattern({ model: "custom/worker:exact", thinkingLevel: "xhigh" })).toBe(
			"custom/worker:exact:xhigh",
		);
	});

	it("treats recommendations as preferences over registry models, not a catalog", () => {
		expect(recommendedModel(ROLES[0], models)).toBe(models[0]);
		expect(recommendedModel(ROLES[1], models)).toBe(models[1]);
		expect(recommendedModel(ROLES[2], models)).toBe(models[2]);
		expect(recommendedModel(ROLES[0], [models[3]])).toBeUndefined();
	});

	it("validates only levels exposed for the selected model", () => {
		expect(validateThinkingLevel(models[0], "high", supportedLevels)).toBeUndefined();
		expect(validateThinkingLevel(models[0], "max", supportedLevels)).toContain("not supported");
		expect(validateThinkingLevel(models[1], undefined, supportedLevels)).toBeUndefined();
		expect(validateThinkingLevel(models[1], "off", supportedLevels)).toContain("does not expose");
	});
});
