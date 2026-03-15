---
name: dev-buddy-bug-fix
description: Bug fix pipeline — chains root cause analysis, requirements, planning, plan review, implementation, and code review stage skills using the configured bugfix_pipeline
user-invocable: true
allowed-tools: Read, Write, Bash, Glob, Grep, Skill, AskUserQuestion
---

# Bug Fix Pipeline Orchestrator

Run the full bug fix pipeline end-to-end. Chains individual stage skills in the order defined by `bugfix_pipeline` in `~/.vcp/dev-buddy.json`.

**Task directory:** `${CLAUDE_PROJECT_DIR}/.vcp/task/`

---

## Step 1: Initialize

1. Create `.vcp/task/` directory if it doesn't exist
2. Save the user's bug report to `.vcp/task/requirements-prompt.md`
3. Load the pipeline config and expand stages:

```bash
bun -e "
import { loadDevBuddyConfig, expandPipelineToEntries } from '${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-config.ts';
const config = loadDevBuddyConfig();
const stages = expandPipelineToEntries(config, 'bugfix_pipeline');
console.log(JSON.stringify({
  pipeline: config.bugfix_pipeline,
  stages,
  max_iterations: config.max_iterations
}));
"
```

4. Write `.vcp/task/pipeline-tasks.json`:
```json
{
  "pipeline_type": "bug-fix",
  "stages": [<expanded stage entries>],
  "created_at": "ISO8601"
}
```

5. Display the pipeline stages to the user:
```
Bug Fix Pipeline: rca → requirements → planning → plan-review → implementation → code-review
Executors: {count} total across {stage_count} stages
```

---

## Step 2: Execute Stages in Order

For each stage type in `bugfix_pipeline`:

### Stage-to-Skill Mapping

| Stage Type | Skill | Notes |
|---|---|---|
| `rca` | `Skill(skill: "dev-buddy-rca")` | Root cause analysis. Outputs `rca-diagnosis.json`. |
| `requirements` | `Skill(skill: "dev-buddy-requirements")` | Auto-picks up `rca-diagnosis.json` as context |
| `planning` | `Skill(skill: "dev-buddy-plan")` | Creates fix plan with TDD test cases |
| `plan-review` | `Skill(skill: "dev-buddy-review", args: "--plan")` | Reviews plan. Owns review→repair→re-review loop. |
| `implementation` | `Skill(skill: "dev-buddy-implement")` | Implements fix with TDD loop |
| `code-review` | `Skill(skill: "dev-buddy-review", args: "--code")` | Reviews code. Owns review→repair→re-review loop. |

### Execution Flow

Same as feature pipeline:
1. Announce each stage
2. Invoke the corresponding skill
3. Verify output artifact exists
4. If a review stage returned `rejected` → **STOP the pipeline**

---

## Step 3: Report

After all stages complete:
1. Present per-stage status summary
2. If all stages passed → "Bug fix pipeline complete!"
3. If any stage was rejected → report which stage and remaining findings
