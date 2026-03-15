---
name: dev-buddy-review
description: Review a plan or implementation. Dispatches review executors in parallel/sequential, enforces evidence-bound findings. Use --plan for plan review, --code for code review.
user-invocable: true
allowed-tools: Read, Write, Bash, Glob, Grep, Task, TaskOutput, AskUserQuestion
---

# Review Stage Skill

Review a plan or code implementation. Uses the executor system to dispatch reviewers.

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
console.log(JSON.stringify({ executors }));
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

Read the user story, plan, and implementation result.
Review the implementation against acceptance criteria and the plan.

For EVERY finding:
- Include contract_reference, evidence, and fix_type
- needs_changes requires at least one must_fix finding

Write output to .vcp/task/{output_file}.
```

---

## Step 5: Dispatch Executors

Determine the output filename for each executor:

```bash
bun -e "
import { getV3OutputFileName } from '${CLAUDE_PLUGIN_ROOT}/types/stage-definitions.ts';
// Count existing review files of this type to determine index
console.log(getV3OutputFileName('{stage-type}', '{executor-name}', {index}, '{preset}', '{model}', 1));
"
```

**Resolve system prompt** for each executor via `system-prompts.ts`, then route by provider type:

- **subscription:** `Task(subagent_type: "general-purpose", model: "<model>", prompt: "<system_prompt_content>\n---\n<assembled review prompt>")`
- **api:** `Bash(run_in_background: true)` → `api-task-runner.ts` with `--system-prompt "${CLAUDE_PLUGIN_ROOT}/docs/review-guidelines.md"`
- **cli:** `Task(subagent_type: "general-purpose", prompt: "Run: bun cli-executor.ts ...")`

- Group adjacent `parallel: true` executors → dispatch simultaneously, wait for all
- Sequential executors → dispatch one at a time, wait for each

---

## Step 6: Aggregate Results

After all executors complete, read each output file and aggregate:

**Multi-executor with synthesizer:**
When multiple executors are configured, all reviewers (including the synthesizer — the last executor) write individual review files using the existing v3 output pattern. The synthesizer does its own review AND may deduplicate/summarize findings from prior reviewers, but it CANNOT suppress `must_fix` findings.

The deterministic aggregation below then runs across ALL review outputs (including the synthesizer's).

1. Collect all findings across all reviewers
2. Determine overall status:
   - If ANY reviewer returned `needs_changes` with `must_fix` findings → overall `needs_changes`
   - If ALL returned `approved` → overall `approved`
3. Present aggregated results to user:
   - Per-reviewer status
   - Combined must_fix findings
   - Combined advisory findings
   - Missing AC coverage

---

## Step 7: Report

Present the aggregated review to the user and suggest next steps:
- If approved → `/dev-buddy-implement` (for plan review) or "done" (for code review)
- If needs_changes → fix the issues and re-run the review
