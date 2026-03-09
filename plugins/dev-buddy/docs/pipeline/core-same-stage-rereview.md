# Dynamic Tasks: Same-Stage Re-Review

> **When to execute:** From the main loop when a review returns `needs_changes`. The **same stage (same index)** must re-review the fix.

---

## Core Rule

**CRITICAL: Re-review returns to the SAME STAGE INDEX, not the next stage.**

If stage index 2 (e.g., `code-review-anthropic-subscription-opus-2-v1.json`) returns `needs_changes`:
- Fix task targets the code issue
- Re-review creates a **NEW versioned file** (`code-review-anthropic-subscription-opus-2-v2.json`)
- `stages[].output_file` is updated AFTER re-review completes (two-phase update)
- Stage index 3 is NOT started until stage index 2 approves

---

## needs_changes -> Fix + Re-Review (Two-Phase Update)

```
// stage = the pipeline stage entry that returned needs_changes (from stages[] in pipeline-tasks.json)
// stageIndex = index of this stage in pipeline-tasks.json.stages[]
// current_task_id = task ID from main loop
// iteration = derived from TaskList: count existing "Fix [subject] v*" tasks + 1

issues = read stage.output_file -> extract blockers + critical/high findings (<= 500 chars)

// PHASE 1: Compute next version output file (stages[] NOT updated yet — keeps old output_file
// pointing to v{N} with needs_changes status so determinePhase() still detects "fix" phase)
nextVersion = stages[stageIndex].current_version + 1
nextOutputFile = getOutputFileName(stage.type, stage.stageIndex, stage.provider, stage.model, nextVersion)

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
OUTPUT: .vcp/task/{nextOutputFile}  <- NEW VERSION FILE (append-only, old versions preserved)
NOTE: Re-review after fix. Same stage index ({stage.stageIndex}), new version file.
{if CLI stage: pass --output-file .vcp/task/{nextOutputFile} and optional --model}
RESULT HANDLING: Same as original stage
COMPLETION: .vcp/task/{nextOutputFile} exists with updated status"
)
TaskUpdate(rerev.id, addBlockedBy: [fix.id])

// Group-aware successor lookup:
groupId = stage.parallel_group_id ?? null
if groupId is not null:
  groupEnd = max index j where stages[j].parallel_group_id === groupId
  successorIndex = groupEnd + 1
else:
  successorIndex = stageIndex + 1
if successorIndex < stages.length:
  TaskUpdate(stages[successorIndex].task_id, addBlockedBy: [rerev.id])

// PHASE 2: After re-review agent completes and orchestrator reads its result:
stages[stageIndex].current_version = nextVersion
stages[stageIndex].output_file = nextOutputFile
// Write updated pipeline-tasks.json to disk
```

---

## Iteration Tracking

Derive iteration count from TaskList. After **max_iterations** re-reviews total across all pipeline stages, escalate to user. The `max_iterations` value comes from `resolved_config.max_iterations` in pipeline-tasks.json (default: 10).

---

## Versioned File Naming

Multi-instance stages: `{type}-{provider}-{model}-{index}-v{version}.json` (e.g., `code-review-anthropic-subscription-sonnet-1-v1.json`). Singleton stages: `user-story/manifest.json`, `plan/manifest.json`, `impl-result.json`. Re-reviews create new versioned files (append-only).
