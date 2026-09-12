import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENTS_START, SERGEANT_START } from "../src/content.ts";
import { parseAgentFile } from "../src/frontmatter.ts";
import type { Artifact } from "../src/persistence.ts";
import { runInitWorkflow } from "../src/workflow.ts";
import { FakeUI, models, supportedLevels } from "./helpers.ts";

const temporaryDirectories: string[] = [];

async function makeRepo(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-init-workflow-test-"));
	temporaryDirectories.push(root);
	await fs.mkdir(path.join(root, ".git"));
	await fs.writeFile(
		path.join(root, "package.json"),
		JSON.stringify({ scripts: { test: "vitest run", typecheck: "tsc --noEmit", spec: "out-of-scope" } }),
	);
	return root;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("/init workflow", () => {
	it("preserves researched context and custom runtime settings on reinitialization", async () => {
		const root = await makeRepo();
		await runInitWorkflow({ cwd: root, models, supportedLevels, ui: new FakeUI() });
		const contextPath = path.join(root, ".pi/PROJECT.md");
		const context = (await fs.readFile(contextPath, "utf8")).replace("# Project context", "# Researched project context");
		await fs.writeFile(contextPath, context);
		const configPath = path.join(root, ".pi/workflow.json");
		const config = JSON.parse(await fs.readFile(configPath, "utf8"));
		config.maxWorkerTurns = 15; config.customConvention = "keep";
		await fs.writeFile(configPath, JSON.stringify(config));
		await runInitWorkflow({ cwd: root, models, supportedLevels, ui: new FakeUI() });
		expect(await fs.readFile(contextPath, "utf8")).toBe(context);
		expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual(config);
	});
	it("rejects invalid runtime settings before collecting choices", async () => {
		const root = await makeRepo();
		await fs.mkdir(path.join(root, ".pi"));
		await fs.writeFile(path.join(root, ".pi/workflow.json"), '{"version":99}');
		const ui = new FakeUI();
		await expect(runInitWorkflow({ cwd: root, models, supportedLevels, ui })).rejects.toThrow(/version/);
		expect(ui.selectCount).toBe(0);
	});

	it("performs first initialization only after summary confirmation", async () => {
		const root = await makeRepo();
		const ui = new FakeUI();
		const result = await runInitWorkflow({ cwd: root, models, supportedLevels, ui });
		expect(result.status).toBe("completed");
		expect(ui.summaries).toHaveLength(1);
		expect(ui.summaries[0]).toContain("Sergeant\n  model: openai/gpt-5.6-sol");
		expect(ui.summaries[0]).toContain("Fast Worker\n  model: deepseek/deepseek-v4.1-flash");
		expect(ui.summaries[0]).toContain("Strong Worker\n  model: openai/luna-max");

		const sergeant = parseAgentFile(await fs.readFile(path.join(root, ".pi/agents/sergeant.md"), "utf8"));
		expect(sergeant.document.get("model")).toBe("openai/gpt-5.6-sol:high");
		expect(sergeant.document.get("thinkingLevel")).toBeUndefined();
		const fast = parseAgentFile(await fs.readFile(path.join(root, ".pi/agents/fast-worker.md"), "utf8"));
		expect(fast.document.get("thinkingLevel")).toBeUndefined();
		expect(await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).toContain("`npm run test`");
	});

	it("is idempotent and offers existing valid selections first", async () => {
		const root = await makeRepo();
		await runInitWorkflow({ cwd: root, models, supportedLevels, ui: new FakeUI() });
		const paths = [
			"AGENTS.md",
			".pi/SERGEANT.md",
			".pi/agents/sergeant.md",
			".pi/agents/fast-worker.md",
			".pi/agents/strong-worker.md",
		];
		const before = await Promise.all(paths.map((file) => fs.readFile(path.join(root, file), "utf8")));
		const seenFirstOptions: string[] = [];
		const ui = new FakeUI((_title, options) => {
			seenFirstOptions.push(options[0]);
			return options[0];
		});
		await runInitWorkflow({ cwd: root, models, supportedLevels, ui });
		const after = await Promise.all(paths.map((file) => fs.readFile(path.join(root, file), "utf8")));
		expect(after).toEqual(before);
		expect(seenFirstOptions.some((option) => option.includes("current"))).toBe(true);
		expect(after[0].match(new RegExp(AGENTS_START, "g"))).toHaveLength(1);
		expect(after[1].match(new RegExp(SERGEANT_START, "g"))).toHaveLength(1);
	});

	it("allows explicit model and supported variant selection", async () => {
		const root = await makeRepo();
		const ui = new FakeUI((title, options) => {
			if (title.includes("select model")) return options.find((option) => option.includes("custom/worker:exact"));
			return options.find((option) => option.startsWith("xhigh"));
		});
		await runInitWorkflow({ cwd: root, models, supportedLevels, ui });
		for (const role of ["sergeant", "fast-worker", "strong-worker"]) {
			const parsed = parseAgentFile(await fs.readFile(path.join(root, `.pi/agents/${role}.md`), "utf8"));
			expect(parsed.document.get("model")).toBe("custom/worker:exact:xhigh");
			expect(parsed.document.get("thinkingLevel")).toBeUndefined();
		}
	});

	it("cancels during selection without invoking persistence", async () => {
		const root = await makeRepo();
		let persisted = false;
		const ui = new FakeUI((_title, options, index) => (index === 1 ? undefined : options[0]));
		const result = await runInitWorkflow({
			cwd: root,
			models,
			supportedLevels,
			ui,
			persist: async () => {
				persisted = true;
			},
		});
		expect(result).toEqual({ status: "cancelled" });
		expect(persisted).toBe(false);
		await expect(fs.stat(path.join(root, ".pi"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("cancels at confirmation without partial initialization", async () => {
		const root = await makeRepo();
		let artifacts: readonly Artifact[] | undefined;
		const result = await runInitWorkflow({
			cwd: root,
			models,
			supportedLevels,
			ui: new FakeUI(undefined, false),
			persist: async (value) => {
				artifacts = value;
			},
		});
		expect(result).toEqual({ status: "cancelled" });
		expect(artifacts).toBeUndefined();
		await expect(fs.stat(path.join(root, "AGENTS.md"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("reports unavailable existing configuration and requires a real selection", async () => {
		const root = await makeRepo();
		await fs.mkdir(path.join(root, ".pi/agents"), { recursive: true });
		await fs.writeFile(
			path.join(root, ".pi/agents/sergeant.md"),
			`---\nname: sergeant\nmodel: removed/model\nthinkingLevel: high\n---\n\nKeep body.\n`,
		);
		const ui = new FakeUI();
		await runInitWorkflow({ cwd: root, models, supportedLevels, ui });
		expect(ui.notifications.map(({ message }) => message).join(" ")).toContain("unavailable model removed/model");
		const parsed = parseAgentFile(await fs.readFile(path.join(root, ".pi/agents/sergeant.md"), "utf8"));
		expect(parsed.document.get("model")).toBe("openai/gpt-5.6-sol:high");
		expect(parsed.body).toContain("Keep body.");
	});

	it("preserves unrelated AGENTS.md and creates workflow foundations without starting a change", async () => {
		const root = await makeRepo();
		await fs.writeFile(path.join(root, "AGENTS.md"), "# Existing\n\nKeep this rule.\n");
		const result = await runInitWorkflow({ cwd: root, models, supportedLevels, ui: new FakeUI() });
		if (result.status !== "completed") throw new Error("expected completion");
		const agents = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
		expect(agents).toContain("Keep this rule.");
		for (const filePath of result.paths) {
			expect(filePath).not.toMatch(/proposal\.md|tasks\.md|state\.json/);
		}
		const piEntries = await fs.readdir(path.join(root, ".pi"));
		expect(piEntries.sort()).toEqual(["PROJECT.md", "SERGEANT.md", "agents", "changes", "workflow.json"]);
	});
});
