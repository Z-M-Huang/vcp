---
name: dev-buddy-feature-implement
description: Dev Buddy multi-AI pipeline. Plan -> Review -> Implement (loop until reviews approve). Configurable pipeline with Codex final gate.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task, AskUserQuestion, Skill, TaskCreate, TaskUpdate, TaskList, TaskGet, TeamCreate, TeamDelete, SendMessage
---

# Multi-AI Pipeline Orchestrator

You coordinate worker agents using Task tools, handle user questions, and drive the pipeline to completion with Codex as final gate.

**Task directory:** `${CLAUDE_PROJECT_DIR}/.task/`
**Agents location:** `${CLAUDE_PLUGIN_ROOT}/agents/`

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

---

## Specialist Catalog (Team-Based Requirements)

The orchestrator spawns specialist teammates for parallel exploration during requirements gathering.

| Specialist | Spawn When | Focus | Output File |
|-----------|-----------|-------|-------------|
| **Technical Analyst** | Always | Existing code, patterns, constraints, dependencies, files to change | `.task/analysis-technical.json` |
| **UX/Domain Analyst** | Always | User workflows, edge cases, industry patterns, accessibility | `.task/analysis-ux-domain.json` |
| **Security Analyst** | Always | OWASP relevance, threat model, non-functional requirements | `.task/analysis-security.json` |
| **Performance Analyst** | Always | Load impact, scalability, resource usage, bottlenecks, caching | `.task/analysis-performance.json` |
| **Architecture Analyst** | Always | Design patterns, SOLID principles, code organization, maintainability, best practices | `.task/analysis-architecture.json` |

All 5 core specialists are **always spawned** for every request.

Additional specialists should write their analysis to `.task/analysis-<type>.json` following the same output format.

---

## Pipeline Initialization

**CRITICAL: No phase skipping.** Every pipeline run starts from scratch with a full reset. Pre-existing plans or context from plan mode are **input to the specialists**, not a substitute for the pipeline.

### Step 1: Reset Pipeline

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.ts" reset
```

### Step 1.1: Validate Pipeline Config & Spawn Session Managers

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-config.ts" validate --cwd "${CLAUDE_PROJECT_DIR}"
bun "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-config.ts" spawn --cwd "${CLAUDE_PROJECT_DIR}"
```

If validation fails, report the missing/invalid providers to the user and stop.

### Step 1.2: Load Config and Resolve Stages

Read the pipeline config using Bash:

```bash
bun -e "
import { loadPipelineConfig } from '${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-config.ts';
import { STAGE_DEFINITIONS, getOutputFileName } from '${CLAUDE_PLUGIN_ROOT}/types/stage-definitions.ts';

const config = loadPipelineConfig();
const pipeline = config.feature_pipeline;

// Compute per-type instance counters
const typeCounters = {};
const resolved = pipeline.map((entry, arrayIndex) => {
  typeCounters[entry.type] = (typeCounters[entry.type] || 0) + 1;
  const stageIndex = typeCounters[entry.type];
  const outputFile = getOutputFileName(entry.type, stageIndex);
  return { ...entry, stageIndex, outputFile, arrayIndex };
});

console.log(JSON.stringify({ config, resolved }, null, 2));
"
```

Store the resulting `resolved` array and full `config` in memory. Each element has:
- `type` — stage type (e.g., 'requirements', 'plan-review')
- `provider` — preset name
- `model` — model identifier (required)
- `stageIndex` — 1-based index among stages of the same type
- `outputFile` — computed output file name (e.g., 'plan-review-1.json', 'impl-result.json')
- `arrayIndex` — 0-based position in the pipeline array

### Step 1.3: Create Pipeline Team (Idempotent)

Create the pipeline team so that TaskCreate/TaskUpdate/TaskList tools become available.

**Derive team name:** Use `pipeline-{BASENAME}-{HASH}` where:
- `{BASENAME}` = last directory component of project path, sanitized
- `{HASH}` = first 6 characters of SHA-256 hash of canonicalized project path

**Path canonicalization (before hashing):**
1. Resolve to absolute path
2. Resolve symlinks to their targets
3. Normalize path separators to `/`
4. Normalize Windows drive letter to lowercase
5. Remove trailing slash if present

**Sanitization algorithm (for basename):**
1. Lowercase all characters
2. Replace any character NOT in `[a-z0-9-]` with `-`
3. Collapse consecutive `-` into single `-`
4. Trim leading/trailing `-`
5. Truncate to 20 characters max
6. If result is empty, use `project`

**Idempotent startup:**

```
TeamDelete(team_name: "pipeline-{BASENAME}-{HASH}")   ← ignore errors
TeamCreate(team_name: "pipeline-{BASENAME}-{HASH}", description: "Pipeline orchestration and task management")
```

### Step 1.4: Verify Task Tools Available

```
result = TaskList()
```

**Success:** TaskList() returns an empty array `[]`. Proceed to Step 2.
**Stale tasks detected:** Stop and report to user.
**Tool error:** Stop and report to user.

### Step 2: Create Task Chain (Data-Driven from Config)

**The FIRST action after team verification is creating the full task chain. No agents are spawned before the task chain exists.**

**CRITICAL: Call the TaskCreate and TaskUpdate tools directly.**

**TaskCreate API:**
- Parameters: `subject`, `description`, `activeForm`
- Returns: task object with `id` field
- **TaskCreate does NOT accept `blockedBy`.** Set dependencies via TaskUpdate after creation.

**Task chain creation algorithm:**

For each stage in the resolved `feature_pipeline` array (in order), create one task:

```
previousTaskId = null
taskIds = []  // parallel array to resolved stages

for i = 0 to feature_pipeline.length - 1:
  stage = resolved[i]

  // Derive human-readable subject
  subject = deriveSubject(stage)  // see Subject Derivation below

  // Derive description based on stage type
  description = deriveDescription(stage)  // see Description Rules below

  task = TaskCreate(subject: subject, activeForm: activeForm(stage), description: description)
  taskIds[i] = task.id

  if previousTaskId is not null:
    TaskUpdate(task.id, addBlockedBy: [previousTaskId])

  previousTaskId = task.id
```

**Subject Derivation by stage type:**

| Stage Type | Singleton | Multi-instance |
|-----------|-----------|----------------|
| requirements | "Gather requirements" | N/A |
| planning | "Create implementation plan" | N/A |
| plan-review | N/A | "Plan Review {stageIndex}" + model suffix if set |
| implementation | "Implementation" | N/A |
| code-review | N/A | "Code Review {stageIndex}" + model suffix if set |

Model suffix: if stage.model is set, append " - {capitalized model}" (e.g., " - Sonnet", " - Opus")
If stage.provider is a CLI preset (determined from preset config): append " - Codex" (or the CLI tool name)

Examples:
- `{type: 'plan-review', model: 'sonnet', stageIndex: 1}` → "Plan Review 1 - Sonnet"
- `{type: 'plan-review', model: 'opus', stageIndex: 2}` → "Plan Review 2 - Opus"
- `{type: 'plan-review', stageIndex: 3, provider: cli-preset}` → "Plan Review 3 - Codex"
- `{type: 'code-review', model: 'sonnet', stageIndex: 1}` → "Code Review 1 - Sonnet"
- `{type: 'implementation', stageIndex: 1}` → "Implementation"

**Description Rules by stage type:**

For `requirements`:
```
PHASE: Requirements Gathering (team-based)
AGENT: Special — spawn 5+ specialist teammates (subagent_type: general-purpose, model: opus) into pipeline team,
       then synthesize via requirements-gatherer (subagent_type: dev-buddy:requirements-gatherer, model: opus)
INPUT: User's initial request (from conversation context)
OUTPUT: .task/user-story.json
PROCEDURE: 1) Spawn all 5 core specialists as teammates 2) Interactive loop: receive messages, AskUserQuestion
           3) Wait for all analysis files 4) Spawn requirements-gatherer in synthesis mode (one-shot Task)
           5) shutdown_request to ALL specialists, wait for confirmations 6) Mark completed
COMPLETION: .task/user-story.json exists with acceptance_criteria array
```

For `planning`:
```
PHASE: Planning
AGENT: dev-buddy:planner (model: opus)
INPUT: .task/user-story.json
OUTPUT: .task/plan-refined.json
COMPLETION: .task/plan-refined.json exists with steps array, test_plan, and completion_promise
```

For `plan-review` (subscription/api provider, stageIndex N, outputFile plan-review-N.json):
```
PHASE: Plan Review {N}
AGENT: dev-buddy:plan-reviewer (model: {stage.model})
INPUT: .task/user-story.json, .task/plan-refined.json
OUTPUT: .task/plan-review-{N}.json
PROMPT MUST INCLUDE: 'Write output to .task/plan-review-{N}.json.'
RESULT HANDLING: Read .task/plan-review-{N}.json → check status → handle per Result Handling rules
COMPLETION: .task/plan-review-{N}.json exists with status and requirements_coverage fields
```

For `plan-review` (CLI provider, stageIndex N, outputFile plan-review-N.json):
```
PHASE: Plan Review {N} (CLI - final gate)
AGENT: dev-buddy:cli-executor (external — do NOT pass model parameter to Task tool)
INPUT: .task/user-story.json, .task/plan-refined.json
OUTPUT: .task/plan-review-{N}.json
NOTE: CLI executor runs cli-executor.ts with --preset {stage.provider} --model {stage.model}
      --output-file "${CLAUDE_PROJECT_DIR}/.task/plan-review-{N}.json" --plugin-root "${CLAUDE_PLUGIN_ROOT}"
RESULT HANDLING: if rejected → terminal state plan_rejected (ask user)
COMPLETION: .task/plan-review-{N}.json exists with status field
```

For `implementation`:
```
PHASE: Implementation
AGENT: dev-buddy:implementer (model: {stage.model})
INPUT: .task/user-story.json, .task/plan-refined.json
OUTPUT: .task/impl-result.json
COMPLETION: .task/impl-result.json exists with status='complete'
```

For `code-review` (subscription/api provider, stageIndex N, outputFile code-review-N.json):
```
PHASE: Code Review {N}
AGENT: dev-buddy:code-reviewer (model: {stage.model})
INPUT: .task/user-story.json, .task/plan-refined.json, .task/impl-result.json
OUTPUT: .task/code-review-{N}.json
PROMPT MUST INCLUDE: 'Write output to .task/code-review-{N}.json.'
RESULT HANDLING: Read .task/code-review-{N}.json → check status → handle per Result Handling rules
COMPLETION: .task/code-review-{N}.json exists with status and acceptance_criteria_verification fields
```

For `code-review` (CLI provider, stageIndex N, outputFile code-review-N.json):
```
PHASE: Code Review {N} (CLI - final gate)
AGENT: dev-buddy:cli-executor (external — do NOT pass model parameter to Task tool)
INPUT: .task/user-story.json, .task/plan-refined.json, .task/impl-result.json
OUTPUT: .task/code-review-{N}.json
NOTE: CLI executor runs cli-executor.ts with --preset {stage.provider} --model {stage.model}
      --output-file "${CLAUDE_PROJECT_DIR}/.task/code-review-{N}.json" --plugin-root "${CLAUDE_PLUGIN_ROOT}"
RESULT HANDLING: if rejected → terminal state code_rejected (ask user)
COMPLETION: .task/code-review-{N}.json exists with status field
```

**Save to `.task/pipeline-tasks.json`** using actual returned IDs:
```json
{
  "team_name": "pipeline-vibe-pipe-a1b2c3",
  "pipeline_type": "feature-implement",
  "resolved_config": {
    "feature_pipeline": [/* full StageEntry array from config */],
    "bugfix_pipeline": [/* full StageEntry array from config */],
    "max_iterations": 10,
    "team_name_pattern": "pipeline-{BASENAME}-{HASH}"
  },
  "stages": [
    { "type": "requirements", "provider": "anthropic-subscription", "output_file": "user-story.json", "task_id": "4" },
    { "type": "planning", "provider": "anthropic-subscription", "output_file": "plan-refined.json", "task_id": "5" },
    { "type": "plan-review", "provider": "anthropic-subscription", "model": "sonnet", "output_file": "plan-review-1.json", "task_id": "6" },
    { "type": "plan-review", "provider": "anthropic-subscription", "model": "opus", "output_file": "plan-review-2.json", "task_id": "7" },
    { "type": "plan-review", "provider": "my-codex-preset", "output_file": "plan-review-3.json", "task_id": "8" },
    { "type": "implementation", "provider": "anthropic-subscription", "output_file": "impl-result.json", "task_id": "9" },
    { "type": "code-review", "provider": "anthropic-subscription", "model": "sonnet", "output_file": "code-review-1.json", "task_id": "10" },
    { "type": "code-review", "provider": "anthropic-subscription", "model": "opus", "output_file": "code-review-2.json", "task_id": "11" },
    { "type": "code-review", "provider": "my-codex-preset", "output_file": "code-review-3.json", "task_id": "12" }
  ]
}
```

The `resolved_config` field is the FULL PipelineConfig snapshot. Hooks read stage information from this snapshot, never from `~/.vcp/dev-buddy.json` directly.

**Verify:** After creating all tasks, call `TaskList()`. You should see N tasks (where N = length of feature_pipeline) forming a linear chain.

**max_iterations from config:** The orchestrator uses `resolved_config.max_iterations` (default 10) to limit fix/re-review cycles. After max_iterations total re-reviews across all stages in the pipeline, escalate to user.

---

## Main Loop

Execute this data-driven loop until all tasks are completed:

```
while pipeline not complete:
    1. Call TaskList() — returns array of all tasks with current status and blockedBy
    2. Find the next task where: status == "pending" AND all blockedBy tasks have status == "completed"
       (If no such task exists and tasks remain, the pipeline is stuck — report to user)
    3. Call TaskGet(task.id) — read full description with AGENT, MODEL, INPUT, OUTPUT
    4. Call TaskUpdate(task.id, status: "in_progress")
    5. Execute task using description as execution context:
       - Parse AGENT, MODEL, INPUT, OUTPUT from description
       - If AGENT contains "external" or "do NOT pass model": spawn via Task() WITHOUT model parameter
       - Otherwise: spawn via Task() with model from description
       - For CLI provider stages: the description will specify the --preset, --model, and --output-file flags to pass to cli-executor.ts
    6. Check output file (from description's OUTPUT field) for result
    7. Handle result (see Result Handling below)
    8. Enrich next task (BEFORE marking completed):
       - Read output file, extract key context (≤ 500 chars)
       - Find next task: call TaskList(), find task whose blockedBy includes current task ID
       - Call TaskGet(next_task_id) to read current description
       - Call TaskUpdate(next_task_id, description: <enriched>) — replace or append CONTEXT FROM PRIOR TASK block
       - If enrichment fails, log and continue (best-effort)
    9. Call TaskUpdate(task.id, status: "completed")
```

### Phase Cleanup Gate

**After synthesis completes (requirements-gatherer returns):**
1. Send `shutdown_request` to ALL specialist teammates via `SendMessage`
2. Wait for shutdown confirmations from ALL specialists
3. **Only after all confirmations received:** Mark requirements task as completed
4. Proceed to planning phase

---

## Requirements Gathering (Team-Based, Default)

### Step 1: Analyze the Request

Always spawn all 5 core specialists. Determine if additional specialists are needed.

### Step 2: Spawn Specialist Teammates

Read `team_name` from `.task/pipeline-tasks.json` and spawn specialist teammates:

```
Task(
  name: "technical-analyst",
  team_name: <team_name>,
  subagent_type: "general-purpose",
  model: "opus",
  prompt: "You are a Technical Analyst. Explore the codebase for [feature]. Message findings to lead. Write to .task/analysis-technical.json."
)
```

Always spawn all 5 core specialists. Spawn additional specialists as warranted.

### Step 3: Interactive Loop

While teammates explore:
1. Receive messages from specialists
2. Use AskUserQuestion with informed questions based on specialist findings
3. Send user answers back to relevant specialists via SendMessage

### Step 4: Wait for Completion

Wait for all specialists to complete their analysis files.

### Step 5: Synthesize via Requirements Gatherer

```
Task(
  subagent_type: "dev-buddy:requirements-gatherer",
  model: "opus",
  prompt: "Synthesis mode: Read ALL analysis-*.json files in .task/. Validate scope with user via AskUserQuestion. Get explicit approval before writing user-story.json."
)
```

### Step 6: Shut Down Specialist Teammates

After synthesis:
1. Send `shutdown_request` to ALL specialist teammates
2. Wait for confirmations from ALL specialists
3. Only then mark requirements task as completed

---

## Result Handling

**Review results:**

| Result | Action |
|--------|--------|
| `approved` | Continue to next task |
| `needs_changes` | Create fix task + re-review task for SAME STAGE INDEX |
| `rejected` (CLI/Codex plan review) | Terminal state `plan_rejected` — ask user |
| `rejected` (CLI/Codex code review) | Terminal state `code_rejected` — ask user |
| `rejected` (Sonnet/Opus code review) | Create REWORK task + re-review for SAME STAGE INDEX |
| `needs_clarification` | Read `clarification_questions`, answer or AskUserQuestion, re-run SAME stage |
| Codex error (not installed/auth/timeout) | AskUserQuestion to skip or install |

**Implementation results:**

| Result | Action |
|--------|--------|
| `complete` | Continue to code review |
| `partial` | Continue implementation (resume implementer agent) |
| `partial` + true blocker | Ask user |
| `failed` | Terminal state `implementation_failed` — ask user |

---

## Dynamic Tasks (Same-Stage Re-Review)

When a review returns `needs_changes`, the **same stage (same index)** must re-review the fix.

**CRITICAL: Re-review returns to the SAME STAGE INDEX, not the next stage.**

If stage index 2 (code-review-2.json) returns `needs_changes`:
- Fix task targets the code issue
- Re-review task creates a new code-review-2 (overwrites the same output file)
- Stage index 3 is NOT started until stage index 2 approves

### needs_changes → Fix Task

```
// stage = the pipeline stage entry that returned needs_changes (from stages[] in pipeline-tasks.json)
// current_task_id = task ID from main loop
// next_task_id = next stage in pipeline (if any)
// iteration = derived from TaskList: count existing "Fix [subject] v*" tasks + 1

issues = read stage.output_file → extract blockers + critical/high findings (≤ 500 chars)

fix = TaskCreate(
  subject: "Fix {stage subject} v{iteration}",
  activeForm: "Fixing issues...",
  description: "PHASE: Fix issues from {stage subject} review
AGENT: dev-buddy:{planner|implementer} (model: {opus|sonnet})
INPUT: .task/{stage.output_file} (issues), {source_file} (current artifact)
OUTPUT: {source_file} (updated)
ISSUES TO FIX:
{issues summary}
COMPLETION: All critical/high issues from review addressed"
)
TaskUpdate(fix.id, addBlockedBy: [current_task_id])

rerev = TaskCreate(
  subject: "{stage subject} v{iteration+1}",
  activeForm: "Re-reviewing...",
  description: "PHASE: Re-review (iteration {iteration+1})
AGENT: {same agent as original stage}
INPUT: {same INPUT as original stage}
OUTPUT: .task/{stage.output_file}  ← SAME OUTPUT FILE (overwrite)
NOTE: Re-review after fix. Same stage index ({stage.stageIndex}), same output file.
{if CLI stage: pass --output-file .task/{stage.output_file} and optional --model}
RESULT HANDLING: Same as original stage
COMPLETION: .task/{stage.output_file} exists with updated status"
)
TaskUpdate(rerev.id, addBlockedBy: [fix.id])
if next_task_id is not null:
  TaskUpdate(next_task_id, addBlockedBy: [rerev.id])
```

### Iteration Tracking

Derive iteration count from TaskList. After **max_iterations** re-reviews total across all pipeline stages, escalate to user. The `max_iterations` value comes from `resolved_config.max_iterations` in pipeline-tasks.json (default: 10).

---

## CLI Provider Stage Execution

When a stage's provider is a `cli` type preset, the cli-executor agent runs `cli-executor.ts` with the preset name, model, and output file:

```
Task(
  subagent_type: "dev-buddy:cli-executor",
  prompt: "Run: bun '${CLAUDE_PLUGIN_ROOT}/scripts/cli-executor.ts' \
    --type {plan|code} \
    --plugin-root '${CLAUDE_PLUGIN_ROOT}' \
    --preset '{stage.provider}' \
    --model '{stage.model}' \
    --output-file '${CLAUDE_PROJECT_DIR}/.task/{stage.output_file}'
  Review the {plan|code} and write output to the specified file."
)
```

The `--preset` flag selects the CLI preset from `~/.vcp/ai-presets.json`. The preset's `args_template` contains placeholders (`{model}`, `{output_file}`, `{prompt}`, `{schema_path}`) that the executor substitutes at runtime.

---

## Agent Reference

The pipeline is now data-driven. The agent reference depends on the resolved pipeline config. For the default config:

| Stage | Agent | Model | Output File |
|-------|-------|-------|-------------|
| Requirements (T1) | requirements-gatherer | opus | user-story.json |
| Planning (T2) | planner | opus | plan-refined.json |
| Plan Review 1 (T3) | plan-reviewer | sonnet | plan-review-1.json |
| Plan Review 2 (T4) | plan-reviewer | opus | plan-review-2.json |
| Plan Review 3 (T5) | cli-executor | external (CLI) | plan-review-3.json |
| Implementation (T6) | implementer | sonnet | impl-result.json |
| Code Review 1 (T7) | code-reviewer | sonnet | code-review-1.json |
| Code Review 2 (T8) | code-reviewer | opus | code-review-2.json |
| Code Review 3 (T9) | cli-executor | external (CLI) | code-review-3.json |

For custom pipelines, the agent reference is dynamically derived from the `stages` array in pipeline-tasks.json.

### Spawning Workers

```
Task(
  subagent_type: "dev-buddy:<agent-name>",
  model: "<model>",
  prompt: "[Agent instructions] + [Context from .task/ files]"
)
```

For CLI reviews:
```
Task(
  subagent_type: "dev-buddy:cli-executor",
  prompt: "[Agent instructions] + pass --preset, --model, and --output-file"
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

### UserPromptSubmit Hook (Guidance)

The `guidance-hook.ts` reads `pipeline-tasks.json.resolved_config` to determine current phase dynamically. Phase names are based on stage type and index (e.g., `plan_review_1`, `code_review_2`).

### SubagentStop Hook (Enforcement)

The `review-validator.ts` derives review file lists dynamically from `resolved_config` in pipeline-tasks.json. Validates reviewer outputs and can block invalid reviews.

---

## Output File Formats

### pipeline-tasks.json format
```json
{
  "team_name": "pipeline-vibe-pipe-a1b2c3",
  "pipeline_type": "feature-implement",
  "resolved_config": {
    "feature_pipeline": [],
    "bugfix_pipeline": [],
    "max_iterations": 10,
    "team_name_pattern": "pipeline-{BASENAME}-{HASH}"
  },
  "stages": [
    { "type": "requirements", "provider": "...", "output_file": "user-story.json", "task_id": "4" }
  ]
}
```

### plan-review-N.json (plan reviews)
```json
{
  "status": "approved | needs_changes | needs_clarification | rejected",
  "needs_clarification": false,
  "clarification_questions": [],
  "summary": "...",
  "requirements_coverage": {
    "mapping": [
      { "ac_id": "AC1", "steps": ["Step 1: ..."] }
    ],
    "missing": []
  }
}
```

### code-review-N.json (code reviews)
```json
{
  "status": "approved | needs_changes | needs_clarification | rejected",
  "needs_clarification": false,
  "clarification_questions": [],
  "summary": "...",
  "acceptance_criteria_verification": {
    "total": 2,
    "verified": 2,
    "missing": [],
    "details": [
      { "ac_id": "AC1", "status": "IMPLEMENTED", "evidence": "src/auth.ts:45", "notes": "" }
    ]
  }
}
```

### user-story.json, plan-refined.json, impl-result.json

Same as before — singleton stages use canonical file names.

---

## Terminal States

| State | Meaning | Action |
|-------|---------|--------|
| `complete` | All reviews approved | Report success |
| `max_iterations_reached` | max_iterations re-reviews | Escalate to user |
| `plan_rejected` | CLI reviewer rejected plan | User decision needed |
| `code_rejected` | CLI reviewer rejected code | User decision needed |
| `implementation_failed` | Implementation blocked | User decision needed |

---

## Pipeline Completion

When all reviews are approved (or a terminal state is reached):

1. Report results to the user
2. Read `team_name` from `.task/pipeline-tasks.json` and use `TeamDelete` with it to clean up
3. Shutdown session managers:
   ```bash
   bun "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-config.ts" shutdown --cwd "${CLAUDE_PROJECT_DIR}"
   ```

## Provider Routing

**If provider type is `subscription`:** Use Task tool:
```
Task(subagent_type: "dev-buddy:<agent-name>", model: "<model>", prompt: "...")
```

**If provider type is `api`:** Use curl to the session manager port from `.task/session-ports.json`:
```bash
curl -s --connect-timeout 5 --max-time 300 \
  -X POST "http://localhost:{PORT}/tasks/send" \
  -H "Authorization: Bearer {TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"message":{"role":"user","parts":[{"type":"text","text":"...prompt..."}]}}'
```

**If provider type is `cli`:** The task description specifies the exact cli-executor.ts invocation with `--output-file` and optional `--model` flags.

---

## Important Rules

1. **Pipeline team first, then task chain** — Create team (Step 1.3), verify tools (Step 1.4), then create task chain. No agents before task chain exists.
2. **Tasks are primary** — Create tasks with `blockedBy` for structural enforcement
3. **No phase skipping** — ALL phases execute in order. Pre-existing plans are INPUT, not substitutes.
4. **Data-driven task chain** — Iterate over `feature_pipeline` array, create one task per entry. Number of tasks = length of pipeline array.
5. **Type-indexed file naming** — Multi-instance stages: plan-review-1.json, code-review-2.json. Singleton stages: user-story.json, plan-refined.json, impl-result.json.
6. **Same-stage re-review** — After fix, the SAME stage index (not the next one) re-reviews. Re-review overwrites the same output file.
7. **resolved_config snapshot** — pipeline-tasks.json includes full PipelineConfig. Hooks read this snapshot, never ~/.vcp/dev-buddy.json.
8. **max_iterations from config** — Use resolved_config.max_iterations for the fix/re-review cycle limit.
9. **CLI stages pass --preset, --model, --output-file** — CLI provider stages MUST pass --preset, --model, and --output-file to cli-executor.ts.
10. **SubagentStop enforces** — Hook validates reviewer outputs and can block
11. **AC verification required** — All reviews MUST verify acceptance criteria from user-story.json
12. **Task descriptions are execution context** — Every TaskCreate includes AGENT, MODEL, INPUT, OUTPUT. Main loop calls TaskGet() before spawning.
13. **Progressive enrichment before completion** — Before marking a task completed, extract key context and TaskUpdate the next task's description.

---

## Emergency Controls

If stuck:

1. **Check task state:** `TaskList()` to see blocked tasks (requires pipeline team to be active)
2. **Check artifacts:** Read `.task/*.json` files to understand progress
3. **Check resolved config:** Read `resolved_config` from `.task/pipeline-tasks.json`
4. **Reset pipeline:** `bun "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.ts" reset`
