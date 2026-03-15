---
name: dev-buddy-feature-implement
description: Full feature development pipeline — chains requirements, planning, plan review, implementation, and code review stage skills using the configured feature_pipeline
user-invocable: true
allowed-tools: Read, Write, Bash, Glob, Grep, Skill, AskUserQuestion
---

# Feature Pipeline Orchestrator

Run the full feature development pipeline end-to-end. Chains individual stage skills in the order defined by `feature_pipeline` in `~/.vcp/dev-buddy.json`.

**Task directory:** `${CLAUDE_PROJECT_DIR}/.vcp/task/`

---

## Step 1: Initialize

1. Create `.vcp/task/` directory if it doesn't exist
2. Save the user's original request to `.vcp/task/requirements-prompt.md`
3. Load the pipeline config and expand stages:

```bash
bun -e "
import { loadDevBuddyConfig, expandPipelineToEntries } from '${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-config.ts';
const config = loadDevBuddyConfig();
const stages = expandPipelineToEntries(config, 'feature_pipeline');
console.log(JSON.stringify({
  pipeline: config.feature_pipeline,
  stages,
  max_iterations: config.max_iterations
}));
"
```

4. Write `.vcp/task/pipeline-tasks.json`:
```json
{
  "pipeline_type": "feature-implement",
  "stages": [<expanded stage entries>],
  "created_at": "ISO8601"
}
```

5. Display the pipeline stages to the user:
```
Feature Pipeline: requirements → planning → plan-review → implementation → code-review
Executors: {count} total across {stage_count} stages
```

---

## Step 2: Execute Stages in Order

For each stage type in `feature_pipeline`:

### Stage-to-Skill Mapping

| Stage Type | Skill | Notes |
|---|---|---|
| `requirements` | `Skill(skill: "dev-buddy-requirements")` | Gathers requirements, creates user-story artifacts |
| `planning` | `Skill(skill: "dev-buddy-plan")` | Creates implementation plan with TDD test cases |
| `plan-review` | `Skill(skill: "dev-buddy-review", args: "--plan")` | Reviews plan. Owns review→repair→re-review loop internally. |
| `implementation` | `Skill(skill: "dev-buddy-implement")` | Implements plan with TDD loop |
| `code-review` | `Skill(skill: "dev-buddy-review", args: "--code")` | Reviews code. Owns review→repair→re-review loop internally. |

### Execution Flow

For each stage:
1. Announce: `**Stage: {stage_type}** — dispatching...`
2. Invoke the corresponding skill (see mapping above)
3. After skill completes, verify the expected output artifact exists
4. If a review stage returned `rejected` after exhausting its iteration budget → **STOP the pipeline** and report to user

**IMPORTANT:** Review stages (`plan-review`, `code-review`) handle their own review→repair→re-review loops internally via `/dev-buddy-review`. The orchestrator just invokes the skill once and waits for it to complete. Do NOT implement loop logic here.

---

## Step 3: Report

After all stages complete:
1. Present per-stage status summary
2. If all stages passed → "Feature pipeline complete!"
3. If any stage was rejected → report which stage and the remaining must_fix findings
