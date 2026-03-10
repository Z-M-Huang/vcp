# Pipeline Fresh Initialization and Task Chain Creation

> **When to execute:** Steps 1 through 2 of pipeline initialization. Runs when resume detection determines a fresh start, or when no previous pipeline exists.

---

## Step 1: Reset Pipeline

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.ts" reset --cwd "${CLAUDE_PROJECT_DIR}"
```

## Step 1.1: Validate Pipeline Config

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-config.ts" validate --cwd "${CLAUDE_PROJECT_DIR}"
```

If validation fails, report the missing/invalid providers to the user and stop.

## Step 1.2: Load Config and Resolve Stages

Read the pipeline config using Bash:

```bash
bun -e "
import { loadPipelineConfig } from '${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-config.ts';
import { STAGE_DEFINITIONS, getOutputFileName } from '${CLAUDE_PLUGIN_ROOT}/types/stage-definitions.ts';
import { readPresets } from '${CLAUDE_PLUGIN_ROOT}/scripts/preset-utils.ts';

const config = loadPipelineConfig();
const presets = readPresets();
const pipeline = config.{PIPELINE_CONFIG_KEY};

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

Where `{PIPELINE_CONFIG_KEY}` is `feature_pipeline` or `bugfix_pipeline` depending on the pipeline type.

Store the resulting `resolved` array and full `config` in memory. Each element has:
- `type` — stage type (e.g., 'requirements', 'plan-review', 'rca')
- `provider` — preset name
- `model` — model identifier (required)
- `stageIndex` — 1-based index among stages of the same type
- `outputFile` — computed output file name (e.g., 'plan-review-anthropic-subscription-sonnet-1-v1.json', 'impl-result.json')
- `arrayIndex` — 0-based position in the pipeline array
- `providerType` — resolved provider type: `'subscription'`, `'api'`, or `'cli'`. **Note:** This is the JSON-serialized field name used in `pipeline-tasks.json` stages. The TypeScript `ResolvedStage` interface uses `provider_type` (snake_case) internally; the orchestrator writes `providerType` (camelCase) to JSON.

**If pipeline_type == "bug-fix":** Also identify RCA stages: all consecutive `rca` type entries at the beginning of the pipeline.

## Step 1.3: Create Pipeline Team (Idempotent)

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
TeamDelete(team_name: "pipeline-{BASENAME}-{HASH}")   <- ignore errors
TeamCreate(team_name: "pipeline-{BASENAME}-{HASH}", description: "{PIPELINE_TYPE} pipeline orchestration and task management")
```

Store team name in `.vcp/task/pipeline-tasks.json` as `team_name` field.

## Step 1.4: Verify Task Tools Available

```
result = TaskList()
```

**Success:** TaskList() returns an empty array `[]`. Proceed to Step 2.
**Stale tasks detected:** Stop and report to user.
**Tool error:** Stop and report to user.

## Step 2: Create Task Chain (Data-Driven from Config)

**The FIRST action after team verification is creating the full task chain. No agents are spawned before the task chain exists.**

**CRITICAL: Call the TaskCreate and TaskUpdate tools directly.**

**TaskCreate API:**
- Parameters: `subject`, `description`, `activeForm`
- Returns: task object with `id` field
- **TaskCreate does NOT accept `blockedBy`.** Set dependencies via TaskUpdate after creation.

**Task chain creation algorithm:**

For each stage in the resolved pipeline array (in order), create one task. Non-review stages are always sequential (each blocked by the previous). Stages with `parallel: true` form fan-out/fan-in groups (applies to `plan-review`, `code-review`, and `rca` types).

```
// --- Parallel Group Detection ---
// Identify groups of consecutive same-type stages with parallel: true
parallelGroups = []
i = 0
while i < resolved.length:
  stage = resolved[i]
  if stage.type not in ['plan-review', 'code-review', 'rca'] OR !stage.parallel:
    i++
    continue
  j = i + 1
  while j < resolved.length AND resolved[j].type === stage.type AND resolved[j].parallel === true:
    j++
  if (j - i) >= 2:  // 2+ consecutive = valid parallel group
    parallelGroups.push({ start: i, end: j - 1, type: stage.type })
  i = j

// --- Task Chain Creation (with parallel group support) ---
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

| Stage Type | Singleton | Multi-instance |
|-----------|-----------|----------------|
| requirements | "Gather requirements" | N/A |
| planning | "Create implementation plan" | N/A |
| rca | N/A | "RCA {stageIndex}" + model suffix if set |
| plan-review | N/A | "Plan Review {stageIndex}" + model suffix if set |
| implementation | "Implementation" | N/A |
| code-review | N/A | "Code Review {stageIndex}" + model suffix if set |

Model suffix: if stage.model is set, append " - {capitalized model}" (e.g., " - Sonnet", " - Opus"). If stage.provider is a CLI preset (determined from preset config): append " - Codex" (or the CLI tool name).

**Save to `.vcp/task/pipeline-tasks.json`** using actual returned IDs:
```json
{
  "team_name": "pipeline-{name}-{hash}",
  "pipeline_type": "{PIPELINE_TYPE}",
  "config_hash": "<sha256-of-JSON.stringify(loadPipelineConfig())>",
  "resolved_config": {
    "feature_pipeline": [/* full StageEntry array from config */],
    "bugfix_pipeline": [/* full StageEntry array from config */],
    "max_iterations": 10,
    "team_name_pattern": "pipeline-{BASENAME}-{HASH}"
  },
  "stages": [/* array of stage entries with task_id, parallel_group_id, current_version */]
}
```

The `resolved_config` field is the FULL PipelineConfig snapshot. Hooks read stage information from this snapshot, never from `~/.vcp/dev-buddy.json` directly.

**Verify:** After creating all tasks, call `TaskList()`. You should see N tasks (where N = length of the pipeline array). Sequential stages form a linear chain; parallel groups share the same predecessor (fan-out) and the next stage waits for all group members (fan-in).

**max_iterations from config:** The orchestrator uses `resolved_config.max_iterations` (default 10) to limit fix/re-review cycles. After max_iterations total re-reviews across all stages in the pipeline, escalate to user.
