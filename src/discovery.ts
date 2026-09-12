import { assertMetadataPath } from "./paths.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { AGENTS_END, AGENTS_START, SERGEANT_END, SERGEANT_START, updateManagedBlock } from "./content.ts";
import { inspectRoleFile } from "./frontmatter.ts";
import type { ExistingRoleState, ModelInfo, ThinkingLevel } from "./types.ts";
import { ROLES } from "./types.ts";

export interface DiscoveredRepository {
	root: string;
	agentsPath: string;
	agentsContent: string | null;
	sergeantPolicyPath: string;
	sergeantPolicyContent: string | null;
	roles: ExistingRoleState[];
}

function isDirectory(value: string): boolean {
	try {
		return fs.statSync(value).isDirectory();
	} catch {
		return false;
	}
}

export function findRepositoryRoot(cwd: string): string {
	let current = path.resolve(cwd);
	let initializedRoot: string | undefined;
	while (true) {
		if (isDirectory(path.join(current, ".git")) || fs.existsSync(path.join(current, ".git"))) return current;
		if (!initializedRoot && fs.existsSync(path.join(current, ".pi/workflow.json"))) initializedRoot = current;
		const parent = path.dirname(current);
		if (parent === current) return initializedRoot ?? path.resolve(cwd);
		current = parent;
	}
}

export function readTextIfPresent(filePath: string): string | null {
	try {
		return fs.readFileSync(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

export function discoverRepository(options: {
	cwd: string;
	models: readonly ModelInfo[];
	supportedLevels: (model: ModelInfo) => readonly ThinkingLevel[];
}): DiscoveredRepository {
	const root = findRepositoryRoot(options.cwd);
	for (const file of ["AGENTS.md", ".pi/SERGEANT.md", ...ROLES.map(role => `.pi/agents/${role.id}.md`)]) assertMetadataPath(root, file);
	const agentsPath = path.join(root, "AGENTS.md");
	const sergeantPolicyPath = path.join(root, ".pi", "SERGEANT.md");
	const agentsContent = readTextIfPresent(agentsPath);
	const sergeantPolicyContent = readTextIfPresent(sergeantPolicyPath);

	// Validate managed markers before collecting any choices.
	updateManagedBlock(agentsContent, AGENTS_START, AGENTS_END, "validation");
	updateManagedBlock(sergeantPolicyContent, SERGEANT_START, SERGEANT_END, "validation");

	const roles = ROLES.map((role) => {
		const rolePath = path.join(root, ".pi", "agents", `${role.id}.md`);
		return inspectRoleFile({
			role,
			path: rolePath,
			content: readTextIfPresent(rolePath),
			models: options.models,
			supportedLevels: options.supportedLevels,
		});
	});

	return { root, agentsPath, agentsContent, sergeantPolicyPath, sergeantPolicyContent, roles };
}
