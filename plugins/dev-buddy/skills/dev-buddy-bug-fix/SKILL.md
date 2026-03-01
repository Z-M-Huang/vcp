---
name: dev-buddy-bug-fix
description: Dev Buddy bug-fix pipeline. Data-driven sequential RCA -> Consolidation -> Validation -> Implementation -> Code Reviews. Configurable pipeline.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task, TaskOutput, AskUserQuestion, Skill, TaskCreate, TaskUpdate, TaskList, TaskGet, TeamCreate, TeamDelete
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

**Bug-fix differentiator:** This pipeline does NOT use requirements-gatherer or planner agents. The orchestrator itself reads all RCA output files after the last consecutive RCA stage completes, consolidates findings, and writes the `user-story/` + `plan/` multi-file artifacts directly. This consolidation is an INLINE ORCHESTRATOR ACTION, not a task.

**Stages execute SEQUENTIALLY by default.** Review stages (plan-review, code-review) can be configured for parallel execution via the `parallel` flag on each StageEntry. Non-review stages (rca, implementation) always run sequentially. Each task has `blockedBy` dependencies enforced via TaskUpdate.

---

## Pipeline Initialization

### Step 0: Resume Detection

Check if a previous pipeline run exists:

```bash
bun -e "
  const fs = require('fs');
  const p = '${CLAUDE_PROJECT_DIR}/.vcp/task/pipeline-tasks.json';
  if (!fs.existsSync(p)) { console.log(JSON.stringify({exists:false})); process.exit(0); }
  const data = JSON.parse(fs.readFileSync(p,'utf-8'));
  const stages = data.stages || [];
  const stageStatus = stages.map(s => {
    const outPath = '${CLAUDE_PROJECT_DIR}/.vcp/task/' + s.output_file;
    if (!fs.existsSync(outPath)) return {...s, file_status:'no_output_file'};
    try {
      const out = JSON.parse(fs.readFileSync(outPath,'utf-8'));
      // RCA outputs lack 'status' field — detect completion via root_cause.summary
      if (s.type === 'rca') {
        const complete = out.root_cause && out.root_cause.summary && out.root_cause.root_file;
        return {...s, file_status: complete ? 'complete' : 'unknown'};
      }
      // Multi-file artifact completion via manifest fields
      if (s.type === 'requirements') {
        const complete = out.artifact === 'user-story' && out.ac_count > 0;
        return {...s, file_status: complete ? 'complete' : 'unknown'};
      }
      if (s.type === 'planning') {
        const complete = out.artifact === 'plan' && out.step_count > 0;
        return {...s, file_status: complete ? 'complete' : 'unknown'};
      }
      return {...s, file_status: out.status || 'unknown'};
    } catch { return {...s, file_status:'invalid'}; }
  });
  console.log(JSON.stringify({exists:true, ...data, stageStatus}, null, 2));
"
```

**If `exists == false`** → Fresh run. Proceed to Step 1.

**If `exists == true`** → Check pipeline type compatibility:
- If `pipeline_type !== "bug-fix"` → AskUserQuestion: "Previous pipeline is a **{pipeline_type}** run, but you invoked `/dev-buddy-bug-fix`. Options: 1. Start fresh (reset and begin new bug-fix pipeline). 2. Cancel (use `/dev-buddy-feature-implement` to resume the existing pipeline)." If start fresh → proceed to Step 1. If cancel → stop.

**If compatible** → Previous pipeline detected. Ask the user:

```
AskUserQuestion:
  "Previous bug-fix pipeline detected:
   Team: {team_name}
   Progress: {completed}/{total} stages complete
   Current phase: {determine from stageStatus}

   1. Resume from where it left off
   2. Start fresh (reset and begin new pipeline)
   3. Show detailed status"
```

- **"Start fresh"** → Proceed to Step 1.
- **"Show status"** → Display stageStatus table, re-ask.
- **"Resume"** → Execute Step 0.1 through Step 0.5:

#### Step 0.1: Safety Checks + Config Drift Detection

```
// Check orchestrator lock — prevent conflicting concurrent runs
lockPath = "${CLAUDE_PROJECT_DIR}/.vcp/task/.orchestrator.lock"
If lock file exists:
  Read PID from lock, check if process alive (kill -0)
  If alive → STOP: "Another pipeline session is running (PID {pid})"
  If dead → remove stale lock, continue
```

Config drift detection:

```bash
bun -e "
  import { loadPipelineConfig } from '${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-config.ts';
  import { createHash } from 'crypto';
  const stored = JSON.parse(require('fs').readFileSync('${CLAUDE_PROJECT_DIR}/.vcp/task/pipeline-tasks.json','utf-8'));
  const storedHash = stored.config_hash || '';
  let currentHash = '';
  let loadError = null;
  try {
    const current = loadPipelineConfig();
    currentHash = createHash('sha256').update(JSON.stringify(current)).digest('hex');
  } catch (e) { loadError = e.message; }
  console.log(JSON.stringify({match: !loadError && currentHash === storedHash, currentHash, storedHash, loadError}));
"
```

If `loadError` is set OR hashes don't match:
```
AskUserQuestion:
  "Pipeline config has changed since this pipeline started.
   Resume will use the ORIGINAL config snapshot (from pipeline-tasks.json).
   1. Resume with original config (safe — no dependency mismatch)
   2. Start fresh with new config (reset pipeline)"
```

#### Step 0.2: Re-create Pipeline Team

Claude Code teams are session-scoped — when a session terminates, the team is already gone. TeamDelete here is a cleanup no-op for stale metadata.

```
team_name = from pipeline-tasks.json.team_name
TeamDelete(team_name)   ← ignore errors (expected: team already gone with dead session)
TeamCreate(team_name, description: "Bug-fix pipeline (resumed)")
TaskList()              ← verify returns [] (fresh team, no tasks yet)
```

#### Step 0.3: Re-create Task Chain (Remaining Stages)

**Two-pass approach** (ensures all task IDs exist before rewiring):

```
// Explicit initialization
stages = pipeline-tasks.json.stages    // array from stored snapshot
taskIdMap = {}                          // index → recreated task ID
needsChangesList = []                   // indices needing fix+re-review in Pass 3
statusMap = {}                          // index → target status ('completed' | 'pending')
previousTaskId = null
groupPredecessors = null

// Normalize parallel_group_id (older snapshots may omit it)
for each stage in stages:
  stage.parallel_group_id = stage.parallel_group_id ?? null
```

**Join file_status into stages:** The Step 0 detection script outputs `stageStatus` (an array with `file_status` per stage). Before processing, merge it into `stages` so each stage entry carries its own `file_status`:
```
for i in 0..stages.length-1:
  stages[i].file_status = stageStatus[i]?.file_status || 'no_output_file'
```

**Validate `parallel_group_id` integrity:** After normalization, verify stored `parallel_group_id` values are consistent:
```
for i in 0..stages.length-1:
  gid = stages[i].parallel_group_id
  if gid is null: continue
  // Must be a review stage
  if stages[i].type !== 'plan-review' AND stages[i].type !== 'code-review':
    log warning: "Stage {i} has parallel_group_id={gid} but type={stages[i].type}; resetting to null"
    stages[i].parallel_group_id = null
    continue
  // Must form contiguous runs of same type
  if i > 0 AND stages[i-1].parallel_group_id === gid AND stages[i-1].type !== stages[i].type:
    log warning: "Stage {i} has parallel_group_id={gid} but type differs from adjacent stage; resetting to null"
    stages[i].parallel_group_id = null
```

**Pass 1 — Create all tasks (pending):** For each stage in `stages` (index 0..N), create a task as **pending** regardless of actual status. Store `taskIdMap[i] = task.id`. Determine target status using the `file_status` (now on each stage entry) from Step 0's detection script (which already handles stage-type-aware completion for RCA outputs via `root_cause.summary + root_cause.root_file`):

- **`file_status === 'complete'` or `'approved'`**: `statusMap[i] = 'completed'`
- **`file_status === 'needs_changes'`**: `statusMap[i] = 'completed'`. Append i to `needsChangesList`.
- **`file_status === 'rejected'`**: AskUserQuestion: "Stage {type} {index} was rejected. Options: 1. Start fresh. 2. Treat as needs_changes." If start fresh → Step 1. If needs_changes → `statusMap[i] = 'completed'`, append i to `needsChangesList`.
- **All other `file_status` values** (`'failed'`, `'needs_clarification'`, `'partial'`, `'pending'`, `'unknown'`, `'invalid'`, `'no_output_file'`): `statusMap[i] = 'pending'` (task stays pending, stage re-runs).

This mapping works for all stage types because the Step 0 detection script already produces `'complete'` for valid RCA outputs that lack a `status` field (detected via `root_cause.summary` and `root_cause.root_file`).

**Pass 2 — Restore dependency edges:** For each stage in `stages` (index 0..N), apply `blockedBy` using the same fan-out/fan-in logic as normal Step 2 task chain creation, using `stages[i].parallel_group_id`:

- If `stages[i].parallel_group_id` is non-null AND same as previous stage's group → fan-out: `TaskUpdate(taskIdMap[i], addBlockedBy: predecessors)` (same predecessors as other group members)
- If starting a new parallel group → compute predecessors from `previousTaskId` or `groupPredecessors`, apply to all group members
- If sequential (null group ID) → `TaskUpdate(taskIdMap[i], addBlockedBy: [previousTaskId])` or fan-in from `groupPredecessors`
- Track `previousTaskId` and `groupPredecessors` identically to the normal Step 2 task chain creation algorithm

Then apply terminal statuses: for each i where `statusMap[i] === 'completed'`: `TaskUpdate(taskIdMap[i], status: 'completed')`.

**Pass 3 — Rewire needs_changes stages:** For each index i in `needsChangesList`:
- Create fix task: `parallel_group_id: null`, `blockedBy: [taskIdMap[i]]`
- Create re-review task: `parallel_group_id: null`, `blockedBy: [fix_task.id]`
- **Group-aware successor:** If `stages[i].parallel_group_id` is non-null, find the last index j where `stages[j].parallel_group_id === stages[i].parallel_group_id` (= groupEnd), then successor = groupEnd + 1. If null, successor = i + 1. If successor exists in `taskIdMap`: `TaskUpdate(taskIdMap[successor], addBlockedBy: [re_review_task.id])`. If no successor, skip.

**Pass 4 — Update `pipeline-tasks.json` with new task IDs:** The main loop matches tasks by `task_id` for provider routing, parallel group lookup, and consolidation triggers. After recreating tasks, the stored IDs are stale. Rewrite:

```
for each i in 0..N:
  stages[i].task_id = taskIdMap[i]
// Atomically rewrite pipeline-tasks.json (preserving team_name, pipeline_type, config_hash, resolved_config)
Write updated stages array back to .vcp/task/pipeline-tasks.json
```

**RCA completion detection:** RCA output files do NOT have a `status` field (unlike review/implementation outputs). The resume detection script detects RCA completion via `root_cause.summary` and `root_cause.root_file` — if both are populated, the stage is `complete`. If not, it's `unknown` (treated as pending, stage re-runs).

**Bug-fix RCA edge case:** If all rca-*.json files are complete AND no user-story/manifest.json exists → run inline Orchestrator Consolidation first (before entering Main Loop).

#### Step 0.5: Enter Main Loop

Jump to existing Main Loop. `TaskList()` finds next unblocked task.

### Step 1: Reset Pipeline

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.ts" reset --cwd "${CLAUDE_PROJECT_DIR}"
```

### Step 1.1: Validate Pipeline Config

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-config.ts" validate --cwd "${CLAUDE_PROJECT_DIR}"
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
  const outputFile = getOutputFileName(entry.type, stageIndex, entry.provider, entry.model, 1);
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
- `outputFile` — computed output file name (e.g., 'rca-anthropic-subscription-sonnet-1-v1.json', 'plan-review-my-codex-preset-o3-1-v1.json')
- `arrayIndex` — 0-based position in the pipeline array
- `providerType` — resolved provider type: `'subscription'`, `'api'`, or `'cli'`. **Note:** This is the JSON-serialized field name used in `pipeline-tasks.json` stages. The TypeScript `ResolvedStage` interface uses `provider_type` (snake_case) internally; the orchestrator writes `providerType` (camelCase) to JSON.

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

For each stage in the resolved `bugfix_pipeline` array (in order), create one task. Non-review stages are always sequential (each blocked by the previous). Review stages with `parallel: true` form fan-out/fan-in groups — see Parallel Group Detection below.

```
// ─── Parallel Group Detection ───────────────────────────────────────────
// Identify groups of consecutive same-type review stages with parallel: true
parallelGroups = []
i = 0
while i < resolved.length:
  stage = resolved[i]
  if stage.type not in ['plan-review', 'code-review'] OR !stage.parallel:
    i++
    continue
  j = i + 1
  while j < resolved.length AND resolved[j].type === stage.type AND resolved[j].parallel === true:
    j++
  if (j - i) >= 2:  // 2+ consecutive = valid parallel group
    parallelGroups.push({ start: i, end: j - 1, type: stage.type })
  i = j

// ─── Task Chain Creation (with parallel group support) ──────────────────
previousTaskId = null
groupPredecessors = null  // array of task IDs from last parallel group
parallelGroupCounter = 0
taskIds = []
stages = []  // parallel metadata for each stage (written to pipeline-tasks.json)

i = 0
while i < resolved.length:
  stage = resolved[i]
  group = parallelGroups.find(g => g.start === i)

  if group:
    // Parallel group: fan-out from predecessor, fan-in to successor
    parallelGroupCounter++
    groupTaskIds = []
    predecessors = previousTaskId ? [previousTaskId]
                 : groupPredecessors ? groupPredecessors
                 : []

    for k = group.start to group.end:
      subject = deriveSubject(resolved[k])
      description = deriveDescription(resolved[k])
      task = TaskCreate(subject: subject, activeForm: activeForm(resolved[k]), description: description)
      taskIds[k] = task.id
      groupTaskIds.push(task.id)
      stages[k] = { ...resolved[k], output_file: resolved[k].outputFile, task_id: task.id, parallel_group_id: parallelGroupCounter, current_version: 1 }
      if predecessors.length > 0:
        TaskUpdate(task.id, addBlockedBy: predecessors)

    groupPredecessors = groupTaskIds
    previousTaskId = null
    i = group.end + 1

  else:
    // Sequential stage
    subject = deriveSubject(stage)
    description = deriveDescription(stage)
    task = TaskCreate(subject: subject, activeForm: activeForm(stage), description: description)
    taskIds[i] = task.id
    stages[i] = { ...resolved[i], output_file: resolved[i].outputFile, task_id: task.id, parallel_group_id: null, current_version: 1 }

    predecessors = previousTaskId ? [previousTaskId]
                 : groupPredecessors ? groupPredecessors
                 : []
    if predecessors.length > 0:
      TaskUpdate(task.id, addBlockedBy: predecessors)

    groupPredecessors = null
    previousTaskId = task.id
    i++
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
INPUT: .vcp/task/plan/manifest.json (then read step files), .vcp/task/user-story/manifest.json, + all rca-*.json files
OUTPUT: .vcp/task/plan-review-{N}.json
PROMPT MUST INCLUDE: 'Write output to .vcp/task/plan-review-{N}.json. Validate that the consolidated RCA diagnosis is correct and the fix plan is sound.'
RESULT HANDLING: Read .vcp/task/plan-review-{N}.json → check status → handle per Result Handling rules
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
RESULT HANDLING: if rejected → ask user to re-examine bug or provide more context
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
RESULT HANDLING: Read .vcp/task/code-review-{N}.json → check status → handle per Result Handling rules
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
RESULT HANDLING: if rejected → terminal state code_rejected (ask user)
COMPLETION: .vcp/task/code-review-{N}.json exists with status field
```

**Save to `.vcp/task/pipeline-tasks.json`**:
```json
{
  "team_name": "pipeline-myproject-a1b2c3",
  "pipeline_type": "bug-fix",
  "config_hash": "<sha256-of-JSON.stringify(loadPipelineConfig())>",
  "resolved_config": {
    "feature_pipeline": [],
    "bugfix_pipeline": [],
    "max_iterations": 10,
    "team_name_pattern": "pipeline-{BASENAME}-{HASH}"
  },
  "stages": [
    { "type": "rca", "provider": "anthropic-subscription", "providerType": "subscription", "model": "sonnet", "output_file": "rca-anthropic-subscription-sonnet-1-v1.json", "task_id": "4", "parallel_group_id": null, "current_version": 1 },
    { "type": "rca", "provider": "anthropic-subscription", "providerType": "subscription", "model": "opus", "output_file": "rca-anthropic-subscription-opus-2-v1.json", "task_id": "5", "parallel_group_id": null, "current_version": 1 },
    { "type": "plan-review", "provider": "my-codex-preset", "providerType": "cli", "model": "o3", "output_file": "plan-review-my-codex-preset-o3-1-v1.json", "task_id": "6", "parallel_group_id": null, "current_version": 1 },
    { "type": "implementation", "provider": "anthropic-subscription", "providerType": "subscription", "model": "sonnet", "output_file": "impl-result.json", "task_id": "7", "parallel_group_id": null, "current_version": 1 },
    { "type": "code-review", "provider": "anthropic-subscription", "providerType": "subscription", "model": "sonnet", "output_file": "code-review-anthropic-subscription-sonnet-1-v1.json", "task_id": "8", "parallel_group_id": null, "current_version": 1 },
    { "type": "code-review", "provider": "anthropic-subscription", "providerType": "subscription", "model": "opus", "output_file": "code-review-anthropic-subscription-opus-2-v1.json", "task_id": "9", "parallel_group_id": null, "current_version": 1 },
    { "type": "code-review", "provider": "my-codex-preset", "providerType": "cli", "model": "o3", "output_file": "code-review-my-codex-preset-o3-3-v1.json", "task_id": "10", "parallel_group_id": null, "current_version": 1 }
  ]
}
```

**Verify:** After creating all tasks, call `TaskList()`. You should see N tasks (where N = length of bugfix_pipeline). Tasks form a chain with fan-out/fan-in at parallel groups (if configured). Non-review stages (rca, implementation) are always sequential.

---

## Main Loop

Execute this data-driven loop until all tasks are completed:

```
while pipeline not complete:
    1. Call TaskList() — returns array of all tasks with current status and blockedBy
    2. Find ALL tasks where: status == "pending" AND all blockedBy tasks have status == "completed"
       If MULTIPLE unblocked tasks found:
         Look up each task's parallel_group_id from pipeline-tasks.json stages (match by task_id)
         If ALL share the SAME non-null parallel_group_id:
           → [PARALLEL OK] Execute all simultaneously (see Parallel Execution below)
         If group IDs differ OR any is null:
           → Sort by stage index (look up each task_id in pipeline-tasks.json.stages to get its index), pick lowest index first, execute sequentially
       If ONE unblocked task → execute it normally
       If NO unblocked tasks and tasks remain → pipeline is stuck, report to user
    3. Call TaskGet(task.id) — read full description
    4. Call TaskUpdate(task.id, status: "in_progress")
    5. Execute task — ROUTE BY PROVIDER TYPE (from resolved stages, NOT from description alone):
       a. Look up current task in pipeline-tasks.json stages array (match by task_id)
       b. Read the stage's `providerType` field to determine routing:

       **If providerType is 'subscription':**
         Task(subagent_type: "dev-buddy:<agent>", model: "<model>", prompt: "...")
         // NO team_name. One-shot subagent.

       **If providerType is 'api':**
         Derive timeout: read `~/.vcp/ai-presets.json` → find preset by stage.provider name → read `timeout_ms` (default: 300000 if not set or lookup fails)
         **IMPORTANT:** The Bash tool has a hard max timeout of 600000ms (10 min). For tasks that may exceed this,
         use `run_in_background: true` so the process is not killed prematurely.
         Run the Bash tool with `run_in_background: true`:
         ```
         bun "${CLAUDE_PLUGIN_ROOT}/scripts/api-task-runner.ts" \
           --preset "<stage.provider>" \
           --model "<stage.model>" \
           --cwd "${CLAUDE_PROJECT_DIR}" \
           --task-timeout "<timeout_ms>" \
           --task-stdin <<'TASK_EOF'
         <prompt>
         TASK_EOF
         ```
         Save the returned `task_id` from the Bash tool result along with the pipeline task ID, stage provider, and model.
         If `run_in_background` does not return a `task_id`, treat it as a dispatch failure — do not retry in foreground mode.
         Then poll for completion:
         ```
         TaskOutput(task_id: "<task_id>", block: true, timeout: min(timeout_ms + 120000, 600000))
         ```
         If TaskOutput returns but the task is still running (not complete), repeat the TaskOutput call
         with `timeout: 600000` until the background task finishes.
         // The api-task-runner creates a V2 Agent SDK session — it CAN read/write files.
         // Parse the final output for JSON: { event: "complete", result: "..." } or { event: "error", error: "..." }

       **If providerType is 'cli':**
         Task(subagent_type: "dev-buddy:cli-executor", prompt: "Run cli-executor.ts with --preset, --model, --output-file")
         // Do NOT pass model parameter to Task tool. Model is passed via --model flag to cli-executor.ts.

       - Parse AGENT, MODEL, INPUT, OUTPUT from task description for the prompt content
       - **NEVER use team_name when spawning agents.** All stages are one-shot subagents, NOT teammates. Parallel review groups dispatch concurrent one-shot `Task()` calls — not team-spawned teammates.
    6. Check output file for result
    7. *** RCA CONSOLIDATION CHECK (inline, before handling result) ***
       After completing a task, look up `completedStageIndex` in pipeline-tasks.json stages (match by task_id):
         (a) `completedStage = stages[completedStageIndex]` — check if `.type === 'rca'`
         (b) `nextStage = stages[completedStageIndex + 1]` — check if null or `.type !== 'rca'`
       If BOTH conditions are true: run the Orchestrator Consolidation step BEFORE dispatching next task.
       See "RCA Consolidation Trigger Detection" section below.
    8. Handle result (see Result Handling below)
    9. Enrich next task (before marking completed — sequential tasks only, NOT parallel group members; see Parallel Execution step 5 for aggregated enrichment)
   10. Call TaskUpdate(task.id, status: "completed")
```

### Parallel Execution [PARALLEL OK]

When multiple tasks share the same non-null `parallel_group_id` and are all unblocked:

1. For EACH task simultaneously: TaskGet, TaskUpdate(in_progress), dispatch agent
2. Wait for ALL to return
3. Handle each result independently:
   - **approved** → mark completed
   - **needs_changes** → mark review completed, create fix task (`parallel_group_id: null`, `blockedBy: [review_task.id]`), create re-review task (`parallel_group_id: null`, `blockedBy: [fix_task.id]`). **Group-aware successor lookup:** look up the task's `parallel_group_id` in `pipeline-tasks.json.stages`, find the last index with that same group ID (= groupEnd), then successor = groupEnd + 1. If successor exists in stages, call `TaskUpdate(stages[successor].task_id, addBlockedBy: [re_review_task.id])`. If no successor (last stage), skip rewiring.
   - **rejected** → handle per Result Handling rules
4. Dynamic fix/re-review tasks always have `parallel_group_id: null` → they always execute sequentially
5. **Aggregated enrichment (replaces per-task step 9 for parallel members):** Do NOT enrich the successor task individually per parallel member — this causes last-write-wins races. Instead, after ALL parallel results are collected, build a single combined context block:
   ```
   context = ""
   for each completed parallel task (approved or needs_changes):
     read output file, extract key context (≤ 250 chars per member)
     context += "FROM {stage.type} {stage.model}: {summary}\n"
   // Find successor: compute group-aware successor index (groupEnd + 1)
   if successor exists:
     TaskGet(successor_task_id) → read current description
     TaskUpdate(successor_task_id, description: append "CONTEXT FROM PRIOR PARALLEL GROUP:\n{context}")
   ```
   If enrichment fails, log and continue (best-effort).

**IMPORTANT:** Only tasks from the original `pipeline-tasks.json.stages` with matching `parallel_group_id` may run in parallel. Dynamic tasks (fix, re-review) NEVER run in parallel.

### RCA Consolidation Trigger Detection

After each task completion, check the `stages` array in `pipeline-tasks.json`:

```
completedStageIndex = find index in stages where task_id matches current task
completedStage = stages[completedStageIndex]
nextStage = stages[completedStageIndex + 1]  // may be null if last

if completedStage.type === 'rca' AND (nextStage === null OR nextStage.type !== 'rca'):
    → Run Orchestrator Consolidation NOW (inline, before dispatching next task)
    → Write user-story/ and plan/ multi-file artifacts
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
// e.g., ['rca-anthropic-subscription-sonnet-1-v1.json', 'rca-anthropic-subscription-opus-2-v1.json']
Read each file from .vcp/task/ using the output_file from stages[]
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

### Step 3: Write user-story/ multi-file artifact

Write the user-story as individual section files. **These paths are FIXED — not configurable.** Write files in this order (manifest LAST):

**3a. `.vcp/task/user-story/meta.json`**
```json
{
  "id": "story-YYYYMMDD-HHMMSS",
  "title": "Fix: [Bug title from RCA]",
  "pipeline_type": "bug-fix"
}
```

**3b. `.vcp/task/user-story/requirements.json`**
```json
{
  "root_cause": "[Consolidated root cause summary]",
  "root_file": "[path/to/file.ts]",
  "root_line": 42
}
```

**3c. `.vcp/task/user-story/acceptance-criteria.json`**
```json
[
  { "id": "AC1", "description": "Bug is resolved — expected behavior is restored" },
  { "id": "AC2", "description": "Regression test covers the exact bug scenario" },
  { "id": "AC3", "description": "No existing tests are broken by the fix" },
  { "id": "AC4", "description": "Root cause is addressed, not just symptoms patched" }
]
```

**3d. `.vcp/task/user-story/scope.json`**
```json
{
  "affected_files": ["[merged from all RCAs]"],
  "blast_radius": "[from RCA impact analysis]",
  "fix_constraints": {
    "must_preserve": ["[merged from all RCAs]"],
    "safe_to_change": ["[merged from all RCAs]"]
  }
}
```

**3e. `.vcp/task/user-story/test-criteria.json`**
```json
{
  "implementation": { "max_iterations": 10 }
}
```

**3f. `.vcp/task/user-story/manifest.json`** (write LAST)
```json
{
  "id": "story-YYYYMMDD-HHMMSS",
  "title": "Fix: [Bug title from RCA]",
  "pipeline_type": "bug-fix",
  "artifact": "user-story",
  "ac_count": 4,
  "sections": {
    "meta": "meta.json",
    "requirements": "requirements.json",
    "acceptance_criteria": "acceptance-criteria.json",
    "scope": "scope.json",
    "test_criteria": "test-criteria.json"
  }
}
```

### Step 4: Write plan/ multi-file artifact

Write the plan as individual section files. **These paths are FIXED — not configurable.** Write files in this order (manifest LAST):

**4a. `.vcp/task/plan/meta.json`**
```json
{
  "id": "plan-YYYYMMDD-HHMMSS",
  "title": "Fix: [Bug title]",
  "pipeline_type": "bug-fix",
  "technical_approach": {
    "root_cause": "[Consolidated root cause]",
    "fix_strategy": "[From recommended_approach of chosen RCA]",
    "complexity": "[From estimated_complexity]"
  }
}
```

**4b. `.vcp/task/plan/steps/{N}.json`** (one file per step, N = 1, 2, 3, ...)
```json
// .vcp/task/plan/steps/1.json
{ "description": "Write regression test that reproduces the bug", "files": ["path/to/test.ts"] }

// .vcp/task/plan/steps/2.json
{ "description": "Apply minimal fix to [root_file] at line [root_line]", "files": ["path/to/file.ts"] }

// .vcp/task/plan/steps/3.json
{ "description": "Verify regression test passes, all existing tests pass", "files": [] }
```

**4c. `.vcp/task/plan/test-plan.json`**
```json
{
  "commands": ["npm test", "npm run lint"],
  "regression_test": "Specific regression test to write",
  "success_pattern": "All tests pass",
  "failure_pattern": "FAIL|ERROR"
}
```

**4d. `.vcp/task/plan/risk-assessment.json`**
```json
{
  "blast_radius": "[from RCA]",
  "regression_risk": "[from RCA]",
  "mitigation": "Regression test covers the exact bug scenario"
}
```

**4e. `.vcp/task/plan/dependencies.json`**
```json
{
  "completion_promise": "<promise>IMPLEMENTATION_COMPLETE</promise>"
}
```

**4f. `.vcp/task/plan/files.json`**
```json
{
  "affected_files": ["[all files from steps]"]
}
```

**4g. `.vcp/task/plan/manifest.json`** (write LAST)
```json
{
  "id": "plan-YYYYMMDD-HHMMSS",
  "title": "Fix: [Bug title]",
  "pipeline_type": "bug-fix",
  "artifact": "plan",
  "step_count": 3,
  "sections": {
    "meta": "meta.json",
    "steps": ["steps/1.json", "steps/2.json", "steps/3.json"],
    "test_plan": "test-plan.json",
    "risk_assessment": "risk-assessment.json",
    "dependencies": "dependencies.json",
    "files": "files.json"
  }
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
| rca-{P}-{M}-N-vV.json | next rca or plan-review stage | root cause summary, confidence, affected files |
| plan-review-{P}-{M}-N-vV.json | implementation or next plan-review | validation status, concerns, AC count |
| impl-result.json | first code-review stage | files modified/created, test results |
| code-review-{P}-{M}-N-vV.json | next code-review stage | status, findings, AC verified/total |

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

**CRITICAL: Re-review returns to the SAME STAGE INDEX, not the next stage.** If stage index 2 (e.g., `code-review-anthropic-subscription-opus-2-v1.json`) returns `needs_changes`:
- Fix task targets the code issue
- Re-review creates a **NEW versioned file** (`code-review-anthropic-subscription-opus-2-v2.json`)
- `stages[].output_file` is updated AFTER re-review completes (two-phase update)
- Stage index 3 is NOT started until stage index 2 approves

### needs_changes → Fix + Re-Review (Two-Phase Update)

```
// stage = the pipeline stage entry that returned needs_changes
// stageIndex = index of this stage in pipeline-tasks.json.stages[]
// current_task_id = from main loop
// iteration = from TaskList: count existing "Fix {stage subject} v*" tasks + 1

// PHASE 1: Compute next version (stages[] NOT updated yet — preserves phase detection)
nextVersion = stages[stageIndex].current_version + 1
nextOutputFile = getOutputFileName(stage.type, stage.stageIndex, stage.provider, stage.model, nextVersion)

fix = TaskCreate(
  subject: "Fix {stage subject} v{iteration}",
  description: "...ISSUES TO FIX: {issues}..."
)
TaskUpdate(fix.id, addBlockedBy: [current_task_id])

rerev = TaskCreate(
  subject: "{stage subject} v{iteration+1}",
  description: "...OUTPUT: .vcp/task/{nextOutputFile}  ← NEW VERSION FILE
               {if CLI stage: --output-file .vcp/task/{nextOutputFile}}..."
)
TaskUpdate(rerev.id, addBlockedBy: [fix.id])

// Group-aware successor lookup (same algorithm as Parallel Execution and Resume Pass 3):
groupId = stage.parallel_group_id ?? null
if groupId is not null:
  groupEnd = max index j where stages[j].parallel_group_id === groupId
  successorIndex = groupEnd + 1
else:
  successorIndex = stageIndex + 1
if successorIndex < stages.length:
  TaskUpdate(stages[successorIndex].task_id, addBlockedBy: [rerev.id])

// PHASE 2: After re-review completes and orchestrator reads result:
stages[stageIndex].current_version = nextVersion
stages[stageIndex].output_file = nextOutputFile
// Write updated pipeline-tasks.json to disk
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

The `review-validator.ts` derives review file lists dynamically from pipeline-tasks.json (stages[] preferred, resolved_config fallback). Validates reviewer outputs and can block invalid reviews.

---

## Important Rules

1. **Pipeline team first, then task chain** — Create team (Step 1.3), verify tools (Step 1.4), then create task chain.
2. **Non-review stages sequential** — RCA, implementation always execute sequentially. Review stages (plan-review, code-review) with `parallel: true` form parallel groups via fan-out/fan-in. Every non-parallel task has `blockedBy` pointing to the previous task.
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
13. **No teammate spawning** — The bug-fix pipeline does NOT use team-based parallel execution. Never spawn teammates with `Task(team_name: ...)`. The pipeline team exists solely for task tool availability (TaskCreate/TaskUpdate/TaskList), not for spawning workers. Parallel review groups use concurrent one-shot `Task()` calls (without `team_name`), NOT team-spawned teammates.

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
## Provider Routing

**If providerType is `subscription`:** Use Task tool (NO `team_name` — one-shot subagent):
```
Task(subagent_type: "dev-buddy:<agent-name>", model: "<model>", prompt: "...")
// Do NOT add team_name or name parameters. This is a one-shot subagent, NOT a teammate.
```

**If providerType is `api`:** Use `api-task-runner.ts` — a per-invocation script that creates a V2 Agent SDK session, runs the task, and exits.

**Derive timeout:** Read `~/.vcp/ai-presets.json` → find the preset matching the stage's `provider` name → read `timeout_ms` (default: 300000 if not set or lookup fails).

**IMPORTANT:** The Bash tool has a hard max timeout of 600,000ms (10 min). API tasks can run much longer (e.g., 30 min). Always use `run_in_background: true` to prevent the Bash tool from killing the process prematurely.

```bash
# Run with run_in_background: true — saves task_id
bun "${CLAUDE_PLUGIN_ROOT}/scripts/api-task-runner.ts" \
  --preset "<stage.provider>" \
  --model "<stage.model>" \
  --cwd "${CLAUDE_PROJECT_DIR}" \
  --task-timeout "<timeout_ms>" \
  --task-stdin <<'TASK_EOF'
...prompt...
TASK_EOF
```

**For review stages (plan-review, code-review) ONLY:** Add `--system-prompt "${CLAUDE_PLUGIN_ROOT}/docs/review-guidelines.md"` to inject centralized review guidelines into the API session's system prompt.

Save `task_id` along with the pipeline task ID, provider, and model. If no `task_id` is returned, treat as dispatch failure.
Then poll: `TaskOutput(task_id, block: true, timeout: min(timeout_ms + 120000, 600000))`. If not complete, repeat `TaskOutput` with `timeout: 600000` until done.
Uses `--task-stdin` with heredoc to avoid OS argv size limits and ps exposure.
Parse the final output for JSON: `{ event: "complete", result: "..." }` or `{ event: "error", error: "..." }`. Exit code 3 = timeout.
The api-task-runner creates a V2 Agent SDK session with Read/Write/Edit/Bash — it CAN modify files on disk. API providers support ALL stage types including implementation and RCA.

**If providerType is `cli`:** The task description specifies the exact cli-executor.ts invocation with `--output-file` and optional `--model` flags.

---

## Emergency Controls

1. **Check task state:** `TaskList()`
2. **Check artifacts:** Read `.vcp/task/*.json` files
3. **Check resolved config:** Read `resolved_config` from `.vcp/task/pipeline-tasks.json`
4. **Reset pipeline:** `bun "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.ts" reset --cwd "${CLAUDE_PROJECT_DIR}"`
