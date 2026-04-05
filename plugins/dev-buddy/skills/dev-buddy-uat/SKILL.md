---
name: dev-buddy-uat
description: UAT stage — execute Playwright tests and mechanical backpressure against the running app
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent, Task, TaskOutput, TaskCreate, TaskUpdate, TaskList, TaskGet, AskUserQuestion
---

# UAT Stage (Outer Ralph Loop)

Validate the feature works from a user's perspective. Pessimistic — assume everything is broken.

**Standalone usage:** `/dev-buddy-uat` — reads the most recent `ralph-*.md` plan file and runs UAT.

**Orchestrator usage:** Called by `/dev-buddy-ralph` after code review passes.

---

## Step 1: Find the plan file

If no plan file path is in current context, find the most recent one:
```bash
ls -t "${CLAUDE_PROJECT_DIR}/.vcp/plan/ralph-*.md" 2>/dev/null | head -1
```

Read the master plan file. Code review must be completed (all units `done`, review verdict `approved`). If not, tell the user to run `/dev-buddy-code-review` first.

Extract the slug from the filename: `ralph-{SLUG}.md` → `{SLUG}`.

---

## Step 2: Load stage executor

```bash
bun -e "
import { loadDevBuddyConfig } from '${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-config.ts';
import { readPresets } from '${CLAUDE_PLUGIN_ROOT}/scripts/preset-utils.ts';
const config = loadDevBuddyConfig();
const presets = readPresets();
const stage = config.stages['ralph-uat'];
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

Single executor only — `ralph-uat` is a singleton stage.

---

## Step 3: Resolve stage + role prompts

```bash
bun -e "
import { loadStageDefinition, composePrompt, getSystemPrompt } from '${CLAUDE_PLUGIN_ROOT}/scripts/system-prompts.ts';
const stage = loadStageDefinition('ralph-uat', '${CLAUDE_PLUGIN_ROOT}/stages');
const role = getSystemPrompt('{SYSTEM_PROMPT}', '${CLAUDE_PLUGIN_ROOT}/system-prompts/built-in');
if (stage && role) console.log(composePrompt(stage, role));
else console.log('ERROR: Could not resolve prompts');
"
```

## Step 4: Execute all backpressure

Run ALL backpressure commands from the master plan's `## Requirements` → `### Backpressure Commands` section:

### 4a. Mechanical backpressure
```bash
{test_command}
```
```bash
{typecheck_command}
```
```bash
{lint_command}
```
```bash
{build_command}
```

### 4b. UAT tests
```bash
{uat_command}
```

If Playwright tests are defined in the UAT scenarios, run them. If Playwright is not available in this environment, fall back to any available integration test commands and report which UAT scenarios could not be validated.

## Step 5: Evaluate results

### If ALL pass

1. Append UAT results to master plan FIRST (before status change):
   ```markdown
   ## UAT Results — Iteration {N}
   - All mechanical backpressure: PASS
   - UAT-1: PASS
   - UAT-2: PASS
   ```
2. THEN update plan status to `done` using Edit tool: replace `**Status:** uat` with `**Status:** done`.
3. If running under orchestrator: `TaskUpdate(T-uat, status: "completed")`
4. Report success to user

### If ANY fail

1. Record results in master plan FIRST (before any status changes):
   ```markdown
   ## UAT Results — Iteration {N}
   - {test}: FAIL — {error summary}
   ```
2. Identify affected units from the AC→unit mapping in master plan
3. Append failure context to affected unit plan files using Edit tool
4. Reset affected unit plan file status using Edit tool:
   - old_string: `**Status:** done`
   - new_string: `**Status:** pending`
5. Reset affected unit attempts counter using Edit tool:
   - old_string: `**Attempts:** {current_N}`
   - new_string: `**Attempts:** 0`
6. Reset affected unit statuses to `pending` in master plan "Units of Work" table using Edit tool
7. THEN update plan status to `build` using Edit tool: replace `**Status:** uat` with `**Status:** build`.

If running under orchestrator: the orchestrator handles looping back to build → code review → UAT.

If standalone: report failures and tell the user to run `/dev-buddy-build` for affected units, then `/dev-buddy-code-review`, then `/dev-buddy-uat` again.

Max outer iterations: `max_outer_iterations` from config. After exhaustion, report to user.

---

## Known Constraints

1. **Playwright/browser tools:** UAT stages require Playwright MCP or Chrome DevTools in the user's environment. If unavailable, fall back to command-line tests and report which scenarios can't be validated.

2. **Tool restriction:** UAT executors get all 6 tools (`--allowed-tools` is omitted). This is intentional — UAT needs Bash for running tests.

3. **Sequential TaskOutput polling:** Do NOT issue multiple TaskOutput calls in the same message.
