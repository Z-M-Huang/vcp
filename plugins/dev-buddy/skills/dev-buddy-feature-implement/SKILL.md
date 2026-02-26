---
name: dev-buddy-feature-implement
description: Dev Buddy multi-AI pipeline. Plan -> Review -> Implement (loop until reviews approve). Configurable pipeline with Codex final gate.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task, AskUserQuestion, Skill, TaskCreate, TaskUpdate, TaskList, TaskGet, TeamCreate, TeamDelete, SendMessage
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
| **Technical Analyst** | Always | Existing code, patterns, constraints, dependencies, files to change | `.vcp/task/analysis-technical.json` |
| **UX/Domain Analyst** | Always | User workflows, edge cases, industry patterns, accessibility | `.vcp/task/analysis-ux-domain.json` |
| **Security Analyst** | Always | VCP standards + OWASP (when VCP detected), threat model, non-functional requirements | `.vcp/task/analysis-security.json` |
| **Performance Analyst** | Always | Load impact, scalability, resource usage, bottlenecks, caching | `.vcp/task/analysis-performance.json` |
| **Architecture Analyst** | Always | Design patterns, SOLID principles, code organization, maintainability, best practices | `.vcp/task/analysis-architecture.json` |

All 5 core specialists are **always spawned** for every request.

Additional specialists should write their analysis to `.vcp/task/analysis-<type>.json` following the same output format.

---

## Pipeline Initialization

**CRITICAL: No phase skipping.** Exception: Resume path (Step 0) skips already-completed stages by creating pre-completed tasks. Pre-existing plans or context from plan mode are **input to the specialists**, not a substitute for the pipeline.

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
      // requirements/planning outputs lack 'status' — detect via content
      if (s.type === 'requirements') {
        const complete = out.title && out.acceptance_criteria && out.acceptance_criteria.length > 0;
        return {...s, file_status: complete ? 'complete' : 'unknown'};
      }
      if (s.type === 'planning') {
        const complete = out.title && out.steps && out.steps.length > 0;
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
- If `pipeline_type !== "feature-implement"` → AskUserQuestion: "Previous pipeline is a **{pipeline_type}** run, but you invoked `/dev-buddy-feature-implement`. Options: 1. Start fresh (reset and begin new feature pipeline). 2. Cancel (use `/dev-buddy-bug-fix` to resume the existing pipeline)." If start fresh → proceed to Step 1. If cancel → stop.

**If compatible** → Previous pipeline detected. Ask the user:

```
AskUserQuestion:
  "Previous feature pipeline detected:
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
TeamCreate(team_name, description: "Pipeline (resumed)")
TaskList()              ← verify returns [] (fresh team, no tasks yet)
```

#### Step 0.3: Spawn Session Managers (from snapshot)

Only needed if `pipeline-tasks.json.resolved_config` has any API provider stages. Skip `validate` (original config was validated at pipeline creation). Do NOT use `pipeline-config.ts spawn` — it reads current disk config, which may have drifted. Instead, extract unique API presets from the stored snapshot and spawn session managers directly:

```
Read pipeline-tasks.json.stages
For each unique provider name where providerType === 'api':
  bun "${CLAUDE_PLUGIN_ROOT}/scripts/session-manager.ts" \
    --preset "<provider_name>" \
    --cwd "${CLAUDE_PROJECT_DIR}"
```

One session manager per unique API provider — no `--model` flag (matches non-resume `spawnSessionManagers` behavior). Model selection is per-task via the stage's `model` field, mapped through the provider's env vars at task dispatch time. This honors the "resume with original config" choice from Step 0.1.

#### Step 0.4: Re-create Task Chain (Remaining Stages)

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

**Pass 1 — Create all tasks (pending):** For each stage in `stages` (index 0..N), create a task as **pending** regardless of actual status. Store `taskIdMap[i] = task.id`. Determine target status using the `file_status` (now on each stage entry) from Step 0's detection script (which already handles stage-type-aware completion for requirements/planning/RCA):

- **`file_status === 'complete'` or `'approved'`**: `statusMap[i] = 'completed'`
- **`file_status === 'needs_changes'`**: `statusMap[i] = 'completed'`. Append i to `needsChangesList`.
- **`file_status === 'rejected'`**: AskUserQuestion: "Stage {type} {index} was rejected. Options: 1. Start fresh. 2. Treat as needs_changes." If start fresh → Step 1. If needs_changes → `statusMap[i] = 'completed'`, append i to `needsChangesList`.
- **All other `file_status` values** (`'failed'`, `'needs_clarification'`, `'partial'`, `'pending'`, `'unknown'`, `'invalid'`, `'no_output_file'`): `statusMap[i] = 'pending'` (task stays pending, stage re-runs).

This mapping works for all stage types because the Step 0 detection script already produces `'complete'` for valid requirements (`title + acceptance_criteria`) and planning (`title + steps`) outputs that lack a `status` field.

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

Requirements edge cases:
- `user-story.json` exists + valid → requirements complete
- Analysis files exist but no user-story → run requirements-gatherer in direct synthesis mode
- No analysis files and no user-story → requirements pending, run in direct mode

#### Step 0.5: Enter Main Loop

Jump to existing Main Loop. `TaskList()` finds next unblocked task.

### Step 1: Reset Pipeline

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.ts" reset --cwd "${CLAUDE_PROJECT_DIR}"
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
import { readPresets } from '${CLAUDE_PLUGIN_ROOT}/scripts/preset-utils.ts';

const config = loadPipelineConfig();
const presets = readPresets();
const pipeline = config.feature_pipeline;

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
- `type` — stage type (e.g., 'requirements', 'plan-review')
- `provider` — preset name
- `model` — model identifier (required)
- `stageIndex` — 1-based index among stages of the same type
- `outputFile` — computed output file name (e.g., 'plan-review-1.json', 'impl-result.json')
- `arrayIndex` — 0-based position in the pipeline array
- `providerType` — resolved provider type: `'subscription'`, `'api'`, or `'cli'`. **Note:** This is the JSON-serialized field name used in `pipeline-tasks.json` stages. The TypeScript `ResolvedStage` interface uses `provider_type` (snake_case) internally; the orchestrator writes `providerType` (camelCase) to JSON.

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
      stages[k] = { ...resolved[k], output_file: resolved[k].outputFile, task_id: task.id, parallel_group_id: parallelGroupCounter }
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
    stages[i] = { ...resolved[i], output_file: resolved[i].outputFile, task_id: task.id, parallel_group_id: null }

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
OUTPUT: .vcp/task/user-story.json
PROCEDURE: 1) Spawn all 5 core specialists as teammates 2) Interactive loop: receive messages, AskUserQuestion
           3) Wait for all analysis files 4) Spawn requirements-gatherer in synthesis mode (one-shot Task)
           5) shutdown_request to ALL specialists, wait ~60s, retry once if needed, then proceed 6) Mark completed
COMPLETION: .vcp/task/user-story.json exists with acceptance_criteria array
```

For `planning`:
```
PHASE: Planning
AGENT: dev-buddy:planner (model: opus)
INPUT: .vcp/task/user-story.json
OUTPUT: .vcp/task/plan-refined.json
COMPLETION: .vcp/task/plan-refined.json exists with steps array, test_plan, and completion_promise
```

For `plan-review` (subscription/api provider, stageIndex N, outputFile plan-review-N.json):
```
PHASE: Plan Review {N}
AGENT: dev-buddy:plan-reviewer (model: {stage.model})
INPUT: .vcp/task/user-story.json, .vcp/task/plan-refined.json
OUTPUT: .vcp/task/plan-review-{N}.json
PROMPT MUST INCLUDE: 'Write output to .vcp/task/plan-review-{N}.json.'
RESULT HANDLING: Read .vcp/task/plan-review-{N}.json → check status → handle per Result Handling rules
COMPLETION: .vcp/task/plan-review-{N}.json exists with status and requirements_coverage fields
```

For `plan-review` (CLI provider, stageIndex N, outputFile plan-review-N.json):
```
PHASE: Plan Review {N} (CLI - final gate)
AGENT: dev-buddy:cli-executor (external — do NOT pass model parameter to Task tool)
INPUT: .vcp/task/user-story.json, .vcp/task/plan-refined.json
OUTPUT: .vcp/task/plan-review-{N}.json
NOTE: CLI executor runs cli-executor.ts with --preset {stage.provider} --model {stage.model}
      --output-file "${CLAUDE_PROJECT_DIR}/.vcp/task/plan-review-{N}.json" --plugin-root "${CLAUDE_PLUGIN_ROOT}"
RESULT HANDLING: if rejected → terminal state plan_rejected (ask user)
COMPLETION: .vcp/task/plan-review-{N}.json exists with status field
```

For `implementation`:
```
PHASE: Implementation
AGENT: dev-buddy:implementer (model: {stage.model})
INPUT: .vcp/task/user-story.json, .vcp/task/plan-refined.json
OUTPUT: .vcp/task/impl-result.json
COMPLETION: .vcp/task/impl-result.json exists with status='complete'
```

For `code-review` (subscription/api provider, stageIndex N, outputFile code-review-N.json):
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

**Save to `.vcp/task/pipeline-tasks.json`** using actual returned IDs:
```json
{
  "team_name": "pipeline-vibe-pipe-a1b2c3",
  "pipeline_type": "feature-implement",
  "config_hash": "<sha256-of-JSON.stringify(loadPipelineConfig())>",
  "resolved_config": {
    "feature_pipeline": [/* full StageEntry array from config */],
    "bugfix_pipeline": [/* full StageEntry array from config */],
    "max_iterations": 10,
    "team_name_pattern": "pipeline-{BASENAME}-{HASH}"
  },
  "stages": [
    { "type": "requirements", "provider": "anthropic-subscription", "providerType": "subscription", "output_file": "user-story.json", "task_id": "4", "parallel_group_id": null },
    { "type": "planning", "provider": "anthropic-subscription", "providerType": "subscription", "output_file": "plan-refined.json", "task_id": "5", "parallel_group_id": null },
    { "type": "plan-review", "provider": "anthropic-subscription", "providerType": "subscription", "model": "sonnet", "output_file": "plan-review-1.json", "task_id": "6", "parallel_group_id": null },
    { "type": "plan-review", "provider": "anthropic-subscription", "providerType": "subscription", "model": "opus", "output_file": "plan-review-2.json", "task_id": "7", "parallel_group_id": null },
    { "type": "plan-review", "provider": "my-codex-preset", "providerType": "cli", "output_file": "plan-review-3.json", "task_id": "8", "parallel_group_id": null },
    { "type": "implementation", "provider": "anthropic-subscription", "providerType": "subscription", "output_file": "impl-result.json", "task_id": "9", "parallel_group_id": null },
    { "type": "code-review", "provider": "anthropic-subscription", "providerType": "subscription", "model": "sonnet", "output_file": "code-review-1.json", "task_id": "10", "parallel_group_id": null },
    { "type": "code-review", "provider": "anthropic-subscription", "providerType": "subscription", "model": "opus", "output_file": "code-review-2.json", "task_id": "11", "parallel_group_id": null },
    { "type": "code-review", "provider": "my-codex-preset", "providerType": "cli", "output_file": "code-review-3.json", "task_id": "12", "parallel_group_id": null }
  ]
}
```

The `resolved_config` field is the FULL PipelineConfig snapshot. Hooks read stage information from this snapshot, never from `~/.vcp/dev-buddy.json` directly.

**Verify:** After creating all tasks, call `TaskList()`. You should see N tasks (where N = length of feature_pipeline). Sequential stages form a linear chain; parallel groups share the same predecessor (fan-out) and the next stage waits for all group members (fan-in).

**max_iterations from config:** The orchestrator uses `resolved_config.max_iterations` (default 10) to limit fix/re-review cycles. After max_iterations total re-reviews across all stages in the pipeline, escalate to user.

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
    3. Call TaskGet(task.id) — read full description with AGENT, MODEL, INPUT, OUTPUT
    4. Call TaskUpdate(task.id, status: "in_progress")
    5. Execute task — ROUTE BY PROVIDER TYPE (from resolved stages, NOT from description alone):
       a. Look up current task in pipeline-tasks.json stages array (match by task_id)
       b. Read the stage's `providerType` field to determine routing:

       **If providerType is 'subscription':**
         Task(subagent_type: "dev-buddy:<agent>", model: "<model>", prompt: "...")
         // NO team_name. One-shot subagent.

       **If providerType is 'api':**
         Read .vcp/task/session-ports.json → find entry where preset_name matches stage.provider
         Derive timeout: read `~/.vcp/presets.json` → find preset by stage.provider name → read `timeout_ms` → compute TIMEOUT_SECONDS = Math.ceil(timeout_ms / 1000) (default: 300 if not set or lookup fails)
         Set Bash tool timeout parameter to timeout_ms + 30000 (default: 330000 if timeout_ms not set or lookup fails)
         curl -s --connect-timeout 10 --max-time {TIMEOUT_SECONDS} \
           -X POST "http://localhost:{PORT}/tasks/send" \
           -H "Authorization: Bearer {TOKEN}" \
           -H "Content-Type: application/json" \
           -d '{"message":{"role":"user","parts":[{"type":"text","text":"<prompt>"}]}}'
         // The session manager runs a V2 Agent SDK session with Read/Write/Edit/Bash — it CAN modify files.

       **If providerType is 'cli':**
         Task(subagent_type: "dev-buddy:cli-executor", prompt: "Run cli-executor.ts with --preset, --model, --output-file")
         // Do NOT pass model parameter to Task tool. Model is passed via --model flag to cli-executor.ts.

       - Parse AGENT, MODEL, INPUT, OUTPUT from task description for the prompt content
       - **NEVER use team_name when spawning agents** (except requirements gathering specialists)
    6. Check output file (from description's OUTPUT field) for result
    7. Handle result (see Result Handling below)
    8. Enrich next task (BEFORE marking completed — sequential tasks only, NOT parallel group members):
       - Skip this step if the task was executed as part of a parallel group (see Parallel Execution step 5 for aggregated enrichment)
       - Read output file, extract key context (≤ 500 chars)
       - Find next task: call TaskList(), find task whose blockedBy includes current task ID
       - Call TaskGet(next_task_id) to read current description
       - Call TaskUpdate(next_task_id, description: <enriched>) — replace or append CONTEXT FROM PRIOR TASK block
       - If enrichment fails, log and continue (best-effort)
    9. Call TaskUpdate(task.id, status: "completed")

### Parallel Execution [PARALLEL OK]

When multiple tasks share the same non-null `parallel_group_id` and are all unblocked:

1. For EACH task simultaneously: TaskGet, TaskUpdate(in_progress), dispatch agent
2. Wait for ALL to return
3. Handle each result independently:
   - **approved** → mark completed
   - **needs_changes** → mark review completed, create fix task (`parallel_group_id: null`, `blockedBy: [review_task.id]`), create re-review task (`parallel_group_id: null`, `blockedBy: [fix_task.id]`). **Group-aware successor lookup:** look up the task's `parallel_group_id` in `pipeline-tasks.json.stages`, find the last index with that same group ID (= groupEnd), then successor = groupEnd + 1. If successor exists in stages, call `TaskUpdate(stages[successor].task_id, addBlockedBy: [re_review_task.id])`. If no successor (last stage), skip rewiring.
   - **rejected** → handle per Result Handling rules
4. Dynamic fix/re-review tasks always have `parallel_group_id: null` → they always execute sequentially
5. **Aggregated enrichment (replaces per-task step 8 for parallel members):** Do NOT enrich the successor task individually per parallel member — this causes last-write-wins races. Instead, after ALL parallel results are collected, build a single combined context block:
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
```

### Phase Cleanup Gate

**PRE-CONDITION:** Synthesis complete (Step 5 returned) AND user-story.json validated (Step 6 pre-condition check passed).

**After user-story.json is confirmed valid:**
1. Send `shutdown_request` to ALL specialist teammates via `SendMessage`
2. Track which specialists have confirmed shutdown
3. If any specialist has not confirmed after ~60 seconds (1-2 idle notifications without a shutdown confirmation), re-send `shutdown_request` to that specialist
4. If a specialist still has not confirmed after the retry, **proceed anyway** — mark requirements task as completed. Unresponsive teammates will be cleaned up when the pipeline team is deleted at completion.
5. Mark requirements task as completed via TaskUpdate
6. **Return control to the Main Loop.** Do NOT manually start the next stage — let the main loop call `TaskList()` to find the next unblocked task.

**Rationale:** Teammates may go idle without processing the shutdown request (known edge case). The pipeline team deletion at the end of the pipeline (`TeamDelete`) will clean up any lingering teammates, so it is safe to proceed past unresponsive specialists.

---

## Requirements Gathering (Team-Based, Default)

### Step 1: Analyze the Request

Always spawn all 5 core specialists. Determine if additional specialists are needed.

### Step 1.5: VCP Detection (Pre-Specialist)

Detect whether VCP is configured. Result is used only for the Security Analyst prompt.

1. Read `.vcp/config.json` from the project root. Extract the `pluginRoot` field.
   If `.vcp/config.json` does not exist, try `.vcp.json` as a fallback (legacy location).
   When `generate-context.ts` runs in step 5, its internal `loadConfig()` will auto-migrate
   `.vcp.json` → `.vcp/config.json` (see `vcp-context-core.ts:112-125`).
2. If neither file exists or `pluginRoot` is missing → `vcp_detected = false`. Skip to Step 2.
3. **Validate `pluginRoot`:** Must be absolute, contain `/.claude/` (or `\.claude\` on Windows),
   must NOT contain `..` path segments (prevents traversal bypassing the `.claude/` check),
   and contain only safe path characters (letters, digits, `/`, `\`, `-`, `_`, `.`, `:`, spaces).
   Reject shell metacharacters (`;`, `&`, `|`, `$`, `` ` ``, `(`, `)`, `{`, `}`, `<`, `>`, `!`,
   `~`, `#`, `*`, `?`, `[`, `]`, `'`, `"`). If invalid → `vcp_detected = false`. Skip to Step 2.
4. Verify `<pluginRoot>/lib/vcp-context-core.ts` exists via Glob.
   If missing → `vcp_detected = false`. Skip to Step 2.
5. Run the VCP context CLI:
   ```bash
   bun "<pluginRoot>/lib/generate-context.ts" "${CLAUDE_PROJECT_DIR}"
   ```
6. Capture stdout as `vcp_context_output`.
   If it starts with `"## VCP Standards Context"` → `vcp_detected = true`.
   Otherwise (fallback message, init prompt, or empty) → `vcp_detected = false`. Skip to Step 2.

Detection is silent — do not warn the user if VCP is not detected.

**Trust model:** The `standards_url` (in project or global config) is considered trusted.
Standards content fetched from this URL is injected into the analyst prompt without
sanitization. This is consistent with VCP's existing trust model — `standards_url`
is set by the developer during `/vcp-init` and points to a controlled repository.

### Step 2: Spawn Specialist Teammates [PARALLEL OK]

Read `team_name` from `.vcp/task/pipeline-tasks.json` and spawn specialist teammates:

```
Task(
  name: "technical-analyst",
  team_name: <team_name>,
  subagent_type: "general-purpose",
  model: "opus",
  prompt: "You are a Technical Analyst. Explore the codebase for [feature]. Message findings to lead. Write to .vcp/task/analysis-technical.json."
)
```

Always spawn all 5 core specialists. Spawn additional specialists as warranted.

**Security Analyst spawn (VCP-aware):**

If `vcp_detected == true`:
```
Task(
  name: "security-analyst",
  team_name: <team_name>,
  subagent_type: "general-purpose",
  model: "opus",
  prompt: "You are a Security Analyst. This project uses VCP standards.

VCP STANDARDS (use as your primary analysis checklist):
<vcp_context>
{vcp_context_output}
</vcp_context>

For each VCP standard listed above, evaluate whether [feature] introduces concerns.
The context contains standards in the format: **StandardName** (severity): rule1 | rule2 | ...
Extract every standard name that appears in the context above — those are the standards
you must evaluate and list in your output.

Also perform general OWASP Top 10 analysis for gaps not covered by VCP.
Compliance-tagged rules (GDPR, PCI-DSS, HIPAA) are included above if the
project has those scopes enabled — assess compliance implications where relevant.

Write to .vcp/task/analysis-security.json:
{
  \"specialist\": \"security\",
  \"vcp_active\": true,
  \"vcp_standards_referenced\": [\"Security\", \"Data Flow Security\", \"Dependency Management\"],
  \"summary\": \"Brief overall assessment\",
  \"findings\": [
    {
      \"area\": \"Input Validation\",
      \"severity\": \"high\",
      \"description\": \"User input flows to database query without parameterization\",
      \"vcp_rule\": \"Data Flow Security: Trace every path from source to sink\",
      \"recommendation\": \"Use parameterized queries for all database access\"
    }
  ],
  \"recommendations\": [\"Implement input validation at API boundary\"],
  \"constraints\": [\"Must use parameterized queries, not string concatenation\"],
  \"questions_for_user\": [\"Are there existing validation utilities we should reuse?\"]
}

The vcp_standards_referenced array MUST list every VCP standard name you found
in the context above. findings[].vcp_rule is optional — include it when a finding
maps to a specific VCP rule, omit for generic OWASP findings.

Message key findings to lead as you discover them."
)
```

If `vcp_detected == false`:
```
Task(
  name: "security-analyst",
  team_name: <team_name>,
  subagent_type: "general-purpose",
  model: "opus",
  prompt: "You are a Security Analyst. Perform OWASP Top 10 analysis for [feature].

Write to .vcp/task/analysis-security.json:
{
  \"specialist\": \"security\",
  \"vcp_active\": false,
  \"vcp_standards_referenced\": [],
  \"summary\": \"Brief overall assessment\",
  \"findings\": [
    {
      \"area\": \"Authentication\",
      \"severity\": \"medium\",
      \"description\": \"No rate limiting on login endpoint\",
      \"recommendation\": \"Add rate limiting to prevent brute force attacks\"
    }
  ],
  \"recommendations\": [\"Add rate limiting middleware\"],
  \"constraints\": [\"Follow OWASP authentication guidelines\"],
  \"questions_for_user\": [\"What authentication method is preferred?\"]
}

Message key findings to lead as you discover them."
)
```

**WAIT for ALL spawn calls to return before proceeding to Step 2.1.**

### Step 2.1: Spawn Verification Gate

After ALL Task spawn calls return, verify results:

1. Build `spawned_specialists` list: names of all specialists whose Task call returned successfully
2. Build `failed_specialists` list: names of all specialists whose Task call returned an error or timed out

**If ALL spawned successfully:** Set `approved_specialists = spawned_specialists`. Proceed to Step 3.

**If ANY failed:** STOP. Do NOT proceed. Do NOT decide to "continue with remaining specialists." Escalate:

```
AskUserQuestion:
  "{N} of {TOTAL} specialists failed to spawn: {failed names}.
   Options:
   1. Retry the failed specialists
   2. Continue with {TOTAL - N} specialists (missing: {failed names})
   3. Abort requirements gathering"
```

If user chooses retry: re-spawn only the failed ones, then re-verify.
If user chooses continue: set `approved_specialists = spawned_specialists` (excluding failed). Record which are skipped — this determines the expected files in Step 4.1.

**Carry forward:** The `approved_specialists` list is used by Step 4.1 and the synthesis prompt.

**Name-to-filename mapping:**

| Specialist Name | Expected File |
|----------------|---------------|
| `technical-analyst` | `analysis-technical.json` |
| `ux-domain-analyst` | `analysis-ux-domain.json` |
| `security-analyst` | `analysis-security.json` |
| `performance-analyst` | `analysis-performance.json` |
| `architecture-analyst` | `analysis-architecture.json` |

For additional specialists, the pattern is `analysis-{type}.json` where `{type}` matches the specialist name prefix.

**Note on stale files:** Step 1 runs `orchestrator.ts reset` which clears the entire `.vcp/task/` directory. Files from prior runs cannot exist when Step 4 runs.

### Step 3: Interactive Loop [INTERACTIVE LOOP]

Relay messages between specialists and the user. Each iteration follows a strict sequential order:

1. Receive incoming messages from specialists (automatic)
2. Summarize specialist questions → call `AskUserQuestion` to ask the user
3. **WAIT** for the user's answer (your response ends here — user's answer starts your next turn)
4. Call `SendMessage` to relay the user's answer to the relevant specialist(s)
5. Repeat from (1)

**Exit condition:** Specialists stop sending new messages AND analysis files should be ready.

**Within each iteration, calls are SEQUENTIAL (receive → ask → wait → send). Do NOT issue AskUserQuestion and SendMessage in the same response.**

**During this loop, do NOT:**
- Spawn any new agents
- Start synthesis (Step 5)
- Run Bash file-check commands
- Make any tool calls other than receiving messages, AskUserQuestion, and SendMessage

### Step 4: Validate Analysis Files

When the interactive loop winds down, validate the analysis files. Check both existence AND JSON shape:

```bash
bun -e "
try {
  const { readdirSync, readFileSync } = require('fs');
  const { join } = require('path');
  const dir = '${CLAUDE_PROJECT_DIR}/.vcp/task';
  const files = readdirSync(dir).filter(f => f.startsWith('analysis-') && f.endsWith('.json'));
  const results = files.map(f => {
    try {
      const data = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
      const valid = typeof data.specialist === 'string'
        && Array.isArray(data.findings)
        && data.findings.length > 0
        && typeof data.findings[0].area === 'string';
      return { file: f, valid, specialist: data.specialist, findings_count: data.findings?.length ?? 0 };
    } catch (e) { return { file: f, valid: false, error: 'invalid JSON: ' + e.message }; }
  });
  console.log(JSON.stringify({ ok: true, found: files, validated: results }, null, 2));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e.message }));
}
"
```

**WAIT** for the Bash result before proceeding.

### Step 4.1: Completion Verification Gate

Compare the validated files against `approved_specialists` from Step 2.1:

For each specialist in `approved_specialists`, check that:
1. The corresponding `analysis-{type}.json` file was found
2. The file has valid JSON with `specialist` and `findings` fields

**If ALL approved specialists have valid files:** Save the validation output. Proceed to Step 5.

**If ANY approved specialist's file is missing or invalid:** STOP. Escalate:

```
AskUserQuestion:
  "Analysis files incomplete:
   - Missing: {list of missing files}
   - Invalid: {list of files with bad JSON}
   Approved specialists: {approved_specialists list}
   Options:
   1. Wait longer (I'll re-check in a moment)
   2. Proceed with available valid analyses (missing: {list})
   3. Abort requirements gathering"
```

If user chooses wait: re-run Step 4.
If user chooses proceed: note the missing/invalid analyses for the synthesis prompt.

### Step 5: Synthesize via Requirements Gatherer

**PRE-CONDITION:** Step 4.1 must have passed. All approved files confirmed valid (or user approved partial).

**This is a single Task call.** Do NOT combine with any other operation.

Include the validation output from Step 4 in the prompt:

```
Task(
  subagent_type: "dev-buddy:requirements-gatherer",
  model: "opus",
  prompt: "Synthesis mode.
    APPROVED SPECIALISTS: {approved_specialists list from Step 2.1}
    VALIDATED ANALYSIS FILES (from Step 4):
    {paste the validation JSON output here}
    {if partial: 'MISSING/INVALID ANALYSES: {list}. Account for gaps in user story.'}
    Read the validated analysis files from .vcp/task/.
    Validate scope with user via AskUserQuestion.
    Get explicit approval before writing user-story.json."
)
```

**WAIT** for the requirements-gatherer to return before proceeding to Step 6.

**If the requirements-gatherer fails:** STOP. Escalate to user via AskUserQuestion.

### Step 6: Shut Down Specialist Teammates

**PRE-CONDITION:** Step 5 MUST have returned. Verify user-story.json exists and is valid:

```bash
bun -e "
try {
  const { readFileSync } = require('fs');
  const data = JSON.parse(readFileSync('${CLAUDE_PROJECT_DIR}/.vcp/task/user-story.json', 'utf-8'));
  const valid = typeof data.title === 'string' && Array.isArray(data.acceptance_criteria) && data.acceptance_criteria.length > 0;
  console.log(JSON.stringify({ exists: true, valid, title: data.title, ac_count: data.acceptance_criteria?.length }));
} catch (e) {
  console.log(JSON.stringify({ exists: false, valid: false, error: e.message }));
}
"
```

**WAIT** for result. If file missing or invalid, STOP and escalate to user via AskUserQuestion.

**If user-story.json is valid:**
1. Send `shutdown_request` to ALL specialist teammates via SendMessage
2. **WAIT** for confirmations (~60s)
3. Re-send once to unresponsive specialists
4. If still unresponsive, proceed — TeamDelete at pipeline end will clean up
5. Mark requirements task completed via TaskUpdate
6. **Return control to the Main Loop.** Do NOT manually start the next stage.

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
// stageIndex = index of this stage in pipeline-tasks.json.stages[]
// current_task_id = task ID from main loop
// iteration = derived from TaskList: count existing "Fix [subject] v*" tasks + 1

issues = read stage.output_file → extract blockers + critical/high findings (≤ 500 chars)

fix = TaskCreate(
  subject: "Fix {stage subject} v{iteration}",
  activeForm: "Fixing issues...",
  description: "PHASE: Fix issues from {stage subject} review
AGENT: dev-buddy:{planner|implementer} (model: {opus|sonnet})
INPUT: .vcp/task/{stage.output_file} (issues), {source_file} (current artifact)
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
OUTPUT: .vcp/task/{stage.output_file}  ← SAME OUTPUT FILE (overwrite)
NOTE: Re-review after fix. Same stage index ({stage.stageIndex}), same output file.
{if CLI stage: pass --output-file .vcp/task/{stage.output_file} and optional --model}
RESULT HANDLING: Same as original stage
COMPLETION: .vcp/task/{stage.output_file} exists with updated status"
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
    --output-file '${CLAUDE_PROJECT_DIR}/.vcp/task/{stage.output_file}'
  Review the {plan|code} and write output to the specified file."
  // Do NOT add team_name or name. One-shot subagent, NOT a teammate.
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

### Spawning Workers (One-Shot Subagents — NO team_name)

```
Task(
  subagent_type: "dev-buddy:<agent-name>",
  model: "<model>",
  prompt: "[Agent instructions] + [Context from .vcp/task/ files]"
  // Do NOT add team_name or name. These are one-shot subagents, NOT teammates.
)
```

For CLI reviews:
```
Task(
  subagent_type: "dev-buddy:cli-executor",
  prompt: "[Agent instructions] + pass --preset, --model, and --output-file"
  // Do NOT add team_name or name. These are one-shot subagents, NOT teammates.
)
```

**IMPORTANT:** Do NOT use `team_name` when spawning worker agents for pipeline stages. Only the requirements gathering phase uses `Task(team_name: ...)` for specialist teammates. All other phases (planning, reviews, implementation, fixes) spawn one-shot subagents without `team_name`. Parallel review groups dispatch multiple one-shot `Task()` calls concurrently (not via team spawning).

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
  "config_hash": "<sha256-of-JSON.stringify(loadPipelineConfig())>",
  "resolved_config": {
    "feature_pipeline": [...],
    "bugfix_pipeline": [...],
    "max_iterations": 10,
    "team_name_pattern": "pipeline-{BASENAME}-{HASH}"
  },
  "stages": [
    { "type": "requirements", "provider": "...", "providerType": "subscription", "model": "opus", "output_file": "user-story.json", "task_id": "4", "parallel_group_id": null },
    { "type": "plan-review", "provider": "...", "providerType": "subscription", "model": "sonnet", "output_file": "plan-review-1.json", "task_id": "7", "parallel_group_id": 1 }
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
2. Read `team_name` from `.vcp/task/pipeline-tasks.json` and use `TeamDelete` with it to clean up
3. Shutdown session managers:
   ```bash
   bun "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-config.ts" shutdown --cwd "${CLAUDE_PROJECT_DIR}"
   ```

## Provider Routing

**If provider type is `subscription`:** Use Task tool (NO `team_name` — one-shot subagent):
```
Task(subagent_type: "dev-buddy:<agent-name>", model: "<model>", prompt: "...")
// Do NOT add team_name or name parameters. This is a one-shot subagent, NOT a teammate.
```

**If provider type is `api`:** Use curl to the session manager port from `.vcp/task/session-ports.json`.

**Derive timeout:** Read `~/.vcp/presets.json` → find the preset matching the stage's `provider` name → read `timeout_ms`. Compute `TIMEOUT_SECONDS = Math.ceil(timeout_ms / 1000)` (default: 300 if `timeout_ms` is not set or preset lookup fails). Set the Bash tool's `timeout` parameter to `timeout_ms + 30000` (or 330000 if not set or lookup fails) so the Bash tool outlives the curl request.

```bash
curl -s --connect-timeout 10 --max-time {TIMEOUT_SECONDS} \
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
3. **No phase skipping** — ALL phases execute in order. Exception: Resume path (Step 0) skips already-completed stages by creating pre-completed tasks. Pre-existing plans are INPUT, not substitutes.
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
14. **Team-based execution is ONLY for requirements gathering** — Spawn specialist teammates (via `Task(team_name: ...)` and `SendMessage`) ONLY during the requirements gathering phase. ALL other phases (planning, plan-review, implementation, code-review, fix tasks, re-reviews) use one-shot `Task()` calls WITHOUT `team_name`. Parallel review groups dispatch concurrent one-shot `Task()` calls — not team-spawned teammates. Never spawn teammates outside requirements gathering. The pipeline team exists for task tool availability — not for spawning workers in every phase.
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
