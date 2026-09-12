import { THINKING_LEVELS, type ModelInfo, type RoleDefinition, type ThinkingLevel } from "./types.ts";

export function canonicalModel(model: Pick<ModelInfo, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

export function modelByCanonical(models: readonly ModelInfo[], value: string): ModelInfo | undefined {
	const slash = value.indexOf("/");
	if (slash <= 0) return undefined;
	return models.find((model) => model.provider === value.slice(0, slash) && model.id === value.slice(slash + 1));
}

export interface ResolvedModelReference {
	model: ModelInfo;
	embeddedThinkingLevel?: ThinkingLevel;
}

/** Resolve the exact model spellings accepted by Pi agent definitions and --model. */
export function resolveModelReference(models: readonly ModelInfo[], value: string): ResolvedModelReference | undefined {
	const canonical = modelByCanonical(models, value);
	if (canonical) return { model: canonical };

	const bareMatches = models.filter((model) => model.id === value);
	if (bareMatches.length === 1) return { model: bareMatches[0] };

	const lastColon = value.lastIndexOf(":");
	if (lastColon <= 0) return undefined;
	const suffix = value.slice(lastColon + 1);
	if (!THINKING_LEVELS.includes(suffix as ThinkingLevel)) return undefined;
	const base = resolveModelReference(models, value.slice(0, lastColon));
	return base ? { model: base.model, embeddedThinkingLevel: suffix as ThinkingLevel } : undefined;
}

export function modelPattern(selection: { model: string; thinkingLevel?: ThinkingLevel }): string {
	return selection.thinkingLevel ? `${selection.model}:${selection.thinkingLevel}` : selection.model;
}

export function recommendedModel(role: RoleDefinition, models: readonly ModelInfo[]): ModelInfo | undefined {
	for (const hint of role.defaultModelHints) {
		const normalizedHint = hint.toLowerCase();
		const match = models.find((model) => {
			const candidates = [model.id, model.name, canonicalModel(model)].map((value) => value.toLowerCase());
			return candidates.some((value) => value === normalizedHint || value.includes(normalizedHint));
		});
		if (match) return match;
	}
	return undefined;
}

export function sortModelsForRole(role: RoleDefinition, models: readonly ModelInfo[]): ModelInfo[] {
	const recommended = recommendedModel(role, models);
	return [...models].sort((left, right) => {
		if (left === recommended) return -1;
		if (right === recommended) return 1;
		return canonicalModel(left).localeCompare(canonicalModel(right));
	});
}

export function validateThinkingLevel(
	model: ModelInfo,
	level: ThinkingLevel | undefined,
	supportedLevels: (model: ModelInfo) => readonly ThinkingLevel[],
): string | undefined {
	const supported = supportedLevels(model);
	const configurable = model.reasoning && supported.length > 1;
	if (!configurable) {
		return level === undefined ? undefined : `${canonicalModel(model)} does not expose a configurable thinking level`;
	}
	if (!level) return `${canonicalModel(model)} requires a thinking-level selection`;
	if (!supported.includes(level)) {
		return `${level} is not supported by ${canonicalModel(model)} (supported: ${supported.join(", ")})`;
	}
	return undefined;
}
