import * as fs from "node:fs";
import * as path from "node:path";
import { discoverRepositoryCommands, updateManagedBlock } from "./content.ts";

export const PROJECT_START = "<!-- pi-init:project:start -->";
export const PROJECT_END = "<!-- pi-init:project:end -->";
const ignored = new Set([".git", ".pi", "node_modules", ".venv", "venv", "dist", "build", "coverage", "vendor", "__pycache__"]);

/** Bounded local inventory. Reading filenames does not execute repository code. */
export function inspectProject(root: string): string {
	const files: string[] = [];
	function visit(dir: string, depth: number) {
		for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			if (files.length >= 150) return;
			if (ignored.has(entry.name) || entry.name.startsWith(".env") || entry.isSymbolicLink()) continue;
			const name = path.posix.join(dir, entry.name);
			if (entry.isDirectory()) {
				files.push(`${name}/`);
				if (depth < 1 && !entry.name.startsWith(".")) visit(name, depth + 1);
			} else files.push(name);
		}
	}
	visit("", 0);
	const commands = discoverRepositoryCommands(root);
	const sources = ["README.md", "CONTRIBUTING.md", "AGENTS.md", "AGENTS.override.md", "CLAUDE.md", ".github/copilot-instructions.md", "pyproject.toml", "Cargo.toml", "go.mod", "Makefile", "package.json"]
		.filter(file => fs.existsSync(path.join(root, file)));
	return [
		"# Project context", "", "## Repository inventory", "", "```text", ...files, "```", "",
		"## Existing sources to read", "", ...sources.map(file => `- ${file}`), "",
		"## Discovered commands (not yet executed)", "",
		...(commands.length ? commands.map(command => `- \`${command}\``) : ["No standard package scripts found. Read the build manifests and CI configuration before choosing checks."]), "",
		"## Guidance", "", "Inventory only. Read the important files to establish architecture, conventions, setup, focused checks, and pitfalls. Record evidence as repository paths; do not infer behavior from names alone.",
	].join("\n");
}

export function renderProject(existing: string | null, guidance: string): string {
	return updateManagedBlock(existing, PROJECT_START, PROJECT_END, guidance);
}
