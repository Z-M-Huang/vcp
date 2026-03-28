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
ls -t ~/.claude/plans/ralph-*.md 2>/dev/null | head -1
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

Same dispatch pattern as discovery. Each executor receives:
- Discovery findings from the master plan
- Feature description
- Instructions to produce: ACs (Given/When/Then + misinterpretation), UAT scenarios, edge cases, risks

**Subscription executors:** `Agent(subagent_type: "general-purpose", model: {model}, prompt: {composed_prompt + discovery_section + feature_description})`

**API/CLI executors:** `Bash(run_in_background: true)` with one-shot-runner.ts using `--stage-type ralph-requirements`

**Dispatch all parallel executors in a single message.** Sequential executors wait for prior ones.

## Step 5: Collect and synthesize

Collect all responses (sequential TaskOutput polling — one at a time, never multiple in same message).

Synthesize into a `## Requirements` section containing:
- **Acceptance Criteria** (Given/When/Then + misinterpretation for each)
- **UAT Scenarios** (Playwright test descriptions mapped to ACs)
- **Backpressure Commands** (test, typecheck, lint, build, uat commands)
- **Risk Registry** (identified risks with mitigations)

Update the master plan using Edit tool: replace `## Requirements\n(pending)` with the synthesis.

Update plan status to `decompose`.

## Step 6: User approval

Present the requirements to the user. Ask: "Do these acceptance criteria and UAT scenarios cover the feature? Any additions or changes?"

Wait for user confirmation via AskUserQuestion.

If running under the orchestrator, update tasks:
- `TaskUpdate(T-requirements, status: "completed")`
- `TaskUpdate(T-decompose, status: "in_progress")`

---

## Known Constraints

1. **Tool constraints are prompt-level guidance for API/CLI executors.** Only subscription executors get structural tool restriction.
2. **Sequential TaskOutput polling:** Do NOT issue multiple TaskOutput calls in the same message.
