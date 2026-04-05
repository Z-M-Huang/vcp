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

**Subscription executors:** `Agent(subagent_type: "general-purpose", model: {model}, prompt: {composed_prompt + plan_context})`

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

Break this feature into small, independently testable units of work. Return your decomposition as text.
{DELIM}
```

**Dispatch all parallel executors in a single message.**

## Step 5: Collect and synthesize

Collect all responses (sequential TaskOutput polling -- one at a time).

Synthesize into a decomposition using the following structured format. Each unit MUST use this exact template:

```markdown
### Unit {N}: {title}
- **ACs:** AC-{X}, AC-{Y}
- **Depends on:** Unit {A}, Unit {B} (or "none")
- **What to implement:** {specific functions, components, or changes}
- **Files to touch:**
  - `src/foo.ts` -- existing | modify
  - `src/bar.ts` -- new | create
- **Backpressure:** `bun test src/foo.test.ts`
- **Done when:** {specific criteria}
```

Each unit must:
- Map to at least one AC
- Have specific backpressure (tests that validate just this unit)
- Be completable without future units existing
- Be ~50 lines of production code max
- Be ordered by dependency (no forward references)
- **First unit**: write the UAT Playwright test files (red -- they should fail initially)
- **Last unit**: integration glue if needed

Every file listed in "Files to touch" MUST be tagged `existing | modify` or `new | create`.

**Do NOT create any artifacts yet.** Hold the synthesis in context for adversarial validation.

## Step 6: Internal adversarial validation loop

### 6a. Load validation config

```bash
bun -e "
import { loadDevBuddyConfig } from '${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-config.ts';
const config = loadDevBuddyConfig();
console.log(JSON.stringify({ max_decomposition_iterations: config.max_decomposition_iterations }));
"
```

Track iteration count. If this is iteration `N` and `N > max_decomposition_iterations`, skip to exhaustion handling (Step 6f).

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
   If FAIL, classify: STRUCTURAL (needs re-dispatch to Step 4) or
   LOCALIZED (can be fixed by re-synthesizing locally in Step 5).
   Structural = missing ACs, wrong unit boundaries, fundamental ordering issues.
   Localized = missing fields, vague descriptions, file tag mismatches.")
```

### 6d. Evaluate validator result

- **PASS:** All gates pass. Proceed to Step 7 (user approval).
- **FAIL (LOCALIZED):** Re-synthesize locally. Return to Step 5 with the validator's specific feedback, fix only the flagged issues, then re-run Step 6 (increment iteration).
- **FAIL (STRUCTURAL):** Re-dispatch to Step 4 with the validator's feedback injected into executor prompts. Increment iteration, then flow through Step 5 -> Step 6 again.
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

### 6f. Exhaustion handling

If iteration count exceeds `max_decomposition_iterations`:
- Do NOT loop again.
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
  options: ["Approve", "Reject one or more units"]
```

### On approval

Proceed to Step 8 (create artifacts).

### On rejection

For each rejected item, classify the rejection:

```
AskUserQuestion: "What kind of issue?"
  options: ["Localized fix", "Structural gap", "Fundamental rethink", "Operational problem"]
```

**Localized fix:** User provides specific feedback. Re-synthesize locally (Step 5) with the feedback, then re-run validation (Step 6). Do not re-dispatch executors.

**Structural gap:** User provides feedback on what's wrong with the structure. Re-dispatch to Step 4 with user feedback injected into executor prompts. Flow through Steps 5 -> 6 -> 7.

**Fundamental rethink:** The decomposition approach is wrong. Escalate -- ask the user what they want to change about the overall approach. Incorporate their direction and re-dispatch to Step 4 with significantly revised instructions.

**Operational problem:** Something outside the decomposition is wrong (e.g., missing dependencies, environment issues). Do not loop. Report the issue and ask the user to resolve it before retrying.

---

## Step 8: Create artifacts (ONLY after user approval)

### 8a. Create per-unit plan files

For each unit, check existence before writing (idempotent):
```bash
test -f "${CLAUDE_PROJECT_DIR}/.vcp/plan/ralph/{SLUG}/unit-{N}.md" && echo "EXISTS" || echo "NEW"
```

Use Write tool to create `${CLAUDE_PROJECT_DIR}/.vcp/plan/ralph/{SLUG}/unit-{N}.md`:

```markdown
# Unit {N}: {Title}

**Parent:** ralph-{SLUG}
**Status:** pending
**Attempts:** 0
**Max Attempts:** {max_build_attempts from config}

## Acceptance Criteria
{specific ACs from master plan}

## What to Implement
{precise instructions -- no design decisions left}

## Discovered Context
{relevant discovery findings}

## Files to Touch
- `src/foo.ts` -- existing | modify -- why and what
- `tests/foo.test.ts` -- new | create -- what to test

## Backpressure
- Unit tests: `{specific test command}`
- Typecheck: `{command}`
- Lint: `{command}`

## Done When
All listed backpressure passes
```

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
