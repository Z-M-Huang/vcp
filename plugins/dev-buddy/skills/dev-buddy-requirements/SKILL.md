---
name: dev-buddy-requirements
description: Requirements + UAT design stage — acceptance criteria and Playwright test scenario authoring
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent, Task, TaskOutput, TaskCreate, TaskUpdate, TaskList, TaskGet, AskUserQuestion
---

# Requirements + UAT Design Stage

Define what "done" looks like — acceptance criteria in Given/When/Then format plus executable UAT scenarios.

**Standalone usage:** `/dev-buddy-requirements` — reads the most recent `ralph-*.md` plan file and appends requirements.

**Orchestrator usage:** Called by `/dev-buddy-ralph` with plan path already established.

---

## Step 1: Find the plan file

If no plan file path is in current context, find the most recent one:
```bash
ls -t "${CLAUDE_PROJECT_DIR}/.vcp/plan/ralph-*.md" 2>/dev/null | head -1
```

Read the plan file. The `## Discovery` section must be populated (not `(pending)`). If discovery hasn't been done, tell the user to run `/dev-buddy-discover` first.

---

## Step 2: Load stage executors

```bash
bun -e "
import { loadDevBuddyConfig } from '${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-config.ts';
import { readPresets } from '${CLAUDE_PLUGIN_ROOT}/scripts/preset-utils.ts';
const config = loadDevBuddyConfig();
const presets = readPresets();
const stage = config.stages['ralph-requirements'];
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

```bash
bun -e "
import { loadStageDefinition, composePrompt, getSystemPrompt } from '${CLAUDE_PLUGIN_ROOT}/scripts/system-prompts.ts';
const stage = loadStageDefinition('ralph-requirements', '${CLAUDE_PLUGIN_ROOT}/stages');
const role = getSystemPrompt('{SYSTEM_PROMPT}', '${CLAUDE_PLUGIN_ROOT}/system-prompts/built-in');
if (stage && role) console.log(composePrompt(stage, role));
else console.log('ERROR: Could not resolve prompts');
"
```

## Step 4: Dispatch executors

**MANDATORY: You MUST dispatch executors as configured. Do NOT skip this step.** Even if you have prior context from discovery, chatroom debates, or earlier stages, executor dispatch is required — each executor brings independent perspective and the synthesis depends on multi-AI diversity. Skipping dispatch violates the pipeline contract.

Same dispatch pattern as discovery. Each executor receives:
- Discovery findings from the master plan
- Feature description
- Instructions to produce: ACs (Given/When/Then + misinterpretation), UAT scenarios, edge cases, risks

Set iteration N = 1 on first entry. On re-entry from Step 6d (validation failure), increment N. Use it in output IDs.

**Subscription executors:** `Agent(subagent_type: "general-purpose", model: {model}, prompt: {composed_prompt + discovery_section + feature_description + validation_feedback_if_any})`

**API/CLI executors:** `Bash(run_in_background: true)` with one-shot-runner.ts:
```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/one-shot-runner.ts" \
  --type {api|cli} --output-id ralph-req-p{i}-iter{N} \
  --preset "{PRESET}" --model "{MODEL}" \
  --stage-type ralph-requirements --system-prompt {SYSTEM_PROMPT} \
  --allowed-tools Read,Glob,Grep \
  --cwd "${CLAUDE_PROJECT_DIR}" --task-stdin <<'{DELIM}'
IMPORTANT: You are a PARALLEL executor. Return your analysis as text output ONLY.
Do NOT create, modify, or delete any files. The orchestrator will write the final output.

{discovery_section + feature_description}

{validation_feedback_if_any}

Define acceptance criteria (Given/When/Then + misinterpretation), UAT scenarios, edge cases, and risks.
{DELIM}
```

**Dispatch all parallel executors in a single message.** Sequential executors wait for prior ones.

## Step 5: Collect and synthesize (structured draft)

Collect all responses (sequential TaskOutput polling — one at a time, never multiple in same message).

Synthesize into a **structured draft** using the exact format below. Every AC and UAT must follow this template:

### AC format

```markdown
### AC-{N}: {title}
- **Given:** {concrete precondition}
- **When:** {specific action}
- **Then:** {observable, testable outcome}
- **Misinterpretation:** {plausible wrong implementation}
- **Discovery refs:** F-{X}, F-{Y}
- **Edge cases:** {list}
```

### UAT format

```markdown
### UAT-{N}: {title}
- **Validates:** AC-{X}, AC-{Y}
- **Test file:** {path}
- **Steps:** {numbered steps}
- **Assertions:** {specific checks}
```

### AC-to-UAT mapping table

Include this table immediately after all AC and UAT definitions:

```markdown
| AC | UAT Scenarios |
|----|--------------|
| AC-1 | UAT-1, UAT-3 |
| AC-2 | UAT-2 |
```

The draft must also include:
- **Backpressure Commands** (test, typecheck, lint, build, uat commands)
- **Risk Registry** (identified risks with mitigations)

**Do NOT write to the plan file yet.** Hold the draft in context for the internal adversarial validation loop.

## Step 6: Internal adversarial validation loop

Before presenting the draft to the user, validate it mechanically. This catches structural defects early and reduces human review burden.

### 6a. Load validation config

```bash
bun -e "
import { loadDevBuddyConfig } from '${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-config.ts';
const config = loadDevBuddyConfig();
console.log(JSON.stringify({ max_requirements_iterations: config.max_requirements_iterations }));
"
```

Store `max_requirements_iterations`.

### 6b. Backpressure gates

Apply these six gates against the current draft. Each gate is either PASS or FAIL. Gates marked **(critical)** cause an overall FAIL regardless of other gate results.

1. **GIVEN/WHEN/THEN COMPLETENESS** (critical): Every AC-{N} has all three fields non-empty. Flag vague terms in any field: "should work," "appropriate," "correctly," "properly," "as expected." Any missing field or vague term = FAIL.

2. **MISINTERPRETATION FIELD**: Every AC has a misinterpretation that describes a *different, plausible* implementation someone might build by misreading the AC. Tautological misinterpretations (restating the AC negated, e.g., "does not do X" when the AC says "does X") = FAIL.

3. **AC-TO-UAT MAPPING** (critical): The mapping table contains every AC-{N} with >= 1 corresponding UAT scenario. Orphan ACs (present in AC list but missing from mapping table) = FAIL.

4. **EDGE CASE COVERAGE**: Each AC has >= 1 edge case listed. "No edge cases" = FAIL unless accompanied by a written justification explaining why none exist.

5. **AC-TO-DISCOVERY TRACEABILITY**: Each AC references >= 1 discovery finding (F-{N}) in its Discovery refs field. Unreferenced ACs = FAIL.

6. **COUNTEREXAMPLE**: Attempt to find at least one AC that is vague, untestable, or has a tautological misinterpretation. If found = FAIL with the specific AC identified. If none found = PASS.

### 6c. Validator dispatch

Dispatch the validator as a single Agent call (inherits the main session's model):

```
Agent(subagent_type: "general-purpose", prompt: """
You are a requirements validator. Evaluate the following draft against these gates.
For each gate, output PASS or FAIL with a one-line justification.
If FAIL, quote the specific offending item(s).

GATES:
1. GIVEN/WHEN/THEN COMPLETENESS (critical) — all ACs have Given/When/Then; no vague terms
2. MISINTERPRETATION FIELD — each AC has a non-tautological misinterpretation
3. AC-TO-UAT MAPPING (critical) — mapping table covers every AC with >= 1 UAT
4. EDGE CASE COVERAGE — each AC has >= 1 edge case or justification
5. AC-TO-DISCOVERY TRACEABILITY — each AC refs >= 1 discovery finding
6. COUNTEREXAMPLE — find one vague, untestable, or tautological AC

Output format:
GATE 1: PASS|FAIL — {reason}
GATE 2: PASS|FAIL — {reason}
...
GATE 6: PASS|FAIL — {reason}
OVERALL: PASS|FAIL

If OVERALL is FAIL, output:
**Failure Summary:** {one-paragraph summary of all failures}
**Fix Guidance:** {specific fixes needed per failed gate}

--- DRAFT ---
{full structured draft}
""")
```

### 6d. PASS/FAIL/exhaustion logic

- **OVERALL PASS**: Proceed to Step 7 (present and confirm).
- **OVERALL FAIL and iteration < max_requirements_iterations:**
  - Extract Failure Summary and Fix Guidance from validator response.
  - Increment iteration counter `N`.
  - Re-dispatch executors (back to Step 4) with additional context:
    ```
    VALIDATION FEEDBACK (iteration {N}): The following issues were found:
    {failure_summary}
    Fix guidance: {fix_guidance}
    Focus on addressing these specific gaps in your acceptance criteria, UAT scenarios, and coverage.
    ```
  - Collect new responses (Step 5), re-synthesize, return to Step 6a.
- **OVERALL FAIL and iteration >= max_requirements_iterations (exhaustion):**
  - If critical gates (1: GIVEN/WHEN/THEN COMPLETENESS or 3: AC-TO-UAT MAPPING) are still failing: re-dispatch to Step 4 one final time with validator feedback (one last attempt before presenting to user).
  - Otherwise: proceed to Step 7 with exhaustion warning — let the human decide.

Track iteration count and report it when presenting to the user: "Internal validation: passed after {N} iteration(s)" or "Internal validation: exhausted after {N} iteration(s), {remaining issues}".

## Step 7: Present findings and confirm

### 7a. Pre-presentation clarification (optional)

If during synthesis you identified ambiguities or questions that would materially affect the ACs or UATs, ask the user BEFORE presenting the final list:

```
AskUserQuestion: "{specific question about the feature that affects requirements}"
  options: ["{option A}", "{option B}", "Let me explain"]
```

Only use this for genuine blockers — questions whose answer changes the requirements. Do not ask rhetorical or confirmatory questions.

### 7b. Present the full draft

Print the complete set of ACs, UATs, and the AC-to-UAT mapping table directly into the session as formatted text. Include the validation status (iteration count, gate results).

The user reads the full draft in context. This IS the review — no separate batched approval flow.

### 7c. Single confirmation

After presenting everything:

```
AskUserQuestion: "Requirements ready for review. {N} acceptance criteria, {M} UAT scenarios."
  options: ["Approve", "Reject", "I have additional context"]
```

### 7d. Handle response

**Approve** → Proceed to Step 8 (write to plan file).

**Reject** → The user provides specific feedback on what needs to change (which ACs/UATs are wrong and why). Classify the feedback:

- **Localized** (specific ACs/UATs are wrong): Re-synthesize only the contested items. Run the internal validation loop (Step 6). Re-present the **full revised set** (back to Step 7b).

- **Structural** (missing areas, wrong scope): Full re-dispatch to Step 4 with user feedback injected into executor prompts. Run the full pipeline (Steps 5-6). Re-present (back to Step 7b).

- **Fundamental** (requirements need rethinking): Escalate — "This feedback suggests re-running discovery with refined scope." Stop the stage.

**I have additional context** → The user provides context that should inform the requirements. Revise the draft incorporating the new context. Run the internal validation loop (Step 6). Re-present the **full revised set** (back to Step 7b).

**Key invariant:** After any revision, the user ALWAYS sees the complete revised set — never a partial update.

## Step 8: Write confirmed requirements to plan file

Now that all ACs and UAT scenarios are user-confirmed, write the final `## Requirements` section to the master plan:

Update the master plan using Edit tool: replace `## Requirements\n(pending)` with the confirmed synthesis.

Update plan status to `decompose`.

If running under the orchestrator, update tasks:
- `TaskUpdate(T-requirements, status: "completed")`
- `TaskUpdate(T-decompose, status: "in_progress")`

---

## Known Constraints

1. **Tool restriction:** API executors are structurally restricted to `Read,Glob,Grep` via `--allowed-tools`. CLI executors receive a prompt-level instruction. Subscription executors get prompt-level guidance only.
2. **Sequential TaskOutput polling:** Do NOT issue multiple TaskOutput calls in the same message.
3. **Adversarial validator:** The validator runs as a subscription-based Agent inheriting the main session's model. It does not have tool access — it validates the synthesis purely from text. The max iteration count is controlled by `config.max_requirements_iterations` (default: 3).
