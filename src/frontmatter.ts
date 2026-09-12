import { Document, isMap, parseDocument } from "yaml";
import type { ExistingRoleState, RoleDefinition, RoleSelection, ThinkingLevel } from "./types.ts";
import { THINKING_LEVELS } from "./types.ts";
import { canonicalModel, modelPattern, resolveModelReference, validateThinkingLevel } from "./models.ts";
import type { ModelInfo } from "./types.ts";

interface ParsedAgentFile {
	document: Document;
	body: string;
}

function splitFrontmatter(content: string): { yaml: string; body: string } {
	const normalized = content.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---\n")) {
		throw new Error("agent definition must start with YAML frontmatter");
	}
	const end = normalized.indexOf("\n---", 4);
	if (end === -1) throw new Error("agent definition has unterminated YAML frontmatter");
	const after = end + 4;
	if (normalized[after] !== undefined && normalized[after] !== "\n") {
		throw new Error("agent definition has an invalid closing frontmatter delimiter");
	}
	return { yaml: normalized.slice(4, end), body: normalized.slice(after + (normalized[after] === "\n" ? 1 : 0)) };
}

export function parseAgentFile(content: string): ParsedAgentFile {
	const split = splitFrontmatter(content);
	const document = parseDocument(split.yaml);
	if (document.errors.length > 0) {
		throw new Error(document.errors.map((error) => error.message).join("; "));
	}
	if (document.contents !== null && !isMap(document.contents)) {
		throw new Error("agent frontmatter must be a YAML mapping");
	}
	return { document, body: split.body };
}

function stringValue(document: Document, key: string): string | undefined {
	const value = document.get(key);
	return typeof value === "string" ? value : undefined;
}

export function inspectRoleFile(options: {
	role: RoleDefinition;
	path: string;
	content: string | null;
	models: readonly ModelInfo[];
	supportedLevels: (model: ModelInfo) => readonly ThinkingLevel[];
}): ExistingRoleState {
	const { role, path, content, models, supportedLevels } = options;
	if (content === null) return { role, path, content, warnings: [] };

	let parsed: ParsedAgentFile;
	try {
		parsed = parseAgentFile(content);
	} catch (error) {
		throw new Error(`Cannot safely update ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}

	const configuredName = stringValue(parsed.document, "name");
	if (configuredName && configuredName !== role.id) {
		throw new Error(`Cannot safely update ${path}: expected role name "${role.id}", found "${configuredName}"`);
	}

	const warnings: string[] = [];
	const modelRef = stringValue(parsed.document, "model");
	const rawThinking = stringValue(parsed.document, "thinkingLevel");
	let selection: RoleSelection | undefined;
	let configuredModel: string | undefined;
	let configuredThinkingLevel: ThinkingLevel | undefined;

	if (!modelRef) {
		warnings.push(`${role.label} has no model configured; choose an available model.`);
	} else {
		const resolved = resolveModelReference(models, modelRef);
		if (!resolved) {
			warnings.push(`${role.label} currently uses unavailable model ${modelRef}; choose a replacement.`);
		} else {
			const model = resolved.model;
			configuredModel = canonicalModel(model);
			let thinkingLevel: ThinkingLevel | undefined;
			if (rawThinking !== undefined) {
				if (!THINKING_LEVELS.includes(rawThinking as ThinkingLevel)) {
					warnings.push(`${role.label} has invalid thinking level "${rawThinking}"; choose a supported level.`);
				} else {
					thinkingLevel = rawThinking as ThinkingLevel;
					configuredThinkingLevel = thinkingLevel;
				}
			}
			if (resolved.embeddedThinkingLevel) {
				if (thinkingLevel && thinkingLevel !== resolved.embeddedThinkingLevel) {
					warnings.push(
						`${role.label} has conflicting thinking levels in model and thinkingLevel; choose a supported level.`,
					);
					thinkingLevel = undefined;
					configuredThinkingLevel = undefined;
				} else {
					thinkingLevel = resolved.embeddedThinkingLevel;
					configuredThinkingLevel = thinkingLevel;
				}
			}

			const thinkingError = validateThinkingLevel(model, thinkingLevel, supportedLevels);
			if (thinkingError) {
				warnings.push(`${role.label}: ${thinkingError}.`);
			} else {
				selection = { role: role.id, model: canonicalModel(model), thinkingLevel };
			}
		}
	}

	return {
		role,
		path,
		content,
		selection,
		configuredModel,
		configuredThinkingLevel,
		warnings,
		document: parsed.document,
		body: parsed.body,
	};
}

export function renderRoleFile(state: ExistingRoleState, selection: RoleSelection): string {
	let document: Document;
	let body: string;
	if (state.document instanceof Document) {
		document = state.document.clone();
		body = state.body ?? "";
	} else {
		document = new Document({});
		body = state.role.defaultPrompt;
	}

	document.set("name", state.role.id);
	document.set("description", state.role.description);
	// Pi's existing subagent runner forwards this value to --model, whose native
	// model-pattern syntax carries the supported thinking level as a suffix.
	document.set("model", modelPattern(selection));
	document.delete("thinkingLevel");
	document.set("piInitVersion", 1);

	const yaml = document.toString({ lineWidth: 0 }).trimEnd();
	const normalizedBody = body.trim().length > 0 ? body.trim() : state.role.defaultPrompt;
	return `---\n${yaml}\n---\n\n${normalizedBody}\n`;
}
