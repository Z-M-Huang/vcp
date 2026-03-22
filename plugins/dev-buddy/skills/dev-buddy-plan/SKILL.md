---
name: dev-buddy-plan
description: Create granular implementation plan from requirements in the plan file. Reads Requirements + TDD Test Plan sections, dispatches planners, appends Implementation Steps to plan file.
user-invocable: true
---

# Planning Stage Skill

Create a granular, TDD-mapped implementation plan from existing requirements. Dispatches planning executors to analyze the codebase and requirements, then a synthesizer appends the `## Implementation Steps` section directly to the plan file.

---

## Step 1: Validate Inputs

Read the plan file and verify it contains:
- `## Requirements` section with acceptance criteria
- `## TDD Test Plan` section with test IDs mapped to ACs
- `## Risk Registry` section

If any section is missing, tell the user to run `/dev-buddy-requirements` first.

**If this is a re-plan after review failure:** Check if the plan file already has a `## Plan Review Record` section with `**Status:** needs_changes`. If so, read the `### Must-Fix Findings` from the review record — these will be injected into the planning prompt.

---

## Step 2: Load Config and Resolve Executors

```bash
bun -e "
import { loadDevBuddyConfig, getProviderType } from '${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-config.ts';
const config = loadDevBuddyConfig();
const stage = config.stages['planning'];
const executors = stage.executors.map(exec => ({
  ...exec,
  providerType: getProviderType(exec.preset)
}));
console.log(JSON.stringify({ executors }));
"
```

---

## Step 3: Resolve Session Variables

1. Resolve tmpdir:
   ```bash
   bun -e "console.log(require('os').tmpdir())"
   ```
2. Generate unique output ID:
   ```bash
   bun -e "console.log(require('crypto').randomBytes(4).toString('hex'))"
   ```
3. Output file for non-synthesizer executor at index `{i}`: `{TMPDIR}/.vcp/oneshot/plan-{RAND}-{i}.json`
4. Ensure output directory:
   ```bash
   mkdir -p "{TMPDIR}/.vcp/oneshot"
   ```

---

## Step 4: Extract Context from Plan File

Read the plan file and extract:
1. All acceptance criteria (AC IDs, given/when/then)
2. All test IDs from TDD Test Plan (unit, e2e, skill tests) with their AC mappings
3. Impact analysis (what could break)
4. Risk registry (acknowledged risks)
5. RCA diagnosis (if bug-fix pipeline)
6. Review findings to fix (if re-plan after review failure)

---

## Step 5: Prompt Assembly

For each **non-synthesizer** planning executor, construct the task prompt:

```
You are executing the PLANNING stage.

REQUIREMENTS (from plan file):
{extracted acceptance criteria}

TDD TEST PLAN (tests already defined — your steps must MAP to these):
{extracted test IDs with AC mappings}

IMPACT ANALYSIS:
{extracted impacts}

RISK REGISTRY:
{extracted risks}

{If re-plan: "REVIEW FINDINGS TO ADDRESS:\n{must_fix findings from review record}"}

---

PESSIMISTIC-FIRST PLANNING:
- Assume every feature you design WILL become a maintenance liability
- For each step: Why could this become technical debt? How do you prevent it?
- Search the codebase FIRST — reuse existing code, do NOT create new abstractions unless justified
- Document what you searched and why new code is necessary (if it is)

GRANULAR AGILE UNITS:
- Each step must be ONE architectural unit (single module/function/component)
- Each step must map to at least one AC and one test ID
- Each step must have a specific rollback procedure
- Each step must be implementable without design decisions from the implementer
- If a step needs more than ~50 lines of changes, split it

Produce a detailed implementation plan with numbered steps. For each step include:
- Title and description
- Which ACs and test IDs it covers
- Files to modify/create
- Existing code to reuse
- Rollback procedure
- Why this step won't become technical debt

Write your analysis to {TMPDIR}/.vcp/oneshot/plan-{RAND}-{i}.json using the Write tool.
```

---

## Step 6: Dispatch Non-Synthesizer Executors

**Resolve system prompt with stage/role composition:**
```bash
bun -e "
import { loadStageDefinition, getSystemPrompt, composePrompt } from '${CLAUDE_PLUGIN_ROOT}/scripts/system-prompts.ts';
const stage = loadStageDefinition('planning', '${CLAUDE_PLUGIN_ROOT}/stages');
const role = getSystemPrompt('{executor.system_prompt}', '${CLAUDE_PLUGIN_ROOT}/system-prompts/built-in');
if (!stage) { console.error('FATAL: Stage definition not found'); process.exit(1); }
if (!role) { console.error('FATAL: Role prompt not found'); process.exit(1); }
console.log(composePrompt(stage, role));
"
```

**If single executor:** skip to Step 7 — this executor IS the synthesizer.

**If multiple executors:** dispatch all except the last one in parallel.

Route by provider type:
- **subscription:** `Task(subagent_type: "general-purpose", model: "<model>", prompt: "<composed + task prompt>")`
- **api:** `Bash(run_in_background: true)` → `bun "${CLAUDE_PLUGIN_ROOT}/scripts/one-shot-runner.ts" --type api --output-id plan-{RAND}-{i} --preset "{PRESET}" --model "{MODEL}" --cwd "${CLAUDE_PROJECT_DIR}" --task-stdin`
- **cli:** `Bash(run_in_background: true)` → `bun "${CLAUDE_PLUGIN_ROOT}/scripts/one-shot-runner.ts" --type cli --output-id plan-{RAND}-{i} --preset "{PRESET}" --model "{MODEL}" --cwd "${CLAUDE_PROJECT_DIR}" --task-stdin`

**Polling background tasks:** The default TaskOutput timeout is 30s — far too short. Use `TaskOutput(task_id, block: true, timeout: 600000)`. If the task is still running when it returns, repeat with `timeout: 600000` until done. Preset timeout is up to 30 minutes.

Wait for all non-synthesizer executors to complete.

---

## Step 7: Dispatch Synthesizer

The synthesizer is either:
- **Single executor mode:** the only executor
- **Multi-executor mode:** the last executor in the list

The synthesizer's job is to **read all prior analyses and the plan file, then append `## Implementation Steps` directly to the plan file.**

**Construct the synthesizer prompt:**

For **single executor** (no prior analysis files):
```
You are the PLANNER. Read the plan file at {PLAN_FILE_PATH} which contains Requirements, TDD Test Plan, and Risk Registry.

{same planning instructions from Step 5}

YOUR OUTPUT: Append a new `## Implementation Steps` section to the plan file using the Edit tool. Write in clear markdown — no JSON.

The section should include:
1. A brief technical approach summary (pattern, rationale, alternatives considered, existing code to reuse)
2. Numbered steps, each with:
   - Title
   - Which ACs and test IDs it covers
   - Files to modify/create
   - What to do (detailed enough for an implementer to execute without design decisions)
   - Existing code to reuse
   - Rollback procedure
   - Why this won't become technical debt
   - Dependencies on other steps (if any)
   - Status checkbox: `[ ] not started`

Use whatever markdown structure is clearest for the content. The key requirements are:
- Every AC must be covered by at least one step
- Every test ID must be mapped to at least one step
- Steps must be granular (one architectural unit each, ~50 lines max)
- Each step must have a rollback procedure

{If re-plan: "REPLACING EXISTING PLAN: Delete the existing ## Implementation Steps section and write a new one."}
```

For **multi-executor** (has prior analysis files):
```
You are the SYNTHESIZER. Read the plan file at {PLAN_FILE_PATH} and all prior planner analyses listed below.

Prior analysis files (read each with the Read tool):
- {TMPDIR}/.vcp/oneshot/plan-{RAND}-0.json
- {TMPDIR}/.vcp/oneshot/plan-{RAND}-1.json
{...list all non-synthesizer output files...}

NOTE: API/CLI executor files are wrapped in {"event":"complete","result":"..."} envelope — parse the "result" field to get the analysis. Subscription executor files contain raw analysis text.

Consolidate the best ideas from all analyses into ONE implementation plan. Then append a `## Implementation Steps` section to the plan file using the Edit tool. Write in clear markdown — no JSON.

{same output format instructions as single executor above}
```

**Route the synthesizer by provider type:**
- **subscription:** `Task(subagent_type: "general-purpose", model: "<model>", prompt: "<synthesizer prompt>")`
- **api:** `Bash(run_in_background: true)` → one-shot-runner with `--type api --output-id plan-{RAND}-synth`
- **cli:** `Bash(run_in_background: true)` → one-shot-runner with `--type cli --output-id plan-{RAND}-synth`

**Polling:** same timeout guidance as Step 6.

---

## Step 8: Verify

After the synthesizer completes:

1. **Read the plan file** and verify it now contains a `## Implementation Steps` section
2. If the section exists — proceed to Step 9
3. If the section is missing — report the failure to the user

---

## Step 9: Cleanup and Report

1. Remove temp files: `rm -f "{TMPDIR}/.vcp/oneshot/plan-{RAND}-"*`
2. Present to user:
   - Number of steps
   - AC coverage summary
   - Test coverage summary
   - Existing code being reused
3. Suggest next step: `/dev-buddy-review --plan`

---

## Error Handling

| Scenario | Action |
|----------|--------|
| No planners configured | Report error, suggest `/dev-buddy-config` |
| Requirements section missing | Tell user to run `/dev-buddy-requirements` first |
| All executors fail | Report error to user |
| Synthesizer didn't append to plan file | Report failure to user |
| Re-plan requested | Replace existing `## Implementation Steps` instead of appending |
