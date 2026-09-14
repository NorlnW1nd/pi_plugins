# Pi document-first workflow

A lightweight Pi package that connects repository initialization, persistent plans, scoped multi-agent implementation, verification, and archival. The main session is **Sergeant**; **Fast Worker** and **Strong Worker** run in independent in-memory Pi SDK sessions. No separate subagent plugin or OpenSpec installation is required.

## Load the package

Requires Node >=22.19 and `@earendil-works/pi-coding-agent` / `pi-ai` >=0.85.1. Tested against Pi 0.85.1.

```bash
# In this package (development setup)
npm install

# Start Pi from the project you want to work on
pi -e /home/summerrain/pi_work/pi_plugins
```

Keep loading the package in future sessions, or register this local package with `pi install /home/summerrain/pi_work/pi_plugins`. `/init` creates project configuration; it does not install the extension globally. If updating an already running Pi session, use `/reload` before invoking the new commands.

## Everyday workflow

```text
/init
/plan add-dark-mode 为应用增加深色模式，并持久化用户选择
/apply add-dark-mode
/verify add-dark-mode
/archive add-dark-mode
```

| Command | Effect |
| --- | --- |
| `/init [instructions]` | Choose models and supported thinking levels, show a summary before writing, build repository context, activate Sergeant, then research important files and save concise project guidance. |
| `/init --quick` | Write configuration and a bounded local inventory, activate Sergeant, and skip the model-driven project research. |
| `/plan <id> <request>` | Research without source writes or shell commands; save proposal, design, behavioral spec and ordered scoped tasks. Stop for the user to review. |
| `/plan <id> [revision instructions]` | Reconcile existing plan edits, retain the previous revision and evidence, and invalidate prior approval/verification. |
| `/apply <id>` | The command itself approves the current plan. Resume incomplete tasks, delegate implementation, review returned evidence, and run verification. It never archives automatically. |
| `/verify <id>` | Rerun declared checks and assess acceptance evidence. This mode cannot implement fixes. |
| `/status [id]` | List active changes or show progress, attempts and the next command. |
| `/archive <id>` | Require successful verification of unchanged documents/source; retain the accepted spec and move the change to archive. |
| `/workflow-exit` | Leave command-specific tool restrictions while preserving all saved change progress. |

`/init` accepts the entire following text as one argument string and substitutes it into `$ARGUMENTS` in the built-in prompt (`src/init-prompt.ts`). The text received from Pi is preserved, including whitespace, newlines, quotes and dollar signs; it is not split into positional arguments or evaluated as shell syntax. With no instructions, `$ARGUMENTS` becomes an empty string. Only a standalone `--quick` (ignoring surrounding whitespace) retains the quick-initialization behavior; `--quick` within a longer instruction is ordinary text.

```text
/init 请使用中文整理项目说明，重点分析插件扩展机制和测试流程
```

`/apply`, `/verify`, and `/archive` may omit the id when the current session already selected a change. IDs use lowercase letters, digits and hyphens. The language of the request should be used in generated plans and reports.

`/apply` may complete verification automatically; a separate `/verify` is useful after manual changes or when you want to repeat it. If final checks reveal a defect, Sergeant can reject/reopen the relevant completed task and retry within its existing budget. A scope change or exhausted budget requires a new plan revision. `/plan` resets task completion for the new revision; the planner should include only the work still required.

## What initialization maintains

```text
AGENTS.md                       # managed workflow overview + discovered commands
.pi/
  PROJECT.md                    # researched project context; managed block
  SERGEANT.md                   # routing, planning and evidence policy; managed block
  workflow.json                 # version and execution limits; no credentials
  agents/
    sergeant.md                 # main-session model and role prompt
    fast-worker.md              # bounded/local implementation model and prompt
    strong-worker.md            # complex/escalated implementation model and prompt
  changes/
    README.md                   # lifecycle instructions; no change started by init
```

`AGENTS.md` links to the project and runtime policy. The extension also injects these documents dynamically into the main session, so the workflow does not depend on Pi automatically discovering arbitrary `.pi/*.md` files. Sergeant's configured model is activated on initialization, on workflow commands and when the extension loads in an initialized repository. Outside an active workflow command, normal conversation tools remain available.

Model bindings remain in the three role files, using Pi-native `provider/model:thinking` syntax. Choices are constrained by the parent session's available/scoped models. Worker sessions inherit configured providers (including extension-registered providers) but not conversation history or recursive workflow tools. Credentials remain in Pi's credential runtime and are not written to the repository.

Initialization finds the nearest Git root. Without Git it uses the current directory, or an initialized ancestor when running subsequent commands from a subdirectory. It scans a bounded set of filenames and common package scripts without executing project code. These commands are **discovered, not verified**. The subsequent read-only model pass researches architecture, conventions, setup and focused checks; unknown information should remain explicit.

## Change documents and evidence

```text
.pi/changes/<id>/
  proposal.md                   # intent, scope, non-goals
  design.md                     # approach and exact verification commands
  spec.md                       # observable behavior and acceptance scenarios
  tasks.md                      # ordered task definitions, scope and acceptance
  state.json                    # authoritative progress, approvals, attempts, reviews
  evidence/r<revision>-<task>-<attempt>.md
  checks.md                     # last check outputs and exit codes
  verification.md               # accepted evidence and content fingerprints
  history/<revision>/           # prior plan documents/state/verification
```

Task progress lives in `state.json` and `/status`; `tasks.md` contains the stable, reviewable task definitions. Do not manually edit runtime state. Human edits to plan documents are detected: use `/plan <id>` to reconcile them before `/apply`. Approval binds both document contents and machine-readable task/check definitions. Previous attempt evidence remains available during retries and after replanning.

Archive moves the entire change to `.pi/changes/archive/<timestamp>-<id>/` and saves its accepted spec to `.pi/specs/<id>.md`. This is an accepted-spec snapshot per change id, **not OpenSpec's semantic delta-spec merge**. Existing OpenSpec directories are untouched.

## Execution guarantees and limits

- One workflow mutation/Worker/check operation per repository, enforced across Pi processes by a lock. `/status` is read-only and remains available. Dead local lock owners are recovered; a malformed/foreign lock is not stolen.
- Fast Worker: one implementation attempt per task/revision. Strong Worker: two. Cancellation, failure, and rejected work consume attempts. Interrupted tasks resume with their reserved attempt counted.
- Workers can read/search and use Pi's `edit`/`write` tools within the task's concrete file/directory scope. Traversal, metadata paths, escaping symlinks and hard-linked files are rejected. Workers have **no shell** and do not delete/rename files. Tasks requiring those operations need a separately reviewed/manual step or a future scoped tool.
- Only the exact shell checks declared in the approved plan run through `pi_check`. Shell commands have normal local process permissions; this is **not an OS sandbox**. Review these commands with the plan. Avoid formatter/fixer commands for final checks: source changes during verification require review and a fresh stable run.
- Checks record actual exit codes and bounded output, with timeout and cancellation of the process group. All tasks must be reviewed before final checks. A manual-only plan must specify a verification procedure.
- Passing commands alone do not certify behavior. Sergeant must provide acceptance evidence; failed/incomplete checks block verification. Content changes after verification block archival. Git snapshots include tracked and non-ignored untracked files; ignored outputs are excluded. Non-Git snapshots skip common dependency/build directories and stop beyond 20,000 files. Submodules/special files are not supported by the snapshot verifier.
- No automatic commit, push, deployment, dependency installation, or background parallel writers. Files outside managed blocks and user-authored role prompts/extra fields are preserved; managed metadata cannot use symlinks. `PROJECT.md` guidance and custom workflow settings survive reinitialization; the default research pass can refresh its managed guidance.

Default limits in `.pi/workflow.json`: 30 Worker turns, 600 seconds per Worker, 300 seconds per check. Settings can be edited between operations. Failed Worker runs may leave partial edits; the next attempt inspects and preserves unrelated user work. Rollback of initialization documents does not imply rollback of implementation changes.

## Verification

```bash
npm test -- --no-cache
npm run typecheck
```

Tests cover migration/idempotence, state transitions, approval invalidation, retries/escalation, interrupted execution, scope/path guards, real SDK tool execution with a non-network test provider, check failures/cancellation and stale verification. No paid live model calls are made by the tests.

Design notes: [docs/design.md](docs/design.md). Inspired by [OpenCode initialization](https://opencode.ai/docs/rules/), [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode), and [OpenSpec's artifact-first workflow](https://github.com/Fission-AI/OpenSpec/blob/main/docs/getting-started.md); this package does not claim compatibility with their full command/configuration formats.
