# Pipeline Resume Detection and Initialization

> **When to execute:** At pipeline start (Step 0). The orchestrator runs this BEFORE fresh initialization to detect and optionally resume a previous pipeline run.

---

## Step 0: Resume Detection

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
      // requirements/planning outputs lack 'status' — detect via content
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

**If `exists == false`** -> Fresh run. Proceed to fresh initialization (Step 1).

**If `exists == true`** -> Check pipeline type compatibility:
- If `pipeline_type` does not match the invoked command -> AskUserQuestion: "Previous pipeline is a **{pipeline_type}** run, but you invoked `{PIPELINE_COMMAND}`. Options: 1. Start fresh (reset and begin new pipeline). 2. Resume the existing **{pipeline_type}** pipeline instead (use `{opposite_command}`)." where `{opposite_command}` is `/dev-buddy-bug-fix` if current is feature or `/dev-buddy-feature-implement` if current is bug-fix. If start fresh -> proceed to Step 1. If resume existing -> stop (user will re-invoke with the correct command).

**If compatible** -> Previous pipeline detected. Ask the user:

```
AskUserQuestion:
  "Previous {PIPELINE_TYPE} pipeline detected:
   Team: {team_name}
   Progress: {completed}/{total} stages complete
   Current phase: {determine from stageStatus}

   1. Resume from where it left off
   2. Start fresh (reset and begin new pipeline)
   3. Show detailed status"
```

- **"Start fresh"** -> Proceed to Step 1.
- **"Show status"** -> Display stageStatus table, re-ask.
- **"Resume"** -> Execute Step 0.1 through Step 0.5:

### Step 0.1: Safety Checks + Config Drift Detection

```
// Check orchestrator lock — prevent conflicting concurrent runs
lockPath = "${CLAUDE_PROJECT_DIR}/.vcp/task/.orchestrator.lock"
If lock file exists:
  Read PID from lock, check if process alive (kill -0)
  If alive -> STOP: "Another pipeline session is running (PID {pid})"
  If dead -> remove stale lock, continue
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

### Step 0.2: Re-create Pipeline Team

Claude Code teams are session-scoped — when a session terminates, the team is already gone. TeamDelete here is a cleanup no-op for stale metadata.

```
team_name = from pipeline-tasks.json.team_name
TeamDelete(team_name)   <- ignore errors (expected: team already gone with dead session)
TeamCreate(team_name, description: "{PIPELINE_TYPE} pipeline (resumed)")
TaskList()              <- verify returns [] (fresh team, no tasks yet)
```

### Step 0.3: Re-create Task Chain (Remaining Stages)

**Two-pass approach** (ensures all task IDs exist before rewiring):

```
// Explicit initialization
stages = pipeline-tasks.json.stages    // array from stored snapshot
taskIdMap = {}                          // index -> recreated task ID
needsChangesList = []                   // indices needing fix+re-review in Pass 3
statusMap = {}                          // index -> target status ('completed' | 'pending')
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
  // Must be a parallel-capable stage (plan-review, code-review, or rca)
  if stages[i].type !== 'plan-review' AND stages[i].type !== 'code-review' AND stages[i].type !== 'rca':
    log warning: "Stage {i} has parallel_group_id={gid} but type={stages[i].type}; resetting to null"
    stages[i].parallel_group_id = null
    continue
  // Must form contiguous runs of same type
  if i > 0 AND stages[i-1].parallel_group_id === gid AND stages[i-1].type !== stages[i].type:
    log warning: "Stage {i} has parallel_group_id={gid} but type differs from adjacent stage; resetting to null"
    stages[i].parallel_group_id = null
```

**Pre-check — Gate rejection terminal states:** Before creating tasks, check for gate rejection flags that indicate a terminal pipeline state:

1. **Per-stage gate rejection:** If any `stages[i].gate_rejected === true`:
   - AskUserQuestion: "Stage {type} {index} was rejected at its review gate. Options: 1. Restart from this stage (clear the gate_rejected flag and re-run). 2. Abort pipeline."
   - If restart: set `stages[i].gate_rejected = false`. **Delete the stage's output file** (`rm .vcp/task/{stages[i].output_file}`) so that `file_status` becomes `no_output_file` → pending in Pass 1. Update `pipeline-tasks.json`, then continue to Pass 1.
   - If abort: report to user, EXIT.

2. **RCA group gate rejection:** If `pipeline-tasks.json` top-level has `rca_gate_rejected === true`:
   - AskUserQuestion: "Pipeline was rejected at the RCA group review gate. Options: 1. Restart from the first non-RCA stage (clear the flag and re-run from plan-review/implementation). 2. Abort pipeline."
   - If restart: remove `rca_gate_rejected` from `pipeline-tasks.json`. **Delete consolidation output** (`rm -rf .vcp/task/user-story/ .vcp/task/plan/`) so that consolidation re-runs on resume if RCA stages are re-examined. Find first non-RCA stage index. For all stages at or after that index, their `file_status` will already be `no_output_file` (they haven't run). Update `pipeline-tasks.json`, then continue to Pass 1.
   - If abort: report to user, EXIT.

**Pass 1 — Create all tasks (pending):** For each stage in `stages` (index 0..N), create a task as **pending** regardless of actual status. Store `taskIdMap[i] = task.id`. Determine target status using the `file_status` (now on each stage entry) from Step 0's detection script (which already handles stage-type-aware completion for requirements/planning/RCA):

- **`file_status === 'complete'` or `'approved'`**: `statusMap[i] = 'completed'`
- **`file_status === 'needs_changes'`**: `statusMap[i] = 'completed'`. Append i to `needsChangesList`.
- **`file_status === 'rejected'`**: AskUserQuestion: "Stage {type} {index} was rejected. Options: 1. Start fresh. 2. Treat as needs_changes." If start fresh -> Step 1. If needs_changes -> `statusMap[i] = 'completed'`, append i to `needsChangesList`.
- **All other `file_status` values** (`'failed'`, `'needs_clarification'`, `'partial'`, `'pending'`, `'unknown'`, `'invalid'`, `'no_output_file'`): `statusMap[i] = 'pending'` (task stays pending, stage re-runs).

This mapping works for all stage types because the Step 0 detection script already produces `'complete'` for valid outputs that lack a `status` field (requirements via `artifact + ac_count`, planning via `artifact + step_count`, RCA via `root_cause.summary + root_cause.root_file`).

**Pass 2 — Restore dependency edges:** For each stage in `stages` (index 0..N), apply `blockedBy` using the same fan-out/fan-in logic as normal task chain creation, using `stages[i].parallel_group_id`:

- If `stages[i].parallel_group_id` is non-null AND same as previous stage's group -> fan-out: `TaskUpdate(taskIdMap[i], addBlockedBy: predecessors)` (same predecessors as other group members)
- If starting a new parallel group -> compute predecessors from `previousTaskId` or `groupPredecessors`, apply to all group members
- If sequential (null group ID) -> `TaskUpdate(taskIdMap[i], addBlockedBy: [previousTaskId])` or fan-in from `groupPredecessors`
- Track `previousTaskId` and `groupPredecessors` identically to the normal task chain creation algorithm

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

**Pipeline-specific edge cases:**

**If pipeline_type == "feature-implement":**
- `user-story/manifest.json` exists + valid -> requirements complete
- Analysis files exist but no user-story -> run requirements-gatherer in direct synthesis mode
- No analysis files and no user-story -> requirements pending, run in direct mode

**If pipeline_type == "bug-fix":**
- RCA output files do NOT have a `status` field (unlike review/implementation outputs). The resume detection script detects RCA completion via `root_cause.summary` and `root_cause.root_file` — if both are populated, the stage is `complete`. If not, it's `unknown` (treated as pending, stage re-runs).
- If all rca-*.json files are complete AND no user-story/manifest.json exists -> run inline Orchestrator Consolidation first (before entering Main Loop).

### Step 0.5: Enter Main Loop

Jump to existing Main Loop. `TaskList()` finds next unblocked task.
