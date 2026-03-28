---
name: dev-buddy-discover
description: Discovery stage — multi-AI codebase and running app exploration
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent, Task, TaskOutput, TaskCreate, TaskUpdate, TaskList, TaskGet, AskUserQuestion
---

# Discovery Stage

Explore the codebase and running application to deeply understand what exists before making changes.

**Standalone usage:** `/dev-buddy-discover` — discovers the most recent `ralph-*.md` plan file in `~/.claude/plans/` and appends findings.

**Orchestrator usage:** Called by `/dev-buddy-ralph` with plan path already established.

---

## Step 1: Find the plan file

If no plan file path is in current context, find the most recent one:
```bash
ls -t ~/.claude/plans/ralph-*.md 2>/dev/null | head -1
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

Use the same dispatch pattern as `/dev-buddy-chatroom`:

**Subscription executors:** `Agent(subagent_type: "general-purpose", model: {model}, prompt: {composed_prompt + feature_description})`

**API/CLI executors:** `Bash(run_in_background: true)` with one-shot-runner.ts:
```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/one-shot-runner.ts" \
  --type {api|cli} --output-id ralph-discover-p{i} \
  --preset "{PRESET}" --model "{MODEL}" \
  --stage-type discovery --system-prompt {SYSTEM_PROMPT} \
  --cwd "${CLAUDE_PROJECT_DIR}" --task-stdin <<'{DELIM}'
{feature_description}

Explore the codebase and running app. Report your findings with file:line references.
{DELIM}
```

**Dispatch all parallel executors in a single message.** Sequential executors wait for prior ones.

## Step 5: Collect and synthesize

Collect all responses (sequential TaskOutput polling — one at a time, never multiple in same message).

As the orchestrator, synthesize all findings into a coherent `## Discovery` section. Be specific — include file:line references, patterns found, impact points, backpressure commands.

Update the master plan file using Edit tool: replace `## Discovery\n(pending)` with the synthesis.

Update plan status to `requirements`.

## Step 6: User checkpoint

Present discovery findings to the user. Ask: "Does this understanding look correct? Any corrections before we proceed to requirements?"

Wait for user confirmation via AskUserQuestion.

If running under the orchestrator, update tasks:
- `TaskUpdate(T-discover, status: "completed")`
- `TaskUpdate(T-requirements, status: "in_progress")`

---

## Known Constraints

1. **Playwright/browser tools:** If the user's environment has Playwright MCP or Chrome DevTools, use them to explore the running app (screenshots, UI interactions). If unavailable, fall back to code-only analysis and ask the user for screenshots.

2. **Tool constraints are prompt-level guidance for API/CLI executors.** Only subscription executors get structural tool restriction via `allowed-tools`. API executors always get their fixed 6 tools.

3. **Sequential TaskOutput polling:** Do NOT issue multiple TaskOutput calls in the same message — this causes cascade failures. Poll one at a time.
