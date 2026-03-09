# Per-Step Phased Implementation Loop

> **When to execute:** From the main loop when an implementation stage has `phased_reviews` configured and non-empty. This replaces the normal monolithic implementer dispatch.

---

## Entry Condition

When the main loop reaches an **implementation stage**, check the stage entry in `resolved_config`:

```
if implementation_stage.phased_reviews && implementation_stage.phased_reviews.length > 0:
    -> enter Per-Step Phased Implementation Loop (this section)
else:
    -> dispatch monolithic implementer as normal (existing behavior, unchanged)
```

If `phased_reviews` is absent or empty: use existing monolithic implementation dispatch. No change to that path.

> **Performance guidance:** Phased reviews multiply orchestrator context consumption linearly with step count. Recommended maximum: 20-30 plan steps when phased reviews are enabled. If step count exceeds 30, warn the user before entering the phased loop: "Plan has {N} steps with phased reviews enabled. This may exhaust the orchestrator context window. Consider splitting into smaller plans or disabling phased reviews. Proceed anyway?" via AskUserQuestion.

## Step P0: Prepare Directories

```bash
mkdir -p "${CLAUDE_PROJECT_DIR}/.vcp/task/impl-steps"
mkdir -p "${CLAUDE_PROJECT_DIR}/.vcp/task/phased-reviews"
```

Read plan step count: read `.vcp/task/plan/manifest.json` -> extract `step_count` as `N`.

## Step P1: Check for Partial Progress (Resume)

Read the implementation stage entry in `pipeline-tasks.json`. Check for `step_progress` field:

- **If `step_progress` exists:** `start_step = step_progress.current_step`; log: "Resuming phased implementation from step {start_step} of {N}"
- **If `step_progress` absent:** `start_step = 1`

Resolve batch state:
```
review_interval = resolved_config.review_interval   // already defaulted to 1 at config load time
last_reviewed_step = step_progress.last_reviewed_step ?? 0
batch_start = last_reviewed_step + 1
```

If `start_step > batch_start`, steps `[batch_start..start_step-1]` are already implemented but not yet reviewed. Continue implementing from `start_step`, then review the full batch `[batch_start..batch_end]` when batch is complete.

## Step P2: Per-Step Iteration (Batch-Aware)

For each `step` from `start_step` to `N` (inclusive):

### P2a. Dispatch Single-Step Implementer

Read the implementation stage's `providerType` from `pipeline-tasks.json` stages[] entry (the same stage that triggered the phased loop). Route dispatch by providerType using [core-provider-dispatch.md](core-provider-dispatch.md) patterns:

**If providerType is 'subscription':**
```
impl_task = Task(
  subagent_type: "dev-buddy:implementer",
  model: "{impl_stage.model}",
  prompt: "SINGLE_STEP_MODE: step {step}
PLAN STEP: .vcp/task/plan/steps/{step}.json
OUTPUT: .vcp/task/impl-steps/impl-step-{step}-v1.json
OVERALL GOAL: Read .vcp/task/user-story/meta.json for {PIPELINE_CONTEXT_LABEL}
PLAN OVERVIEW: Read .vcp/task/plan/manifest.json for architecture decisions
NOTE: {PIPELINE_IMPL_NOTE}"
)
```

**Pipeline-specific values:**
- **Feature:** `{PIPELINE_CONTEXT_LABEL}` = "feature context"; `{PIPELINE_IMPL_NOTE}` = "Implement ONLY step {step}. Do NOT touch prior or future steps."
- **Bug-fix:** `{PIPELINE_CONTEXT_LABEL}` = "bug context"; `{PIPELINE_IMPL_NOTE}` = "This is a bug-fix pipeline. Implement ONLY step {step} — minimal fix targeting root cause. Do NOT touch prior or future steps."

**If providerType is 'api':**
Derive timeout: read `~/.vcp/ai-presets.json` -> find preset by impl_stage.provider name -> read `timeout_ms` (default: 300000 if not set or lookup fails).
Run the Bash tool with `run_in_background: true`:
```
bun "${CLAUDE_PLUGIN_ROOT}/scripts/api-task-runner.ts" \
  --preset "<impl_stage.provider>" \
  --model "<impl_stage.model>" \
  --cwd "${CLAUDE_PROJECT_DIR}" \
  --task-timeout "<timeout_ms>" \
  --task-stdin <<'TASK_EOF'
SINGLE_STEP_MODE: step {step}
PLAN STEP: .vcp/task/plan/steps/{step}.json
OUTPUT: .vcp/task/impl-steps/impl-step-{step}-v1.json
OVERALL GOAL: Read .vcp/task/user-story/meta.json for {PIPELINE_CONTEXT_LABEL}
PLAN OVERVIEW: Read .vcp/task/plan/manifest.json for architecture decisions
NOTE: {PIPELINE_IMPL_NOTE}
TASK_EOF
```
Save the returned `task_id`. If `run_in_background` does not return a `task_id`, treat as dispatch failure.
Poll for completion:
```
TaskOutput(task_id: "<task_id>", block: true, timeout: min(timeout_ms + 120000, 600000))
```
If TaskOutput returns but the task is still running, repeat with `timeout: 600000`.
Parse JSON output: `{ event: "complete" }` or `{ event: "error" }`.

**If providerType is 'cli':**
```
impl_task = Task(
  subagent_type: "dev-buddy:cli-executor",
  prompt: "Run cli-executor.ts with --preset <impl_stage.provider>, --model <impl_stage.model>, --output-file .vcp/task/impl-steps/impl-step-{step}-v1.json
SINGLE_STEP_MODE: step {step}
PLAN STEP: .vcp/task/plan/steps/{step}.json
NOTE: {PIPELINE_IMPL_NOTE}"
)
```
// Do NOT pass model parameter to Task tool. Model is passed via --model flag to cli-executor.ts.

Wait for completion. Verify `.vcp/task/impl-steps/impl-step-{step}-v1.json` exists and `status != "failed"`.

### P2b. Check Batch Boundary and Dispatch Reviewers

After each step's implementation completes, check if a batch boundary has been reached:

```
steps_in_batch = step - batch_start + 1
is_batch_complete = (steps_in_batch >= review_interval) OR (step == N)
```

**If batch is NOT complete** (mid-batch):
- Update `step_progress` with `current_step = step + 1` only (no review dispatch)
- Continue to next step

**If batch IS complete** (batch boundary reached):
- `batch_end = step`
- Proceed to dispatch reviewers for the full batch `[batch_start..batch_end]`

**Generate prior batch summary** (for batch_start > 1):
```
prior_summary = ""
For each completed batch [prev_start..prev_end] (derived from approved phased-review files):
    Read the approved phased-review file -> extract summary field
    Read each impl-step file in that batch -> extract files_modified + files_created
    Append: "Steps {prev_start}-{prev_end}: {summary}. Files: [{file_list}]"
```

**Determine output filename:**
```
if review_interval == 1:
    output_file = getPhasedReviewFileName(step, pr.provider, pr.model, 1)   // single-step (backward compat)
else:
    output_file = getPhasedBatchReviewFileName(batch_start, batch_end, pr.provider, pr.model, 1)
```

**Determine reviewer prompt content:**
```
if review_interval == 1:
    // Single-step prompt (unchanged from current behavior)
    plan_steps = "PLAN STEP: .vcp/task/plan/steps/{step}.json"
    impl_steps = "IMPL STEP: .vcp/task/impl-steps/impl-step-{step}-v1.json"
    note = "Review ONLY step {step}. Write output file before completing."
else:
    // Batch prompt
    plan_steps = "PLAN STEPS: .vcp/task/plan/steps/{batch_start}.json ... steps/{batch_end}.json"
    impl_steps = "IMPL STEPS: .vcp/task/impl-steps/impl-step-{batch_start}-v{latest}.json ... impl-step-{batch_end}-v{latest}.json"
    prior_batches = "PRIOR BATCHES: {prior_summary}"  // omit if batch_start == 1
    note = "Review steps {batch_start} through {batch_end}. Check cross-step coherence.
            step_reviewed = {batch_end}. steps_reviewed = [{batch_start}..{batch_end}]."
```

Apply the **parallel grouping algorithm** to `phased_reviews[]` (same as main pipeline loop):
- Consecutive entries with `parallel: true` form a parallel group -- fan-out same `blockedBy`
- Sequential entries execute one after another

For each reviewer `pr` in `phased_reviews[]`, resolve its providerType:
```
Read ~/.vcp/ai-presets.json -> find preset by pr.provider name
If preset found: providerType = preset.type ('subscription' | 'api' | 'cli')
If preset name is 'anthropic-subscription': providerType = 'subscription'
If preset not found: treat as dispatch failure
```

**Each reviewer is dispatched independently using its own providerType.** Mixed providerTypes within a parallel group are supported -- each reviewer uses its own routing, all dispatched concurrently.

Route dispatch by providerType:

**If providerType is 'subscription':**
```
review_task = Task(
  subagent_type: "dev-buddy:phased-reviewer",
  model: "{pr.model}",
  prompt: "AGENT: dev-buddy:phased-reviewer (model: {pr.model}, provider: {pr.provider})
{plan_steps}
{impl_steps}
{prior_batches}
OUTPUT: .vcp/task/phased-reviews/{output_file}
{note}"
)
```

**If providerType is 'api':**
Derive timeout: read `~/.vcp/ai-presets.json` -> find preset by pr.provider name -> read `timeout_ms` (default: 300000).
Run the Bash tool with `run_in_background: true`:
```
bun "${CLAUDE_PLUGIN_ROOT}/scripts/api-task-runner.ts" \
  --preset "<pr.provider>" \
  --model "<pr.model>" \
  --cwd "${CLAUDE_PROJECT_DIR}" \
  --task-timeout "<timeout_ms>" \
  --system-prompt "${CLAUDE_PLUGIN_ROOT}/docs/review-guidelines.md" \
  --task-stdin <<'TASK_EOF'
AGENT: dev-buddy:phased-reviewer (model: {pr.model}, provider: {pr.provider})
{plan_steps}
{impl_steps}
{prior_batches}
OUTPUT: .vcp/task/phased-reviews/{output_file}
{note}
TASK_EOF
```
Save `task_id`. If no `task_id` returned, treat as dispatch failure.
Poll: `TaskOutput(task_id, block: true, timeout: min(timeout_ms + 120000, 600000))`.
Repeat if still running. Parse JSON output.

**If providerType is 'cli':**
```
review_task = Task(
  subagent_type: "dev-buddy:cli-executor",
  prompt: "Run cli-executor.ts with --preset <pr.provider>, --model <pr.model>, --output-file .vcp/task/phased-reviews/{output_file}
{plan_steps}
{impl_steps}
{prior_batches}
{note}"
)
```
// Do NOT pass model parameter to Task tool.

**Dispatch failure handling:** After each reviewer dispatch completes, check if the expected output file exists. If the output file does NOT exist:
- Treat as `needs_changes` with a synthetic error note:
```json
{
  "status": "needs_changes",
  "step_reviewed": {batch_end},
  "issues": [{ "id": "DISPATCH_FAIL", "description": "Reviewer dispatch failed, no output produced", "severity": "error", "category": "dispatch" }],
  "summary": "Reviewer {pr.provider}/{pr.model} dispatch failed -- no output file found."
}
```
- Write this synthetic result to the expected output path so downstream processing is consistent.

Wait for all reviewers for this batch to complete.

### P2c. Check Verdicts

Read each reviewer's output file. Check `status` field.

- **If ALL reviewers return `"approved"`:** -> proceed to P2d
- **If ANY reviewer returns `"needs_changes"`:** -> proceed to P2e

### P2d. Batch Approved — Update Progress

Update `pipeline-tasks.json` implementation stage entry:

```json
"step_progress": {
  "current_step": {batch_end + 1},
  "total_steps": {N},
  "completed_steps": [...prev_completed_steps, ...range(batch_start, batch_end)],
  "last_reviewed_step": {batch_end}
}
```

Write updated `pipeline-tasks.json` to disk. Set `batch_start = batch_end + 1`. Continue to next step.

### P2e. Fix/Re-Review Cycle (Step-Scoped Within Batch)

Fixes stay **step-scoped** — the implementer always runs in `SINGLE_STEP_MODE` for one step at a time.

```
phased_iteration = 1
max_phased = resolved_config.max_phased_iterations   // already defaulted to 3 at config load time

while phased_iteration < max_phased:
    Extract issues from reviewer(s) that returned needs_changes (first 500 chars of issues array)

    // Group issues by step: match issue file paths against each step's files_modified in the batch
    // For each affected step in [batch_start..batch_end]:
    For each affected_step in batch where issues reference its files:
        next_version = find max(V) from impl-step-{affected_step}-v*.json files + 1

        // Dispatch fix task using the SAME providerType routing as P2a above.
        // Read impl_stage.providerType from pipeline-tasks.json stages[] entry.
        // Route: subscription -> Task(dev-buddy:implementer), api -> Bash(api-task-runner.ts), cli -> Task(dev-buddy:cli-executor)
        // Use the same task description fields as P2a, with these differences:
        //   - OUTPUT: .vcp/task/impl-steps/impl-step-{affected_step}-v{next_version}.json
        //   - Add ISSUES FROM PRIOR REVIEW: {step_issues_summary} to the prompt
        //   - Subject: "Fix Step {affected_step} v{next_version}"
        //   - **Bug-fix pipeline:** Retain the bug-fix-specific NOTE: "Bug-fix pipeline — apply minimal targeted fix for the listed issues."
        fix_task = <dispatch using P2a providerType routing with above modifications>
        Wait for fix to complete.

    // After all step-scoped fixes complete: re-review the same batch [batch_start..batch_end]
    // reading latest version of each step (max(V) from impl-step-{step}-v*.json glob)
    // Dispatch re-reviews using the SAME per-reviewer providerType routing as P2b above.
    // Each reviewer resolves its own providerType from ai-presets.json.
    // Route: subscription -> Task(dev-buddy:phased-reviewer), api -> Bash(api-task-runner.ts + --system-prompt), cli -> Task(dev-buddy:cli-executor)
    // Use next review version in output file names:
    //   if review_interval == 1: getPhasedReviewFileName(step, pr.provider, pr.model, next_review_version)
    //   else: getPhasedBatchReviewFileName(batch_start, batch_end, pr.provider, pr.model, next_review_version)
    // Apply the same parallel grouping algorithm as P2b.
    // Apply the same dispatch failure handling as P2b.
    re_review_tasks = <dispatch using P2b per-reviewer providerType routing with next_review_version>

    Wait for all re-reviews to complete.
    Check verdicts again (same as P2c).
    If all approved: update step_progress (P2d), break to next batch.
    phased_iteration++
```

### P2f. Escalation on Exhausted Iterations

If `phased_iteration >= max_phased` and last review still returned `needs_changes`:

```
AskUserQuestion(
  "Batch steps {batch_start}-{batch_end} has failed phased review {max_phased} times.
   Most recent issues (attempt {max_phased}):
   {issues_from_last_review}

   Options:
   1. Take over manually — resolve the issues yourself,
      then continue the pipeline when ready
   2. Abort pipeline — stop execution entirely (can resume later via
      step_progress tracking)

   The pipeline is paused. Please choose an option."
)
```

**CRITICAL:** The pipeline MUST pause for user intervention. Do NOT skip to the next step automatically. Do NOT offer a "skip forward" option. The user MUST either resolve the failing step or abort.

## After All Steps Complete

**Do NOT dispatch the normal monolithic implementer** — that would re-touch prior work.

Instead, aggregate results inline:

1. Read all impl-step files: `.vcp/task/impl-steps/impl-step-{1..N}-v{latest_version}.json`
2. Merge `files_modified`, `files_created`, `files_deleted` arrays (deduplicate)
3. Concatenate notes/summaries from each step
4. Write `.vcp/task/impl-result.json`:

```json
{
  "status": "complete",
  "plan_implemented": "{plan_id}",
  "files_modified": ["...merged list..."],
  "files_created": ["...merged list..."],
  "steps_completed": {N},
  "phased": true,
  "notes": "Aggregated from {N} per-step implementations{PIPELINE_NOTES_SUFFIX}",
  "completed_at": "ISO8601"
}
```

**Pipeline-specific values:**
- **Feature:** `{PIPELINE_NOTES_SUFFIX}` = "" (empty)
- **Bug-fix:** `{PIPELINE_NOTES_SUFFIX}` = " (bug-fix pipeline)"

5. Mark the implementation pipeline task as completed.
6. Continue to the next stage (code-review) as normal.

## Resume Detection Extension (Step 0)

In the Step 0 resume detection block, add phased progress detection after the existing implementation stage check:

```
if implementation_stage.status == "in_progress" or "partial":
    check step_progress field in implementation stage entry
    if step_progress exists AND step_progress.current_step <= step_progress.total_steps:
        status = "partial_phased"
        resume_from_step = step_progress.current_step
        -> enter Per-Step Phased Implementation Loop at Step P1
```

## Implementation Stage Task Description Update

When creating the implementation task in the task chain (Step 2 task creation), if `phased_reviews` is configured and non-empty on this stage entry, replace the default task description with this enriched template:

```
PHASE: Implementation (phased reviews enabled)
AGENT: dev-buddy:implementer (model: {impl_stage.model})
PROVIDER: {impl_stage.provider} (providerType: {impl_stage.providerType})
STEPS: {N} (from plan/manifest.json step_count)
CONFIG SOURCE: .vcp/task/pipeline-tasks.json resolved_config.{PIPELINE_CONFIG_KEY}

PHASED REVIEWERS:
{for each pr in phased_reviews:}
  - {pr.provider}/{pr.model} {pr.parallel ? '(parallel)' : '(sequential)'}
{end for}

REVIEW_INTERVAL: {review_interval}

WORKFLOW:
  P0: mkdir impl-steps/ + phased-reviews/, read step_count from plan/manifest.json
  P1: Check step_progress in pipeline-tasks.json for resume (batch_start = last_reviewed_step + 1)
  P2: For each step 1..N:
    P2a: Dispatch implementer (route by impl_stage.providerType: subscription|api|cli)
    P2b: Check batch boundary (steps_in_batch >= review_interval OR step == N)
         If batch complete: dispatch phased reviewers for batch [batch_start..batch_end]
         If mid-batch: update step_progress.current_step, continue to next step
    P2c: Check verdicts (all approved -> P2d, any needs_changes -> P2e)
    P2d: Update step_progress (last_reviewed_step = batch_end), continue
    P2e: Step-scoped fixes + batch re-review (max {max_phased_iterations} iterations)
    P2f: Escalate to user if iterations exhausted
  Aggregate: merge impl-step files -> impl-result.json

MAX_PHASED_ITERATIONS: {max_phased_iterations}
ESCALATION: After {max_phased_iterations} failed reviews per batch, pause pipeline and ask user.
OUTPUT NAMING:
  impl-steps/impl-step-{N}-v{V}.json (implementer)
  phased-reviews/phased-review-{provider}-{model}-step-{N}-v{V}.json (reviewer, interval=1)
  phased-reviews/phased-review-{provider}-{model}-steps-{start}-{end}-v{V}.json (reviewer, interval>1)
FINAL OUTPUT: .vcp/task/impl-result.json
```

This enriched description is self-contained: after context compaction, `TaskGet()` returns enough information for the orchestrator to re-derive the phased workflow without re-reading the SKILL.md instructions.
