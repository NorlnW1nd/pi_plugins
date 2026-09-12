import { foundationArtifacts } from "./config.ts";
import { discoverRepositoryCommands, renderAgentsFile, renderSergeantPolicy } from "./content.ts";
import { discoverRepository, type DiscoveredRepository } from "./discovery.ts";
import { renderRoleFile } from "./frontmatter.ts";
import { canonicalModel, modelByCanonical, recommendedModel, sortModelsForRole, validateThinkingLevel } from "./models.ts";
import { persistArtifacts, type Artifact } from "./persistence.ts";
import type { ExistingRoleState, InitUI, ModelInfo, RoleSelection, ThinkingLevel } from "./types.ts";

export interface InitWorkflowOptions {
	cwd: string;
	models: readonly ModelInfo[];
	supportedLevels: (model: ModelInfo) => readonly ThinkingLevel[];
	ui: InitUI;
	discover?: typeof discoverRepository;
	persist?: (artifacts: readonly Artifact[]) => Promise<void>;
	discoverCommands?: (root: string) => string[];
}

export type InitWorkflowResult =
	| { status: "cancelled" }
	| { status: "completed"; root: string; paths: string[]; selections: RoleSelection[] };

function modelLabel(model: ModelInfo): string {
	return `${canonicalModel(model)} — ${model.name}`;
}

async function chooseModel(
	state: ExistingRoleState,
	models: readonly ModelInfo[],
	ui: InitUI,
): Promise<ModelInfo | undefined> {
	const ordered = sortModelsForRole(state.role, models);
	const current = state.configuredModel ? modelByCanonical(models, state.configuredModel) : undefined;
	if (current) {
		const index = ordered.indexOf(current);
		if (index > 0) ordered.splice(index, 1);
		if (index !== 0) ordered.unshift(current);
	}

	const recommendation = recommendedModel(state.role, models);
	const labels = new Map<string, ModelInfo>();
	for (const model of ordered) {
		const annotations = [
			model === current ? "current" : undefined,
			model === recommendation ? "recommended" : undefined,
		].filter(Boolean);
		const label = `${modelLabel(model)}${annotations.length > 0 ? ` (${annotations.join(", ")})` : ""}`;
		labels.set(label, model);
	}

	const chosen = await ui.select(`${state.role.label}: select model`, [...labels.keys()]);
	return chosen === undefined ? undefined : labels.get(chosen);
}

async function chooseThinkingLevel(options: {
	state: ExistingRoleState;
	model: ModelInfo;
	supportedLevels: (model: ModelInfo) => readonly ThinkingLevel[];
	ui: InitUI;
}): Promise<ThinkingLevel | undefined | null> {
	const { state, model, supportedLevels, ui } = options;
	const supported = [...supportedLevels(model)];
	if (!model.reasoning || supported.length <= 1) return null;

	const current = state.configuredModel === canonicalModel(model) ? state.configuredThinkingLevel : undefined;
	const recommended = state.role.defaultThinking && supported.includes(state.role.defaultThinking)
		? state.role.defaultThinking
		: undefined;
	const ordered = [...supported].sort((left, right) => {
		if (left === current) return -1;
		if (right === current) return 1;
		if (left === recommended) return -1;
		if (right === recommended) return 1;
		return 0;
	});

	const labels = new Map<string, ThinkingLevel>();
	for (const level of ordered) {
		const annotations = [level === current ? "current" : undefined, level === recommended ? "recommended" : undefined]
			.filter(Boolean);
		const label = `${level}${annotations.length > 0 ? ` (${annotations.join(", ")})` : ""}`;
		labels.set(label, level);
	}
	const chosen = await ui.select(`${state.role.label}: select thinking level`, [...labels.keys()]);
	return chosen === undefined ? undefined : labels.get(chosen);
}

export function formatSelectionSummary(selections: readonly RoleSelection[], models: readonly ModelInfo[]): string {
	return selections
		.map((selection) => {
			const model = modelByCanonical(models, selection.model);
			return [
				selection.role === "sergeant" ? "Sergeant" : selection.role === "fast-worker" ? "Fast Worker" : "Strong Worker",
				`  model: ${selection.model}${model ? ` (${model.name})` : ""}`,
				`  thinking: ${selection.thinkingLevel ?? "not configurable"}`,
			].join("\n");
		})
		.join("\n\n");
}

export function buildArtifacts(
	repository: DiscoveredRepository,
	selections: readonly RoleSelection[],
	commands: readonly string[],
): Artifact[] {
	const byRole = new Map(selections.map((selection) => [selection.role, selection]));
	const roleArtifacts = repository.roles.map((state) => {
		const selection = byRole.get(state.role.id);
		if (!selection) throw new Error(`Missing selection for ${state.role.label}`);
		return { path: state.path, content: renderRoleFile(state, selection), original: state.content };
	});
	return [
		...roleArtifacts,
		{
			path: repository.agentsPath,
			content: renderAgentsFile(repository.agentsContent, commands),
			original: repository.agentsContent,
		},
		{
			path: repository.sergeantPolicyPath,
			content: renderSergeantPolicy(repository.sergeantPolicyContent),
			original: repository.sergeantPolicyContent,
		},
	];
}

export async function runInitWorkflow(options: InitWorkflowOptions): Promise<InitWorkflowResult> {
	if (options.models.length === 0) throw new Error("No available models were found. Configure a Pi provider and retry /init.");
	const discover = options.discover ?? discoverRepository;
	const repository = discover({ cwd: options.cwd, models: options.models, supportedLevels: options.supportedLevels });
	const foundation = foundationArtifacts(repository.root);

	for (const state of repository.roles) {
		for (const warning of state.warnings) options.ui.notify(warning, "warning");
	}

	const selections: RoleSelection[] = [];
	for (const state of repository.roles) {
		const model = await chooseModel(state, options.models, options.ui);
		if (!model) return { status: "cancelled" };
		const thinkingLevel = await chooseThinkingLevel({ state, model, supportedLevels: options.supportedLevels, ui: options.ui });
		if (thinkingLevel === undefined) return { status: "cancelled" };
		selections.push({ role: state.role.id, model: canonicalModel(model), thinkingLevel: thinkingLevel ?? undefined });
	}

	// Revalidate the resolved configuration immediately before confirmation and persistence.
	for (const selection of selections) {
		const model = modelByCanonical(options.models, selection.model);
		if (!model) throw new Error(`Selected model is no longer available: ${selection.model}`);
		const error = validateThinkingLevel(model, selection.thinkingLevel, options.supportedLevels);
		if (error) throw new Error(error);
	}

	const confirmed = await options.ui.confirm(
		"Initialize Pi multi-agent configuration?",
		`${formatSelectionSummary(selections, options.models)}\n\nRepository: ${repository.root}\nCreates/updates role definitions, AGENTS.md, .pi/SERGEANT.md, .pi/PROJECT.md, .pi/workflow.json and .pi/changes/README.md. Existing project guidance and workflow settings are preserved.`,
	);
	if (!confirmed) return { status: "cancelled" };

	const commands = (options.discoverCommands ?? discoverRepositoryCommands)(repository.root);
	const artifacts = [...buildArtifacts(repository, selections, commands), ...foundation];
	await (options.persist ?? persistArtifacts)(artifacts);
	return { status: "completed", root: repository.root, paths: artifacts.map((artifact) => artifact.path), selections };
}
