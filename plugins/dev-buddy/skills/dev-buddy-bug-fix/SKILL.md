---
name: dev-buddy-bug-fix
description: Dev Buddy bug-fix pipeline. Data-driven RCA (sequential or parallel) -> Consolidation -> Validation -> Implementation -> Code Reviews. Configurable pipeline.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task, TaskOutput, AskUserQuestion, Skill, TaskCreate, TaskUpdate, TaskList, TaskGet, TeamCreate, TeamDelete
---

# Bug-Fix Pipeline Orchestrator

You coordinate worker agents using Task tools to diagnose and fix a bug. The pipeline is data-driven from the bugfix_pipeline config: RCA stages (sequential by default, or parallel with `parallel: true`), followed by implicit orchestrator consolidation, then plan-review/implementation/code-review stages.

**Task directory:** `${CLAUDE_PROJECT_DIR}/.vcp/task/`
**Agents location:** `${CLAUDE_PLUGIN_ROOT}/agents/`

---

## Orchestrator Execution Model

**STRICT SEQUENTIAL EXECUTION.** You are a sequential orchestrator. You execute ONE step at a time, WAIT for its result, VERIFY the result, then proceed to the next step.

### Execution Rules (MANDATORY)

1. **ONE tool call per step.** Each numbered step produces exactly ONE tool call (or one batch where explicitly marked). Do NOT combine steps into a single response.
2. **WAIT for return.** After each tool call, WAIT for the result before doing anything else. Do NOT start the next step while the current step is in flight.
3. **VERIFY before proceeding.** After each step returns, CHECK the result. If it failed, follow the error handling for that step. Do NOT skip verification.
4. **NEVER auto-recover.** If ANY operation fails or produces unexpected output: STOP and escalate to the user via `AskUserQuestion`. Do NOT decide to "proceed with what we have." The user decides recovery strategy.
5. **NEVER run Bash polling loops alongside other operations.** File checks are their own step — not combined with agent spawning or message sending.
6. **User interruption means FULL STOP.** If the user sends a message mid-pipeline, STOP. Read the user's message. Respond. Do NOT continue until the user explicitly says to.

---

## Pipeline Variables

These values are used by shared pipeline procedures referenced below:

| Variable | Value |
|----------|-------|
| `{PIPELINE_TYPE}` | `bug-fix` |
| `{PIPELINE_COMMAND}` | `/dev-buddy-bug-fix` |
| `{PIPELINE_CONFIG_KEY}` | `bugfix_pipeline` |

---

## Architecture: Tasks + Hook Enforcement

| Component | Role |
|-----------|------|
| **Tasks** (primary) | Structural enforcement via `blockedBy`, user visibility, audit trail |
| **UserPromptSubmit Hook** (guidance) | Reads artifact files, injects phase guidance |
| **SubagentStop Hook** (enforcement) | Validates reviewer outputs, can BLOCK until requirements met |
| **Main Thread** (orchestrator) | Handles consolidation (inline, not a task), user input, dynamic tasks |

**Key insight:** `blockedBy` is *data*, not an instruction. Only claim tasks where blockedBy is empty or all dependencies completed.

**Bug-fix differentiator:** This pipeline does NOT use requirements-gatherer or planner agents. The orchestrator itself reads all RCA output files after the last consecutive RCA stage completes, consolidates findings, and writes the `user-story/` + `plan/` multi-file artifacts directly. This consolidation is an INLINE ORCHESTRATOR ACTION, not a task.

**Stages execute SEQUENTIALLY by default.** Review stages (plan-review, code-review) can be configured for parallel execution via the `parallel` flag on each StageEntry. Non-review stages (rca, implementation) always run sequentially. Each task has `blockedBy` dependencies enforced via TaskUpdate.

---

## Pipeline Initialization

### Step 0: Resume Detection

**Execute [core-init-resume.md](../../docs/pipeline/core-init-resume.md).**

### Steps 1-2: Fresh Initialization and Task Chain

**Execute [core-task-chain.md](../../docs/pipeline/core-task-chain.md).**

After loading config, also identify RCA stages: all consecutive `rca` type entries at the beginning of the pipeline.

---

## Task Chain: Description Rules by Stage Type

For `rca` (stageIndex N, outputFile rca-N.json):
```
PHASE: Root Cause Analysis {N}
AGENT: dev-buddy:root-cause-analyst (model: {stage.model})
INPUT: Bug description from conversation context
OUTPUT: .vcp/task/rca-{N}.json
PROMPT MUST INCLUDE: Full bug description, 'Write output to .vcp/task/rca-{N}.json. Set reviewer field to {stage.model or "rca-{N}"}.'
COMPLETION: .vcp/task/rca-{N}.json exists with root_cause.summary populated
```

For `plan-review` (subscription/api, stageIndex N, outputFile plan-review-N.json):
```
PHASE: Plan Review {N} (RCA + Plan Validation)
AGENT: dev-buddy:plan-reviewer (model: {stage.model})
INPUT: .vcp/task/plan/manifest.json (then read step files), .vcp/task/user-story/manifest.json, + all rca-*.json files
OUTPUT: .vcp/task/plan-review-{N}.json
PROMPT MUST INCLUDE: 'Write output to .vcp/task/plan-review-{N}.json. Validate that the consolidated RCA diagnosis is correct and the fix plan is sound.'
RESULT HANDLING: Read .vcp/task/plan-review-{N}.json -> check status -> handle per Result Handling rules
COMPLETION: .vcp/task/plan-review-{N}.json exists with status and requirements_coverage fields
```

For `plan-review` (CLI provider, stageIndex N, outputFile plan-review-N.json):
```
PHASE: Plan Review {N} (CLI - RCA Validation gate)
AGENT: dev-buddy:cli-executor (external — do NOT pass model parameter to Task tool)
INPUT: .vcp/task/plan/manifest.json (then read step files), .vcp/task/user-story/manifest.json, + all rca-*.json files
OUTPUT: .vcp/task/plan-review-{N}.json
NOTE: CLI executor runs cli-executor.ts with --preset {stage.provider} --model {stage.model}
      --output-file "${CLAUDE_PROJECT_DIR}/.vcp/task/plan-review-{N}.json" --plugin-root "${CLAUDE_PLUGIN_ROOT}"
RESULT HANDLING: if rejected -> ask user to re-examine bug or provide more context
COMPLETION: .vcp/task/plan-review-{N}.json exists with status field
```

For `implementation`:
```
PHASE: Implementation (Bug Fix)
AGENT: dev-buddy:implementer (model: {stage.model})
INPUT: .vcp/task/plan/manifest.json (read steps from sections.steps[]), .vcp/task/user-story/manifest.json
OUTPUT: .vcp/task/impl-result.json
PROMPT MUST INCLUDE: This is a bug fix — make the smallest possible change that addresses the root cause.
COMPLETION: .vcp/task/impl-result.json exists with status='complete'
```

For `code-review` (subscription/api, stageIndex N, outputFile code-review-N.json):
```
PHASE: Code Review {N}
AGENT: dev-buddy:code-reviewer (model: {stage.model})
INPUT: .vcp/task/user-story/acceptance-criteria.json, .vcp/task/plan/manifest.json, .vcp/task/impl-result.json
OUTPUT: .vcp/task/code-review-{N}.json
PROMPT MUST INCLUDE: 'Write output to .vcp/task/code-review-{N}.json.'
RESULT HANDLING: Read .vcp/task/code-review-{N}.json -> check status -> handle per Result Handling rules
COMPLETION: .vcp/task/code-review-{N}.json exists with status and acceptance_criteria_verification fields
```

For `code-review` (CLI provider, stageIndex N, outputFile code-review-N.json):
```
PHASE: Code Review {N} (CLI - final gate)
AGENT: dev-buddy:cli-executor (external — do NOT pass model parameter to Task tool)
INPUT: .vcp/task/user-story/acceptance-criteria.json, .vcp/task/plan/manifest.json, .vcp/task/impl-result.json
OUTPUT: .vcp/task/code-review-{N}.json
NOTE: CLI executor runs cli-executor.ts with --preset {stage.provider} --model {stage.model}
      --output-file "${CLAUDE_PROJECT_DIR}/.vcp/task/code-review-{N}.json" --plugin-root "${CLAUDE_PLUGIN_ROOT}"
RESULT HANDLING: if rejected -> terminal state code_rejected (ask user)
COMPLETION: .vcp/task/code-review-{N}.json exists with status field
```

---

## Main Loop

**Execute [core-main-loop.md](../../docs/pipeline/core-main-loop.md).**

The main loop drives all stages to completion. For this pipeline:
- After completing the LAST consecutive RCA stage, the main loop triggers RCA consolidation (step 7 in the loop)
- No requirements gathering team (bug-fix pipeline does not use specialist teammates)

---

## RCA Consolidation (Inline Orchestrator Action)

**Execute [bugfix-rca-consolidation.md](../../docs/pipeline/bugfix-rca-consolidation.md).**

This is triggered from the main loop after the last consecutive RCA stage completes. The orchestrator reads all RCA output files and writes `user-story/` + `plan/` multi-file artifacts directly — NOT a task, NOT an agent call.

---

## Per-Step Phased Implementation Loop

**Execute [core-phased-implementation.md](../../docs/pipeline/core-phased-implementation.md).**

Pipeline-specific values for this loop:
- `{PIPELINE_CONTEXT_LABEL}` = "bug context"
- `{PIPELINE_IMPL_NOTE}` = "This is a bug-fix pipeline. Implement ONLY step {step} — minimal fix targeting root cause. Do NOT touch prior or future steps."
- `{PIPELINE_NOTES_SUFFIX}` = " (bug-fix pipeline)"
- `{PIPELINE_CONFIG_KEY}` = `bugfix_pipeline`

---

## Provider Routing Summary

Three provider types determine how tasks are dispatched. Full details in [core-provider-dispatch.md](../../docs/pipeline/core-provider-dispatch.md).

| Provider Type | Dispatch Method | Key Details |
|--------------|----------------|-------------|
| `subscription` | `Task(subagent_type: "dev-buddy:<agent>", model: "<model>")` | One-shot subagent, NO team_name |
| `api` | `Bash(run_in_background: true)` -> `api-task-runner.ts` | Timeout from preset, poll via TaskOutput |
| `cli` | `Task(subagent_type: "dev-buddy:cli-executor")` | Pass --preset, --model, --output-file; do NOT pass model to Task tool |

**IMPORTANT:** The bug-fix pipeline does NOT use team-based parallel execution. Never spawn teammates with `Task(team_name: ...)`. The pipeline team exists solely for task tool availability (TaskCreate/TaskUpdate/TaskList), not for spawning workers. Parallel review groups use concurrent one-shot `Task()` calls (without `team_name`), NOT team-spawned teammates.

---

## Same-Stage Re-Review Rule

When a review returns `needs_changes`: **Execute [core-same-stage-rereview.md](../../docs/pipeline/core-same-stage-rereview.md).**

Key invariant: Re-review returns to the SAME STAGE INDEX, not the next stage. The `stages[].output_file` is updated AFTER re-review completes (two-phase update) to preserve phase detection during the fix phase.

---

## Agent Reference (Default Bugfix Pipeline)

| Stage | Agent | Model | Output File |
|-------|-------|-------|-------------|
| RCA 1 | root-cause-analyst | sonnet | rca-anthropic-subscription-sonnet-1-v1.json |
| RCA 2 | root-cause-analyst | opus | rca-anthropic-subscription-opus-2-v1.json |
| Plan Review 1 | cli-executor | external (CLI) | plan-review-my-codex-preset-o3-1-v1.json |
| Implementation | implementer | sonnet | impl-result.json |
| Code Review 1 | code-reviewer | sonnet | code-review-anthropic-subscription-sonnet-1-v1.json |
| Code Review 2 | code-reviewer | opus | code-review-anthropic-subscription-opus-2-v1.json |
| Code Review 3 | cli-executor | external (CLI) | code-review-my-codex-preset-o3-3-v1.json |

For custom pipelines, derive agent reference dynamically from `stages` in pipeline-tasks.json.

---

## User Interaction

### User Provides Additional Info

1. **During RCA:** Note additional context — relay context to the running analyst (for sequential RCA) or note for the next round (for parallel RCA)
2. **During consolidation:** Incorporate into diagnosis
3. **After implementation started:** Ask user if they want to continue or restart from RCA

### Suggesting Restart

```
AskUserQuestion:
  "The bug fix has fundamental issues. Options:"
  1. "Restart from RCA"
  2. "Revise fix plan"
  3. "Continue anyway"
```

---

## Hook Behavior

Key points for this pipeline:
- `guidance-hook.ts` reads `pipeline-tasks.json.resolved_config` for dynamic phase detection; detects RCA progress by checking rca-*.json output files
- `review-validator.ts` validates reviewer outputs and can block invalid reviews

---

## Important Rules

1. **Pipeline team first, then task chain** — Create team (Step 1.3), verify tools (Step 1.4), then create task chain.
2. **Non-review stages** — Implementation always executes sequentially. RCA stages are sequential by default but support `parallel: true` for parallel execution. Review stages (plan-review, code-review) with `parallel: true` form parallel groups via fan-out/fan-in. Every non-parallel task has `blockedBy` pointing to the previous task.
3. **Data-driven task chain** — Iterate over `bugfix_pipeline` array, create one task per entry.
4. **RCA consolidation is inline** — NOT a task, NOT an agent call. The orchestrator reads all rca-*.json files and writes `user-story/` + `plan/` multi-file artifacts directly. Singleton stage names: `user-story/manifest.json`, `plan/manifest.json`, `impl-result.json`.
5. **Consolidation trigger** — After completing an rca stage, check if next stage is non-rca (or no next stage). If yes, run consolidation immediately before dispatching next task.
6. **Versioned file naming** — `{type}-{provider}-{model}-{index}-v{version}.json` (e.g., `rca-anthropic-subscription-sonnet-1-v1.json`). Re-reviews create new versioned files (append-only).
7. **Same-stage re-review (two-phase)** — After fix, SAME stage index re-reviews with a new version file. `stages[].output_file` updated AFTER re-review completes.
8. **AC verification** — Code reviewers reference `user-story/acceptance-criteria.json` for acceptance criteria verification.
9. **resolved_config snapshot** — pipeline-tasks.json includes full PipelineConfig. Hooks read this, never ~/.vcp/dev-buddy.json.
10. **max_iterations from config** — Use resolved_config.max_iterations for fix/re-review cycle limit.
11. **CLI stages pass --preset, --model, --output-file** — CLI provider stages MUST pass --preset, --model, and --output-file to cli-executor.ts.
12. **Minimal fix principle** — Fix is the smallest possible change addressing root cause. No refactoring.
13. **No teammate spawning** — The bug-fix pipeline does NOT use team-based parallel execution. Never spawn teammates with `Task(team_name: ...)`. The pipeline team exists solely for task tool availability, not for spawning workers.

---

## Emergency Controls

If stuck:

1. **Check task state:** `TaskList()` to see blocked tasks (requires pipeline team to be active)
2. **Check artifacts:** Read `.vcp/task/*.json` files to understand progress
3. **Check resolved config:** Read `resolved_config` from `.vcp/task/pipeline-tasks.json`
4. **Reset pipeline:** `bun "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.ts" reset --cwd "${CLAUDE_PROJECT_DIR}"`
