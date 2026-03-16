---
name: dev-buddy-plan
description: Create a thorough implementation plan from existing requirements. Reads user-story artifacts, dispatches planning executors, writes plan with test cases and step-to-AC mapping.
user-invocable: true
allowed-tools: Read, Write, Bash, Glob, Grep, Task, TaskOutput, AskUserQuestion
---

# Planning Stage Skill

Create a thorough implementation plan from existing requirements. Uses the executor system to dispatch planning agents.

**Task directory:** `${CLAUDE_PROJECT_DIR}/.vcp/task/`

---

## Step 1: Validate Inputs

Check that required input artifacts exist:

```
Required: .vcp/task/user-story/manifest.json (with format_version and ac_count > 0)
Optional: .vcp/task/rca-diagnosis.json (provides bug-fix context if present)
```

If `user-story/manifest.json` is missing, tell the user to run `/dev-buddy-requirements` first.

Read `user-story/manifest.json` and verify `ac_count > 0`. Read `user-story/acceptance-criteria.json` for the full AC list.

---

## Step 1a: Stale-State Cleanup

Remove leftover clarification state from prior runs to avoid false positives:
```bash
rm -f .vcp/task/plan/status.json
```

## Step 1b: Check for Review Repair Context

If `.vcp/task/review-findings-to-fix.json` exists, this is a re-plan after review failure. Read the file and inject its `must_fix` findings into every executor prompt as additional context:

```
REVIEW FINDINGS TO ADDRESS:
The following must_fix findings were raised by plan reviewers. Address each one in the revised plan:
{findings from review-findings-to-fix.json}
```

This file is written by `/dev-buddy-review --plan` when the review loop triggers a re-plan.

---

## Step 2: Load Config and Resolve Executors

```bash
bun -e "
import { loadDevBuddyConfig, getProviderType } from '${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-config.ts';
const config = loadDevBuddyConfig();
const stage = config.stages['planning'];
const executors = stage.executors.map(exec => ({
  ...exec,
  providerType: getProviderType(exec.preset)
}));
console.log(JSON.stringify({ executors, max_tdd_iterations: config.max_tdd_iterations }));
"
```

Parse the output to get the list of executors with their system prompts, provider types, presets, and models.

---

## Step 3: Prompt Assembly (Anti-Drift)

For each executor, assemble the prompt:

```
ORIGINAL REQUEST: {user's original request from conversation context}
---

You are executing the PLANNING stage.

Read the user story at .vcp/task/user-story/manifest.json, then read all section files.
{If rca-diagnosis.json exists: "Also read .vcp/task/rca-diagnosis.json for root cause context."}

Create a thorough implementation plan following the planner agent's instructions.

CRITICAL REQUIREMENTS:
1. Every plan step MUST include ac_ids[] referencing acceptance criteria
2. Write test cases in plan/test-plan.json mapped to AC IDs
3. Steps must be atomic and independently testable
4. Do NOT add features or steps not justified by the acceptance criteria

Write output to .vcp/task/plan/ using the multi-file format (meta.json, steps/{N}.json, test-plan.json, risk-assessment.json, dependencies.json, files.json, manifest.json LAST).
```

---

## Step 4: Dispatch Executors

**Resolve system prompt with stage/role composition.** Compose the `planning` stage definition with the executor's role prompt:
```bash
bun -e "
import { loadStageDefinition, getSystemPrompt, composePrompt } from '${CLAUDE_PLUGIN_ROOT}/scripts/system-prompts.ts';
const stage = loadStageDefinition('planning', '${CLAUDE_PLUGIN_ROOT}/stages');
const role = getSystemPrompt('{executor.system_prompt}', '${CLAUDE_PLUGIN_ROOT}/system-prompts/built-in');
if (!stage) { console.error('FATAL: Stage definition not found for planning'); process.exit(1); }
if (!role) { console.error('FATAL: Role prompt not found: {executor.system_prompt}'); process.exit(1); }
console.log(composePrompt(stage, role));
"
```

Use the composed output as the system prompt content, then route each executor by provider type:

- **subscription:** `Task(subagent_type: "general-purpose", model: "<model>", prompt: "<composed_prompt>\n---\n<assembled task prompt>")`
- **api:** `Bash(run_in_background: true)` → `api-task-runner.ts --preset <preset> --model <model> --stage-type planning --system-prompt "${CLAUDE_PLUGIN_ROOT}/system-prompts/built-in/{executor.system_prompt}.md" --task-stdin` → `TaskOutput(timeout: min(timeout_ms + 120000, 600000))`
- **cli:** `Task(subagent_type: "general-purpose", prompt: "Run: bun '${CLAUDE_PLUGIN_ROOT}/scripts/cli-executor.ts' --stage-type planning ...")`

**Single executor (common case):** Route directly — write to `.vcp/task/plan/`. No variant indirection.

**Multiple executors (multi-planner with synthesizer):**
Non-synthesizer planners (all except last) each write to a separate variant directory:
- **Compute dirname** via the name-helper (deterministic, no ad-hoc formatting):
  ```bash
  bun "${CLAUDE_PLUGIN_ROOT}/scripts/name-helper.ts" --type plan-variant --index {0-based-index} --system-prompt {system_prompt_name} --provider {preset_name} --model {model_name}
  ```
- Modify assembled prompt: "Write output to .vcp/task/{computed_dirname}/ using the multi-file format."

Dispatch per parallel/sequential config (group adjacent `parallel: true` → simultaneous).

Last executor (synthesizer) runs last with augmented prompt — it does its own planning AND reads all prior variants:
```
---
SYNTHESIZER MODE: You are the final planner in a multi-executor planning stage.

Prior plan variants are available at:
{list of .vcp/task/plan-{index}-*/manifest.json paths}

In addition to creating your own plan, you MUST:
1. Read all prior plan variants listed above
2. Merge the best elements from each
3. Write the FINAL synthesized plan to .vcp/task/plan/ (standard multi-file format)
4. Note which variant contributed key decisions in meta.json

IMPORTANT: If you are unsure about any architectural decision, step ordering, or scope boundary,
do NOT assume. Instead:
1. Write .vcp/task/plan/status.json:
   {"status": "needs_clarification", "clarification_questions": ["Q1?", "Q2?"]}
2. Do NOT write manifest.json (that signals completion)
3. Stop and let the orchestrator handle asking the user

If you have no questions, proceed to write all artifacts including manifest.json.
```

**Post-synthesis cleanup:** Only after verifying `.vcp/task/plan/manifest.json` exists:
```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/name-helper.ts" --type plan-variants --list --task-dir .vcp/task | xargs -I{} rm -rf ".vcp/task/{}"
```
On synthesis failure, preserve variant directories for manual recovery.

**Failure handling:**
- Non-synthesizer failure: note, continue with remaining
- All non-synthesizer fail: synthesizer runs solo
- Synthesizer failure: do NOT cleanup variants, report error

---

## Step 5: Check for Clarification

After the synthesizer completes, check for `.vcp/task/plan/status.json`:

1. If it exists and `status == "needs_clarification"`:
   a. Read the `clarification_questions[]` array
   b. Present questions to user via AskUserQuestion
   c. Collect answers
   d. Delete `status.json` (prevent stale state)
   e. Re-dispatch ONLY the synthesizer (last executor) with the SAME synthesis augmentation plus:
      ```
      CLARIFICATION ANSWERS:
      - Q1? → A1
      - Q2? → A2
      ```
   f. Return to this step (max 3 rounds — escalate to user if exceeded)
2. If `status.json` does not exist, proceed to Step 6

---

## Step 6: Verify Output

After the executor completes, verify:

1. `.vcp/task/plan/manifest.json` exists and has `step_count > 0`
2. Each `plan/steps/{N}.json` file exists and contains `ac_ids[]`
3. `plan/test-plan.json` exists and has `test_cases[]`

If verification fails, report what's missing to the user.

---

## Step 7: Report Results

Present a summary to the user:
- Plan title and summary
- Number of steps
- Number of test cases
- Synthesized from {N} plan variants (if multi-planner was used)
- Any unmapped ACs (steps without ac_ids)
- Suggest next step: `/dev-buddy-review --plan` or `/dev-buddy-implement`
