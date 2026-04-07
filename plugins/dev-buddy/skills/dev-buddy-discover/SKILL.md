---
name: dev-buddy-discover
description: Discovery stage — multi-AI codebase and running app exploration
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent, Task, TaskOutput, TaskCreate, TaskUpdate, TaskList, TaskGet, AskUserQuestion
---

# Discovery Stage

Explore the codebase and running application to deeply understand what exists before making changes.

**Standalone usage:** `/dev-buddy-discover` — discovers the most recent `ralph-*.md` plan file in `{PROJECT_PATH}/.vcp/plan/` and appends findings.

**Orchestrator usage:** Called by `/dev-buddy-ralph` with plan path already established.

---

## Step 1: Find the plan file

If no plan file path is in current context, find the most recent one:
```bash
ls -t "${CLAUDE_PROJECT_DIR}/.vcp/plan/ralph-*.md" 2>/dev/null | head -1
```

Read the plan file. Extract the feature description from the `# Ralph: {title}` heading.

---

## Step 2: Load stage executors

```bash
bun -e "
import { loadDevBuddyConfig } from '${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-config.ts';
import { readPresets } from '${CLAUDE_PLUGIN_ROOT}/scripts/preset-utils.ts';
const config = loadDevBuddyConfig();
const presets = readPresets();
const stage = config.stages['discovery'];
console.log(JSON.stringify(stage.executors.map((e, i) => ({
  index: i,
  system_prompt: e.system_prompt,
  preset: e.preset,
  model: e.model,
  parallel: e.parallel ?? false,
  type: presets.presets[e.preset]?.type || 'unknown',
  timeout_ms: presets.presets[e.preset]?.timeout_ms
}))));
"
```

## Step 3: Resolve stage + role prompts

For each executor, resolve the composed prompt (stage definition + role prompt):
```bash
bun -e "
import { loadStageDefinition, composePrompt, getSystemPrompt } from '${CLAUDE_PLUGIN_ROOT}/scripts/system-prompts.ts';
const stage = loadStageDefinition('discovery', '${CLAUDE_PLUGIN_ROOT}/stages');
const role = getSystemPrompt('{SYSTEM_PROMPT}', '${CLAUDE_PLUGIN_ROOT}/system-prompts/built-in');
if (stage && role) console.log(composePrompt(stage, role));
else console.log('ERROR: Could not resolve prompts');
"
```

## Step 4: Dispatch executors

**MANDATORY: You MUST dispatch executors as configured. Do NOT skip this step.** Even if you have prior context from chatroom debates or other stages, executor dispatch is required — each executor brings independent perspective and the synthesis depends on multi-AI diversity. Skipping dispatch violates the pipeline contract.

Use the same dispatch pattern as `/dev-buddy-chatroom`:

Set iteration N = 1 on first entry. On re-entry from Step 6b (validation failure) or Step 7 (user rejection), increment N.

**Subscription executors:** `Agent(subagent_type: "general-purpose", model: {model}, prompt: {composed_prompt + feature_description + validation_feedback_if_any})`

**API/CLI executors:** `Bash(run_in_background: true)` with one-shot-runner.ts:
```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/one-shot-runner.ts" \
  --type {api|cli} --output-id ralph-discover-p{i}-iter{N} \
  --preset "{PRESET}" --model "{MODEL}" \
  --stage-type discovery --system-prompt {SYSTEM_PROMPT} \
  --allowed-tools Read,Glob,Grep \
  --cwd "${CLAUDE_PROJECT_DIR}" --task-stdin <<'{DELIM}'
IMPORTANT: You are a PARALLEL executor. Return your analysis as text output ONLY.
Do NOT create, modify, or delete any files. The orchestrator will write the final output.

{feature_description}

{validation_feedback_if_any}

Explore the codebase and running app. Report your findings with file:line references.
{DELIM}
```

**Dispatch all parallel executors in a single message.** Sequential executors wait for prior ones.

## Step 5: Collect and synthesize (draft)

Collect all responses (sequential TaskOutput polling — one at a time, never multiple in same message).

As the orchestrator, synthesize all findings into a **draft** `## Discovery` section. Be specific — include file:line references, patterns found, impact points, backpressure commands.

**Do NOT write to the plan file yet.** Hold the draft in context for adversarial validation.

The synthesis MUST use this structured format with numbered findings:

```markdown
## Discovery

### Finding F-1: {title}
- **Area:** structure | app-behavior | test-infrastructure | error-handling
- **Evidence:** {file:line references}
- **Executor support:** {list of executor indices that found this}
- **Confidence:** high | medium | low
- **Resolution:** {only if executors disagreed — which executor is correct and why}

### Finding F-2: {title}
...

### Area Coverage
- **structure:** F-1, F-3, F-7
- **app-behavior:** F-2, F-5
- **test-infrastructure:** not applicable — no test files exist in this repo
- **error-handling:** F-4, F-6
```

Rules for the synthesis:
- Every finding MUST have exactly one area tag: `structure`, `app-behavior`, `test-infrastructure`, or `error-handling`.
- The Area Coverage section MUST list all 4 areas. Areas with no findings MUST say `not applicable — {reason}`.
- When executors disagree, the synthesizer MUST include a `Resolution` field explaining which executor is correct and why.
- `Confidence` is derived from executor agreement: all executors agree = `high`, majority = `medium`, minority = `low`.

## Step 5b: Create dispatch proof

Before any plan-file Edit/Write is allowed at this checkpoint stage, create a dispatch proof for the current synthesis:

```bash
mkdir -p "${CLAUDE_PROJECT_DIR}/.vcp/plan/.dispatch"
```

Use Write tool to create `${CLAUDE_PROJECT_DIR}/.vcp/plan/.dispatch/{SLUG}-proof.json` with:

```json
{
  "stage": "discover",
  "iteration": {N},
  "timestamp": "{ISO-8601 UTC now}",
  "executor_count": {total_executor_count},
  "executor_type": "{subscription|api|mixed}",
  "output_ids": ["ralph-discover-p0-iter{N}", "ralph-discover-p1-iter{N}"]
}
```

Rules:
- Derive `{SLUG}` from the master plan filename `ralph-{SLUG}.md`.
- Overwrite the prior proof for the same slug when creating a new synthesis iteration.
- Set `executor_type` to `subscription` only if every executor was a subscription Agent. Otherwise use `api` or `mixed`.
- For any non-`subscription` proof, `output_ids` MUST include the one-shot output IDs that should exist under `${TMPDIR:-/tmp}/.vcp/oneshot/`.

## Step 6: Internal adversarial validation

Load the max iteration count:
```bash
bun -e "
import { loadDevBuddyConfig } from '${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-config.ts';
const config = loadDevBuddyConfig();
console.log(JSON.stringify({ max_discovery_iterations: config.max_discovery_iterations }));
"
```

If this is the first time reaching Step 6, set iteration = 1.

### 6a. Dispatch adversarial validator

Dispatch a separate agent to validate the synthesis:

```
Agent(subagent_type: "general-purpose", prompt: {validator_prompt})
```

The validator prompt:

```
You are an ADVERSARIAL VALIDATOR. Your job is to find flaws, not to approve.
You MUST operate fail-closed: if you cannot verify a gate with concrete evidence, it FAILS.

## What You Are Validating
Stage: Discovery
Iteration: {N} of {max}

## Synthesis Under Review
{draft_synthesis}

## Raw Executor Outputs
{executor_1_output}
---
{executor_2_output}
---
...

## Backpressure Gates (ALL must pass)

1. AREA COVERAGE (critical): Every finding has an area tag. All 4 areas (structure, app-behavior, test-infrastructure, error-handling) have >= 1 finding OR an explicit "not applicable — {reason}" entry in Area Coverage. Missing areas = FAIL.

2. CROSS-EXECUTOR AGREEMENT (critical): For each finding, the executor-support list must include >= ceil(executor_count * 0.8) executors. Findings supported by fewer must have explicit justification or be flagged as "low-confidence".

3. NO UNRESOLVED CONTRADICTIONS: Where executors disagree, the synthesis must include a Resolution field. Contradictions without resolutions = FAIL.

4. COUNTEREXAMPLE: Attempt to identify an obvious question about the codebase that remains unanswered and would block requirements definition.

## Rules
1. For every PASS, you MUST quote specific evidence from the synthesis or executor outputs.
2. If you cannot find evidence for a gate, it is FAIL — not PASS.
3. "UNVERIFIABLE" means FAIL. Do not pass gates you cannot check.
4. Before issuing a final PASS verdict, you MUST attempt one concrete counterexample.

## Response Format
**VERDICT:** PASS | FAIL

**Gate Results:**
- Gate 1: AREA COVERAGE — PASS (evidence: "...") | FAIL: {reason}
- Gate 2: CROSS-EXECUTOR AGREEMENT — PASS (evidence: "...") | FAIL: {reason}
- Gate 3: NO UNRESOLVED CONTRADICTIONS — PASS (evidence: "...") | FAIL: {reason}
- Gate 4: COUNTEREXAMPLE — PASS (counterexample: "..." — synthesis handles this) | FAIL: {gap found}

**Counterexample Attempt:**
{scenario and result}

**Failure Summary** (only if FAIL):
**Fix Guidance** (only if FAIL):
```

### 6b. Evaluate validator result

Parse the validator's response for **VERDICT: PASS** or **VERDICT: FAIL**.

**If PASS:** Proceed to Step 7 (user checkpoint).

**If FAIL and iteration < max_discovery_iterations:**
- Extract Fix Guidance from validator response.
- Clear the current dispatch proof before re-dispatch:
  ```bash
  rm -f "${CLAUDE_PROJECT_DIR}/.vcp/plan/.dispatch/{SLUG}-proof.json"
  ```
- Increment iteration.
- Re-dispatch executors (back to Step 4) with additional context:
  ```
  VALIDATION FEEDBACK (iteration {N}): The following issues were found:
  {failure_summary}
  Fix guidance: {fix_guidance}
  Focus your exploration on addressing these specific gaps.
  ```
- Collect new responses (Step 5), re-synthesize, return to Step 6a.

**If FAIL and iteration >= max_discovery_iterations:**

Compute confidence from gate results:
- Count passing gates vs total gates (4 total). Critical gates: AREA COVERAGE (Gate 1), CROSS-EXECUTOR AGREEMENT (Gate 2).
- **HIGH** (>= 80% pass, no critical fail) -- proceed with a brief note, no banner.
- **MEDIUM** (50-80% pass, no critical fail) -- proceed with caution, show warning banner.
- **LOW** (< 50% pass OR any critical fail) -- manual review required, prominent warning.
- **BLOCK** (both critical gates fail) -- escalate to orchestrator, do not present to user.

For HIGH: proceed directly to Step 7.

For MEDIUM or LOW: present structured failure warning before Step 7:

```
**WARNING: Internal validation did not fully pass after {N} iterations.**
Confidence: {level} ({X}/{Y} gates passed, critical gates: {pass|fail for each})
Unresolved: [failing gates with one-line evidence each]
Attempted fixes: [what each iteration addressed]
Recommendation: {PROCEED_WITH_CAUTION|MANUAL_REVIEW_REQUIRED}
```

Then proceed to Step 7.

For BLOCK: If running under the orchestrator, signal stop via `TaskUpdate(T-discover, status: "blocked")`. If standalone, inform the user that discovery could not produce reliable findings and ask how to proceed.

## Step 7: User checkpoint with rejection classification

Present discovery findings to the user directly in the session. Include the validation status (passed, passed with warnings, or failed with details).

The user reads the full findings in context. This IS the review.

```
AskUserQuestion: "Discovery findings ready for review. Proceed to requirements?"
  options: ["Approve", "Reject", "I have additional context"]
```

**If the user responds with questions or free-form text instead of selecting an option:**
1. Answer their questions
2. Classify: did the dialogue result in a design change (added/removed/changed findings, changed scope, invalidated assumptions)?
   - **YES** → treat as "Everything else" below — delete proof, re-dispatch ALL executors with the design change as additional context
   - **NO** (purely informational, no design impact) → return to this AskUserQuestion to get a formal Approve/Reject/Context

**Approve** → Proceed to Step 8.

**Reject / I have additional context** → The user provides feedback or new context. Two paths:

- **Single-item correction** (one already-drafted finding is factually wrong — no additions, no removals, no scope changes, no design changes): Re-synthesize only that finding (keep all others as-is). Re-run the validator (Step 6) on the full revised draft. Return to Step 7 to re-present.

- **Everything else** (additions, removals, missing areas, wrong scope, new context, multiple items, design changes, or unclear): Before re-dispatching, delete the current proof:
  ```bash
  rm -f "${CLAUDE_PROJECT_DIR}/.vcp/plan/.dispatch/{SLUG}-proof.json"
  ```
  Then re-dispatch ALL executors (back to Step 4) with user feedback injected into executor prompts alongside the original feature description and any prior synthesis. Run the full pipeline (Steps 5-6). Return to Step 7 to re-present the full revised set.

  **The orchestrator MUST NOT author, add, remove, or revise findings locally.** The orchestrator synthesizes executor outputs — it does not replace multi-AI diversity with its own analysis. Even if the revision seems straightforward, re-dispatch.

**Scope change detection:** User feedback constitutes "Everything else" if ANY of these apply:
- Changes the count of findings (adds or removes)
- Changes the investigation scope or focus area
- Invalidates assumptions in existing findings
- Provides new context that affects multiple findings

**Default:** If the feedback does not clearly match a single-item factual correction, re-dispatch to executors. When in doubt, re-dispatch — do NOT revise the synthesis locally.

## Step 8: Write approved synthesis to plan file

Only after user approval in Step 7:

Update the master plan file using Edit tool: replace `## Discovery\n(pending)` with the approved synthesis.

Update plan status to `requirements`.

If running under the orchestrator, update tasks:
- `TaskUpdate(T-discover, status: "completed")`
- `TaskUpdate(T-requirements, status: "in_progress")`

---

## Known Constraints

1. **Playwright/browser tools:** If the user's environment has Playwright MCP or Chrome DevTools, use them to explore the running app (screenshots, UI interactions). If unavailable, fall back to code-only analysis and ask the user for screenshots.

2. **Tool restriction:** API executors are structurally restricted to `Read,Glob,Grep` via `--allowed-tools`. CLI executors receive a prompt-level instruction. Subscription executors get prompt-level guidance only.

3. **Sequential TaskOutput polling:** Do NOT issue multiple TaskOutput calls in the same message — this causes cascade failures. Poll one at a time.

4. **Adversarial validator:** The validator runs as a subscription-based Agent inheriting the main session's model. It does not have tool access — it validates the synthesis purely from the text of the draft and executor outputs. The max iteration count is controlled by `config.max_discovery_iterations` (default: 3).
