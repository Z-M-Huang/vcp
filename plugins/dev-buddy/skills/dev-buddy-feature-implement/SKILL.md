---
name: dev-buddy-feature-implement
description: Dev Buddy multi-AI pipeline. Plan -> Review -> Implement (loop until reviews approve). Configurable pipeline with Codex final gate.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task, TaskOutput, AskUserQuestion, Skill, TaskCreate, TaskUpdate, TaskList, TaskGet, TeamCreate, TeamDelete, SendMessage
---

# Multi-AI Pipeline Orchestrator

You coordinate worker agents using Task tools, handle user questions, and drive the pipeline to completion with Codex as final gate.

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

### Execution Markers

Steps are annotated with execution markers:

| Marker | Meaning |
|--------|---------|
| `[PARALLEL OK]` | Multiple independent tool calls MAY be issued in a single response |
| `[INTERACTIVE LOOP]` | Sequential message relay loop. Each iteration follows a strict order: (1) receive messages, (2) AskUserQuestion, (3) WAIT for answer, (4) SendMessage. These calls are sequential within each iteration — NOT parallel. Only message-related calls allowed (AskUserQuestion, SendMessage, receiving messages). No Bash, no Task, no file operations during the loop. |
| *(no marker)* | Strictly ONE tool call, WAIT, verify, then next step |

`[PARALLEL OK]` applies to: Step 2 (spawn specialists), Main Loop parallel execution (same parallel_group_id tasks).
`[INTERACTIVE LOOP]` applies only to Step 3 (interactive exploration).

---

## Pipeline Variables

These values are used by shared pipeline procedures referenced below:

| Variable | Value |
|----------|-------|
| `{PIPELINE_TYPE}` | `feature-implement` |
| `{PIPELINE_COMMAND}` | `/dev-buddy-feature-implement` |
| `{PIPELINE_CONFIG_KEY}` | `feature_pipeline` |

---

## Architecture: Tasks + Hook Enforcement

This pipeline uses a **task-based approach with hook enforcement**:

| Component | Role |
|-----------|------|
| **Tasks** (primary) | Structural enforcement via `blockedBy`, user visibility, audit trail |
| **UserPromptSubmit Hook** (guidance) | Reads artifact files, injects phase guidance |
| **SubagentStop Hook** (enforcement) | Validates reviewer outputs, can BLOCK until requirements met |
| **Main Thread** (orchestrator) | Handles user input, creates dynamic tasks, can restart/kick back |

**Key insight:** `blockedBy` is *data*, not an instruction. `TaskList()` shows all tasks with their `blockedBy` fields — only claim tasks where blockedBy is empty or all dependencies are completed.

**Stages execute SEQUENTIALLY by default.** Review stages (plan-review, code-review) can be configured for parallel execution via the `parallel` flag on each StageEntry. Non-review stages always run sequentially. Each task has `blockedBy` dependencies enforced via TaskUpdate.

---

## Pipeline Initialization

**CRITICAL: No phase skipping.** Exception: Resume path (Step 0) skips already-completed stages by creating pre-completed tasks. Pre-existing plans or context from plan mode are **input to the specialists**, not a substitute for the pipeline.

### Step 0: Resume Detection

**Execute [core-init-resume.md](../../docs/pipeline/core-init-resume.md).**

### Steps 1-2: Fresh Initialization and Task Chain

**Execute [core-task-chain.md](../../docs/pipeline/core-task-chain.md).**

---

## Task Chain: Description Rules by Stage Type

For `requirements`:
```
PHASE: Requirements Gathering (team-based)
AGENT: Special — spawn 5+ specialist teammates (subagent_type: general-purpose, model: opus) into pipeline team,
       then synthesize via requirements-gatherer (subagent_type: dev-buddy:requirements-gatherer, model: opus)
INPUT: User's initial request (from conversation context)
OUTPUT: .vcp/task/user-story/manifest.json
PROCEDURE: 1) Spawn all 5 core specialists as teammates 2) Interactive loop: receive messages, AskUserQuestion
           3) Wait for all analysis files 4) Spawn requirements-gatherer in synthesis mode (one-shot Task)
           5) shutdown_request to ALL specialists, wait ~60s, retry once if needed, then proceed 6) Mark completed
COMPLETION: .vcp/task/user-story/manifest.json exists with ac_count field
```

For `planning`:
```
PHASE: Planning
AGENT: dev-buddy:planner (model: opus)
INPUT: .vcp/task/user-story/ (all sections)
OUTPUT: .vcp/task/plan/manifest.json
COMPLETION: .vcp/task/plan/manifest.json exists with step_count field and completion_promise
```

For `plan-review` (subscription/api provider, stageIndex N, outputFile plan-review-N.json):
```
PHASE: Plan Review {N}
AGENT: dev-buddy:plan-reviewer (model: {stage.model})
INPUT: .vcp/task/user-story/acceptance-criteria.json, .vcp/task/user-story/scope.json, .vcp/task/plan/manifest.json (then read step files)
OUTPUT: .vcp/task/plan-review-{N}.json
PROMPT MUST INCLUDE: 'Write output to .vcp/task/plan-review-{N}.json.'
RESULT HANDLING: Read .vcp/task/plan-review-{N}.json -> check status -> handle per Result Handling rules
COMPLETION: .vcp/task/plan-review-{N}.json exists with status and requirements_coverage fields
```

For `plan-review` (CLI provider, stageIndex N, outputFile plan-review-N.json):
```
PHASE: Plan Review {N} (CLI - final gate)
AGENT: dev-buddy:cli-executor (external — do NOT pass model parameter to Task tool)
INPUT: .vcp/task/user-story/acceptance-criteria.json, .vcp/task/user-story/scope.json, .vcp/task/plan/manifest.json (then read step files)
OUTPUT: .vcp/task/plan-review-{N}.json
NOTE: CLI executor runs cli-executor.ts with --preset {stage.provider} --model {stage.model}
      --output-file "${CLAUDE_PROJECT_DIR}/.vcp/task/plan-review-{N}.json" --plugin-root "${CLAUDE_PLUGIN_ROOT}"
RESULT HANDLING: if rejected -> terminal state plan_rejected (ask user)
COMPLETION: .vcp/task/plan-review-{N}.json exists with status field
```

For `implementation`:
```
PHASE: Implementation
AGENT: dev-buddy:implementer (model: {stage.model})
INPUT: .vcp/task/user-story/ (all sections), .vcp/task/plan/manifest.json (then read step files)
OUTPUT: .vcp/task/impl-result.json
COMPLETION: .vcp/task/impl-result.json exists with status='complete'
```

For `code-review` (subscription/api provider, stageIndex N, outputFile code-review-N.json):
```
PHASE: Code Review {N}
AGENT: dev-buddy:code-reviewer (model: {stage.model})
INPUT: .vcp/task/user-story/acceptance-criteria.json, .vcp/task/user-story/scope.json, .vcp/task/plan/manifest.json (then read step files), .vcp/task/impl-result.json
OUTPUT: .vcp/task/code-review-{N}.json
PROMPT MUST INCLUDE: 'Write output to .vcp/task/code-review-{N}.json.'
RESULT HANDLING: Read .vcp/task/code-review-{N}.json -> check status -> handle per Result Handling rules
COMPLETION: .vcp/task/code-review-{N}.json exists with status and acceptance_criteria_verification fields
```

For `code-review` (CLI provider, stageIndex N, outputFile code-review-N.json):
```
PHASE: Code Review {N} (CLI - final gate)
AGENT: dev-buddy:cli-executor (external — do NOT pass model parameter to Task tool)
INPUT: .vcp/task/user-story/acceptance-criteria.json, .vcp/task/user-story/scope.json, .vcp/task/plan/manifest.json (then read step files), .vcp/task/impl-result.json
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
- Requirements stage triggers the team-based requirements gathering procedure below
- No RCA consolidation check (feature pipeline has no RCA stages)

---

## Requirements Gathering (Team-Based)

**Execute [feature-requirements-team.md](../../docs/pipeline/feature-requirements-team.md).**

---

## Per-Step Phased Implementation Loop

**Execute [core-phased-implementation.md](../../docs/pipeline/core-phased-implementation.md).**

Pipeline-specific values for this loop:
- `{PIPELINE_CONTEXT_LABEL}` = "feature context"
- `{PIPELINE_IMPL_NOTE}` = "Implement ONLY step {step}. Do NOT touch prior or future steps."
- `{PIPELINE_NOTES_SUFFIX}` = "" (empty)
- `{PIPELINE_CONFIG_KEY}` = `feature_pipeline`

---

## Provider Routing Summary

Three provider types determine how tasks are dispatched. Full details in [core-provider-dispatch.md](../../docs/pipeline/core-provider-dispatch.md).

| Provider Type | Dispatch Method | Key Details |
|--------------|----------------|-------------|
| `subscription` | `Task(subagent_type: "dev-buddy:<agent>", model: "<model>")` | One-shot subagent, NO team_name |
| `api` | `Bash(run_in_background: true)` -> `api-task-runner.ts` | Timeout from preset, poll via TaskOutput |
| `cli` | `Task(subagent_type: "dev-buddy:cli-executor")` | Pass --preset, --model, --output-file; do NOT pass model to Task tool |

**IMPORTANT:** Do NOT use `team_name` when spawning worker agents for pipeline stages. Only the requirements gathering phase uses `Task(team_name: ...)` for specialist teammates. All other phases spawn one-shot subagents without `team_name`. Parallel review groups dispatch multiple one-shot `Task()` calls concurrently (not via team spawning).

---

## Same-Stage Re-Review Rule

When a review returns `needs_changes`: **Execute [core-same-stage-rereview.md](../../docs/pipeline/core-same-stage-rereview.md).**

Key invariant: Re-review returns to the SAME STAGE INDEX, not the next stage. The `stages[].output_file` is updated AFTER re-review completes (two-phase update) to preserve phase detection during the fix phase.

---

## Agent Reference (Default Feature Pipeline)

| Stage | Agent | Model | Output File |
|-------|-------|-------|-------------|
| Requirements (T1) | requirements-gatherer | opus | user-story/manifest.json |
| Planning (T2) | planner | opus | plan/manifest.json |
| Plan Review 1 (T3) | plan-reviewer | sonnet | plan-review-anthropic-subscription-sonnet-1-v1.json |
| Plan Review 2 (T4) | plan-reviewer | opus | plan-review-anthropic-subscription-opus-2-v1.json |
| Plan Review 3 (T5) | cli-executor | external (CLI) | plan-review-my-codex-preset-o3-3-v1.json |
| Implementation (T6) | implementer | sonnet | impl-result.json |
| Code Review 1 (T7) | code-reviewer | sonnet | code-review-anthropic-subscription-sonnet-1-v1.json |
| Code Review 2 (T8) | code-reviewer | opus | code-review-anthropic-subscription-opus-2-v1.json |
| Code Review 3 (T9) | cli-executor | external (CLI) | code-review-my-codex-preset-o3-3-v1.json |

For custom pipelines, the agent reference is dynamically derived from the `stages` array in pipeline-tasks.json.

### Spawning Workers (One-Shot Subagents — NO team_name)

```
Task(
  subagent_type: "dev-buddy:<agent-name>",
  model: "<model>",
  prompt: "[Agent instructions] + [Context from .vcp/task/ files]"
  // Do NOT add team_name or name. These are one-shot subagents, NOT teammates.
)
```

---

## User Interaction

### User Provides Additional Info

If user adds requirements mid-pipeline:
1. **During requirements/planning:** Incorporate and continue
2. **After plan review started:** Ask user if they want to continue, kick back to planning, or restart

### Suggesting Restart

```
AskUserQuestion:
  "The plan has fundamental issues. Options:"
  1. "Restart from requirements"
  2. "Revise plan"
  3. "Continue anyway"
```

---

## Hook Behavior

See CLAUDE.md § "Hook Enforcement" for hook details. Key points for this pipeline:
- `guidance-hook.ts` reads `pipeline-tasks.json.resolved_config` for dynamic phase detection
- `review-validator.ts` validates reviewer outputs and can block invalid reviews

---

## Important Rules

1. **Pipeline team first, then task chain** — Create team (Step 1.3), verify tools (Step 1.4), then create task chain. No agents before task chain exists.
2. **Tasks are primary** — Create tasks with `blockedBy` for structural enforcement
3. **No phase skipping** — ALL phases execute in order. Exception: Resume path (Step 0) skips already-completed stages by creating pre-completed tasks. Pre-existing plans are INPUT, not substitutes.
4. **Data-driven task chain** — Iterate over `feature_pipeline` array, create one task per entry. Number of tasks = length of pipeline array.
5. **Versioned file naming** — Multi-instance stages: `{type}-{provider}-{model}-{index}-v{version}.json`. Singleton stages: `user-story/manifest.json`, `plan/manifest.json`, `impl-result.json`. Re-reviews create new versioned files (append-only).
6. **Same-stage re-review (two-phase)** — After fix, the SAME stage index re-reviews with a new version file. `stages[].output_file` is updated AFTER re-review completes (not before) to preserve phase detection during fix phase.
7. **resolved_config snapshot** — pipeline-tasks.json includes full PipelineConfig. Hooks read this snapshot, never ~/.vcp/dev-buddy.json.
8. **max_iterations from config** — Use resolved_config.max_iterations for the fix/re-review cycle limit.
9. **CLI stages pass --preset, --model, --output-file** — CLI provider stages MUST pass --preset, --model, and --output-file to cli-executor.ts.
10. **SubagentStop enforces** — Hook validates reviewer outputs and can block
11. **AC verification required** — All reviews MUST verify acceptance criteria from user-story/acceptance-criteria.json
12. **Task descriptions are execution context** — Every TaskCreate includes AGENT, MODEL, INPUT, OUTPUT. Main loop calls TaskGet() before spawning.
13. **Progressive enrichment before completion** — Before marking a task completed, extract key context and TaskUpdate the next task's description.
14. **Team-based execution is ONLY for requirements gathering** — Spawn specialist teammates (via `Task(team_name: ...)` and `SendMessage`) ONLY during the requirements gathering phase. ALL other phases use one-shot `Task()` calls WITHOUT `team_name`.
15. **Orchestrator executes sequentially** — Each step is one response turn unless marked `[PARALLEL OK]` or `[INTERACTIVE LOOP]`. Make the tool call, WAIT for the result, VERIFY, then proceed.
16. **NEVER auto-recover from failures** — If any operation fails, STOP and escalate to user via AskUserQuestion. The user decides recovery. Never "proceed with what we have" without asking.
17. **Verification gates are mandatory** — Step 2.1 (spawn) and Step 4.1 (completion) MUST execute. Do NOT skip them.
18. **User interruption means FULL STOP** — If the user sends a message mid-pipeline, stop current operations, respond to user, wait for explicit instruction to continue.

---

## Emergency Controls

If stuck:

1. **Check task state:** `TaskList()` to see blocked tasks (requires pipeline team to be active)
2. **Check artifacts:** Read `.vcp/task/*.json` files to understand progress
3. **Check resolved config:** Read `resolved_config` from `.vcp/task/pipeline-tasks.json`
4. **Reset pipeline:** `bun "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.ts" reset --cwd "${CLAUDE_PROJECT_DIR}"`
