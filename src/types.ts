export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type RoleId = "sergeant" | "fast-worker" | "strong-worker";

export interface RoleDefinition {
	id: RoleId;
	label: string;
	description: string;
	defaultModelHints: readonly string[];
	defaultThinking?: ThinkingLevel;
	defaultPrompt: string;
}

export const ROLES: readonly RoleDefinition[] = [
	{
		id: "sergeant",
		label: "Sergeant",
		description: "Plans, routes, reviews, verifies, escalates, and replans delegated work",
		defaultModelHints: ["gpt-5.6-sol", "gpt 5.6 sol", "gpt-5.6 sol"],
		defaultThinking: "high",
		defaultPrompt:
			"You are Sergeant. Use the repository's compact runtime policy at .pi/SERGEANT.md to plan, route, review, verify, escalate, and replan work. Workers provide implementation and evidence; you make decisions and perform final verification.",
	},
	{
		id: "fast-worker",
		label: "Fast Worker",
		description: "Inspects repositories and performs clear, bounded, localized, low-risk work",
		defaultModelHints: ["deepseek-v4.1-flash", "deepseek v4.1 flash", "v4.1 flash"],
		defaultPrompt:
			"You are Fast Worker. Follow the delegation contract and stay within the allowed scope. Inspect mode is read-only by default. Execute mode is for bounded, localized, low-risk work. Return concise evidence and verification results.",
	},
	{
		id: "strong-worker",
		label: "Strong Worker",
		description: "Handles complex, ambiguous, cross-module, high-risk, or escalated work",
		defaultModelHints: ["luna-max", "luna max"],
		defaultPrompt:
			"You are Strong Worker. Follow the delegation contract and stay within the allowed scope. Handle complex, ambiguous, cross-module, high-risk, or escalated work. Return concise evidence and verification results.",
	},
] as const;

export interface ModelInfo {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}

export interface RoleSelection {
	role: RoleId;
	model: string;
	thinkingLevel?: ThinkingLevel;
}

export interface ExistingRoleState {
	role: RoleDefinition;
	path: string;
	content: string | null;
	selection?: RoleSelection;
	configuredModel?: string;
	configuredThinkingLevel?: ThinkingLevel;
	warnings: string[];
	document?: unknown;
	body?: string;
}

export interface InitUI {
	select(title: string, options: string[]): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}
