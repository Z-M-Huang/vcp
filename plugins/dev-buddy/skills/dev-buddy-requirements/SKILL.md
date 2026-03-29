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

## Step 6: AC review round (batched, up to 4 per call)

Present ALL ACs to the user in **batches of up to 4** via AskUserQuestion. The user reviews the entire set before any re-synthesis happens. AskUserQuestion supports 1-4 questions per call, each with 2-4 options.

### 6a. Full round — present all ACs

For each batch of up to 4 ACs, make one AskUserQuestion call:

```
AskUserQuestion(questions: [
  {
    question: "AC-1: {title}\n\nGiven {context}\nWhen {action}\nThen {outcome}\n\nMisinterpretation: {wrong impl}",
    options: ["Approve", "Needs changes"]
  },
  {
    question: "AC-2: ...",
    options: ["Approve", "Needs changes"]
  },
  // ... up to 4 per call
])
```

Continue with batches until ALL ACs have been presented. Track which ACs the user marked "Needs changes".

### 6b. Additional ACs check

After all batches:
```
AskUserQuestion: "All {N} acceptance criteria reviewed. Any additional ACs needed?"
  options: ["No — I'm done reviewing", "Yes — I have more ACs to add"]
```

If the user wants additions, collect descriptions of new ACs.

### 6c. Evaluate round result

- **All approved, no additions** → ACs are confirmed. Proceed to Step 7.
- **Any "Needs changes" or additions** → collect specific feedback for each changed AC via follow-up AskUserQuestion calls, then **re-run the stage** (back to Step 4):
  - Re-dispatch executors with: discovery findings + previous ACs + user feedback per changed item + any new AC descriptions
  - Instruct executors: "Revise these ACs based on user feedback. Check ALL other ACs for cascading impacts from the changes."
  - When new synthesis returns, go back to Step 6a (fresh full round with revised ACs)

The user always sees the complete revised set — no partial re-confirmation.

## Step 7: UAT review round (batched, up to 4 per call)

Same round-based pattern. ACs are now locked (confirmed in Step 6).

### 7a. Full round — present all UAT scenarios

For each batch of up to 4 UAT scenarios:

```
AskUserQuestion(questions: [
  {
    question: "UAT-1: {scenario}\n\nTest file: {path}\nSteps: {steps}\nAssertions: {checks}\nValidates: AC-{X}, AC-{Y}",
    options: ["Approve", "Needs changes"]
  },
  // ... up to 4 per call
])
```

### 7b. Additional scenarios check

```
AskUserQuestion: "All {N} UAT scenarios reviewed. Any additional scenarios needed?"
  options: ["No — I'm done reviewing", "Yes — I have more scenarios to add"]
```

### 7c. Evaluate round result

- **All approved, no additions** → UATs are confirmed. Proceed to Step 8.
- **Any "Needs changes" or additions** → collect feedback, **re-run the stage** (back to Step 4) with: confirmed ACs + previous UATs + user feedback. Instruct executors to revise UAT scenarios and check for cascading impacts. Return to Step 7a with revised UATs.

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
