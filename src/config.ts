import { assertMetadataPath } from "./paths.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { readTextIfPresent } from "./discovery.ts";
import { PROJECT_END, PROJECT_START, inspectProject, renderProject } from "./project.ts";
import { updateManagedBlock } from "./content.ts";
import type { Artifact } from "./persistence.ts";

export interface WorkflowConfig {
	version: 1;
	maxWorkerTurns: number;
	workerTimeoutSeconds: number;
	checkTimeoutSeconds: number;
	[key: string]: unknown;
}

export const DEFAULT_CONFIG: WorkflowConfig = { version: 1, maxWorkerTurns: 30, workerTimeoutSeconds: 600, checkTimeoutSeconds: 300 };

export function parseConfig(content: string): WorkflowConfig {
	const value = JSON.parse(content);
	if (!value || value.version !== 1) throw new Error("Unsupported .pi/workflow.json version; expected 1.");
	for (const key of ["maxWorkerTurns", "workerTimeoutSeconds", "checkTimeoutSeconds"] as const) {
		if (!Number.isInteger(value[key]) || value[key] < 1 || value[key] > 3600) throw new Error(`Invalid workflow setting: ${key}`);
	}
	return value;
}

export function readConfig(root: string): WorkflowConfig {
	assertMetadataPath(root, ".pi/workflow.json");
	const content = readTextIfPresent(path.join(root, ".pi/workflow.json"));
	if (content === null) throw new Error("Run /init in this repository first.");
	return parseConfig(content);
}

export function foundationArtifacts(root: string): Artifact[] {
	for (const file of [".pi/workflow.json", ".pi/PROJECT.md", ".pi/changes/README.md"]) assertMetadataPath(root, file);
	const configPath = path.join(root, ".pi/workflow.json");
	const originalConfig = readTextIfPresent(configPath);
	if (originalConfig !== null) parseConfig(originalConfig);
	const projectPath = path.join(root, ".pi/PROJECT.md");
	const originalProject = readTextIfPresent(projectPath);
	// Validate markers but preserve already researched context on reinitialization.
	updateManagedBlock(originalProject, PROJECT_START, PROJECT_END, "validation");
	const readmePath = path.join(root, ".pi/changes/README.md");
	const originalReadme = readTextIfPresent(readmePath);
	return [
		{ path: configPath, original: originalConfig, content: originalConfig ?? `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n` },
		{ path: projectPath, original: originalProject, content: originalProject?.includes(PROJECT_START) ? originalProject : renderProject(originalProject, inspectProject(root)) },
		{ path: readmePath, original: originalReadme, content: originalReadme ?? "# Changes\n\nUse /plan <id> <request> to create proposal.md, design.md, spec.md, tasks.md and state.json. Review the documents, then /apply <id>, /verify <id>, and /archive <id>. Use /status to resume. Edit plans through /plan to reconcile task scope and invalidate stale approval. Evidence and prior revisions stay with each change.\n" },
	];
}

export function isInitialized(root: string): boolean {
	return fs.existsSync(path.join(root, ".pi/workflow.json"));
}
