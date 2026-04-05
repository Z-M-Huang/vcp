---
name: dev-buddy-build
description: Build stage — per-unit implementation with fresh context and mechanical backpressure
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent, Task, TaskOutput, TaskCreate, TaskUpdate, TaskList, TaskGet, AskUserQuestion
---

# Build Stage (Inner Ralph Loop)

Implement each unit of work with fresh context per iteration. Orchestrator independently runs backpressure.

**Standalone usage:** `/dev-buddy-build` — reads the most recent `ralph-*.md` plan file and builds all pending units.

**Orchestrator usage:** Called by `/dev-buddy-ralph` with plan path already established.

---

## Step 1: Find the plan file

If no plan file path is in current context, find the most recent one:
```bash
ls -t "${CLAUDE_PROJECT_DIR}/.vcp/plan/ralph-*.md" 2>/dev/null | head -1
```

Read the master plan file. The `## Units of Work` table must exist with at least one unit. If not, tell the user to run `/dev-buddy-decompose` first.

Extract the slug from the filename: `ralph-{SLUG}.md` → `{SLUG}`.

Load config for `max_build_attempts`:
```bash
bun -e "
import { loadDevBuddyConfig } from '${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-config.ts';
const config = loadDevBuddyConfig();
console.log(JSON.stringify({ max_build_attempts: config.max_build_attempts }));
"
```

---

## Step 2: Load stage executor

```bash
bun -e "
import { loadDevBuddyConfig } from '${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-config.ts';
import { readPresets } from '${CLAUDE_PLUGIN_ROOT}/scripts/preset-utils.ts';
const config = loadDevBuddyConfig();
const presets = readPresets();
const stage = config.stages['ralph-build'];
console.log(JSON.stringify(stage.executors.map((e, i) => ({
  index: i,
  system_prompt: e.system_prompt,
  preset: e.preset,
  model: e.model,
  type: presets.presets[e.preset]?.type || 'unknown',
  timeout_ms: presets.presets[e.preset]?.timeout_ms
}))));
"
```

Single executor only — `ralph-build` is a singleton stage.

---

## Step 3: Build loop

For each unit in dependency order where status is not `done` and not `failed`:

**Status handling on entry:**
- `pending` → normal flow (3a through 3f). If `## Attempt` sections exist in the unit file, this is a resumed unit — the implementer will see prior failure context.
- `done` → skip
- `failed` → skip (already escalated)

### 3a. Check dependencies

Read the master plan's "Units of Work" table. Verify all dependency units are `done`. If a dependency is `failed`, skip this unit and report.

### 3b. Read unit plan

Read `${CLAUDE_PROJECT_DIR}/.vcp/plan/ralph/{SLUG}/unit-{N}.md`.

### 3c. Resolve stage + role prompts

```bash
bun -e "
import { loadStageDefinition, composePrompt, getSystemPrompt } from '${CLAUDE_PLUGIN_ROOT}/scripts/system-prompts.ts';
const stage = loadStageDefinition('ralph-build', '${CLAUDE_PLUGIN_ROOT}/stages');
const role = getSystemPrompt('{SYSTEM_PROMPT}', '${CLAUDE_PLUGIN_ROOT}/system-prompts/built-in');
if (stage && role) console.log(composePrompt(stage, role));
else console.log('ERROR: Could not resolve prompts');
"
```

### 3d. Dispatch fresh-context implementer

**Before dispatch — record file state baseline** for each file in "Files to Touch":
```bash
# For each file in "Files to Touch":
stat -c '%Y' "{file_path}" 2>/dev/null || echo "MISSING"
```
Store the timestamps (or "MISSING") as the baseline for this attempt.

The implementer prompt is the composed stage+role prompt PLUS the full unit plan file content.

**Subscription executor:** `Agent(subagent_type: "general-purpose", model: {model}, prompt: {composed_prompt + unit_plan_content})`

**API/CLI executor:** `Bash(run_in_background: true)` with one-shot-runner.ts:
```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/one-shot-runner.ts" \
  --type {api|cli} --output-id ralph-build-unit-{N} \
  --preset "{PRESET}" --model "{MODEL}" \
  --stage-type ralph-build --system-prompt {SYSTEM_PROMPT} \
  --cwd "${CLAUDE_PROJECT_DIR}" --task-stdin <<'{DELIM}'
{unit_plan_content}
{DELIM}
```

### 3d.1. Verify all files were touched

After the implementer finishes, BEFORE running backpressure, mechanically verify every file listed in the unit plan's "## Files to Touch" section against the pre-dispatch baseline:

```bash
# For EACH file in "Files to Touch":
# Files tagged "new | create" — must now exist:
test -f "{file_path}" && echo "OK: {file_path} created" || echo "FAIL: {file_path} NOT CREATED"

# Files tagged "existing | modify" — must exist AND have changed since baseline:
test -f "{file_path}" || echo "FAIL: {file_path} MISSING"
CURRENT_TS=$(stat -c '%Y' "{file_path}" 2>/dev/null)
if [ "$CURRENT_TS" = "{baseline_timestamp}" ]; then
  echo "FAIL: {file_path} NOT MODIFIED (timestamp unchanged since baseline)"
fi
```

Collect all results. If ANY result is `FAIL`:
- Do NOT run backpressure
- Go directly to Step 3f's failure path with the verification output as the "Failure Output"
- The next implementer attempt will see exactly which files were missed in the Attempt section

If all results are `OK`: proceed to Step 3e (backpressure).

### 3e. Orchestrator independently runs backpressure (only after 3d.1 passes)

**Never trust subagent self-reports.** After the implementer finishes, run the backpressure commands from the unit plan yourself:

```bash
{unit_test_command}
```
```bash
{typecheck_command}
```
```bash
{lint_command}
```

### 3f. Evaluate results

**If ALL backpressure passes:**

1. Update unit plan file status using Edit tool:
   - old_string: `**Status:** pending`
   - new_string: `**Status:** done`

2. Verify the edit took effect:
   ```bash
   grep '^\*\*Status:\*\* done' "${CLAUDE_PROJECT_DIR}/.vcp/plan/ralph/{SLUG}/unit-{N}.md"
   ```
   If grep returns no match, re-read the file to find the actual status line and retry the Edit with the correct old_string.

3. Update master plan "Units of Work" table using Edit tool: change this unit's status cell from `pending` to `done`.

4. If running under orchestrator: `TaskUpdate(T-unit-N, status: "completed")`

5. Continue to next unit.

**If ANY backpressure fails:**

1. Increment attempts counter in unit plan file using Edit tool:
   - old_string: `**Attempts:** {current_N}`
   - new_string: `**Attempts:** {current_N + 1}`

2. Append `## Attempt {N}` section to unit plan file using Edit tool (insert after the last section):
   ```markdown
   ## Attempt {N}
   **Result:** fail
   **Failure Output:**
   {full error output from backpressure}
   **Next Action:** retry
   ```

3. If under max attempts: go back to 3d (fresh implementer reads updated plan with failure context). Status remains `pending`.

4. If at or over max attempts:
   - Update the last Attempt's `**Next Action:** retry` to `**Next Action:** escalate` using Edit tool
   - Update unit plan file status using Edit tool:
     - old_string: `**Status:** pending`
     - new_string: `**Status:** failed`
   - Update master plan "Units of Work" table: unit status → `failed` using Edit tool
   - If running under orchestrator: `TaskUpdate(T-unit-N, status: "blocked")`
   - Ask user via AskUserQuestion what to do with the failed unit

### 3g. After build loop finishes

**Completion guard:** Before advancing, verify all units are done:

1. Re-read the master plan's "Units of Work" table.
2. If ALL units are `done`: proceed to advance the plan status below.
3. If ANY unit is `failed`: do NOT advance. Ask user via AskUserQuestion: "Unit(s) {list} failed after max attempts. Retry them, skip them, or abort?"
   - If user says retry: reset those units to `pending` (Edit unit plan file and master plan table), reset their attempts to 0, go back to the build loop.
   - If user says skip: leave them as `failed`, proceed to advance (code review will see them as `failed` and report).
   - If user says abort: stop the pipeline.

**Advance to review:**

Update plan status to `review` using Edit tool: replace `**Status:** build` with `**Status:** review`.

If running under the orchestrator, update tasks:
- `TaskUpdate(T-build, status: "completed")`
- `TaskUpdate(T-review, status: "in_progress")`

**Pipeline continuation:** After updating, call `TaskList()` to find the next pending stage. The task description tells you which skill to invoke. Continue the pipeline immediately — do NOT stop and wait for user input. The pipeline must run to completion after decompose.

---

## Known Constraints

1. **Fresh context is critical.** Each build attempt uses a fresh subagent. Do not accumulate context across iterations — the unit plan file on disk carries all necessary state.

2. **Tool restriction:** Build executors get all 6 tools (`--allowed-tools` is omitted). This is intentional — build needs Write, Edit, and Bash.

3. **Sequential TaskOutput polling:** Do NOT issue multiple TaskOutput calls in the same message.
