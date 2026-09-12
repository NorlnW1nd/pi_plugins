import type { InitUI, ModelInfo, ThinkingLevel } from "../src/types.ts";

export const models: ModelInfo[] = [
	{
		provider: "openai",
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		reasoning: true,
		thinkingLevelMap: { off: "none", low: "low", high: "high" },
	},
	{
		provider: "deepseek",
		id: "deepseek-v4.1-flash",
		name: "DeepSeek V4.1 Flash",
		reasoning: false,
	},
	{
		provider: "openai",
		id: "luna-max",
		name: "Luna Max",
		reasoning: true,
		thinkingLevelMap: { low: "low", max: "max" },
	},
	{
		provider: "custom",
		id: "worker:exact",
		name: "Custom Worker",
		reasoning: true,
		thinkingLevelMap: { minimal: "tiny", xhigh: "huge" },
	},
];

export function supportedLevels(model: ModelInfo): ThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	const mapped = Object.entries(model.thinkingLevelMap ?? {})
		.filter(([, value]) => value !== null)
		.map(([level]) => level as ThinkingLevel);
	return mapped.length > 0 ? mapped : ["off", "minimal", "low", "medium", "high"];
}

export class FakeUI implements InitUI {
	readonly notifications: Array<{ message: string; type?: "info" | "warning" | "error" }> = [];
	readonly summaries: string[] = [];
	selectCount = 0;

	constructor(
		private readonly choose: (title: string, options: string[], index: number) => string | undefined = (_title, options) =>
			options[0],
		private readonly confirmation = true,
	) {}

	async select(title: string, options: string[]): Promise<string | undefined> {
		return this.choose(title, options, this.selectCount++);
	}

	async confirm(_title: string, message: string): Promise<boolean> {
		this.summaries.push(message);
		return this.confirmation;
	}

	notify(message: string, type?: "info" | "warning" | "error"): void {
		this.notifications.push({ message, type });
	}
}
