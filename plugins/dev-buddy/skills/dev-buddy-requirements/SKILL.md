---
name: dev-buddy-requirements
description: Gather requirements and create user story artifacts. Simplified output focused on acceptance criteria and scope. Supports multi-executor analysis with provenance tracking.
user-invocable: true
allowed-tools: Read, Write, Bash, Glob, Grep, Task, TaskOutput, AskUserQuestion, WebSearch
---

# Requirements Stage Skill

Gather requirements from the user and create user story artifacts. Dispatches requirements executors, synthesizes results into a minimal artifact set.

**Task directory:** `${CLAUDE_PROJECT_DIR}/.vcp/task/`

---

## Step 1: Load Config and Resolve Executors

```bash
bun -e "
import { loadDevBuddyConfig, getProviderType } from '${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-config.ts';
const config = loadDevBuddyConfig();
const stage = config.stages['requirements'];
const executors = stage.executors.map(exec => ({
  ...exec,
  providerType: getProviderType(exec.preset)
}));
console.log(JSON.stringify({ executors }));
"
```

---

## Step 2: Check for RCA Context

If `.vcp/task/rca-diagnosis.json` exists, this is a bug-fix requirements stage. Read the diagnosis and include it as context for the requirements executor.

---

## Step 2a: Stale-State Cleanup

Remove leftover clarification state from prior runs to avoid false positives:
```bash
rm -f .vcp/task/user-story/status.json
```

---

## Step 3: Prompt Assembly (Anti-Drift)

**Single executor (typical):**
```
ORIGINAL REQUEST: {user's original request from conversation}
---

You are executing the REQUIREMENTS stage.

{If RCA context exists: "Bug-fix context — read .vcp/task/rca-diagnosis.json for root cause."}

Gather requirements from the user's request. Focus on:
1. Clear acceptance criteria (Given/When/Then format)
2. Scope (in_scope / out_of_scope)
3. Each AC must include a "source" field: "original_request", "user_answer", or "specialist_suggestion"
4. Suggestions beyond the original request go to "candidate_additions" — NOT into the main ACs

DO NOT add features not in the original request. Ask 2-3 clarifying questions max.

Output: Write minimal user-story artifacts to .vcp/task/user-story/:
- meta.json (id, title, description)
- acceptance-criteria.json (array with source field per AC)
- scope.json (in_scope, out_of_scope, assumptions, candidate_additions)
- manifest.json (LAST — signals completion)

Do NOT write requirements.json or test-criteria.json (moved to planner).
```

**Multi-executor (analysts with synthesizer):**
If multiple executors are configured for requirements:
1. Non-synthesizer executors (all except the last): Each writes an analysis file.
   - **Compute filename** via the name-helper (deterministic, no ad-hoc formatting):
     ```bash
     bun "${CLAUDE_PLUGIN_ROOT}/scripts/name-helper.ts" --type analysis --index {0-based-index} --system-prompt {system_prompt_name} --provider {preset_name} --model {model_name}
     ```
   - **Analysis file format:** Valid JSON (NOT markdown). Must be parseable by `JSON.parse()`:
     ```json
     {"acceptance_criteria": [...], "scope": {...}, "risks": [...], "questions": [...]}
     ```
   - Dispatch per parallel/sequential config (group adjacent `parallel: true` → simultaneous)
2. Last executor (synthesizer) runs last with augmented prompt:
   - It performs its OWN requirements analysis
   - It ALSO reads all prior `analysis-*.json` files
   - It synthesizes and writes the canonical output to `user-story/`

   Synthesizer prompt augmentation (append to regular requirements prompt):
   ```
   ---
   SYNTHESIZER MODE: You are the final executor in a multi-executor stage.

   Prior analysis outputs are available at:
   {list of .vcp/task/analysis-*.json paths}

   In addition to performing your own requirements analysis, you MUST:
   1. Read all prior analysis outputs listed above
   2. Synthesize the best acceptance criteria from each
   3. Write the FINAL consolidated user-story artifacts to .vcp/task/user-story/

   IMPORTANT: If you are unsure about any requirement, scope decision, or acceptance criterion,
   do NOT assume. Instead:
   1. Write .vcp/task/user-story/status.json:
      {"status": "needs_clarification", "clarification_questions": ["Q1?", "Q2?"]}
   2. Do NOT write manifest.json (that signals completion)
   3. Stop and let the orchestrator handle asking the user

   If you have no questions, proceed to write all artifacts including manifest.json.
   Your output is the authoritative result.
   ```

**Failure handling:**
- If a non-synthesizer executor fails: note failure, continue with remaining executors
- If ALL non-synthesizer executors fail: synthesizer runs solo (single-executor mode)
- If synthesizer fails: report error to user, preserve any analysis-*.json files for debugging

---

## Step 4: Dispatch Executors

**Resolve system prompt with stage/role composition.** Compose the `requirements` stage definition with the executor's role prompt:
```bash
bun -e "
import { loadStageDefinition, getSystemPrompt, composePrompt } from '${CLAUDE_PLUGIN_ROOT}/scripts/system-prompts.ts';
const stage = loadStageDefinition('requirements', '${CLAUDE_PLUGIN_ROOT}/stages');
const role = getSystemPrompt('{executor.system_prompt}', '${CLAUDE_PLUGIN_ROOT}/system-prompts/built-in');
if (!stage) { console.error('FATAL: Stage definition not found for requirements'); process.exit(1); }
if (!role) { console.error('FATAL: Role prompt not found: {executor.system_prompt}'); process.exit(1); }
console.log(composePrompt(stage, role));
"
```

Use the composed output as the system prompt content, then route by provider type:

- **subscription:** `Task(subagent_type: "general-purpose", model: "<model>", prompt: "<composed_prompt>\n---\n<assembled task prompt>")`
- **api:** `Bash(run_in_background: true)` → `api-task-runner.ts --stage-type requirements --system-prompt "${CLAUDE_PLUGIN_ROOT}/system-prompts/built-in/{executor.system_prompt}.md"` → `TaskOutput`
- **cli:** `Task(subagent_type: "general-purpose", prompt: "Run: bun cli-executor.ts --stage-type requirements ...")`

---

## Step 5: Check for Clarification

After the synthesizer completes, check for `.vcp/task/user-story/status.json`:

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

After completion, verify:
1. `.vcp/task/user-story/manifest.json` exists with `ac_count > 0`
2. `acceptance-criteria.json` has entries with `source` field
3. `scope.json` has `in_scope` and `out_of_scope`
4. If `candidate_additions` exist in scope.json, present them to user for approval

---

## Step 7: Report Results

Present to the user:
- Number of acceptance criteria
- Key scope items
- Any candidate additions pending approval
- Suggest next step: `/dev-buddy-plan`
