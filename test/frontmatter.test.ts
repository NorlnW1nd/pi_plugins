import { describe, expect, it } from "vitest";
import { inspectRoleFile, parseAgentFile, renderRoleFile } from "../src/frontmatter.ts";
import { models, supportedLevels } from "./helpers.ts";
import { ROLES } from "../src/types.ts";

const sergeant = ROLES[0];

describe("role configuration", () => {
	it("reads a valid existing selection", () => {
		const content = `---\nname: sergeant\ndescription: Existing\nmodel: openai/gpt-5.6-sol\nthinkingLevel: high\n---\n\nCustom prompt.\n`;
		const state = inspectRoleFile({ role: sergeant, path: "/repo/.pi/agents/sergeant.md", content, models, supportedLevels });
		expect(state.selection).toEqual({ role: "sergeant", model: "openai/gpt-5.6-sol", thinkingLevel: "high" });
		expect(state.warnings).toEqual([]);
	});

	it("preserves user fields, comments, and body when updating a selection", () => {
		const content = `---\nname: sergeant\ndescription: Existing\n# Keep this note\nmodel: openai/gpt-5.6-sol\nthinkingLevel: low\ntools: read, grep\n---\n\nCustom user-authored prompt.\n`;
		const state = inspectRoleFile({ role: sergeant, path: "/repo/.pi/agents/sergeant.md", content, models, supportedLevels });
		const rendered = renderRoleFile(state, {
			role: "sergeant",
			model: "custom/worker:exact",
			thinkingLevel: "xhigh",
		});
		expect(rendered).toContain("# Keep this note");
		expect(rendered).toContain("tools: read, grep");
		expect(rendered).toContain("Custom user-authored prompt.");
		expect(rendered).toContain("model: custom/worker:exact:xhigh");
		expect(rendered).not.toContain("thinkingLevel:");
	});

	it("omits manufactured thinking configuration for non-reasoning models", () => {
		const state = inspectRoleFile({ role: sergeant, path: "/repo/.pi/agents/sergeant.md", content: null, models, supportedLevels });
		const rendered = renderRoleFile(state, {
			role: "sergeant",
			model: "deepseek/deepseek-v4.1-flash",
		});
		expect(parseAgentFile(rendered).document.get("thinkingLevel")).toBeUndefined();
		expect(parseAgentFile(rendered).document.get("model")).toBe("deepseek/deepseek-v4.1-flash");
	});

	it("preserves valid Pi-native model patterns and bare unique IDs", () => {
		for (const model of ["gpt-5.6-sol:high", "openai/gpt-5.6-sol:high"]) {
			const state = inspectRoleFile({
				role: sergeant,
				path: "/repo/.pi/agents/sergeant.md",
				content: `---\nname: sergeant\nmodel: ${model}\n---\n`,
				models,
				supportedLevels,
			});
			expect(state.selection).toEqual({
				role: "sergeant",
				model: "openai/gpt-5.6-sol",
				thinkingLevel: "high",
			});
		}
	});

	it("flags unavailable models and incompatible thinking without silently falling back", () => {
		const unavailable = inspectRoleFile({
			role: sergeant,
			path: "/repo/.pi/agents/sergeant.md",
			content: `---\nname: sergeant\nmodel: gone/model\nthinkingLevel: high\n---\n`,
			models,
			supportedLevels,
		});
		expect(unavailable.selection).toBeUndefined();
		expect(unavailable.warnings[0]).toContain("unavailable model gone/model");

		const incompatible = inspectRoleFile({
			role: sergeant,
			path: "/repo/.pi/agents/sergeant.md",
			content: `---\nname: sergeant\nmodel: openai/gpt-5.6-sol\nthinkingLevel: max\n---\n`,
			models,
			supportedLevels,
		});
		expect(incompatible.configuredModel).toBe("openai/gpt-5.6-sol");
		expect(incompatible.selection).toBeUndefined();
		expect(incompatible.warnings.join(" ")).toContain("not supported");
	});

	it("refuses to overwrite a different role or malformed YAML", () => {
		expect(() =>
			inspectRoleFile({
				role: sergeant,
				path: "/repo/.pi/agents/sergeant.md",
				content: `---\nname: another-role\nmodel: openai/gpt-5.6-sol\n---\n`,
				models,
				supportedLevels,
			}),
		).toThrow(/expected role name/);
		expect(() => parseAgentFile("---\nname: [\n---\n")).toThrow();
	});
});
