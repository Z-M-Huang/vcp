# Pipeline Main Loop

> **When to execute:** After task chain creation (fresh start) or after resume initialization. This is the core execution loop that drives the pipeline to completion.

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
           -> [PARALLEL OK] Execute all simultaneously (see Parallel Execution below)
         If group IDs differ OR any is null:
           -> Sort by stage index (look up each task_id in pipeline-tasks.json.stages to get its index), pick lowest index first, execute sequentially
       If ONE unblocked task -> execute it normally
       If NO unblocked tasks and tasks remain -> pipeline is stuck, report to user
    3. Call TaskGet(task.id) — read full description with AGENT, MODEL, INPUT, OUTPUT
    4. Call TaskUpdate(task.id, status: "in_progress")
    5. Execute task:
       a. Look up current task in pipeline-tasks.json stages array (match by task_id)
       b. **PHASED REVIEW CHECK (before provider routing):**
          If `stage.type == 'implementation'`:
            Find the matching stage entry in `resolved_config` pipeline array by matching
            the stage's index position in `pipeline-tasks.json.stages` among implementation-type entries.
            If that resolved_config entry has a non-empty `phased_reviews` array:
              -> **Execute [core-phased-implementation.md](core-phased-implementation.md).**
              -> When the loop completes (all steps done, `impl-result.json` written), skip to step 6.
              -> Do NOT fall through to the providerType routing.
       c. **ROUTE BY PROVIDER TYPE** — Execute [core-provider-dispatch.md](core-provider-dispatch.md)
          using the stage's `providerType` field.
       - Parse AGENT, MODEL, INPUT, OUTPUT from task description for the prompt content
       - **NEVER use team_name when spawning agents** (except requirements gathering specialists in the feature pipeline)
    6. Check output file (from description's OUTPUT field) for result
    7. **RCA CONSOLIDATION CHECK** (bug-fix pipeline only, inline, before handling result):
       After completing a task, look up `completedStageIndex` in pipeline-tasks.json stages (match by task_id):
         (a) `completedStage = stages[completedStageIndex]` — check if `.type === 'rca'`
         (b) `nextStage = stages[completedStageIndex + 1]` — check if null or `.type !== 'rca'`
       If BOTH conditions are true: execute [bugfix-rca-consolidation.md](bugfix-rca-consolidation.md)
       BEFORE dispatching next task.
    8. Handle result (see Result Handling below)
    9. Enrich next task (BEFORE marking completed — sequential tasks only, NOT parallel group members):
       - Skip this step if the task was executed as part of a parallel group (see Parallel Execution step 5 for aggregated enrichment)
       - Read output file, extract key context (<= 500 chars)
       - Find next task: call TaskList(), find task whose blockedBy includes current task ID
       - Call TaskGet(next_task_id) to read current description
       - Call TaskUpdate(next_task_id, description: <enriched>) — replace or append CONTEXT FROM PRIOR TASK block
       - If enrichment fails, log and continue (best-effort)
   10. Call TaskUpdate(task.id, status: "completed")
```

### Progressive Enrichment

Before marking each task completed, read its output file, extract key context (<= 500 chars), and update the next task's description via TaskUpdate.

**Enrichment Update Rule:** Read next task's description via TaskGet(). If it already contains a "CONTEXT FROM PRIOR TASK:" block, replace it. Otherwise, append. Only one context block per task.

| Completed Stage | Enrich Next Stage | Extract From Output |
|----------------|-------------------|---------------------|
| rca-{P}-{M}-N-vV.json | next rca or plan-review stage | root cause summary, confidence, affected files |
| plan-review-{P}-{M}-N-vV.json | implementation or next plan-review | validation status, concerns, AC count |
| impl-result.json | first code-review stage | files modified/created, test results |
| code-review-{P}-{M}-N-vV.json | next code-review stage | status, findings, AC verified/total |

### Parallel Execution [PARALLEL OK]

When multiple tasks share the same non-null `parallel_group_id` and are all unblocked:

1. For EACH task simultaneously: TaskGet, TaskUpdate(in_progress), dispatch agent
2. Wait for ALL to return
3. Handle each result independently:
   - **approved** -> mark completed
   - **needs_changes** -> mark review completed, create fix task (`parallel_group_id: null`, `blockedBy: [review_task.id]`), create re-review task (`parallel_group_id: null`, `blockedBy: [fix_task.id]`). **Group-aware successor lookup:** look up the task's `parallel_group_id` in `pipeline-tasks.json.stages`, find the last index with that same group ID (= groupEnd), then successor = groupEnd + 1. If successor exists in stages, call `TaskUpdate(stages[successor].task_id, addBlockedBy: [re_review_task.id])`. If no successor (last stage), skip rewiring.
   - **rejected** -> handle per Result Handling rules
4. Dynamic fix/re-review tasks always have `parallel_group_id: null` -> they always execute sequentially
5. **Aggregated enrichment (replaces per-task enrichment for parallel members):** Do NOT enrich the successor task individually per parallel member — this causes last-write-wins races. Instead, after ALL parallel results are collected, build a single combined context block:
   ```
   context = ""
   for each completed parallel task (approved or needs_changes):
     read output file, extract key context (<= 250 chars per member)
     context += "FROM {stage.type} {stage.model}: {summary}\n"
   // Find successor: compute group-aware successor index (groupEnd + 1)
   if successor exists:
     TaskGet(successor_task_id) -> read current description
     TaskUpdate(successor_task_id, description: append "CONTEXT FROM PRIOR PARALLEL GROUP:\n{context}")
   ```
   If enrichment fails, log and continue (best-effort).

**IMPORTANT:** Only tasks from the original `pipeline-tasks.json.stages` with matching `parallel_group_id` may run in parallel. Dynamic tasks (fix, re-review) NEVER run in parallel.

---

## Result Handling

**Review results:**

| Result | Action |
|--------|--------|
| `approved` | Continue to next task |
| `needs_changes` | Execute [core-same-stage-rereview.md](core-same-stage-rereview.md) for SAME STAGE INDEX |
| `rejected` (CLI/Codex plan review, feature) | Terminal state `plan_rejected` — ask user |
| `rejected` (CLI/Codex plan review, bug-fix) | Ask user to re-examine bug or provide more context (not terminal — can restart RCA) |
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

## Terminal States

| State | Meaning | Action |
|-------|---------|--------|
| `complete` | All reviews approved | Report success |
| `max_iterations_reached` | max_iterations re-reviews | Escalate to user |
| `plan_rejected` | CLI reviewer rejected plan (feature only) | User decision needed |
| `code_rejected` | CLI reviewer rejected code | User decision needed |
| `implementation_failed` | Implementation blocked | User decision needed |

---

## Pipeline Completion

When all reviews are approved (or a terminal state is reached):

1. Report results to the user
2. Read `team_name` from `.vcp/task/pipeline-tasks.json` and use `TeamDelete` with it to clean up
