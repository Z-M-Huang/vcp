---
name: dev-buddy-run
description: Run a named pipeline end-to-end. Usage /dev-buddy-run <pipeline-name>. Chains stage skills in the order defined by the pipeline config. Uses single plan file and TaskManagement for progress tracking.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Skill, AskUserQuestion, TaskCreate, TaskUpdate, TaskList, TaskGet
---

# Pipeline Runner

Run any named pipeline end-to-end. All phases append to a single plan file. Uses TaskManagement for progress tracking across context compactions.

**Usage:** `/dev-buddy-run <pipeline-name>` (e.g., `/dev-buddy-run feature`, `/dev-buddy-run bug-fix`, `/dev-buddy-run hotfix`)

---

## Step 1: Initialize

1. Parse the pipeline name from args. If no name provided, load config and list available pipelines, then ask the user which to run.

2. Load the pipeline config and expand entries:

```bash
bun -e "
import { loadDevBuddyConfig, expandPipelineToEntries } from '${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-config.ts';
const config = loadDevBuddyConfig();
const pipelineName = '{PIPELINE_NAME}';
const pipelineStages = config.pipelines[pipelineName];
if (!pipelineStages) {
  console.log(JSON.stringify({ error: 'not_found', available: Object.keys(config.pipelines) }));
} else {
  const stages = expandPipelineToEntries(config, pipelineName);
  console.log(JSON.stringify({
    pipeline: pipelineStages,
    stages,
    max_iterations: config.max_iterations
  }));
}
"
```

3. If pipeline not found → display available pipelines and ask the user to choose.

4. Display the pipeline stages to the user:
```
Pipeline: {pipeline_name}
Stages: {stage1} → {stage2} → ... → {stageN}
Executors: {count} total across {stage_count} stages
```

5. **Initialize plan file** if it doesn't already exist. Create via the Write tool:
```markdown
# Plan: {User's description (short title)}
**Status:** {first_stage_type}
**Pipeline:** {pipeline_name}
**Created:** {date}

---
```

6. **Create pipeline phase tasks with TaskManagement:**

For each stage type in the pipeline, create a task:
```
T_{stage} = TaskCreate(subject='Phase: {Stage Display Name}', description='{stage description}', activeForm='{active form}...')
```

Set up blocking dependencies so each phase depends on the previous one.

---

## Step 2: Execute Stages in Order

For each stage type in the pipeline:

### Stage-to-Skill Mapping

| Stage Type | Skill | Plan File Section Produced |
|---|---|---|
| `rca` | `Skill(skill: "dev-buddy-rca")` | RCA Diagnosis |
| `requirements` | `Skill(skill: "dev-buddy-requirements")` | Requirements + TDD Test Plan + Risk Registry |
| `planning` | `Skill(skill: "dev-buddy-plan")` | Implementation Steps |
| `plan-review` | `Skill(skill: "dev-buddy-review", args: "--plan")` | Plan Review Record |
| `implementation` | `Skill(skill: "dev-buddy-implement")` | Step status updates |
| `code-review` | `Skill(skill: "dev-buddy-review", args: "--code")` | Code Review Record + Sign-off |

### Execution Flow

For each stage:
1. `TaskUpdate(phase_task_id, status: 'in_progress')`
2. Announce: `**Stage: {stage_type}** — dispatching...`
3. Invoke the corresponding skill (see mapping above)
4. After skill completes, verify the expected plan file section exists (Read the plan file, check for the section header)
5. `TaskUpdate(phase_task_id, status: 'completed')`
6. If a review stage status is `rejected` (check for `**Status:** rejected` in the review record section) → **STOP the pipeline**, `TaskUpdate(phase_task_id, status: 'blocked')`, report to user

**IMPORTANT:** Review stages handle their own repair loops internally. The orchestrator just invokes once and waits.

---

## Step 3: Resume Support

If context is compacted mid-pipeline:
1. `TaskList()` — find which phase tasks are completed vs pending
2. Read the plan file — check which sections exist
3. Skip completed phases, continue from the next pending one

---

## Step 4: Report

After all stages complete:
1. Present per-stage status summary
2. `TaskList()` to show final task statuses
3. If all stages passed → "Pipeline '{pipeline_name}' complete!"
4. If any stage was rejected → report which stage and remaining findings
