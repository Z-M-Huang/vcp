---
name: dev-buddy-decompose
description: Decomposition stage — break features into small, independently testable units of work
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent, Task, TaskOutput, TaskCreate, TaskUpdate, TaskList, TaskGet, AskUserQuestion
---

# Decomposition Stage

Break the feature into tiny, independently testable units of work. Create per-unit plan files.

**Standalone usage:** `/dev-buddy-decompose` — reads the most recent `ralph-*.md` plan file and creates unit plans.

**Orchestrator usage:** Called by `/dev-buddy-ralph` with plan path already established.

---

## Step 1: Find the plan file

If no plan file path is in current context, find the most recent one:
```bash
ls -t "${CLAUDE_PROJECT_DIR}/.vcp/plan/ralph-*.md" 2>/dev/null | head -1
```

Read the plan file. The `## Requirements` section must be populated. If not, tell the user to run `/dev-buddy-requirements` first.

Extract the slug from the filename: `ralph-{SLUG}.md` -> `{SLUG}`.

---

## Step 2: Load stage executors

```bash
bun -e "
import { loadDevBuddyConfig } from '${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-config.ts';
import { readPresets } from '${CLAUDE_PLUGIN_ROOT}/scripts/preset-utils.ts';
const config = loadDevBuddyConfig();
const presets = readPresets();
const stage = config.stages['decomposition'];
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
const stage = loadStageDefinition('decomposition', '${CLAUDE_PLUGIN_ROOT}/stages');
const role = getSystemPrompt('{SYSTEM_PROMPT}', '${CLAUDE_PLUGIN_ROOT}/system-prompts/built-in');
if (stage && role) console.log(composePrompt(stage, role));
else console.log('ERROR: Could not resolve prompts');
"
```

## Step 4: Dispatch executors

Track the current iteration number `N` (starts at 1, increments on re-dispatch).

Each executor receives:
- Discovery findings + Requirements from master plan
- Decomposition rules (max ~50 LOC, AC mapping, dependency ordering, first unit = UAT tests)
- If re-dispatched from Step 6: validator feedback and specific revision instructions

**Subscription executors:** `Agent(subagent_type: "general-purpose", model: {model}, prompt: {composed_prompt + plan_context + validation_feedback_if_any})`

**API/CLI executors:** `Bash(run_in_background: true)` with one-shot-runner.ts:
```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/one-shot-runner.ts" \
  --type {api|cli} --output-id ralph-decomp-p{i}-iter{N} \
  --preset "{PRESET}" --model "{MODEL}" \
  --stage-type decomposition --system-prompt {SYSTEM_PROMPT} \
  --allowed-tools Read,Glob,Grep \
  --cwd "${CLAUDE_PROJECT_DIR}" --task-stdin <<'{DELIM}'
IMPORTANT: You are a PARALLEL executor. Return your analysis as text output ONLY.
Do NOT create, modify, or delete any files. The orchestrator will write the final output.

{plan_context}

{validation_feedback_if_any}

Break this feature into small, independently testable units of work. Return your decomposition as text.
{DELIM}
```

**Dispatch all parallel executors in a single message.**

## Step 5: Collect and synthesize

Collect all responses (sequential TaskOutput polling -- one at a time).

**Before synthesizing:** Re-read the master plan's `## Discovery` section. For each unit you create, you MUST:
1. Identify which discovery findings (F-N) are relevant to that unit's files and functionality
2. Extract specific file:line references, existing patterns, and API signatures from those findings
3. Include this extracted context in the unit's "Discovered Context" field — cite the finding IDs

Do NOT synthesize from memory alone. Do NOT use generic placeholders.

Synthesize into a decomposition using the following structured format. This template matches the `decomposition.md` stage definition Output Format — ALL sections are required, do not omit any:

```markdown
### Unit {N}: {title}

#### Acceptance Criteria
- AC-{X}: {copy the specific AC text from master plan}

#### What to Implement
- **Current state:** {what the code/app looks like now — from discovery findings}
- **Target state:** {what it should look like after — from requirements/ACs}
- **Changes:** {specific functions, components, or changes to make}

#### Discovered Context
{Relevant findings from discovery — cite F-N IDs, include file:line refs, existing patterns, API signatures, architectural constraints that the implementer needs}

#### Files to Touch
- `src/foo.ts` -- existing | modify -- {why this file and what to change in it}
- `tests/foo.test.ts` -- new | create -- {what this file contains and why}

#### Backpressure
- Unit tests: `{specific test command for this unit}`
- Typecheck: `{typecheck command}`
- Lint: `{lint command}`

#### Dependencies
- Depends on: Unit {A}, Unit {B} (or "none")
- Required by: Unit {P} (or "none")

#### Done When
{specific testable criteria — all backpressure passes}
```

Each unit must:
- Map to at least one AC
- Have specific backpressure (tests that validate just this unit)
- Be completable without future units existing
- Be ~50 lines of production code max
- Be ordered by dependency (no forward references)
- **First unit**: write the UAT Playwright test files (red -- they should fail initially)
- **Last unit**: integration glue if needed

Every file listed in "Files to Touch" MUST be tagged `existing | modify` or `new | create` with a "why and what" annotation.

**Do NOT create any artifacts yet.** Hold the synthesis in context for adversarial validation.

## Step 5b: Create dispatch proof

Before any plan-file Edit/Write is allowed at this checkpoint stage, create a dispatch proof for the current synthesis:

```bash
mkdir -p "${CLAUDE_PROJECT_DIR}/.vcp/plan/.dispatch"
```

Use Write tool to create `${CLAUDE_PROJECT_DIR}/.vcp/plan/.dispatch/{SLUG}-proof.json` with:

```json
{
  "stage": "decompose",
  "iteration": {N},
  "timestamp": "{ISO-8601 UTC now}",
  "executor_count": {total_executor_count},
  "executor_type": "{subscription|api|mixed}",
  "output_ids": ["ralph-decomp-p0-iter{N}", "ralph-decomp-p1-iter{N}"]
}
```

Rules:
- Reuse the slug already extracted from `ralph-{SLUG}.md`.
- Overwrite the prior proof for the same slug when creating a new synthesis iteration.
- Set `executor_type` to `subscription` only if every executor was a subscription Agent. Otherwise use `api` or `mixed`.
- For any non-`subscription` proof, `output_ids` MUST include the one-shot output IDs that should exist under `${TMPDIR:-/tmp}/.vcp/oneshot/`.

## Step 6: Internal adversarial validation loop

### 6a. Load validation config

```bash
bun -e "
import { loadDevBuddyConfig } from '${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-config.ts';
const config = loadDevBuddyConfig();
console.log(JSON.stringify({ max_decomposition_iterations: config.max_decomposition_iterations }));
"
```

Track iteration count `N`.

### 6b. Mechanical file existence check

Run BEFORE the validator. For each file listed in all units' "Files to Touch":
```bash
# For each file in all units' "Files to Touch":
test -f "{file_path}" && echo "EXISTS: {file_path}" || echo "MISSING: {file_path}"
```

Collect results. Files tagged `existing | modify` MUST show EXISTS. Files tagged `new | create` MUST show MISSING. Record all mismatches.

### 6c. Dispatch adversarial validator

Dispatch a single validator subagent. Feed it the full decomposition, the mechanical file-check results from Step 6b, and the fresh-context simulation results from Step 6e.

```
Agent(subagent_type: "general-purpose", prompt:
  "You are an adversarial reviewer of a decomposition plan.
   Your job is to find flaws that will cause build failures.

   DECOMPOSITION:
   {full_synthesis_from_step_5}

   FILE EXISTENCE CHECK RESULTS:
   {results_from_step_6b}

   FRESH-CONTEXT SIMULATION RESULTS:
   {results_from_step_6e}

   Evaluate against these gates:

   1. **AC COVERAGE** (critical): Every AC-{N} from Requirements maps to >= 1 unit.
      Every unit maps to >= 1 AC. List any unmapped ACs or orphan units.

   2. **NO DEPENDENCY CYCLES** (critical): Units form a DAG. Trace 'Depends on' arrays.
      Flag any transitive self-dependency (A->B->C->A).

   3. **UNIT PLAN COMPLETENESS**: Every unit has all required fields:
      - What to Implement (specific, not vague)
      - Files to Touch (with existing|new tags)
      - Backpressure (specific commands, not generic)
      - Done When (concrete, testable)
      List any unit missing or having vague fields.

   4. **FILE EXISTENCE**: Cross-reference with mechanical check results above.
      Files tagged 'existing' must show EXISTS. Files tagged 'new' must show MISSING.
      List all mismatches.

   5. **FRESH-CONTEXT SIMULATION**: Review the simulation results above.
      Any unit where the simulator found gaps = FAIL for that unit.
      List affected units and the gaps found.

   6. **COUNTEREXAMPLE**: Find a unit with hidden dependency on another unit's
      implementation details that is NOT declared in 'Depends on'.
      Describe the specific coupling.

   For each gate: PASS or FAIL with specific evidence.
   Final verdict: PASS (all gates pass) or FAIL (any gate fails).
   If FAIL, output:
   **Failure Summary:** {one-paragraph summary of all failures}
   **Fix Guidance:** {specific fixes needed per failed gate}")
```

### 6d. Evaluate validator result

- **PASS:** All gates pass. Proceed to Step 7 (user approval).
- **FAIL and iteration < max_decomposition_iterations:**
  - Extract Failure Summary and Fix Guidance from validator response.
  - Clear the current dispatch proof before re-dispatch:
    ```bash
    rm -f "${CLAUDE_PROJECT_DIR}/.vcp/plan/.dispatch/{SLUG}-proof.json"
    ```
  - Increment iteration counter `N`.
  - Re-dispatch executors (back to Step 4) with additional context:
    ```
    VALIDATION FEEDBACK (iteration {N}): The following issues were found:
    {failure_summary}
    Fix guidance: {fix_guidance}
    Focus on addressing these specific gaps in your decomposition.
    ```
  - Collect new responses (Step 5), re-synthesize, run Steps 6b-6e, return to Step 6c.
- **FAIL and iteration >= max_decomposition_iterations (exhaustion):**
  - If critical gates (1: AC COVERAGE or 2: NO DEPENDENCY CYCLES) are still failing: re-dispatch to Step 4 one final time with validator feedback (one last attempt before presenting to user). After this final attempt, proceed to Step 6f regardless of outcome.
  - Otherwise: proceed to Step 6f (exhaustion handling).
- **Critical gate failures** (AC COVERAGE or NO DEPENDENCY CYCLES) always count as FAIL regardless of other gates.

### 6e. Fresh-context simulation (runs in parallel with 6b, before 6c)

For ALL units, dispatch in parallel batches of up to 5 subagents:

```
Agent(subagent_type: "general-purpose", prompt:
  "You are a developer starting a fresh session. You have NEVER seen
   this codebase before. Your ONLY context is this unit plan:

   {unit_plan_text_only}

   Can you implement this? Identify:
   1. Missing context that would force you to explore the codebase
   2. Ambiguous instructions where you'd have to guess
   3. Unstated assumptions about existing code
   4. Missing file paths, function names, or API signatures

   List every gap. If none, say COMPLETE.")
```

Collect all simulation results. Any unit where the simulator found gaps = evidence for gate 5 in Step 6c.

**Gap enrichment for re-dispatch:** When simulation gaps trigger a FAIL verdict (Step 6d) and re-dispatch to Step 4, include the specific gaps as enrichment instructions in the re-dispatch prompt. One-way flow:
- Missing file paths → executor must add to "Files to Touch" with correct existing/new tags
- Missing function names or API signatures → executor must add to "Discovered Context" by reading relevant source files
- Ambiguous instructions → executor must expand in "What to Implement" with concrete before/after/changes
- Unstated assumptions → executor must make explicit in "Discovered Context"

### 6f. Exhaustion handling

Reached from Step 6d when iterations are exhausted (after any critical-gate final attempt).
- Present the current decomposition to the user with all outstanding validator findings.
- Ask the user to resolve the remaining issues manually via AskUserQuestion.
- Proceed to Step 7 with whatever the user confirms.

---

## Step 7: User approval (BEFORE artifact creation)

Present the complete decomposition to the user. Include:
- All units in structured format
- Validation status (PASS, or remaining findings if exhaustion)
- Dependency graph summary

```
AskUserQuestion: "Does this breakdown look right? Any units that should be split further or reordered?"
  options: ["Approve", "Reject one or more units", "I have additional context"]
```

**If the user responds with questions or free-form text instead of selecting an option:**
1. Answer their questions
2. Classify: did the dialogue result in a design change (added/removed/changed units, changed scope, invalidated assumptions)?
   - **YES** → treat as "Everything else" below — delete proof, re-dispatch ALL executors with the design change as additional context
   - **NO** (purely informational, no design impact) → return to this AskUserQuestion to get a formal Approve/Reject/Context

### On approval

Proceed to Step 8 (create artifacts).

### On rejection / "I have additional context"

The user provides feedback or new context. Two paths:

- **Single-unit correction** (one already-drafted unit needs factual correction — no additions, no removals, no scope changes, no design changes, no new units): Re-synthesize only that unit locally (Step 5) with the feedback, then re-run validation (Step 6). Do not re-dispatch executors.

- **Everything else** (additions, removals, missing areas, wrong scope, new context, multiple units, design changes, or unclear): Before re-dispatching, delete the current proof:
  ```bash
  rm -f "${CLAUDE_PROJECT_DIR}/.vcp/plan/.dispatch/{SLUG}-proof.json"
  ```
  Then re-dispatch ALL executors (back to Step 4) with user feedback injected into executor prompts alongside the plan context. Run the full pipeline (Steps 5-6). Return to Step 7 to re-present the full revised set.

  **The orchestrator MUST NOT author, add, remove, or revise units locally.** The orchestrator synthesizes executor outputs — it does not replace multi-AI diversity with its own analysis. Even if the revision seems straightforward, re-dispatch.

**Scope change detection:** User feedback constitutes "Everything else" if ANY of these apply:
- Changes the count of units (adds or removes)
- Changes the dependency order or architecture approach
- Invalidates assumptions in existing units
- Provides new context that affects multiple units

**Default:** If the feedback does not clearly match a single-unit factual correction, re-dispatch to executors. When in doubt, re-dispatch — do NOT revise the decomposition locally.


---

## Step 8: Create artifacts (ONLY after user approval)

### 8a. Create per-unit plan files

For each unit, check existence before writing (idempotent):
```bash
test -f "${CLAUDE_PROJECT_DIR}/.vcp/plan/ralph/{SLUG}/unit-{N}.md" && echo "EXISTS" || echo "NEW"
```

Use Write tool to create `${CLAUDE_PROJECT_DIR}/.vcp/plan/ralph/{SLUG}/unit-{N}.md`.

Populate each field by **transcribing from the approved synthesis** (Step 5/7). The unit file is a self-contained document — a fresh-context implementer reads ONLY this file. Every field must contain concrete content transcribed from the synthesis, not placeholders.

```markdown
# Unit {N}: {Title}

**Parent:** ralph-{SLUG}
**Status:** pending
**Attempts:** 0
**Max Attempts:** {max_build_attempts from config}

## Acceptance Criteria
{transcribe the specific AC text from synthesis — include Given/When/Then from master plan's ## Requirements}

## What to Implement
- **Current state:** {transcribe from synthesis — what the code/app looks like now}
- **Target state:** {transcribe from synthesis — what it should look like after}
- **Changes:** {transcribe from synthesis — specific functions, components, or changes}

## Discovered Context
{transcribe from synthesis — must include F-N finding IDs, file:line refs, existing patterns, API signatures, architectural constraints from master plan's ## Discovery section}

## Files to Touch
- `src/foo.ts` -- existing | modify -- {transcribe why and what from synthesis}
- `tests/foo.test.ts` -- new | create -- {transcribe what to test from synthesis}

## Backpressure
- Unit tests: `{specific test command from synthesis}`
- Typecheck: `{typecheck command from synthesis}`
- Lint: `{lint command from synthesis}`

## Dependencies
- Depends on: {transcribe from synthesis}
- Required by: {transcribe from synthesis}

## Done When
{transcribe specific criteria from synthesis}
```

**Post-Write verification:** After each unit file Write, confirm the Discovered Context section is non-empty:
```bash
grep -c '## Discovered Context' "${CLAUDE_PROJECT_DIR}/.vcp/plan/ralph/{SLUG}/unit-{N}.md" && \
grep -A1 '## Discovered Context' "${CLAUDE_PROJECT_DIR}/.vcp/plan/ralph/{SLUG}/unit-{N}.md" | tail -1 | grep -cv '^$'
```
If the section is empty (second grep returns 0), re-Write the file with the missing content before proceeding to the next unit.

### 8b. Update master plan

Append `## Units of Work` table to master plan using Edit tool:

```markdown
## Units of Work
| # | Title | ACs | Depends On | Status |
|---|-------|-----|------------|--------|
| 1 | Write UAT tests | UAT-1,2,3 | -- | pending |
| 2 | {title} | AC-1 | -- | pending |
| 3 | {title} | AC-2,3 | 2 | pending |
```

### 8c. Create unit tasks (if running under orchestrator)

```
TaskCreate("Unit 1: {title} -- ralph-{SLUG}", status: "pending", blocked_by: [T-decompose])
TaskCreate("Unit 2: {title} -- ralph-{SLUG}", status: "pending", blocked_by: [T-decompose, T-unit-1 if dependency])
...
```

Update Code Review task to depend on all unit tasks.

### 8d. Rollback on partial failure

If any artifact creation fails mid-way:
1. Delete any unit plan files already created:
   ```bash
   rm -f "${CLAUDE_PROJECT_DIR}/.vcp/plan/ralph/{SLUG}/unit-*.md"
   ```
2. Do NOT update plan status (stays "decompose").
3. Do NOT create remaining tasks.
4. Report failure to user with specifics of what failed.
5. User can retry -- re-runs Step 8 only (decomposition is already approved).

---

## Step 9: Update plan status

ONLY after ALL artifacts from Step 8 are successfully created:

Update plan status to `build` using Edit tool: replace `**Status:** decompose` with `**Status:** build`.

If running under the orchestrator, update tasks:
- `TaskUpdate(T-decompose, status: "completed")`

---

## Known Constraints

1. **Tool restriction:** API executors are structurally restricted to `Read,Glob,Grep` via `--allowed-tools`. CLI executors receive a prompt-level instruction. Subscription executors get prompt-level guidance only.
2. **Sequential TaskOutput polling:** Do NOT issue multiple TaskOutput calls in the same message.
3. **Validation loop budget:** The adversarial validation loop (Step 6) is bounded by `max_decomposition_iterations` from config (default: 2). After exhaustion, the decomposition is presented to the user as-is with outstanding findings.
4. **Adversarial validator:** The validator and fresh-context simulators run as subscription-based Agents inheriting the main session's model. They do not have tool access.
5. **Approve-before-create:** Artifacts (unit plan files, master plan updates, tasks) are NEVER created until the user explicitly approves the decomposition in Step 7. This prevents wasted work and simplifies rollback.
6. **Rollback scope:** If artifact creation (Step 8) fails partway, all unit plan files for this slug are deleted. The plan status remains "decompose" so the user can retry without re-running validation.
7. **Fresh-context simulation:** Step 6e runs in parallel with Step 6b (both before 6c). Dispatch up to 5 simulation subagents at a time to stay within concurrency limits.
