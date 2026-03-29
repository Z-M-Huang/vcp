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

**API/CLI executors:** `Bash(run_in_background: true)` with one-shot-runner.ts:
```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/one-shot-runner.ts" \
  --type {api|cli} --output-id ralph-req-p{i} \
  --preset "{PRESET}" --model "{MODEL}" \
  --stage-type ralph-requirements --system-prompt {SYSTEM_PROMPT} \
  --allowed-tools Read,Glob,Grep \
  --cwd "${CLAUDE_PROJECT_DIR}" --task-stdin <<'{DELIM}'
IMPORTANT: You are a PARALLEL executor. Return your analysis as text output ONLY.
Do NOT create, modify, or delete any files. The orchestrator will write the final output.

{discovery_section + feature_description}

Define acceptance criteria (Given/When/Then + misinterpretation), UAT scenarios, edge cases, and risks.
{DELIM}
```

**Dispatch all parallel executors in a single message.** Sequential executors wait for prior ones.

## Step 5: Collect and synthesize (draft)

Collect all responses (sequential TaskOutput polling — one at a time, never multiple in same message).

Synthesize into a draft containing:
- **Acceptance Criteria** (Given/When/Then + misinterpretation for each)
- **UAT Scenarios** (Playwright test descriptions mapped to ACs)
- **Backpressure Commands** (test, typecheck, lint, build, uat commands)
- **Risk Registry** (identified risks with mitigations)

**Do NOT write to the plan file yet.** Hold the draft in context for interactive confirmation.

## Step 6: Interactive AC confirmation

Present each AC to the user **one at a time** via AskUserQuestion. The user should not need to open the plan file — all information flows through the conversation.

For each AC:
```
AskUserQuestion: "AC-{N}: {title}

Given {context}
When {action}
Then {outcome}

Misinterpretation: {wrong implementation that technically passes}

Approve this AC? Or describe what needs to change."
```

- If the user **approves** — mark this AC as confirmed, proceed to the next.
- If the user **requests changes** — revise the AC based on feedback, then present the revised version for re-confirmation. Repeat until approved.

After all ACs are confirmed:
```
AskUserQuestion: "All {N} acceptance criteria are confirmed. Are there any additional acceptance criteria we should add? If yes, describe what's missing. If no, say 'done'."
```

- If the user adds new ACs — draft them, confirm each one individually (same loop as above), then ask again if more are needed.
- If the user says done — proceed to UAT confirmation.

## Step 7: Interactive UAT scenario confirmation

Present each UAT scenario to the user **one at a time** via AskUserQuestion:

```
AskUserQuestion: "UAT-{N}: {scenario description}

Test file: {file path}
Steps:
1. {step}
2. {step}
...
Assertions: {what gets checked}
Validates: AC-{X}, AC-{Y}

Is this scenario sufficient? Or describe changes or additions needed."
```

- If the user **approves** — mark confirmed, proceed to next.
- If the user **requests changes** — revise and re-confirm.

After all UAT scenarios confirmed:
```
AskUserQuestion: "All {N} UAT scenarios are confirmed. Are there any additional scenarios we should add? If yes, describe what's missing. If no, say 'done'."
```

- If the user adds new scenarios — draft, confirm each, ask again.
- If done — proceed to write.

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
