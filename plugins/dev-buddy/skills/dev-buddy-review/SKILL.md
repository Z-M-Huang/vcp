---
name: dev-buddy-review
description: Review a plan or implementation. Dispatches review executors, validates outputs, and owns the review→repair→re-review loop. Use --plan for plan review, --code for code review.
user-invocable: true
allowed-tools: Read, Write, Bash, Glob, Grep, Task, TaskOutput, AskUserQuestion, Skill
---

# Review Stage Skill

Review a plan or code implementation. Uses the executor system to dispatch reviewers. Owns the full review→repair→re-review loop — if reviewers find `must_fix` issues, this skill dispatches the repair stage and re-reviews automatically.

**Task directory:** `${CLAUDE_PROJECT_DIR}/.vcp/task/`
**Usage:** `/dev-buddy-review --plan` or `/dev-buddy-review --code`

---

## Step 1: Determine Review Type

Parse the user's invocation for `--plan` or `--code` flag.

- `--plan` → plan review (uses `stages['plan-review']` executors)
- `--code` → code review (uses `stages['code-review']` executors)
- Neither → ask the user which review to run

---

## Step 2: Validate Inputs

**For plan review (`--plan`):**
```
Required: .vcp/task/user-story/manifest.json
Required: .vcp/task/plan/manifest.json
```

**For code review (`--code`):**
```
Required: .vcp/task/user-story/manifest.json
Required: .vcp/task/plan/manifest.json
Required: .vcp/task/impl-result.json
```

If any required artifact is missing, tell the user which stage to run first.

---

## Step 3: Load Config and Resolve Executors

```bash
bun -e "
import { loadDevBuddyConfig, getProviderType } from '${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-config.ts';
const config = loadDevBuddyConfig();
const stageType = '{plan-review or code-review}';
const stage = config.stages[stageType];
const executors = stage.executors.map(exec => ({
  ...exec,
  providerType: getProviderType(exec.preset)
}));
console.log(JSON.stringify({ executors, max_iterations: config.max_iterations }));
"
```

---

## Step 4: Prompt Assembly (Anti-Drift)

For each executor, assemble the review prompt:

**Plan review prompt:**
```
ORIGINAL REQUEST: {user's original request}
---

You are executing the PLAN REVIEW stage.
Your system prompt name is: {executor.system_prompt}
Your model is: {executor.model}
Set revision_number to: {revision_number}

Read the user story at .vcp/task/user-story/manifest.json (then sections).
Read the plan at .vcp/task/plan/manifest.json (then step files).

Review the plan against the acceptance criteria. For EVERY finding:
- Include contract_reference (which AC, plan step, or security rule it relates to)
- Include evidence (specific file:line or plan reference)
- Set fix_type to must_fix (blocks approval) or advisory (informational)

IMPORTANT: needs_changes requires at least one must_fix finding with evidence. Advisory-only findings cannot block approval.

Write output to .vcp/task/{output_file}.
```

**Code review prompt:**
```
ORIGINAL REQUEST: {user's original request}
---

You are executing the CODE REVIEW stage.
Your system prompt name is: {executor.system_prompt}
Your model is: {executor.model}
Set revision_number to: {revision_number}

Read the user story, plan, and implementation result.
Review the implementation against acceptance criteria and the plan.

For EVERY finding:
- Include contract_reference, evidence, and fix_type
- needs_changes requires at least one must_fix finding

Write output to .vcp/task/{output_file}.
```

---

## Step 5: Dispatch Executors

Determine the output filename for each executor. If `pipeline-tasks.json` exists with `stages[]` entries, use the stored `output_file` for this executor. Otherwise compute it:

```bash
bun -e "
import { getV3OutputFileName } from '${CLAUDE_PLUGIN_ROOT}/types/stage-definitions.ts';
console.log(getV3OutputFileName('{stage-type}', '{executor-name}', {index}, '{preset}', '{model}', 1));
"
```

**Resolve system prompt** for each executor via `system-prompts.ts`, then route by provider type:

- **subscription:** `Task(subagent_type: "general-purpose", model: "<model>", prompt: "<system_prompt_content>\n---\n<assembled review prompt>")`
- **api:** `Bash(run_in_background: true)` → `api-task-runner.ts` with `--system-prompt "${CLAUDE_PLUGIN_ROOT}/docs/review-guidelines.md"`
- **cli:** `Task(subagent_type: "general-purpose", prompt: "Run: bun cli-executor.ts ...")` — pass `--changes-summary` with the reviewer identity and revision_number so the CLI prompt includes them

- Group adjacent `parallel: true` executors → dispatch simultaneously, wait for all
- Sequential executors → dispatch one at a time, wait for each

**CRITICAL: You MUST dispatch ALL configured executors.** Do NOT skip any executor — even if prior reviewers already approved. The last sequential executor (the synthesizer) is configured specifically for cross-model validation. Skipping it defeats the purpose of multi-reviewer pipelines. Every executor in the config exists for a reason.

---

## Step 6: Validate and Aggregate Results

After all executors complete, validate each output file before aggregating:

**Validation (REQUIRED before aggregation):**
1. **Verify ALL executor outputs exist** — count output files against the executor list. If any executor's output file is missing, that executor was not dispatched. This is a dispatch failure — go back to Step 5 and dispatch the missing executors. Do NOT aggregate partial results.
2. Parse JSON — if invalid, treat as **stage failure** (do NOT skip)
3. Verify required fields: `id`, `reviewer`, `model`, `revision_number`, `status`, `summary`, `findings`
   - Plan review: also require `requirements_coverage`
   - Code review: also require `acceptance_criteria_verification`, `checklist`
4. Verify `status` is one of: `approved`, `needs_changes`, `needs_clarification`, `rejected`
5. Verify any `needs_changes` status has at least one `must_fix` finding with `contract_reference` and `evidence`
6. **If any reviewer output is malformed or missing → report which executor failed and ask user to re-run. Do NOT proceed with partial results.**

**Aggregation (only if all outputs are valid):**

When multiple executors are configured, all reviewers (including the synthesizer — the last executor) write individual review files. The synthesizer does its own review AND may deduplicate/summarize findings from prior reviewers, but it CANNOT suppress `must_fix` findings.

1. Collect all findings across all reviewers
2. Determine overall status:
   - If ANY reviewer returned `needs_changes` with `must_fix` findings → overall `needs_changes`
   - If ALL returned `approved` → overall `approved`
   - If ANY returned `needs_clarification` → overall `needs_clarification`
   - If ANY returned `rejected` → overall `rejected`
3. Present aggregated results to user:
   - Per-reviewer status
   - Combined must_fix findings
   - Combined advisory findings
   - Missing AC coverage

---

## Step 7: Review→Repair→Re-Review Loop

After aggregation, handle the result. `max_iterations` is the per-review-stage budget.

```
iteration = 0
WHILE aggregated_status == 'needs_changes' AND iteration < max_iterations:
  7a. Collect all must_fix findings across reviewers
  7b. Write .vcp/task/review-findings-to-fix.json:
      { "findings": [<aggregated must_fix findings>], "review_type": "plan|code" }
  7c. Present findings summary to user
  7d. Dispatch repair via Skill tool:
      - If --plan: Skill(skill: "dev-buddy-plan")
      - If --code: Skill(skill: "dev-buddy-implement")
  7e. Delete .vcp/task/review-findings-to-fix.json
  7f. Prepare for re-dispatch:
      - Record expected_revision = current revision_number + 1
      - DELETE all expected review output files (prevents stale files from passing validation)
  7g. Re-dispatch all reviewers:
      - Pass expected_revision in the prompt:
        "This is re-review revision {expected_revision}. Set revision_number to {expected_revision}."
      - For CLI executors: use --resume flag with --changes-summary
      - Write to same output files (use stored output_file from pipeline-tasks.json)
  7h. Re-validate and re-aggregate (repeat Step 6)
      - ADDITIONALLY verify each output's revision_number === expected_revision (reject stale outputs)
  7h. iteration++

IF aggregated_status == 'needs_clarification':
  → AskUserQuestion with combined clarification_questions
  → After user responds, re-dispatch reviewers (does NOT consume iteration budget)

IF aggregated_status == 'rejected':
  → Present rejection to user, STOP (do not consume iterations)

IF aggregated_status == 'approved':
  → Report approval to user, suggest next step
```

---

## Step 8: Report

Present the final aggregated review to the user and suggest next steps:
- If approved → `/dev-buddy-implement` (for plan review) or "done" (for code review)
- If needs_changes after max_iterations → report remaining must_fix findings, suggest manual fixes
- If rejected → suggest major rework or `/dev-buddy-plan` from scratch
