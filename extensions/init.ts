import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as path from "node:path";
import { runInitWorkflow } from "../src/workflow.ts";
import { findRepositoryRoot } from "../src/discovery.ts";
import { isInitialized, readConfig } from "../src/config.ts";
import { persistArtifacts } from "../src/persistence.ts";
import { renderProject } from "../src/project.ts";
import { artifact, beginPlan, approvePlan, changeDir, loadChange, planContext, readOptional, savePlan, statusText, withLock, type PlanInput } from "../src/changes.ts";
import { archiveChange, checkChange, delegateTask, finishVerification, reviewTask } from "../src/execution.ts";
import { createWorkerRunner, resolveRole } from "../src/runner.ts";
import type { ThinkingLevel } from "../src/types.ts";

type Stage = "idle" | "init" | "plan" | "apply" | "verify";
interface Mode { root: string; stage: Stage; id?: string; }
const READ_TOOLS = ["read", "grep", "find", "ls"];
const toolResult = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

export default function initExtension(pi: ExtensionAPI) {
  let mode: Mode | undefined;
  const controllers = new Set<AbortController>();
  function setMode(next: Mode) { mode = next; pi.appendEntry("pi-workflow-mode", next); }
  const rootOf = (ctx: ExtensionContext) => findRepositoryRoot(ctx.cwd);
  function requireMode(ctx: ExtensionContext, stages: Stage[], id?: string): string {
    const root = rootOf(ctx);
    readConfig(root);
    if (!mode || mode.root !== root || !stages.includes(mode.stage) || (id !== undefined && mode.id !== id)) throw new Error(`Use ${stages.map(stage => `/${stage}`).join(" or ")}${id ? ` ${id}` : ""} before this operation.`);
    return root;
  }
  async function activate(ctx: ExtensionContext, root: string) {
    const role = await resolveRole(root, "sergeant", ctx);
    if (!await pi.setModel(role.model)) throw new Error("Sergeant model authentication is unavailable. Configure the provider or run /init.");
    pi.setThinkingLevel(role.thinkingLevel ?? "off");
  }
  function report(ctx: ExtensionContext, text: string) {
    pi.sendMessage({ customType: "pi-workflow", content: text, display: true });
    ctx.ui.notify(text.split("\n")[0], "info");
  }
  function registerCommand(name: string, description: string, handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>) {
    pi.registerCommand(name, { description, handler: async (args, ctx) => {
      if (!ctx.isIdle()) { ctx.ui.notify("Wait for the current turn or cancel it before changing workflow mode.", "warning"); return; }
      try { await handler(args.trim(), ctx); }
      catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    } });
  }
  function parseArgs(args: string) {
    const match = args.match(/^(\S+)(?:\s+([\s\S]*))?$/);
    return { id: match?.[1], request: match?.[2] ?? "" };
  }
  function selectedId(args: string, ctx: ExtensionContext): string {
    if (args && /\s/.test(args)) throw new Error("Expected one change id.");
    const id = args || (mode?.root === rootOf(ctx) ? mode.id : undefined);
    if (!id) throw new Error("Specify a change id; use /status to list changes.");
    return id;
  }
  async function cancellable<T>(signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController(); controllers.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try { return await run(controller.signal); }
    finally { signal?.removeEventListener("abort", abort); controllers.delete(controller); }
  }

  registerCommand("init", "Initialize repository-level Sergeant and Worker configuration and project workflow", async (args, ctx) => {
    if (!ctx.hasUI) throw new Error("/init requires an interactive Pi UI.");
    if (args && args !== "--quick") throw new Error("Usage: /init [--quick]");
    const scoped = new Set(ctx.scopedModels.map(({ model }) => `${model.provider}/${model.id}`));
    const models = ctx.modelRegistry.getAvailable().filter(model => !scoped.size || scoped.has(`${model.provider}/${model.id}`));
    const root = rootOf(ctx);
    const result = await runInitWorkflow({ cwd: ctx.cwd, models, supportedLevels: model => getSupportedThinkingLevels(model as Model<any>) as ThinkingLevel[], ui: ctx.ui,
      persist: artifacts => withLock(root, () => persistArtifacts(artifacts), false),
    });
    if (result.status === "cancelled") { ctx.ui.notify("Initialization cancelled; no files were changed.", "info"); return; }
    await activate(ctx, root);
    setMode({ root, stage: args === "--quick" ? "idle" : "init" });
    report(ctx, `Initialized workflow in ${root}.\nUse /plan <id> <request>, /apply <id>, /verify <id>, /archive <id>, and /status. Load this package again in future sessions (pi -e <package-path> or install it).`);
    if (args !== "--quick") pi.sendUserMessage("Initialize reusable project understanding. Read .pi/PROJECT.md, existing repository instructions, README, relevant build/CI manifests and representative source files. Establish architecture and module responsibilities, conventions, setup, focused verification commands, and pitfalls with file references. Keep unsupported conclusions explicitly unknown. Save concise guidance in the user's language with pi_project_context. This is read-only repository research, not an implementation task. Do not run shell commands or change source files.");
  });
  registerCommand("plan", "Research and save a document-first change: /plan <id> <request>", async (args, ctx) => {
    const parsed = parseArgs(args);
    const id = parsed.id ?? selectedId("", ctx);
    const root = rootOf(ctx);
    readConfig(root); await activate(ctx, root);
    await withLock(root, () => beginPlan(root, id, parsed.request));
    setMode({ root, id, stage: "plan" });
    pi.sendUserMessage(`Plan change ${id}. Read the project and existing change documents, clarify material ambiguity, and use pi_inspect for bounded read-only investigation if helpful. Produce a proportional proposal, design, behavioral spec with observable acceptance scenarios, and ordered tasks with concrete file/directory scopes. Identify verification commands, or an explicit manual-only procedure. Save with pi_save_plan. Do not implement or execute shell commands. If revising, reconcile existing user edits and retain relevant decisions. Stop after saving and present the documents and /apply ${id} for the user to review.\n\n${await planContext(root, id)}`);
  });
  registerCommand("apply", "Approve the reviewed plan and execute scoped tasks", async (args, ctx) => {
    const root = rootOf(ctx), id = selectedId(args, ctx);
    readConfig(root); await activate(ctx, root);
    await withLock(root, () => approvePlan(root, id));
    setMode({ root, id, stage: "apply" });
    pi.sendUserMessage(`The user approved change ${id} via /apply. Read its documents and resume the first incomplete task. Use pi_delegate for one task at a time. Inspect returned files/evidence and call pi_review_task; do not accept unsupported claims. On failure, inspect partial edits and use the remaining retry budget, escalating to Strong Worker automatically. If scope/requirements need changes or retries are exhausted, stop and explain the needed replan. Once every task is reviewed, run pi_check. If checks reveal a defect in a completed task, use pi_review_task with accepted:false and concrete failure evidence to reopen it, then retry within its budget. Inspect all acceptance scenarios, and call pi_finish_verification with concrete evidence only when justified. Do not archive automatically.\n\n${await planContext(root, id)}`);
  });
  registerCommand("verify", "Run reviewed checks and record acceptance evidence", async (args, ctx) => {
    const root = rootOf(ctx), id = selectedId(args, ctx);
    readConfig(root); await activate(ctx, root);
    await loadChange(root, id);
    setMode({ root, id, stage: "verify" });
    pi.sendUserMessage(`Verify change ${id}. Read the spec and task reviews, run pi_check, inspect acceptance scenarios and changed code, and call pi_finish_verification only when checks pass and the evidence supports the spec. Do not implement fixes during verification. Explain failures and the required replan.\n\n${await planContext(root, id)}`);
  });
  registerCommand("status", "Show active changes or /status <id> progress", async (args, ctx) => {
    const root = rootOf(ctx); readConfig(root); report(ctx, await statusText(root, args || undefined));
  });
  registerCommand("archive", "Archive a verified change and retain its accepted spec", async (args, ctx) => {
    const root = rootOf(ctx), id = selectedId(args, ctx);
    const destination = await withLock(root, () => archiveChange(root, id));
    if (mode?.root === root && mode.id === id) setMode({ root, stage: "idle" });
    report(ctx, `Archived ${id} to ${destination}. Accepted spec: .pi/specs/${id}.md`);
  });
  registerCommand("workflow-exit", "Leave workflow mode; preserve durable change progress", async (_args, ctx) => {
    setMode({ root: rootOf(ctx), stage: "idle" }); report(ctx, "Left workflow mode. Saved plans and progress remain available through /status.");
  });

  pi.registerTool({ name: "pi_project_context", label: "Save project context", description: "Save researched project architecture, conventions, setup, verification guidance and pitfalls. Only available during /init.",
    parameters: Type.Object({ guidance: Type.String({ minLength: 1, maxLength: 30000 }) }),
    async execute(_call, params, _signal, _update, ctx) {
      const root = requireMode(ctx, ["init"]);
      await withLock(root, async () => { const file = path.join(root, ".pi/PROJECT.md"); await persistArtifacts([await artifact(file, renderProject(await readOptional(file), params.guidance))]); });
      setMode({ root, stage: "idle" });
      return toolResult("Project context saved. Initialization complete. Present the useful guidance and /plan <id> <request> as the next step.");
    },
  });
  const taskSchema = Type.Object({ id: Type.String(), title: Type.String(), role: Type.Union([Type.Literal("fast-worker"), Type.Literal("strong-worker")]), scope: Type.Array(Type.String(), { minItems: 1 }), acceptance: Type.Array(Type.String(), { minItems: 1 }) });
  pi.registerTool({ name: "pi_save_plan", label: "Save plan documents", description: "Persist proposal, design, behavioral spec and ordered scoped tasks. Invalidates old approval and retains prior revisions. Only during /plan.",
    parameters: Type.Object({ id: Type.String(), proposal: Type.String(), design: Type.String(), spec: Type.String(), tasks: Type.Array(taskSchema, { minItems: 1, maxItems: 50 }), checks: Type.Array(Type.String(), { maxItems: 20 }), manualVerification: Type.String() }),
    async execute(_call, params, _signal, _update, ctx) {
      const root = requireMode(ctx, ["plan"], params.id);
      const state = await withLock(root, () => savePlan(root, params.id, params as PlanInput));
      return toolResult(`Saved revision ${state.revision} in ${changeDir(root, params.id)}. Stop for document review. The user starts execution with /apply ${params.id}.`);
    },
  });
  pi.registerTool({ name: "pi_inspect", label: "Inspect with Worker", description: "Delegate a bounded read-only repository question to Fast Worker in an isolated context. No shell or writes.",
    parameters: Type.Object({ question: Type.String({ minLength: 1, maxLength: 20000 }) }),
    async execute(_call, params, signal, update, ctx) {
      const root = requireMode(ctx, ["init", "plan", "apply", "verify"]);
      return toolResult(await cancellable(signal, s => createWorkerRunner(ctx)({ root, role: "fast-worker", mode: "inspect", scope: [], task: params.question, signal: s, onUpdate: message => update?.(toolResult(message)) })));
    },
  });
  pi.registerTool({ name: "pi_delegate", label: "Execute scoped task", description: "Execute the next approved task in an isolated Worker session. Persists attempts and evidence; one writer per repository; Fast 1 attempt, Strong 2 per task/revision. A returned task needs Sergeant review.",
    parameters: Type.Object({ id: Type.String(), taskId: Type.String() }),
    async execute(_call, params, signal, update, ctx) {
      const root = requireMode(ctx, ["apply"], params.id);
      return toolResult(await cancellable(signal, s => withLock(root, () => delegateTask(root, params.id, params.taskId, createWorkerRunner(ctx), s, message => update?.(toolResult(message))))));
    },
  });
  pi.registerTool({ name: "pi_review_task", label: "Review Worker task", description: "Record Sergeant's review after inspecting returned edits and acceptance evidence. Reject unsupported/incomplete work; accepted:false can reopen a completed task after checks reveal a defect.",
    parameters: Type.Object({ id: Type.String(), taskId: Type.String(), accepted: Type.Boolean(), evidence: Type.String({ minLength: 1 }) }),
    async execute(_call, params, _signal, _update, ctx) {
      const root = requireMode(ctx, ["apply"], params.id);
      await withLock(root, () => reviewTask(root, params.id, params.taskId, params.accepted, params.evidence));
      return toolResult(await statusText(root, params.id));
    },
  });
  pi.registerTool({ name: "pi_check", label: "Run declared checks", description: "Execute ONLY the verification commands in the approved plan. Records outputs and exit codes. All tasks must be reviewed first. Commands may create ignored build artifacts; source changes require a fresh verification run.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_call, params, signal, _update, ctx) {
      const root = requireMode(ctx, ["apply", "verify"], params.id);
      const state = await cancellable(signal, s => withLock(root, () => checkChange(root, params.id, s)));
      return toolResult(JSON.stringify(state.checkRun, null, 2));
    },
  });
  pi.registerTool({ name: "pi_finish_verification", label: "Record verified change", description: "Record acceptance evidence only after all tasks were reviewed, all declared checks passed, and the repository remained unchanged. Does not archive.",
    parameters: Type.Object({ id: Type.String(), evidence: Type.String({ minLength: 1, maxLength: 40000 }) }),
    async execute(_call, params, _signal, _update, ctx) {
      const root = requireMode(ctx, ["apply", "verify"], params.id);
      await withLock(root, () => finishVerification(root, params.id, params.evidence));
      return toolResult(`Verified ${params.id}. Summarize the evidence. The user may archive with /archive ${params.id}.`);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    mode = undefined;
    for (const entry of ctx.sessionManager.getBranch()) if (entry.type === "custom" && entry.customType === "pi-workflow-mode") mode = entry.data as Mode;
    const root = rootOf(ctx);
    if (mode?.root !== root) mode = undefined;
    if (isInitialized(root)) {
      try { readConfig(root); await activate(ctx, root); ctx.ui.setStatus("pi-workflow", `Sergeant · ${mode?.stage ?? "idle"}${mode?.id ? ` · ${mode.id}` : ""}`); }
      catch (error) { ctx.ui.notify(`Workflow activation failed: ${String(error)}`, "error"); }
    }
  });
  pi.on("before_agent_start", async (event, ctx) => {
    const root = rootOf(ctx);
    if (!isInitialized(root)) return;
    const active = mode?.root === root ? mode : undefined;
    const contents = await Promise.all(["AGENTS.md", ".pi/PROJECT.md", ".pi/SERGEANT.md", ".pi/agents/sergeant.md"].map(async file => `${file}:\n${await readOptional(path.join(root, file)) ?? "(missing)"}`));
    ctx.ui.setStatus("pi-workflow", `Sergeant · ${active?.stage ?? "idle"}${active?.id ? ` · ${active.id}` : ""}`);
    let progress = "";
    if (active?.id) { try { progress = await statusText(root, active.id); } catch (error) { progress = String(error); } }
    return { systemPrompt: `${event.systemPrompt}\n\nRepository workflow (root: ${root}; mode: ${active?.stage ?? "idle"}):\n${contents.join("\n\n")}\n\n${progress}\n\nDuring a workflow command, use only read/search and the matching pi_* tools. Do not bypass state transitions through shell, raw file writes, other extensions, or external agents. Preserve the user's language. Finish each workflow stage before offering the next command.` };
  });
  pi.on("tool_call", event => {
    if (!mode || mode.stage === "idle") return;
    const allowed: Record<Exclude<Stage, "idle">, string[]> = {
      init: [...READ_TOOLS, "pi_project_context", "pi_inspect"], plan: [...READ_TOOLS, "pi_save_plan", "pi_inspect"],
      apply: [...READ_TOOLS, "pi_inspect", "pi_delegate", "pi_review_task", "pi_check", "pi_finish_verification"],
      verify: [...READ_TOOLS, "pi_inspect", "pi_check", "pi_finish_verification"],
    };
    if (!allowed[mode.stage].includes(event.toolName)) return { block: true, reason: `Tool '${event.toolName}' is unavailable during /${mode.stage}. Use the workflow tools; /workflow-exit returns to normal conversation tools.` };
  });
  pi.on("session_shutdown", async () => { for (const controller of controllers) controller.abort(); });
}
