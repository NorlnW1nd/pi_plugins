import * as fs from "node:fs/promises";
import * as syncFs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { persistArtifacts, type Artifact } from "./persistence.ts";
import { readConfig } from "./config.ts";
import { assertMetadataPath, relativeScope } from "./paths.ts";

export type WorkerRole = "fast-worker" | "strong-worker";
export interface PlanTask { id: string; title: string; role: WorkerRole; scope: string[]; acceptance: string[]; }
export interface PlanInput { proposal: string; design: string; spec: string; tasks: PlanTask[]; checks: string[]; manualVerification: string; }
export interface Attempt { role: WorkerRole; startedAt: string; outcome: "running" | "returned" | "failed"; evidence?: string; }
export interface TaskState extends PlanTask { status: "pending" | "running" | "review" | "complete" | "blocked"; attempts: Attempt[]; review?: string; }
export interface CheckResult { command: string; exitCode: number; output: string; }
export interface ChangeState {
  version: 1; id: string; request: string; revision: number;
  phase: "draft" | "planned" | "applying" | "blocked" | "implemented" | "verified";
  tasks: TaskState[]; checks: string[]; manualVerification: string;
  planDigest?: string; approvedDigest?: string;
  checkRun?: { results: CheckResult[]; snapshot: string; planDigest: string };
  verification?: { evidence: string; snapshot: string; planDigest: string; at: string };
}
const planFiles = ["proposal.md", "design.md", "spec.md", "tasks.md"];
export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export const now = () => new Date().toISOString();
export function changeId(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value) || value === "archive") throw new Error("Change id must use 1–64 lowercase letters, digits or hyphens; 'archive' is reserved.");
  return value;
}
export function changeDir(root: string, id: string): string { const relative = `.pi/changes/${changeId(id)}`; assertMetadataPath(root, relative); return path.join(root, relative); }
export async function readOptional(file: string): Promise<string | null> {
  try { return await fs.readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export async function artifact(file: string, content: string): Promise<Artifact> {
  const marker = file.lastIndexOf(`${path.sep}.pi${path.sep}`);
  if (marker >= 0) assertMetadataPath(file.slice(0, marker), file.slice(marker + 1));
  return { path: file, content, original: await readOptional(file) };
}
export async function loadChange(root: string, id: string): Promise<ChangeState> {
  const content = await readOptional(path.join(changeDir(root, id), "state.json"));
  if (content === null) throw new Error(`Change '${id}' does not exist. Use /plan ${id} <request>.`);
  const state = JSON.parse(content) as ChangeState;
  if (state.version !== 1 || state.id !== id || !Array.isArray(state.tasks)) throw new Error(`Invalid state for ${id}.`);
  return state;
}
export async function saveState(root: string, state: ChangeState): Promise<void> {
  await persistArtifacts([await artifact(path.join(changeDir(root, state.id), "state.json"), `${JSON.stringify(state, null, 2)}\n`)]);
}

/** Serializes mutations across tools and Pi processes. Dead local owners are recoverable. */
export async function withLock<T>(root: string, operation: () => Promise<T>, requireInitialized = true): Promise<T> {
  if (requireInitialized) readConfig(root);
  assertMetadataPath(root, ".pi/workflow.lock");
  await fs.mkdir(path.join(root, ".pi"), { recursive: true });
  const lock = path.join(root, ".pi/workflow.lock");
  const token = randomUUID();
  const owner = JSON.stringify({ pid: process.pid, host: hostname(), token });
  let handle;
  try { handle = await fs.open(lock, "wx"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const previous = await readOptional(lock);
    try {
      const parsed = JSON.parse(previous ?? "null");
      if (parsed?.host === hostname() && Number.isInteger(parsed.pid) && parsed.pid > 0) {
        try { process.kill(parsed.pid, 0); }
        catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ESRCH" && await readOptional(lock) === previous) {
            await fs.unlink(lock);
            return withLock(root, operation, requireInitialized);
          }
        }
      }
    } catch { /* A partial/foreign lock is not safe to steal. */ }
    throw new Error("Another workflow operation holds .pi/workflow.lock. Wait for it to finish; /status remains available.");
  }
  try { await handle.writeFile(owner); return await operation(); }
  finally { await handle.close(); if (await readOptional(lock) === owner) await fs.unlink(lock); }
}

export function renderTasks(tasks: readonly TaskState[]): string {
  return ["# Tasks", "", "Task definitions are reconciled by /plan; status is recorded in state.json.", "", ...tasks.flatMap(task => [
    `## ${task.id}: ${task.title}`, `- Worker: ${task.role}`, `- Scope: ${task.scope.map(p => `\`${p}\``).join(", ")}`,
    "- Acceptance:", ...task.acceptance.map(item => `  - ${item}`), "",
  ])].join("\n");
}
function definitionDigest(state: ChangeState): string {
  return JSON.stringify({ revision: state.revision, tasks: state.tasks.map(({ id, title, role, scope, acceptance }) => ({ id, title, role, scope, acceptance })), checks: state.checks, manualVerification: state.manualVerification });
}
export async function currentPlanDigest(root: string, id: string): Promise<string> {
  const state = await loadChange(root, id);
  return digest((await Promise.all(planFiles.map(file => fs.readFile(path.join(changeDir(root, id), file), "utf8")))).join("\n\0\n") + definitionDigest(state));
}
export async function assertPlan(root: string, state: ChangeState, approved = false): Promise<void> {
  if (!state.planDigest || state.planDigest !== await currentPlanDigest(root, state.id)) throw new Error("Plan documents changed or are incomplete. Run /plan to reconcile the documents before continuing.");
  if (approved && state.approvedDigest !== state.planDigest) throw new Error(`This plan is not approved. Review the documents and run /apply ${state.id}.`);
}
export async function beginPlan(root: string, id: string, request: string): Promise<ChangeState> {
  changeId(id);
  const existing = await readOptional(path.join(changeDir(root, id), "state.json"));
  if (existing !== null) {
    const state = await loadChange(root, id);
    state.phase = "draft";
    if (request.trim()) state.request = request.trim();
    delete state.approvedDigest; delete state.checkRun; delete state.verification;
    await saveState(root, state);
    return state;
  }
  if (!request.trim()) throw new Error("Usage: /plan <change-id> <request>");
  const state: ChangeState = { version: 1, id, request: request.trim(), revision: 0, phase: "draft", tasks: [], checks: [], manualVerification: "" };
  await saveState(root, state);
  return state;
}
export async function savePlan(root: string, id: string, input: PlanInput): Promise<ChangeState> {
  const state = await loadChange(root, id);
  if (state.phase !== "draft") throw new Error("Use /plan before saving or revising a plan.");
  for (const field of ["proposal", "design", "spec"] as const) if (!input[field].trim()) throw new Error(`${field} cannot be empty.`);
  if (input.tasks.length === 0 || input.tasks.length > 50) throw new Error("A plan needs 1–50 bounded tasks.");
  const ids = new Set<string>();
  for (const task of input.tasks) {
    changeId(task.id);
    if (ids.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
    ids.add(task.id);
    if (!task.title.trim() || !["fast-worker", "strong-worker"].includes(task.role) || !task.scope.length || !task.acceptance.length || task.acceptance.some(item => !item.trim())) throw new Error(`Incomplete task: ${task.id}`);
    task.scope.forEach(relativeScope);
  }
  if (input.checks.some(command => !command.trim()) || input.checks.length > 20) throw new Error("Provide at most 20 nonempty verification commands.");
  if (!input.checks.length && !input.manualVerification.trim()) throw new Error("Declare verification commands, or explain the manual verification procedure.");
  const dir = changeDir(root, id);
  const history: Artifact[] = [];
  if (state.revision > 0) {
    for (const file of [...planFiles, "state.json", "verification.md"]) {
      const previous = await readOptional(path.join(dir, file));
      if (previous !== null) history.push(await artifact(path.join(dir, "history", String(state.revision), file), previous));
    }
  }
  state.revision++;
  state.tasks = input.tasks.map(task => ({ id: task.id, title: task.title, role: task.role, scope: task.scope.map(relativeScope), acceptance: task.acceptance, status: "pending", attempts: [] }));
  state.checks = input.checks; state.manualVerification = input.manualVerification; state.phase = "planned";
  delete state.approvedDigest; delete state.checkRun; delete state.verification;
  const contents = [input.proposal.trim(), input.design.trim(), input.spec.trim(), renderTasks(state.tasks)].map(s => `${s}\n`);
  // Check commands are part of the user-reviewed document digest.
  contents[1] += `\n## Verification commands\n\n${input.checks.map(c => `~~~sh\n${c}\n~~~`).join("\n\n")}\n\n${input.manualVerification}\n`;
  state.planDigest = digest(contents.join("\n\0\n") + definitionDigest(state));
  await persistArtifacts([...history, ...await Promise.all(planFiles.map((file, index) => artifact(path.join(dir, file), contents[index]))), await artifact(path.join(dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`)]);
  return state;
}
export async function approvePlan(root: string, id: string): Promise<ChangeState> {
  const state = await loadChange(root, id);
  if (state.phase === "draft") throw new Error("Finish /plan before /apply.");
  await assertPlan(root, state);
  state.approvedDigest = state.planDigest;
  if (state.phase !== "verified") state.phase = state.tasks.every(t => t.status === "complete") ? "implemented" : "applying";
  // A process that died after reserving an attempt must not silently retry it for free.
  for (const task of state.tasks) if (task.status === "running") { task.status = "blocked"; const last = task.attempts.at(-1); if (last) last.outcome = "failed"; }
  await saveState(root, state);
  return state;
}
export function nextWorker(task: TaskState): WorkerRole {
  const fast = task.attempts.filter(a => a.role === "fast-worker").length;
  const strong = task.attempts.filter(a => a.role === "strong-worker").length;
  if (strong >= 2) throw new Error(`Retry budget exhausted for ${task.id}. Replan before another attempt.`);
  return task.role === "fast-worker" && fast === 0 ? "fast-worker" : "strong-worker";
}
export async function planContext(root: string, id: string): Promise<string> {
  const state = await loadChange(root, id);
  return [`Change: ${id}\nRequest: ${state.request}`, ...await Promise.all(planFiles.map(async file => `${file}:\n${await readOptional(path.join(changeDir(root, id), file)) ?? "(not written yet)"}`)), `Runtime state:\n${JSON.stringify(state, null, 2)}`].join("\n\n");
}
export async function statusText(root: string, id?: string): Promise<string> {
  if (!id) {
    const entries = await fs.readdir(path.join(root, ".pi/changes"), { withFileTypes: true });
    const states = await Promise.all(entries.filter(e => e.isDirectory() && e.name !== "archive").map(e => loadChange(root, e.name)));
    return states.length ? states.map(s => `${s.id}: ${s.phase}; ${s.tasks.filter(t => t.status === "complete").length}/${s.tasks.length} tasks complete`).join("\n") : "No active changes. Use /plan <id> <request>.";
  }
  const state = await loadChange(root, id);
  let valid = false;
  try { valid = state.planDigest === await currentPlanDigest(root, id); } catch { /* Draft */ }
  return [`${id}: ${state.phase}, revision ${state.revision}`, `Documents: ${valid ? "consistent" : "draft or modified; reconcile with /plan"}`, ...state.tasks.map(t => `${t.id}: ${t.status}; attempts fast=${t.attempts.filter(a => a.role === "fast-worker").length}/1 strong=${t.attempts.filter(a => a.role === "strong-worker").length}/2`), `Next: ${!valid || state.phase === "draft" ? `/plan ${id}` : state.phase === "verified" ? `/archive ${id}` : state.tasks.every(t => t.status === "complete") ? `/verify ${id}` : `/apply ${id}`}`].join("\n");
}

/** Snapshot source contents, including untracked files; never include workflow evidence. */
export async function repositorySnapshot(root: string): Promise<string> {
  let files: string[];
  try { files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 20 * 1024 * 1024 }).toString().split("\0").filter(Boolean); }
  catch {
    files = [];
    const visit = async (dir: string) => {
      for (const entry of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
        if ([".git", "node_modules", ".venv", "dist", "build", "coverage", "__pycache__"].includes(entry.name)) continue;
        const file = path.posix.join(dir, entry.name);
        if (file.startsWith(".pi/changes") || file.startsWith(".pi/specs")) continue;
        if (entry.isDirectory()) await visit(file); else files.push(file);
        if (files.length > 20000) throw new Error("Repository snapshot exceeds 20,000 files; initialize Git with appropriate ignore rules.");
      }
    };
    await visit("");
  }
  const hash = createHash("sha256");
  for (const file of [...new Set(files)].sort()) {
    if (file.startsWith(".pi/changes/") || file.startsWith(".pi/specs/") || file === ".pi/workflow.lock" || file.includes(".pi-init-stage-") || file.includes(".pi-init-restore-")) continue;
    hash.update(file); hash.update("\0");
    const full = path.join(root, file);
    let stat;
    try { stat = await fs.lstat(full); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; hash.update("deleted"); continue; }
    hash.update(String(stat.mode));
    if (stat.isSymbolicLink()) hash.update(await fs.readlink(full));
    else if (stat.isFile()) for await (const chunk of syncFs.createReadStream(full)) hash.update(chunk);
    else throw new Error(`Cannot verify special file or submodule: ${file}`);
  }
  return hash.digest("hex");
}
