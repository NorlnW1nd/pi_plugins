# Repository workflow foundation

## Intent

Make `/init` establish reusable project knowledge, a working Sergeant/Worker runtime, and a small document-first change lifecycle. Preserve existing repository instructions and role customizations. Do not depend on OpenCode, oh-my-opencode, OpenSpec, or a separately installed subagent extension.

## Workflow

- `/init`: choose live models, inventory the repository, write managed configuration, activate Sergeant, and ask it to inspect important files and save concise project guidance.
- `/plan <id> <request>`: read-only exploration followed by persisted proposal, design, behavioral spec, and scoped tasks. Revising a plan invalidates its approval and verification.
- `/apply <id>`: explicit approval of the current documents. Execute one scoped Worker at a time; Sergeant reviews its evidence before completing a task. Resume persisted progress after interruption.
- `/verify <id>`: execute the plan's declared checks, inspect acceptance criteria, and record evidence. A failed check cannot become a successful verification.
- `/archive <id>`: require completed tasks and verification of unchanged documents and repository contents; retain the accepted spec and move the change into history.
- `/status [id]`: show durable progress, retry counts, and the next useful command.

## Boundaries

The main session is Sergeant. Isolated in-memory Pi SDK sessions run Workers, using configured providers and no recursive workflow extension. Inspection tools are read-only. Worker writes use Pi's edit/write tools with a canonical-path scope guard; Workers have no shell. Verification shell commands are declared in the reviewed plan and executed by the workflow, with timeout, cancellation, exit codes, and bounded output. These are local filesystem guards, not an OS sandbox.

There is one writer per repository, enforced by an exclusive lock. Fast Worker gets one implementation attempt per task per plan revision; Strong Worker gets two. Failures, cancellation and rejected work consume an attempt. Replanning keeps prior revisions as history and starts a fresh revision.

## Durable files

Initialization maintains AGENTS.md, .pi/SERGEANT.md, three .pi/agents role files, .pi/PROJECT.md, .pi/workflow.json and .pi/changes/README.md. Changes own proposal.md, design.md, spec.md, tasks.md, state.json and evidence logs. Human-readable plan edits invalidate approval until the plan is reconciled through `/plan`. No credentials are copied into project files.

## Validation

Test initialization and migration, configuration preservation, plan approval/digest invalidation, scope enforcement including symlinks, independent sessions, retry budgets, interrupted execution, concurrency, failed checks, stale verification, archival, and real Pi extension loading. Live paid model calls are not required by the deterministic test suite.

## References

- https://opencode.ai/docs/rules/
- https://github.com/code-yeongyu/oh-my-opencode
- https://github.com/Fission-AI/OpenSpec/blob/main/docs/getting-started.md
