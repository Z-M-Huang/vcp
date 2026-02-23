---
name: dev-buddy-bug-fix
description: Dev Buddy bug-fix pipeline. Data-driven sequential RCA -> Consolidation -> Validation -> Implementation -> Code Reviews. Configurable pipeline.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task, AskUserQuestion, Skill, TaskCreate, TaskUpdate, TaskList, TaskGet, TeamCreate, TeamDelete
---

# Bug-Fix Pipeline Orchestrator

You coordinate worker agents using Task tools to diagnose and fix a bug. The pipeline is data-driven from the bugfix_pipeline config: sequential RCA stages, followed by implicit orchestrator consolidation, then plan-review/implementation/code-review stages.

**Task directory:** `${CLAUDE_PROJECT_DIR}/.vcp/task/`
**Agents location:** `${CLAUDE_PLUGIN_ROOT}/agents/`

---

## Architecture: Tasks + Hook Enforcement

| Component | Role |
|-----------|------|
| **Tasks** (primary) | Structural enforcement via `blockedBy`, user visibility, audit trail |
| **UserPromptSubmit Hook** (guidance) | Reads artifact files, injects phase guidance |
| **SubagentStop Hook** (enforcement) | Validates reviewer outputs, can BLOCK until requirements met |
| **Main Thread** (orchestrator) | Handles consolidation (inline, not a task), user input, dynamic tasks |

**Key insight:** `blockedBy` is *data*, not an instruction. Only claim tasks where blockedBy is empty or all dependencies completed.

**Bug-fix differentiator:** This pipeline does NOT use requirements-gatherer or planner agents. The orchestrator itself reads all RCA output files after the last consecutive RCA stage completes, consolidates findings, and writes `user-story.json` + `plan-refined.json` directly. This consolidation is an INLINE ORCHESTRATOR ACTION, not a task.

**All stages execute SEQUENTIALLY.** There is NO parallel execution, even for consecutive RCA stages. Each task has `blockedBy` pointing to the previous task.

---

## Pipeline Initialization

### Step 1: Reset Pipeline

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.ts" reset --cwd "${CLAUDE_PROJECT_DIR}"
```

### Step 1.1: Validate Pipeline Config & Spawn Session Managers

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-config.ts" validate --cwd "${CLAUDE_PROJECT_DIR}"
bun "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-config.ts" spawn --cwd "${CLAUDE_PROJECT_DIR}"
```

If validation fails, report missing/invalid providers and stop.

### Step 1.2: Load Config and Resolve Stages

Read the pipeline config using Bash:

```bash
bun -e "
import { loadPipelineConfig } from '${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-config.ts';
import { STAGE_DEFINITIONS, getOutputFileName } from '${CLAUDE_PLUGIN_ROOT}/types/stage-definitions.ts';
import { readPresets } from '${CLAUDE_PLUGIN_ROOT}/scripts/preset-utils.ts';

const config = loadPipelineConfig();
const presets = readPresets();
const pipeline = config.bugfix_pipeline;

// Compute per-type instance counters and resolve provider types
const typeCounters = {};
const resolved = pipeline.map((entry, arrayIndex) => {
  typeCounters[entry.type] = (typeCounters[entry.type] || 0) + 1;
  const stageIndex = typeCounters[entry.type];
  const outputFile = getOutputFileName(entry.type, stageIndex);
  const providerType = presets.presets[entry.provider]?.type ?? 'subscription';
  return { ...entry, stageIndex, outputFile, arrayIndex, providerType };
});

console.log(JSON.stringify({ config, resolved }, null, 2));
"
```

Store the resulting `resolved` array and full `config` in memory. Each element has:
- `type` — stage type
- `provider` — preset name
- `model` — model identifier (required)
- `stageIndex` — 1-based index among stages of the same type
- `outputFile` — computed output file name (e.g., 'rca-1.json', 'plan-review-1.json')
- `arrayIndex` — 0-based position in the pipeline array
- `providerType` — resolved provider type: `'subscription'`, `'api'`, or `'cli'`

Identify RCA stages: all consecutive `rca` type entries at the beginning of the pipeline.

### Step 1.3: Create Pipeline Team (Idempotent)

**Derive team name:** `pipeline-{BASENAME}-{HASH}` (same algorithm as feature pipeline — see feature SKILL.md)

```
TeamDelete(team_name: "pipeline-{BASENAME}-{HASH}")   ← ignore errors
TeamCreate(team_name: "pipeline-{BASENAME}-{HASH}", description: "Bug-fix pipeline orchestration and task management")
```

Store team name in `.vcp/task/pipeline-tasks.json` as `team_name` field.

### Step 1.4: Verify Task Tools Available

```
result = TaskList()
```

Success: empty array `[]`. Proceed to Step 2.
Stale tasks or tool error: Stop and report to user.

### Step 2: Create Task Chain (Data-Driven from bugfix_pipeline)

**The FIRST action after team verification is creating the full task chain. No agents are spawned before the task chain exists.**

**Task chain creation algorithm:**

For each stage in the resolved `bugfix_pipeline` array (in order), create one task. ALL tasks are sequential — each blocked by the previous.

```
previousTaskId = null
taskIds = []

for i = 0 to bugfix_pipeline.length - 1:
  stage = resolved[i]
  subject = deriveSubject(stage)        // see Subject Derivation below
  description = deriveDescription(stage) // see Description Rules below

  task = TaskCreate(subject: subject, activeForm: activeForm(stage), description: description)
  taskIds[i] = task.id

  if previousTaskId is not null:
    TaskUpdate(task.id, addBlockedBy: [previousTaskId])

  previousTaskId = task.id
```

**Subject Derivation by stage type:**

| Stage Type | Subject Format |
|-----------|----------------|
| rca | "RCA {stageIndex}" + model suffix if set (e.g., "RCA 1 - Sonnet", "RCA 2 - Opus") |
| plan-review | "Plan Review {stageIndex}" + model suffix if set |
| implementation | "Implementation" |
| code-review | "Code Review {stageIndex}" + model suffix if set |

Model suffix: if stage.model is set, append " - {capitalized model}". If CLI preset, append " - Codex".

**Description Rules by stage type:**

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
INPUT: .vcp/task/user-story.json, .vcp/task/plan-refined.json, + all rca-*.json files
OUTPUT: .vcp/task/plan-review-{N}.json
PROMPT MUST INCLUDE: 'Write output to .vcp/task/plan-review-{N}.json. Validate that the consolidated RCA diagnosis is correct and the fix plan is sound.'
RESULT HANDLING: Read .vcp/task/plan-review-{N}.json → check status → handle per Result Handling rules
COMPLETION: .vcp/task/plan-review-{N}.json exists with status and requirements_coverage fields
```

For `plan-review` (CLI provider, stageIndex N, outputFile plan-review-N.json):
```
PHASE: Plan Review {N} (CLI - RCA Validation gate)
AGENT: dev-buddy:cli-executor (external — do NOT pass model parameter to Task tool)
INPUT: .vcp/task/user-story.json, .vcp/task/plan-refined.json, + all rca-*.json files
OUTPUT: .vcp/task/plan-review-{N}.json
NOTE: CLI executor runs cli-executor.ts with --preset {stage.provider} --model {stage.model}
      --output-file "${CLAUDE_PROJECT_DIR}/.vcp/task/plan-review-{N}.json" --plugin-root "${CLAUDE_PLUGIN_ROOT}"
RESULT HANDLING: if rejected → ask user to re-examine bug or provide more context
COMPLETION: .vcp/task/plan-review-{N}.json exists with status field
```

For `implementation`:
```
PHASE: Implementation (Bug Fix)
AGENT: dev-buddy:implementer (model: {stage.model})
INPUT: .vcp/task/user-story.json, .vcp/task/plan-refined.json
OUTPUT: .vcp/task/impl-result.json
PROMPT MUST INCLUDE: This is a bug fix — make the smallest possible change that addresses the root cause.
COMPLETION: .vcp/task/impl-result.json exists with status='complete'
```

For `code-review` (subscription/api, stageIndex N, outputFile code-review-N.json):
```
PHASE: Code Review {N}
AGENT: dev-buddy:code-reviewer (model: {stage.model})
INPUT: .vcp/task/user-story.json, .vcp/task/plan-refined.json, .vcp/task/impl-result.json
OUTPUT: .vcp/task/code-review-{N}.json
PROMPT MUST INCLUDE: 'Write output to .vcp/task/code-review-{N}.json.'
RESULT HANDLING: Read .vcp/task/code-review-{N}.json → check status → handle per Result Handling rules
COMPLETION: .vcp/task/code-review-{N}.json exists with status and acceptance_criteria_verification fields
```

For `code-review` (CLI provider, stageIndex N, outputFile code-review-N.json):
```
PHASE: Code Review {N} (CLI - final gate)
AGENT: dev-buddy:cli-executor (external — do NOT pass model parameter to Task tool)
INPUT: .vcp/task/user-story.json, .vcp/task/plan-refined.json, .vcp/task/impl-result.json
OUTPUT: .vcp/task/code-review-{N}.json
NOTE: CLI executor runs cli-executor.ts with --preset {stage.provider} --model {stage.model}
      --output-file "${CLAUDE_PROJECT_DIR}/.vcp/task/code-review-{N}.json" --plugin-root "${CLAUDE_PLUGIN_ROOT}"
RESULT HANDLING: if rejected → terminal state code_rejected (ask user)
COMPLETION: .vcp/task/code-review-{N}.json exists with status field
```

**Save to `.vcp/task/pipeline-tasks.json`**:
```json
{
  "team_name": "pipeline-myproject-a1b2c3",
  "pipeline_type": "bug-fix",
  "resolved_config": {
    "feature_pipeline": [],
    "bugfix_pipeline": [],
    "max_iterations": 10,
    "team_name_pattern": "pipeline-{BASENAME}-{HASH}"
  },
  "stages": [
    { "type": "rca", "provider": "anthropic-subscription", "providerType": "subscription", "model": "sonnet", "output_file": "rca-1.json", "task_id": "4" },
    { "type": "rca", "provider": "anthropic-subscription", "providerType": "subscription", "model": "opus", "output_file": "rca-2.json", "task_id": "5" },
    { "type": "plan-review", "provider": "my-codex-preset", "providerType": "cli", "output_file": "plan-review-1.json", "task_id": "6" },
    { "type": "implementation", "provider": "anthropic-subscription", "providerType": "subscription", "model": "sonnet", "output_file": "impl-result.json", "task_id": "7" },
    { "type": "code-review", "provider": "anthropic-subscription", "providerType": "subscription", "model": "sonnet", "output_file": "code-review-1.json", "task_id": "8" },
    { "type": "code-review", "provider": "anthropic-subscription", "providerType": "subscription", "model": "opus", "output_file": "code-review-2.json", "task_id": "9" },
    { "type": "code-review", "provider": "my-codex-preset", "providerType": "cli", "output_file": "code-review-3.json", "task_id": "10" }
  ]
}
```

**Verify:** After creating all tasks, call `TaskList()`. You should see N tasks (where N = length of bugfix_pipeline) forming a LINEAR SEQUENTIAL CHAIN. ALL tasks are blocked — no parallel execution.

---

## Main Loop

Execute this data-driven loop until all tasks are completed:

```
while pipeline not complete:
    1. Call TaskList() — returns array of all tasks with current status and blockedBy
    2. Find the next task where: status == "pending" AND all blockedBy tasks have status == "completed"
       (Only one task will be unblocked at a time — all tasks are sequential)
    3. Call TaskGet(task.id) — read full description
    4. Call TaskUpdate(task.id, status: "in_progress")
    5. Execute task — ROUTE BY PROVIDER TYPE (from resolved stages, NOT from description alone):
       a. Look up current task in pipeline-tasks.json stages array (match by task_id)
       b. Read the stage's `providerType` field to determine routing:

       **If providerType is 'subscription':**
         Task(subagent_type: "dev-buddy:<agent>", model: "<model>", prompt: "...")
         // NO team_name. One-shot subagent.

       **If providerType is 'api':**
         Read .vcp/task/session-ports.json → find entry where preset_name matches stage.provider
         curl -s --connect-timeout 5 --max-time 300 \
           -X POST "http://localhost:{PORT}/tasks/send" \
           -H "Authorization: Bearer {TOKEN}" \
           -H "Content-Type: application/json" \
           -d '{"message":{"role":"user","parts":[{"type":"text","text":"<prompt>"}]}}'
         // The session manager runs a V2 Agent SDK session with Read/Write/Edit/Bash — it CAN modify files.

       **If providerType is 'cli':**
         Task(subagent_type: "dev-buddy:cli-executor", prompt: "Run cli-executor.ts with --preset, --model, --output-file")
         // Do NOT pass model parameter to Task tool. Model is passed via --model flag to cli-executor.ts.

       - Parse AGENT, MODEL, INPUT, OUTPUT from task description for the prompt content
       - **NEVER use team_name when spawning agents.** All stages are one-shot sequential subagents, NOT teammates.
    6. Check output file for result
    7. *** RCA CONSOLIDATION CHECK (inline, before handling result) ***
       After completing a task, check if:
         (a) The just-completed task is of type 'rca' (check stages[i].type === 'rca')
         (b) The NEXT task in the pipeline is NOT of type 'rca' (or there is no next task)
       If BOTH conditions are true: run the Orchestrator Consolidation step BEFORE dispatching next task.
       See "Orchestrator Consolidation" section below.
    8. Handle result (see Result Handling below)
    9. Enrich next task (before marking completed — best-effort, see Progressive Enrichment)
   10. Call TaskUpdate(task.id, status: "completed")
```

### RCA Consolidation Trigger Detection

After each task completion, check the `stages` array in `pipeline-tasks.json`:

```
completedStageIndex = find index in stages where task_id matches current task
completedStage = stages[completedStageIndex]
nextStage = stages[completedStageIndex + 1]  // may be null if last

if completedStage.type === 'rca' AND (nextStage === null OR nextStage.type !== 'rca'):
    → Run Orchestrator Consolidation NOW (inline, before dispatching next task)
    → Write user-story.json and plan-refined.json
    → Then proceed to next task
```

This trigger correctly handles any number of consecutive RCA stages (not just 2). It fires after the LAST RCA in a consecutive sequence.

---

## Orchestrator Consolidation (Inline Action, NOT a Task)

This is an INLINE ORCHESTRATOR ACTION. It is NOT a task, NOT delegated to an agent. The orchestrator reads all RCA output files and writes the consolidated diagnosis directly.

### Step 1: Read All RCA Outputs

Find all rca-*.json files from `stages` array entries with `type === 'rca'`:
```
rcaFiles = stages.filter(s => s.type === 'rca').map(s => s.output_file)
// e.g., ['rca-1.json', 'rca-2.json']
Read each: Read(".vcp/task/rca-1.json"), Read(".vcp/task/rca-2.json"), ...
```

### Step 2: Consolidate Findings

**If all RCAs agree on root cause** (same file, same general diagnosis):
- Use the shared diagnosis — high confidence
- Take the most detailed explanation
- Merge affected files, fix constraints, and impact analysis from all RCAs

**If RCAs disagree** (different root files, different categories):
- Present diagnoses to user via AskUserQuestion:
  ```
  "The RCA analyses disagree on the root cause:
   RCA 1 (Sonnet): [summary] in [file]:[line]
   RCA 2 (Opus): [summary] in [file]:[line]
   Which diagnosis is more likely correct?"
  Options: Each RCA's diagnosis, or "All may be contributing factors"
  ```
- Use user's chosen diagnosis, or merge if "all contributing"

### Step 3: Write user-story.json

Write `.vcp/task/user-story.json` with bug-fix acceptance criteria. **This file name is FIXED — not configurable:**

```json
{
  "id": "story-YYYYMMDD-HHMMSS",
  "title": "Fix: [Bug title from RCA]",
  "pipeline_type": "bug-fix",
  "requirements": {
    "root_cause": "[Consolidated root cause summary]",
    "root_file": "[path/to/file.ts]",
    "root_line": 42
  },
  "acceptance_criteria": [
    { "id": "AC1", "description": "Bug is resolved — expected behavior is restored" },
    { "id": "AC2", "description": "Regression test covers the exact bug scenario" },
    { "id": "AC3", "description": "No existing tests are broken by the fix" },
    { "id": "AC4", "description": "Root cause is addressed, not just symptoms patched" }
  ],
  "scope": {
    "affected_files": ["[merged from all RCAs]"],
    "blast_radius": "[from RCA impact analysis]",
    "fix_constraints": {
      "must_preserve": ["[merged from all RCAs]"],
      "safe_to_change": ["[merged from all RCAs]"]
    }
  },
  "implementation": { "max_iterations": 10 }
}
```

### Step 4: Write plan-refined.json

Write `.vcp/task/plan-refined.json` with a minimal fix plan. **This file name is FIXED — not configurable:**

```json
{
  "id": "plan-YYYYMMDD-HHMMSS",
  "title": "Fix: [Bug title]",
  "pipeline_type": "bug-fix",
  "technical_approach": {
    "root_cause": "[Consolidated root cause]",
    "fix_strategy": "[From recommended_approach of chosen RCA]",
    "complexity": "[From estimated_complexity]"
  },
  "steps": [
    { "description": "Write regression test that reproduces the bug", "files": ["path/to/test.ts"] },
    { "description": "Apply minimal fix to [root_file] at line [root_line]", "files": ["path/to/file.ts"] },
    { "description": "Verify regression test passes, all existing tests pass", "files": [] }
  ],
  "test_plan": {
    "commands": ["npm test", "npm run lint"],
    "regression_test": "Specific regression test to write",
    "success_pattern": "All tests pass",
    "failure_pattern": "FAIL|ERROR"
  },
  "risk_assessment": {
    "blast_radius": "[from RCA]",
    "regression_risk": "[from RCA]",
    "mitigation": "Regression test covers the exact bug scenario"
  },
  "completion_promise": "<promise>IMPLEMENTATION_COMPLETE</promise>"
}
```

**Key principle:** The fix plan must be the **smallest possible change** that addresses the root cause. No refactoring, no cleanup beyond the fix itself.

### Step 5: Continue Main Loop

After writing both files, the consolidation is complete. Continue the main loop — the next task (plan-review or implementation, depending on config) is now unblocked.

---

## Progressive Enrichment

Before marking each task completed, read its output file, extract key context (≤ 500 chars), and update the next task's description via TaskUpdate.

**Enrichment Update Rule:** Read next task's description via TaskGet(). If it already contains a "CONTEXT FROM PRIOR TASK:" block, replace it. Otherwise, append. Only one context block per task.

| Completed Stage | Enrich Next Stage | Extract From Output |
|----------------|-------------------|---------------------|
| rca-N.json | rca-(N+1).json or plan-review-1.json | root cause summary, confidence, affected files |
| plan-review-N.json | implementation or next plan-review | validation status, concerns, AC count |
| impl-result.json | code-review-1.json | files modified/created, test results |
| code-review-N.json | code-review-(N+1).json | status, findings, AC verified/total |

---

## Result Handling

**Review results:**

| Result | Action |
|--------|--------|
| `approved` | Continue to next task |
| `needs_changes` | Create fix task + re-review task for SAME STAGE INDEX |
| `rejected` (CLI/Codex plan review) | Ask user to provide more context or re-examine bug |
| `rejected` (CLI/Codex code review) | Terminal state `code_rejected` — ask user |
| `rejected` (Sonnet/Opus code review) | Create REWORK task + re-review for SAME STAGE INDEX |
| `needs_clarification` | Read questions, answer or AskUserQuestion, re-run SAME stage |
| Codex error | AskUserQuestion to skip or install |

**Implementation results:**

| Result | Action |
|--------|--------|
| `complete` | Continue to code review |
| `partial` | Continue implementation |
| `partial` + true blocker | Ask user |
| `failed` | Terminal state `implementation_failed` — ask user |

---

## Dynamic Tasks (Same-Stage Re-Review)

When a review returns `needs_changes`, the **same stage (same index)** re-reviews the fix.

**CRITICAL: Re-review returns to the SAME STAGE INDEX, not the next stage.** If code-review-2.json returns `needs_changes`:
- Fix task targets the code issue
- Re-review targets stage index 2 (same output file code-review-2.json)
- Stage index 3 is NOT started until stage index 2 approves

### needs_changes → Fix Task

```
// stage = the pipeline stage entry that returned needs_changes
// current_task_id = from main loop
// next_task_id = next stage in pipeline (if any)
// iteration = from TaskList: count existing "Fix {stage subject} v*" tasks + 1

fix = TaskCreate(
  subject: "Fix {stage subject} v{iteration}",
  description: "...ISSUES TO FIX: {issues}..."
)
TaskUpdate(fix.id, addBlockedBy: [current_task_id])

rerev = TaskCreate(
  subject: "{stage subject} v{iteration+1}",
  description: "...SAME OUTPUT FILE: .vcp/task/{stage.output_file}
               {if CLI stage: --output-file .vcp/task/{stage.output_file}}..."
)
TaskUpdate(rerev.id, addBlockedBy: [fix.id])
if next_task_id is not null:
  TaskUpdate(next_task_id, addBlockedBy: [rerev.id])
```

### Iteration Tracking

After **max_iterations** re-reviews total across all pipeline stages (from `resolved_config.max_iterations`), escalate to user.

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
    --output-file '${CLAUDE_PROJECT_DIR}/.vcp/task/{stage.output_file}'
  Review the {plan|code} and write output to the specified file."
  // Do NOT add team_name or name. One-shot subagent, NOT a teammate.
)
```

---

## Agent Reference (Default Bugfix Pipeline)

| Stage | Agent | Model | Output File |
|-------|-------|-------|-------------|
| RCA 1 | root-cause-analyst | sonnet | rca-1.json |
| RCA 2 | root-cause-analyst | opus | rca-2.json |
| Plan Review 1 | cli-executor | external (CLI) | plan-review-1.json |
| Implementation | implementer | sonnet | impl-result.json |
| Code Review 1 | code-reviewer | sonnet | code-review-1.json |
| Code Review 2 | code-reviewer | opus | code-review-2.json |
| Code Review 3 | cli-executor | external (CLI) | code-review-3.json |

For custom pipelines, derive agent reference dynamically from `stages` in pipeline-tasks.json.

---

## User Interaction

### User Provides Additional Info

1. **During RCA:** Note additional context — each RCA is sequential, so you can relay context to the running analyst
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

### UserPromptSubmit Hook (Guidance)

The `guidance-hook.ts` reads `pipeline-tasks.json.resolved_config` to determine current phase. For bug-fix pipelines, it detects RCA progress by checking how many rca-*.json output files exist.

### SubagentStop Hook (Enforcement)

The `review-validator.ts` derives review file lists dynamically from `resolved_config` in pipeline-tasks.json. Validates reviewer outputs and can block invalid reviews.

---

## Important Rules

1. **Pipeline team first, then task chain** — Create team (Step 1.3), verify tools (Step 1.4), then create task chain.
2. **All stages sequential** — NO parallel execution, even for RCA stages. Every task has `blockedBy` pointing to the previous task.
3. **Data-driven task chain** — Iterate over `bugfix_pipeline` array, create one task per entry.
4. **RCA consolidation is inline** — NOT a task, NOT an agent call. The orchestrator reads all rca-*.json files and writes user-story.json + plan-refined.json directly. Fixed file names.
5. **Consolidation trigger** — After completing an rca stage, check if next stage is non-rca (or no next stage). If yes, run consolidation immediately before dispatching next task.
6. **Type-indexed file naming** — rca-1.json, rca-2.json, plan-review-1.json, code-review-1.json, etc.
7. **Same-stage re-review** — After fix, SAME stage index re-reviews (not the next stage).
8. **resolved_config snapshot** — pipeline-tasks.json includes full PipelineConfig. Hooks read this, never ~/.vcp/dev-buddy.json.
9. **max_iterations from config** — Use resolved_config.max_iterations for fix/re-review cycle limit.
10. **CLI stages pass --preset, --model, --output-file** — CLI provider stages MUST pass --preset, --model, and --output-file to cli-executor.ts.
11. **Minimal fix principle** — Fix is the smallest possible change addressing root cause. No refactoring.
12. **No teammate spawning** — The bug-fix pipeline does NOT use team-based parallel execution. ALL stages use sequential one-shot `Task()` calls WITHOUT `team_name`. Never spawn teammates with `Task(team_name: ...)`. The pipeline team exists solely for task tool availability (TaskCreate/TaskUpdate/TaskList), not for spawning workers.

---

## Terminal States

| State | Meaning | Action |
|-------|---------|--------|
| `complete` | All reviews approved | Report success |
| `max_iterations_reached` | max_iterations re-reviews | Escalate to user |
| `code_rejected` | CLI reviewer rejected code | User decision needed |
| `implementation_failed` | Implementation blocked | User decision needed |

---

## Pipeline Completion

1. Report results to the user
2. Read `team_name` from `.vcp/task/pipeline-tasks.json` and use `TeamDelete` to clean up
3. Shutdown session managers:
   ```bash
   bun "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-config.ts" shutdown --cwd "${CLAUDE_PROJECT_DIR}"
   ```

## Provider Routing

**If providerType is `subscription`:** Use Task tool (NO `team_name` — one-shot subagent):
```
Task(subagent_type: "dev-buddy:<agent-name>", model: "<model>", prompt: "...")
// Do NOT add team_name or name parameters. This is a one-shot subagent, NOT a teammate.
```

**If providerType is `api`:** Use curl to the session manager port from `.vcp/task/session-ports.json`:
```bash
curl -s --connect-timeout 5 --max-time 300 \
  -X POST "http://localhost:{PORT}/tasks/send" \
  -H "Authorization: Bearer {TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"message":{"role":"user","parts":[{"type":"text","text":"...prompt..."}]}}'
```
The session manager runs a V2 Agent SDK session with Read/Write/Edit/Bash — it CAN modify files on disk. API providers support ALL stage types including implementation and RCA.

**If providerType is `cli`:** The task description specifies the exact cli-executor.ts invocation with `--output-file` and optional `--model` flags.

---

## Emergency Controls

1. **Check task state:** `TaskList()`
2. **Check artifacts:** Read `.vcp/task/*.json` files
3. **Check resolved config:** Read `resolved_config` from `.vcp/task/pipeline-tasks.json`
4. **Reset pipeline:** `bun "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.ts" reset --cwd "${CLAUDE_PROJECT_DIR}"`
