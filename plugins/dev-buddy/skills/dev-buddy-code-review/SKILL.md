---
name: dev-buddy-code-review
description: Code review stage — multi-AI semantic drift detection with AC tracing
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent, Task, TaskOutput, TaskCreate, TaskUpdate, TaskList, TaskGet, AskUserQuestion
---

# Code Review Stage

Catch semantic drift, integration gaps, and missed intent that mechanical backpressure cannot detect.

**Standalone usage:** `/dev-buddy-code-review` — reads the most recent `ralph-*.md` plan file and reviews all implemented units.

**Orchestrator usage:** Called by `/dev-buddy-ralph` after all units are built.

---

## Step 1: Find the plan file

If no plan file path is in current context, find the most recent one:
```bash
ls -t "${CLAUDE_PROJECT_DIR}/.vcp/plan/ralph-*.md" 2>/dev/null | head -1
```

Read the master plan file. All units in the "Units of Work" table must be `done`. If any are `pending`, tell the user to run `/dev-buddy-build` first. Units with status `failed` were explicitly skipped by the user during build — include them in the review report as unimplemented.

Extract the slug from the filename: `ralph-{SLUG}.md` → `{SLUG}`.

---

## Step 2: Load stage executors

```bash
bun -e "
import { loadDevBuddyConfig } from '${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-config.ts';
import { readPresets } from '${CLAUDE_PLUGIN_ROOT}/scripts/preset-utils.ts';
const config = loadDevBuddyConfig();
const presets = readPresets();
const stage = config.stages['ralph-code-review'];
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
const stage = loadStageDefinition('ralph-code-review', '${CLAUDE_PLUGIN_ROOT}/stages');
const role = getSystemPrompt('{SYSTEM_PROMPT}', '${CLAUDE_PLUGIN_ROOT}/system-prompts/built-in');
if (stage && role) console.log(composePrompt(stage, role));
else console.log('ERROR: Could not resolve prompts');
"
```

## Step 4: Gather review context

Prepare the review package for each executor:
- Master plan (requirements, ACs, discovery findings)
- All unit plan files: `${CLAUDE_PROJECT_DIR}/.vcp/plan/ralph/{SLUG}/unit-*.md`
- Git diff of all changes: `git diff HEAD~{N}` (or since workflow started)
- Review guidelines: `${CLAUDE_PLUGIN_ROOT}/docs/review-guidelines.md`

## Step 5: Dispatch executors

Each executor receives the review package. Executors are assigned a **focused review lens** based on their system prompt role — this narrows the review scope per executor, making the task weak-model-compatible while ensuring diverse coverage across all reviewers.

Each executor performs:
1. **AC tracing** (all reviewers): For each AC, find implementing code (file:line). No code found = FAIL.
2. **Contract verification** (all reviewers): Verify implementations match Interface Contracts from unit plans — typed signatures, error conditions, pre/post conditions.
3. **Lens-specific review** (per system prompt role): Security lens, compliance lens, correctness lens, UX lens, data lens, or integration lens — see stage definition for mapping.
4. **Edge cases** (from lens perspective): Scenarios NOT tested that should be, focused through the reviewer's lens.

**Subscription executors:** `Agent(subagent_type: "general-purpose", model: {model}, prompt: {composed_prompt + review_package})`

**API/CLI executors:** `Bash(run_in_background: true)` with one-shot-runner.ts:
```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/one-shot-runner.ts" \
  --type {api|cli} --output-id ralph-review-p{i} \
  --preset "{PRESET}" --model "{MODEL}" \
  --stage-type ralph-code-review --system-prompt {SYSTEM_PROMPT} \
  --allowed-tools Read,Glob,Grep \
  --cwd "${CLAUDE_PROJECT_DIR}" --task-stdin <<'{DELIM}'
IMPORTANT: You are a PARALLEL executor. Return your analysis as text output ONLY.
Do NOT create, modify, or delete any files. The orchestrator will write the final output.

{review_package}
{DELIM}
```

**Dispatch all parallel executors in a single message.**

## Step 6: Collect and synthesize — produce verdict

Collect all responses (sequential TaskOutput polling — one at a time).

Synthesize all reviewer findings into a verdict.

**Write verdict to plan file FIRST** (before any status changes). Use Edit tool to replace the `## Code Review` section:

### approved

Edit tool: replace `## Code Review\n(pending)` (or the previous verdict block) with:
```markdown
## Code Review
**Verdict:** approved
**Iteration:** {N}
All ACs traced to code. No semantic drift. Integration sound.
```

THEN update plan status to `uat` using Edit tool: replace `**Status:** review` with `**Status:** uat`.
- If running under orchestrator: proceed to UAT stage
- If standalone: report approval to user

### needs_changes

Edit tool: replace `## Code Review\n(pending)` (or the previous verdict block) with:
```markdown
## Code Review
**Verdict:** needs_changes
**Iteration:** {N}
{summary of findings requiring changes}
```

Then for each finding that requires changes:
1. Identify affected unit(s)
2. Append fix instructions to affected unit plan file(s) using Edit tool
3. Reset affected unit plan file status using Edit tool:
   - old_string: `**Status:** done`
   - new_string: `**Status:** pending`
4. Reset affected unit attempts counter using Edit tool:
   - old_string: `**Attempts:** {current_N}`
   - new_string: `**Attempts:** 0`
5. Reset affected unit status to `pending` in master plan "Units of Work" table using Edit tool
6. THEN update plan status to `build` using Edit tool: replace `**Status:** review` with `**Status:** build`.
7. If running under orchestrator: reset affected unit tasks to `in_progress`

Report findings to user. If running under orchestrator, the orchestrator handles looping back to build.

If standalone: tell the user to run `/dev-buddy-build` to fix the affected units, then re-run `/dev-buddy-code-review`.

### rejected

Edit tool: replace `## Code Review\n(pending)` (or the previous verdict block) with:
```markdown
## Code Review
**Verdict:** rejected
**Iteration:** {N}
{reason for rejection}
```

Fundamental design issue. Escalate to user via AskUserQuestion. Do not loop — this needs human intervention.

---

## Step 7: Update tasks and continue (if under orchestrator)

- `TaskUpdate(T-review, status: "completed")`
- `TaskUpdate(T-uat, status: "in_progress")`

Max review iterations: `max_iterations` from config. After exhaustion, report to user.

---

## Known Constraints

1. **Tool restriction:** API executors are structurally restricted to `Read,Glob,Grep` via `--allowed-tools`. CLI executors receive a prompt-level instruction. Subscription executors get prompt-level guidance only.
2. **Sequential TaskOutput polling:** Do NOT issue multiple TaskOutput calls in the same message.
3. **Fresh context per review round.** Each re-review dispatches fresh executors that don't see prior review conclusions.
