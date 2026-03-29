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
ls -t ~/.claude/plans/ralph-*.md 2>/dev/null | head -1
```

Read the master plan file. All units in the "Units of Work" table must be `done`. If any are `pending` or `failed`, tell the user to run `/dev-buddy-build` first.

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
- All unit plan files: `~/.claude/plans/ralph/{SLUG}/unit-*.md`
- Git diff of all changes: `git diff HEAD~{N}` (or since workflow started)
- Review guidelines: `${CLAUDE_PLUGIN_ROOT}/docs/review-guidelines.md`

## Step 5: Dispatch executors

Each executor receives the review package plus instructions to:
1. **AC tracing:** For each AC, find implementing code (file:line). No code found = FAIL.
2. **Intent matching:** Does the code do what the AC MEANS, not just what the words say?
3. **Integration check:** Do units work together? Interfaces match? No missing glue?
4. **Pattern adherence:** Does code follow existing patterns identified in discovery?
5. **Edge cases:** What scenarios are NOT tested that should be?

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

Synthesize all reviewer findings into a verdict:

### approved

All ACs traced to code. No semantic drift. Integration is sound.
- Update plan status to `uat` using Edit tool: replace `**Status:** review` with `**Status:** uat`.
- If running under orchestrator: proceed to UAT stage
- If standalone: report approval to user

### needs_changes

For each finding that requires changes:
1. Identify affected unit(s)
2. Append fix instructions to affected unit plan file(s) using Edit tool
3. Reset affected unit status to `pending` in master plan
4. Update plan status to `build` using Edit tool: replace `**Status:** review` with `**Status:** build`.
5. If running under orchestrator: reset affected unit tasks to `in_progress`

Report findings to user. If running under orchestrator, the orchestrator handles looping back to build.

If standalone: tell the user to run `/dev-buddy-build` to fix the affected units, then re-run `/dev-buddy-code-review`.

### rejected

Fundamental design issue. Escalate to user via AskUserQuestion. Do not loop — this needs human intervention.

---

## Step 7: Update tasks (if under orchestrator)

- `TaskUpdate(T-review, status: "completed")`
- `TaskUpdate(T-uat, status: "in_progress")`

Max review iterations: `max_iterations` from config. After exhaustion, report to user.

---

## Known Constraints

1. **Tool restriction:** API executors are structurally restricted to `Read,Glob,Grep` via `--allowed-tools`. CLI executors receive a prompt-level instruction. Subscription executors get prompt-level guidance only.
2. **Sequential TaskOutput polling:** Do NOT issue multiple TaskOutput calls in the same message.
3. **Fresh context per review round.** Each re-review dispatches fresh executors that don't see prior review conclusions.
