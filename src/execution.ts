import * as fs from "node:fs/promises";
import * as path from "node:path";
import { assertMetadataPath } from "./paths.ts";
import { readConfig } from "./config.ts";
import { persistArtifacts } from "./persistence.ts";
import { assertPlan, artifact, changeDir, loadChange, nextWorker, now, planContext, readOptional, repositorySnapshot, saveState, type CheckResult, type ChangeState } from "./changes.ts";
import type { WorkerRunner } from "./runner.ts";
import { runCheck } from "./runner.ts";

export async function delegateTask(root: string, id: string, taskId: string, runner: WorkerRunner, signal?: AbortSignal, onUpdate?: (message: string) => void): Promise<string> {
  const state = await loadChange(root, id);
  await assertPlan(root, state, true);
  if (!["applying", "blocked", "implemented"].includes(state.phase)) throw new Error(`Cannot execute in phase ${state.phase}. Use /apply.`);
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) throw new Error(`Unknown task: ${taskId}`);
  if (task.status === "complete" || task.status === "review" || task.status === "running") throw new Error(`Task ${taskId} is ${task.status}; review returned work before another attempt.`);
  const first = state.tasks.find(t => t.status !== "complete");
  if (first?.id !== taskId) throw new Error(`Complete/review task ${first?.id} first. Tasks execute in plan order.`);
  const role = nextWorker(task);
  signal?.throwIfAborted();
  const attempt = { role, startedAt: now(), outcome: "running" as "running" | "returned" | "failed" };
  task.attempts.push(attempt); task.status = "running"; state.phase = "applying";
  delete state.checkRun; delete state.verification;
  await saveState(root, state);
  let output: string;
  try {
    output = await runner({ root, role, mode: "execute", scope: task.scope, signal, onUpdate, task: `${await planContext(root, id)}\n\nEXECUTE ONLY TASK ${task.id}: ${task.title}\nAcceptance: ${task.acceptance.join("; ")}\nPrevious review: ${task.review ?? "none"}\nPrevious attempt evidence:\n${(await Promise.all(task.attempts.slice(0, -1).map(a => a.evidence ? readOptional(path.join(changeDir(root, id), a.evidence)) : null))).filter(Boolean).join("\n")}\nThe workspace may contain user changes or partial prior attempts. Inspect first; preserve unrelated edits. Do not run checks or update plan state.` });
    signal?.throwIfAborted();
    await assertPlan(root, state, true);
    attempt.outcome = "returned"; task.status = "review";
  } catch (error) {
    output = `Worker failed: ${error instanceof Error ? error.message : String(error)}`;
    attempt.outcome = "failed"; task.status = "blocked"; state.phase = "blocked";
  }
  const evidence = `evidence/r${state.revision}-${task.id}-${task.attempts.length}.md`;
  Object.assign(attempt, { evidence });
  await persistArtifacts([await artifact(path.join(changeDir(root, id), evidence), `# ${task.id} — ${role}\n\n${output}\n`), await artifact(path.join(changeDir(root, id), "state.json"), `${JSON.stringify(state, null, 2)}\n`)]);
  return `${output}\n\nTask state: ${task.status}. ${task.status === "review" ? "Sergeant must inspect the edits and call pi_review_task." : "Inspect partial edits, then retry/escalate within the remaining budget or replan."}`;
}
export async function reviewTask(root: string, id: string, taskId: string, accepted: boolean, evidence: string): Promise<ChangeState> {
  const state = await loadChange(root, id);
  await assertPlan(root, state, true);
  const task = state.tasks.find(t => t.id === taskId);
  if (!task || (task.status !== "review" && !(task.status === "complete" && !accepted))) throw new Error("Review returned work, or reject a completed task when verification reveals a defect.");
  if (!evidence.trim()) throw new Error("Review needs concrete file/acceptance evidence.");
  task.review = evidence; task.status = accepted ? "complete" : "blocked";
  state.phase = state.tasks.every(t => t.status === "complete") ? "implemented" : accepted ? "applying" : "blocked";
  delete state.checkRun; delete state.verification;
  await saveState(root, state);
  return state;
}
export type CheckRunner = (root: string, command: string, timeout: number, signal?: AbortSignal) => Promise<CheckResult>;
export async function checkChange(root: string, id: string, signal?: AbortSignal, runner: CheckRunner = runCheck): Promise<ChangeState> {
  const state = await loadChange(root, id);
  await assertPlan(root, state, true);
  if (!state.tasks.length || !state.tasks.every(t => t.status === "complete")) throw new Error("Finish and review all tasks before running final checks.");
  delete state.verification; delete state.checkRun; state.phase = "implemented";
  await saveState(root, state);
  const results: CheckResult[] = [];
  const before = await repositorySnapshot(root);
  for (const command of state.checks) {
    if (signal?.aborted) { results.push({ command, exitCode: 1, output: "Check cancelled before execution" }); break; }
    try { results.push(await runner(root, command, readConfig(root).checkTimeoutSeconds, signal)); }
    catch (error) { results.push({ command, exitCode: 1, output: String(error) }); }
    if (results.at(-1)!.exitCode !== 0) break;
  }
  const snapshot = await repositorySnapshot(root);
  if (before !== snapshot) results.push({ command: "[repository stability]", exitCode: 1, output: "Repository contents changed during checks. Inspect generated edits and rerun verification on stable contents." });
  await assertPlan(root, state, true);
  state.checkRun = { results, snapshot, planDigest: state.planDigest! };
  await persistArtifacts([await artifact(path.join(changeDir(root, id), "checks.md"), ["# Verification command results", ...results.map(result => `\n## ${result.command}\n\nExit code: ${result.exitCode}\n\n~~~text\n${result.output}\n~~~`), state.manualVerification].join("\n")), await artifact(path.join(changeDir(root, id), "state.json"), `${JSON.stringify(state, null, 2)}\n`)]);
  return state;
}
export async function finishVerification(root: string, id: string, evidence: string): Promise<ChangeState> {
  const state = await loadChange(root, id);
  await assertPlan(root, state, true);
  if (!state.tasks.length || !state.tasks.every(t => t.status === "complete")) throw new Error("All tasks must be reviewed and complete.");
  if (!evidence.trim()) throw new Error("Provide acceptance evidence; command success alone is insufficient.");
  const checks = state.checkRun;
  if (!checks || checks.planDigest !== state.planDigest || checks.results.length !== state.checks.length || checks.results.some(result => result.exitCode !== 0)) throw new Error("Declared checks are missing, incomplete or failed. Run pi_check and resolve failures first.");
  if (!state.checks.length && !state.manualVerification.trim()) throw new Error("Manual verification requires a declared procedure.");
  const snapshot = await repositorySnapshot(root);
  if (snapshot !== checks.snapshot) throw new Error("Repository changed after checks; rerun /verify.");
  state.verification = { evidence, snapshot, planDigest: state.planDigest!, at: now() }; state.phase = "verified";
  await persistArtifacts([await artifact(path.join(changeDir(root, id), "verification.md"), `# Verification\n\nVerified at: ${state.verification.at}\nPlan digest: ${state.planDigest}\nRepository snapshot: ${snapshot}\n\n${evidence}\n`), await artifact(path.join(changeDir(root, id), "state.json"), `${JSON.stringify(state, null, 2)}\n`)]);
  return state;
}
export async function archiveChange(root: string, id: string): Promise<string> {
  const state = await loadChange(root, id);
  await assertPlan(root, state, true);
  if (state.phase !== "verified" || !state.verification || state.verification.planDigest !== state.planDigest || !state.tasks.every(t => t.status === "complete")) throw new Error("Only a verified, completed change can be archived.");
  if (await repositorySnapshot(root) !== state.verification.snapshot) throw new Error("Repository changed after verification; rerun /verify before archiving.");
  const dir = changeDir(root, id);
  const destination = path.join(root, ".pi/changes/archive", `${now().replace(/[:.]/g, "-")}-${id}`);
  const specPath = path.join(root, ".pi/specs", `${id}.md`);
  assertMetadataPath(root, path.relative(root, destination));
  assertMetadataPath(root, path.relative(root, specPath));
  const previous = await readOptional(specPath);
  const spec = await fs.readFile(path.join(dir, "spec.md"), "utf8");
  await persistArtifacts([{ path: specPath, original: previous, content: spec }]);
  try { await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.rename(dir, destination); }
  catch (error) {
    if (previous === null) await fs.unlink(specPath); else await persistArtifacts([{ path: specPath, original: spec, content: previous }]);
    throw error;
  }
  return destination;
}
