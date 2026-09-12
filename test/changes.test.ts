import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { approvePlan, assertPlan, beginPlan, changeDir, loadChange, readOptional, savePlan, statusText, withLock, type PlanInput } from "../src/changes.ts";
import { archiveChange, checkChange, delegateTask, finishVerification, reviewTask } from "../src/execution.ts";
import { assertMetadataPath, assertWorkerPath } from "../src/paths.ts";
import { runCheck } from "../src/runner.ts";

const dirs: string[] = [];
async function repo() {
  const root = await fs.mkdtemp("/tmp/pi-workflow-test-"); dirs.push(root);
  await fs.mkdir(path.join(root, ".pi")); await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, ".pi/workflow.json"), JSON.stringify(DEFAULT_CONFIG));
  await fs.writeFile(path.join(root, "src/app.ts"), "before");
  return root;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });
const input: PlanInput = { proposal: "Fix the app", design: "Change src/app.ts", spec: "The app returns after", tasks: [{ id: "fix", title: "Fix app", role: "fast-worker", scope: ["src"], acceptance: ["Returns after"] }], checks: ["test -f src/app.ts"], manualVerification: "" };
async function planned(root: string, plan = input) { await beginPlan(root, "fix-app", "Fix app behavior"); return savePlan(root, "fix-app", structuredClone(plan)); }
async function implemented(root: string) {
  await planned(root); await approvePlan(root, "fix-app");
  await delegateTask(root, "fix-app", "fix", async request => { expect(request.mode).toBe("execute"); await fs.writeFile(path.join(root, "src/app.ts"), "after"); return "Updated src/app.ts; checks not run."; });
  await reviewTask(root, "fix-app", "fix", true, "Read src/app.ts: now returns after.");
}
const passCheck = async (_root: string, command: string) => ({ command, exitCode: 0, output: "pass" });

describe("document-first changes", () => {
  it("reopens a completed task after verification finds a defect without resetting its budget", async () => {
    const root = await repo(); await implemented(root);
    await reviewTask(root, "fix-app", "fix", false, "Final check exposed a missing case");
    await delegateTask(root, "fix-app", "fix", async request => { expect(request.role).toBe("strong-worker"); return "Fixed missing case"; });
    expect((await loadChange(root, "fix-app")).tasks[0].attempts).toHaveLength(2);
  });

  it("requires document review before execution and preserves a durable complete lifecycle", async () => {
    const root = await repo(); await planned(root);
    await expect(delegateTask(root, "fix-app", "fix", async () => "no")).rejects.toThrow(/not approved/);
    await approvePlan(root, "fix-app");
    await delegateTask(root, "fix-app", "fix", async request => { expect(request.role).toBe("fast-worker"); return "Changed app."; });
    expect((await loadChange(root, "fix-app")).tasks[0].status).toBe("review");
    await expect(checkChange(root, "fix-app", undefined, passCheck)).rejects.toThrow(/review/);
    await reviewTask(root, "fix-app", "fix", true, "Inspected actual app behavior.");
    await checkChange(root, "fix-app", undefined, passCheck);
    await finishVerification(root, "fix-app", "Accepted scenario verified with src/app.ts and passing checks.");
    const archive = await archiveChange(root, "fix-app");
    expect(await fs.readFile(path.join(root, ".pi/specs/fix-app.md"), "utf8")).toContain(input.spec);
    expect(await readOptional(path.join(archive, "state.json"))).toContain('"verified"');
    expect(await statusText(root)).toContain("No active changes");
  });
  it("invalidates approval when documents or machine-readable task scope/checks change", async () => {
    const root = await repo(); await planned(root); await approvePlan(root, "fix-app");
    await fs.appendFile(path.join(changeDir(root, "fix-app"), "proposal.md"), "\nMore scope");
    await expect(delegateTask(root, "fix-app", "fix", async () => "no")).rejects.toThrow(/changed/);
    await beginPlan(root, "fix-app", "Revised"); await savePlan(root, "fix-app", structuredClone(input));
    const state = await loadChange(root, "fix-app");
    expect(state.revision).toBe(2); expect(state.approvedDigest).toBeUndefined();
    expect(await readOptional(path.join(changeDir(root, "fix-app"), "history/1/proposal.md"))).toContain("More scope");
    state.checks.push("unexpected-command");
    await fs.writeFile(path.join(changeDir(root, "fix-app"), "state.json"), JSON.stringify(state));
    await expect(assertPlan(root, state)).rejects.toThrow(/changed/);
  });
  it("enforces retry limits across reloads and escalates Fast Worker to Strong Worker", async () => {
    const root = await repo(); await planned(root); await approvePlan(root, "fix-app");
    const roles: string[] = [];
    for (let i = 0; i < 3; i++) await delegateTask(root, "fix-app", "fix", async request => { roles.push(request.role); throw new Error("failure"); });
    expect(roles).toEqual(["fast-worker", "strong-worker", "strong-worker"]);
    await approvePlan(root, "fix-app");
    await expect(delegateTask(root, "fix-app", "fix", async () => "no")).rejects.toThrow(/budget exhausted/);
    expect((await loadChange(root, "fix-app")).tasks[0].attempts).toHaveLength(3);
  });
  it("counts cancellation and rejected returned work as attempts", async () => {
    const root = await repo(); await planned(root); await approvePlan(root, "fix-app");
    await delegateTask(root, "fix-app", "fix", async () => "Incomplete edit");
    await reviewTask(root, "fix-app", "fix", false, "Acceptance scenario missing");
    const controller = new AbortController();
    await delegateTask(root, "fix-app", "fix", async () => { controller.abort(); return "partial"; }, controller.signal);
    const task = (await loadChange(root, "fix-app")).tasks[0];
    expect(task.attempts.map(a => a.outcome)).toEqual(["returned", "failed"]); expect(task.status).toBe("blocked");
  });
  it("recovers an interrupted running task without refunding its reserved attempt", async () => {
    const root = await repo(); await planned(root); await approvePlan(root, "fix-app");
    const state = await loadChange(root, "fix-app"); state.tasks[0].status = "running"; state.tasks[0].attempts.push({ role: "fast-worker", outcome: "running", startedAt: "before crash" });
    await fs.writeFile(path.join(changeDir(root, "fix-app"), "state.json"), JSON.stringify(state));
    await approvePlan(root, "fix-app");
    await delegateTask(root, "fix-app", "fix", async request => { expect(request.role).toBe("strong-worker"); return "Recovered partial edits"; });
    expect((await loadChange(root, "fix-app")).tasks[0].attempts).toHaveLength(2);
  });
  it("refuses to verify failed checks and detects source changes after successful verification", async () => {
    const root = await repo(); await implemented(root);
    await checkChange(root, "fix-app", undefined, async (_r, command) => ({ command, exitCode: 1, output: "failed" }));
    await expect(finishVerification(root, "fix-app", "trust me")).rejects.toThrow(/failed/);
    await checkChange(root, "fix-app", undefined, passCheck);
    await finishVerification(root, "fix-app", "Actual acceptance evidence");
    await fs.writeFile(path.join(root, "src/app.ts"), "different");
    await expect(archiveChange(root, "fix-app")).rejects.toThrow(/changed/);
  });
  it("requires manual verification rationale when no commands apply", async () => {
    const root = await repo(); await beginPlan(root, "fix-app", "docs");
    await expect(savePlan(root, "fix-app", { ...structuredClone(input), checks: [] })).rejects.toThrow(/manual/);
  });
  it("does not certify a repository modified by its verification commands", async () => {
    const root = await repo(); await implemented(root);
    await checkChange(root, "fix-app", undefined, async (_r, command) => { await fs.writeFile(path.join(root, "src/app.ts"), "formatted"); return { command, exitCode: 0, output: "formatted" }; });
    await expect(finishVerification(root, "fix-app", "pass")).rejects.toThrow(/failed/);
  });
});

describe("execution boundaries", () => {
  it("rejects symlinked workflow metadata before writing outside the repository", async () => {
    const root = await repo(), outside = await repo();
    await fs.symlink(outside, path.join(root, ".pi/changes"));
    expect(() => assertMetadataPath(root, ".pi/changes/example/state.json")).toThrow(/symlink/);
    await expect(beginPlan(root, "example", "Do work")).rejects.toThrow(/symlink/);
    await expect(fs.stat(path.join(outside, "example"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows scoped new files and blocks traversal, metadata, symlinks and hardlinks", async () => {
    const root = await repo(), outside = await repo();
    expect(() => assertWorkerPath(root, "src/new/file.ts", ["src"])).not.toThrow();
    expect(() => assertWorkerPath(root, "other.ts", ["src"])).toThrow(/scope/);
    expect(() => assertWorkerPath(root, "../outside.ts", ["src"])).toThrow();
    expect(() => assertWorkerPath(root, ".pi/workflow.json", ["src"])).toThrow();
    await fs.symlink(outside, path.join(root, "src/escape"));
    expect(() => assertWorkerPath(root, "src/escape/new.ts", ["src"])).toThrow();
    await fs.link(path.join(outside, "src/app.ts"), path.join(root, "src/hard.ts"));
    expect(() => assertWorkerPath(root, "src/hard.ts", ["src"])).toThrow(/hard-linked/);
  });
  it("serializes operations and releases the lock after errors", async () => {
    const root = await repo();
    await withLock(root, async () => { await expect(withLock(root, async () => {})).rejects.toThrow(/holds/); });
    await expect(withLock(root, async () => { throw new Error("failure"); })).rejects.toThrow("failure");
    await expect(withLock(root, async () => "ready")).resolves.toBe("ready");
  });
  it("executes declared commands with real exit codes and bounded cancellation", async () => {
    const root = await repo();
    expect(await runCheck(root, "printf evidence; exit 2", 5)).toMatchObject({ exitCode: 2, output: "evidence" });
    const controller = new AbortController(); const result = runCheck(root, "sleep 20", 5, controller.signal); controller.abort();
    expect(await result).toMatchObject({ exitCode: 1, output: expect.stringContaining("cancelled") });
  });
});
