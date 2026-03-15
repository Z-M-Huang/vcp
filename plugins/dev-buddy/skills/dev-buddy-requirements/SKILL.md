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
1. Non-synthesizer executors (all except the last): Each writes `.vcp/task/analysis-{index}-{system_prompt}-{preset}-{model}.json`
   - All dynamic parts sanitized via `sanitizeForFilename()` from `stage-definitions.ts`
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

   Your output is the authoritative result.
   ```

**Failure handling:**
- If a non-synthesizer executor fails: note failure, continue with remaining executors
- If ALL non-synthesizer executors fail: synthesizer runs solo (single-executor mode)
- If synthesizer fails: report error to user, preserve any analysis-*.json files for debugging

---

## Step 4: Dispatch Executors

**Resolve system prompt** for the executor via `system-prompts.ts`, then route by provider type:

- **subscription:** `Task(subagent_type: "general-purpose", model: "<model>", prompt: "<system_prompt_content>\n---\n<assembled task prompt>")`
- **api:** `Bash(run_in_background: true)` → `api-task-runner.ts` → `TaskOutput`
- **cli:** `Task(subagent_type: "general-purpose", prompt: "Run: bun cli-executor.ts ...")`

---

## Step 5: Verify Output

After completion, verify:
1. `.vcp/task/user-story/manifest.json` exists with `ac_count > 0`
2. `acceptance-criteria.json` has entries with `source` field
3. `scope.json` has `in_scope` and `out_of_scope`
4. If `candidate_additions` exist in scope.json, present them to user for approval

---

## Step 6: Report Results

Present to the user:
- Number of acceptance criteria
- Key scope items
- Any candidate additions pending approval
- Suggest next step: `/dev-buddy-plan`
