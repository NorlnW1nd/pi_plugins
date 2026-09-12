import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { ModelRuntime, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { createWorkerRunner } from "../src/runner.ts";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { force: true, recursive: true }))); });
async function setup() {
  const root = await fs.mkdtemp("/tmp/pi-sdk-worker-test-"); dirs.push(root);
  await fs.mkdir(path.join(root, ".pi/agents"), { recursive: true });
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, ".pi/workflow.json"), JSON.stringify(DEFAULT_CONFIG));
  await fs.writeFile(path.join(root, ".pi/agents/fast-worker.md"), "---\nname: fast-worker\nmodel: pi-test/fake\n---\nYou are a test Worker.\n");
  return root;
}

describe("isolated Pi SDK Worker", () => {
  it("executes real Pi tools, blocks out-of-scope edits and never loads recursive workflow tools", async () => {
    const root = await setup();
    const contexts: Context[] = [];
    const runtime = await ModelRuntime.create({ authPath: path.join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
    runtime.registerProvider("pi-test", {
      api: "openai-completions", baseUrl: "https://invalid.test", apiKey: "fake-key-never-sent",
      models: [{ id: "fake", name: "Fake", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple(model, context) {
        contexts.push(context);
        const results = context.messages.filter(message => message.role === "toolResult");
        const content: AssistantMessage["content"] = results.length === 0
          ? [{ type: "toolCall", id: "outside", name: "write", arguments: { path: "outside.txt", content: "must not be written" } }]
          : results.length === 1
            ? [{ type: "toolCall", id: "inside", name: "write", arguments: { path: "src/inside.txt", content: "written inside scope" } }]
            : [{ type: "text", text: "Scoped write complete; outside write blocked." }];
        const stopReason = results.length < 2 ? "toolUse" : "stop";
        const message: AssistantMessage = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, stopReason, timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: stopReason, message }); stream.end();
        return stream;
      },
    });
    await runtime.getAvailable();
    const registry = new ModelRegistry(runtime);
    const runner = createWorkerRunner({ modelRegistry: registry, scopedModels: [] }, { agentDir: root });
    expect(await runner({ root, role: "fast-worker", mode: "execute", scope: ["src"], task: "Exercise scoped tools." })).toContain("Scoped write complete");
    expect(await fs.readFile(path.join(root, "src/inside.txt"), "utf8")).toBe("written inside scope");
    await expect(fs.stat(path.join(root, "outside.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    const names = contexts[0].tools?.map(tool => tool.name) ?? [];
    expect(names).toContain("write"); expect(names).not.toContain("bash"); expect(names).not.toContain("pi_delegate");
    expect(contexts.at(-1)?.messages.some(message => message.role === "toolResult" && message.isError)).toBe(true);
    const firstContextCount = contexts.length;
    await runner({ root, role: "fast-worker", mode: "inspect", scope: [], task: "Try to inspect." });
    expect(contexts[firstContextCount].messages.filter(message => message.role === "user")).toHaveLength(1);
    expect(contexts[firstContextCount].tools?.map(tool => tool.name)).not.toContain("write");
  }, 20000);
});
