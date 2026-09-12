import { describe, expect, it } from "vitest";
import {
	AGENTS_END,
	AGENTS_START,
	SERGEANT_POLICY,
	renderAgentsFile,
	renderSergeantPolicy,
	updateManagedBlock,
} from "../src/content.ts";

describe("managed repository instructions", () => {
	it("creates compact instructions with discovered commands", () => {
		const result = renderAgentsFile(null, ["npm test", "npm run typecheck"]);
		expect(result).toContain(AGENTS_START);
		expect(result).toContain("Sergeant, Fast Worker, and Strong Worker");
		expect(result).toContain("`npm test`");
		expect(result).not.toMatch(/gpt|deepseek|luna/i);
	});

	it("preserves unrelated AGENTS.md content and replaces its block idempotently", () => {
		const existing = "# Team rules\n\nNever edit generated files.\n";
		const once = renderAgentsFile(existing, ["pnpm test"]);
		const twice = renderAgentsFile(once, ["pnpm test"]);
		expect(twice).toBe(once);
		expect(twice).toContain("Never edit generated files.");
		expect(twice.match(new RegExp(AGENTS_START, "g"))).toHaveLength(1);
		expect(twice.match(new RegExp(AGENTS_END, "g"))).toHaveLength(1);
	});

	it("refuses malformed managed markers", () => {
		expect(() => updateManagedBlock(`${AGENTS_START}\nbroken`, AGENTS_START, AGENTS_END, "new")).toThrow(
			/markers are missing/,
		);
	});
});

describe("Sergeant policy", () => {
	it("contains the routing, retry, and response contracts using logical roles", () => {
		const result = renderSergeantPolicy(null);
		expect(result).toContain("Fast Worker: at most one formal implementation attempt");
		expect(result).toContain("Strong Worker: at most two formal implementation attempts");
		expect(result).toContain("GOAL, CONSTRAINTS, RELEVANT_CONTEXT");
		expect(result).toContain("CALL_CHAIN");
		expect(result).toContain("UNRESOLVED_ISSUES");
		expect(SERGEANT_POLICY).not.toMatch(/openai|anthropic|deepseek|gpt|luna/i);
	});
});
