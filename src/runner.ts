import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { parseAgentFile } from "./frontmatter.ts";
import { resolveModelReference, validateThinkingLevel } from "./models.ts";
import { readConfig } from "./config.ts";
import { assertWorkerPath } from "./paths.ts";
import type { WorkerRole, CheckResult } from "./changes.ts";
import type { ThinkingLevel } from "./types.ts";

export interface WorkerRequest { root: string; role: WorkerRole; mode: "inspect" | "execute"; scope: string[]; task: string; signal?: AbortSignal; onUpdate?: (message: string) => void; }
export type WorkerRunner = (request: WorkerRequest) => Promise<string>;

export async function resolveRole(root: string, role: string, ctx: Pick<ExtensionContext, "modelRegistry" | "scopedModels">) {
  const file = parseAgentFile(await readFile(path.join(root, ".pi/agents", `${role}.md`), "utf8"));
  if (file.document.get("name") !== role) throw new Error(`Invalid role definition: ${role}`);
  const configured = file.document.get("model");
  if (typeof configured !== "string") throw new Error(`No model configured for ${role}. Run /init.`);
  const scoped = new Set(ctx.scopedModels.map(({ model }) => `${model.provider}/${model.id}`));
  const available = ctx.modelRegistry.getAvailable().filter(model => !scoped.size || scoped.has(`${model.provider}/${model.id}`));
  const selection = resolveModelReference(available, configured);
  if (!selection) throw new Error(`Configured ${role} model is unavailable or outside this session's model scope: ${configured}. Run /init.`);
  const error = validateThinkingLevel(selection.model, selection.embeddedThinkingLevel, model => getSupportedThinkingLevels(model as Model<any>) as ThinkingLevel[]);
  if (error) throw new Error(error);
  return { model: selection.model as Model<any>, thinkingLevel: selection.embeddedThinkingLevel, prompt: file.body };
}

/** SDK sessions share provider definitions, not messages or workflow tools. */
export function createWorkerRunner(ctx: Pick<ExtensionContext, "modelRegistry" | "scopedModels">, options: { agentDir?: string } = {}): WorkerRunner {
  return async request => {
    request.signal?.throwIfAborted();
    const role = await resolveRole(request.root, request.role, ctx);
    const config = readConfig(request.root);
    const agentDir = options.agentDir ?? getAgentDir();
    const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), signal: request.signal });
    for (const provider of ctx.modelRegistry.getRegisteredProviderIds()) {
      const native = ctx.modelRegistry.getRegisteredNativeProvider(provider);
      const compat = ctx.modelRegistry.getRegisteredProviderConfig(provider);
      if (native) runtime.registerNativeProvider(native);
      else if (compat) runtime.registerProvider(provider, compat);
    }
    // Also support an API key supplied to the parent process at runtime.
    if (!runtime.hasConfiguredAuth(role.model.provider)) {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(role.model.provider);
      if (apiKey) await runtime.setRuntimeApiKey(role.model.provider, apiKey);
    }
    const settings = SettingsManager.inMemory();
    const tools = ["read", "grep", "find", "ls", ...(request.mode === "execute" ? ["edit", "write"] : [])];
    const loader = new DefaultResourceLoader({
      cwd: request.root, agentDir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      appendSystemPrompt: [role.prompt, `You are a bounded ${request.mode} Worker, not the main Sergeant. Do not delegate or alter workflow state. Allowed write scope: ${JSON.stringify(request.scope)}. You have no shell; report any required command/deletion/rename to Sergeant. Return changed files, evidence, risks and remaining work. Never claim checks you did not run.`],
      extensionFactories: [(pi) => {
        pi.on("tool_call", event => {
          if (!tools.includes(event.toolName)) return { block: true, reason: "Tool is not allowed in this Worker session." };
          if (event.toolName === "edit" || event.toolName === "write") {
            try {
              const file = (event.input as { path?: unknown }).path;
              if (typeof file !== "string") throw new Error("Missing path");
              assertWorkerPath(request.root, file, request.scope);
            } catch (error) { return { block: true, reason: String(error) }; }
          }
        });
      }],
    });
    await loader.reload();
    const { session } = await createAgentSession({ cwd: request.root, agentDir, modelRuntime: runtime, model: role.model, thinkingLevel: role.thinkingLevel, tools, settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.inMemory(request.root) });
    let failure: string | undefined;
    let turns = 0;
    const abort = () => { failure = "Worker cancelled; inspect partial edits before retrying."; void session.abort(); };
    const unsubscribe = session.subscribe(event => {
      if (event.type === "turn_end" && ++turns >= config.maxWorkerTurns && event.message.role === "assistant" && event.message.stopReason === "toolUse") { failure = "Worker turn limit reached; inspect partial edits before retrying."; void session.abort(); }
      if (event.type === "tool_execution_start") request.onUpdate?.(`${request.role}: ${event.toolName}`);
    });
    const timer = setTimeout(() => { failure = "Worker timed out; inspect partial edits before retrying."; void session.abort(); }, config.workerTimeoutSeconds * 1000);
    request.signal?.addEventListener("abort", abort, { once: true });
    try {
      request.signal?.throwIfAborted();
      await session.prompt(request.task);
      if (failure) throw new Error(failure);
      const assistant = session.messages.filter(message => message.role === "assistant").at(-1);
      if (!assistant || assistant.role !== "assistant") throw new Error("Worker returned no assistant output.");
      if (assistant.stopReason === "error" || assistant.stopReason === "aborted") throw new Error(assistant.errorMessage ?? `Worker ${assistant.stopReason}`);
      const output = assistant.content.filter(part => part.type === "text").map(part => part.text).join("\n");
      if (!output.trim()) throw new Error("Worker returned no textual evidence.");
      return output.slice(0, 80000);
    } finally { clearTimeout(timer); request.signal?.removeEventListener("abort", abort); unsubscribe(); session.dispose(); }
  };
}

/** Reviewed check commands run as one process group; cancellation kills descendants. */
export function runCheck(root: string, command: string, timeoutSeconds: number, signal?: AbortSignal): Promise<CheckResult> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-o", "pipefail", "-c", command], { cwd: root, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let failure: string | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-64000); };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    const kill = (kind: NodeJS.Signals) => {
      try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, kind); else child.kill(kind); } catch { /* Already exited. */ }
    };
    const stop = (message: string) => {
      if (failure) return;
      failure = message; kill("SIGTERM"); escalation = setTimeout(() => kill("SIGKILL"), 1000);
    };
    const cancel = () => stop("Check cancelled");
    const timer = setTimeout(() => stop("Check timed out"), timeoutSeconds * 1000);
    const cleanup = () => { clearTimeout(timer); if (escalation) clearTimeout(escalation); signal?.removeEventListener("abort", cancel); };
    child.on("error", error => { cleanup(); reject(error); });
    child.on("close", code => { if (failure) kill("SIGKILL"); cleanup(); resolve({ command, exitCode: failure ? 1 : code ?? 1, output: `${output}${failure ? `\n${failure}` : ""}` }); });
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}
