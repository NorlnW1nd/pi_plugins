import * as fs from "node:fs";
import * as path from "node:path";

export const AGENTS_START = "<!-- pi-init:repository:start -->";
export const AGENTS_END = "<!-- pi-init:repository:end -->";
export const SERGEANT_START = "<!-- pi-init:sergeant:start -->";
export const SERGEANT_END = "<!-- pi-init:sergeant:end -->";

export function updateManagedBlock(existing: string | null, start: string, end: string, body: string): string {
	const current = existing ?? "";
	const startIndex = current.indexOf(start);
	const endIndex = current.indexOf(end);
	const duplicateStart = startIndex !== -1 && current.indexOf(start, startIndex + start.length) !== -1;
	const duplicateEnd = endIndex !== -1 && current.indexOf(end, endIndex + end.length) !== -1;

	if (duplicateStart || duplicateEnd || (startIndex === -1) !== (endIndex === -1) || endIndex < startIndex) {
		throw new Error(`Cannot safely update managed block ${start}: markers are missing, duplicated, or out of order`);
	}

	const newline = current.includes("\r\n") ? "\r\n" : "\n";
	const block = `${start}${newline}${body.trim().replace(/\n/g, newline)}${newline}${end}`;
	if (startIndex !== -1) {
		return `${current.slice(0, startIndex)}${block}${current.slice(endIndex + end.length)}`;
	}

	const prefix = current.length === 0 ? "" : `${current.trimEnd()}${newline}${newline}`;
	return `${prefix}${block}${newline}`;
}

function packageManager(root: string): string {
	if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
	if (fs.existsSync(path.join(root, "yarn.lock"))) return "yarn";
	if (fs.existsSync(path.join(root, "bun.lock")) || fs.existsSync(path.join(root, "bun.lockb"))) return "bun";
	return "npm";
}

export function discoverRepositoryCommands(root: string): string[] {
	const packagePath = path.join(root, "package.json");
	if (!fs.existsSync(packagePath)) return [];

	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(packagePath, "utf8"));
	} catch {
		return [];
	}
	if (!parsed || typeof parsed !== "object" || !("scripts" in parsed)) return [];
	const scripts = (parsed as { scripts?: unknown }).scripts;
	if (!scripts || typeof scripts !== "object") return [];

	const manager = packageManager(root);
	const preferred = ["build", "test", "lint", "typecheck", "check"];
	return preferred
		.filter((name) => typeof (scripts as Record<string, unknown>)[name] === "string")
		.map((name) => (manager === "npm" ? `npm run ${name}` : `${manager} ${name}`));
}

export function agentsManagedContent(commands: readonly string[]): string {
	const lines = [
		"## Pi multi-agent",
		"",
		"This repository uses Sergeant, Fast Worker, and Strong Worker.",
		"The main Pi session is Sergeant. Read .pi/PROJECT.md for project context and .pi/SERGEANT.md for runtime policy.",
		"Workflow: /plan <id> <request> → review documents → /apply <id> → /verify <id> → /archive <id>. Use /status to resume.",
		"Plans and evidence live in .pi/changes/<id>/. Use pi_delegate for scoped Worker implementation; Sergeant reviews and verifies.",
	];
	if (commands.length > 0) {
		lines.push("", "Discovered repository commands (not yet executed):", "", ...commands.map((command) => `- \`${command}\``));
	}
	return lines.join("\n");
}

export const SERGEANT_POLICY = `# Sergeant runtime policy

## Roles

- Sergeant plans, routes, reviews, verifies, escalates, and replans. It is not the default implementation worker.
- Fast Worker inspects repositories and performs localized, low-risk work.
- Strong Worker handles complex, ambiguous, cross-module, high-risk, or escalated work.

## Standard flow

With sufficient context: Sergeant → Fast Worker or Strong Worker execute → Sergeant verifies.

With insufficient context: Fast Worker inspects → Sergeant plans → Fast Worker or Strong Worker executes → Sergeant verifies.

## Routing

Prefer Fast Worker for clear, bounded, localized, low-risk, and easily verified work.

Prefer Strong Worker for cross-module work, unresolved ambiguity, architectural or high-risk changes, schema/auth/concurrency/cache/complex-state work, and escalation after a failed Fast Worker implementation attempt.

## Retry limits

- Fast Worker: at most one formal implementation attempt per plan.
- Strong Worker: at most two formal implementation attempts per plan.

After a limit is reached, return to Sergeant to reassess and replan.

## Delegation contract

Sergeant normally supplies: GOAL, CONSTRAINTS, RELEVANT_CONTEXT, ACCEPTANCE_CRITERIA, ALLOWED_SCOPE, and MODE.

Inspect responses contain: STATUS, RELEVANT_FILES, RELEVANT_SYMBOLS, CALL_CHAIN, FINDINGS, EVIDENCE, and RECOMMENDATION.

Execute responses contain: STATUS, CHANGED_FILES, SUMMARY, TESTS_RUN, TEST_RESULTS, DIFF_SUMMARY, RISKS, and UNRESOLVED_ISSUES.

Workers produce evidence and implementation. Sergeant makes decisions and performs final verification.

## Document-first workflow

Read .pi/PROJECT.md and the active change documents before deciding what to do. /plan creates proposal.md, design.md, spec.md and scoped tasks.md before any implementation. Each task needs concrete acceptance criteria and file/directory scope; choose Strong Worker for risky or cross-module tasks.

/plan is read-only until pi_save_plan saves documents. /apply is the user's approval of the current plan. Use pi_delegate to run Workers with isolated context, then inspect their output and files and use pi_review_task. Failed attempts consume the persisted retry budget. Replan when requirements or scope change; never silently widen scope or reset retries.

Workers have read/search/edit/write tools only, with enforced write scope and no shell. Run the reviewed verification commands using pi_check. /verify requires completed tasks, successful declared checks (or an explicit manual-only rationale), and concrete acceptance evidence via pi_finish_verification. Only /archive publishes an accepted spec into .pi/specs and archives a verified, unchanged change.

Use the language of the user's request in plans, context summaries, and reports. Keep plans proportional: small changes need short documents and few tasks. Do not auto-commit, push, deploy, install dependencies, or run unrelated operations. Explain missing prerequisites and ask the user for material scope decisions.

The workflow tools are the source of truth for state transitions. Do not edit state.json, task checkboxes, or verification records directly. If no workflow command is active, help normally and suggest /plan for implementation work.`;

export function renderAgentsFile(existing: string | null, commands: readonly string[]): string {
	return updateManagedBlock(existing, AGENTS_START, AGENTS_END, agentsManagedContent(commands));
}

export function renderSergeantPolicy(existing: string | null): string {
	return updateManagedBlock(existing, SERGEANT_START, SERGEANT_END, SERGEANT_POLICY);
}
