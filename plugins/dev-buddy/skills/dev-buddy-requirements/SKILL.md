---
name: dev-buddy-requirements
description: Gather requirements with TDD test plans, pessimistic impact analysis, and risk registry. Appends Requirements, TDD Test Plan, and Risk Registry sections to the plan file.
user-invocable: true
---

# Requirements Stage Skill

Gather requirements, generate TDD test plans, and identify risks through pessimistic-first analysis. Dispatches requirements executors, then a synthesizer appends `## Requirements`, `## TDD Test Plan`, and `## Risk Registry` sections directly to the plan file.

---

## Step 1: Load Config and Resolve Executors

```bash
bun -e "
import { loadDevBuddyConfig, getProviderType } from '${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-config.ts';
const config = loadDevBuddyConfig();
const stage = config.stages['requirements'];
const executors = stage.executors.map(exec => ({
  ...exec,
  providerType: getProviderType(exec.preset)
}));
console.log(JSON.stringify({ executors }));
"
```

---

## Step 2: Resolve Session Variables

1. Resolve tmpdir:
   ```bash
   bun -e "console.log(require('os').tmpdir())"
   ```
   Store as `{TMPDIR}`.

2. Generate unique output ID:
   ```bash
   bun -e "console.log(require('crypto').randomBytes(4).toString('hex'))"
   ```
   Store as `{RAND}`. Output file for non-synthesizer executor at index `{i}`: `{TMPDIR}/.vcp/oneshot/req-{RAND}-{i}.json`

3. Ensure output directory:
   ```bash
   mkdir -p "{TMPDIR}/.vcp/oneshot"
   ```

---

## Step 3: Check for RCA Context

Read the plan file. If it contains a `## RCA Diagnosis` section, this is a bug-fix requirements stage. Extract the root cause summary, affected files, and fix constraints to include as context for the requirements executor.

---

## Step 4: Prompt Assembly

For each **non-synthesizer** requirements executor, construct the task prompt:

```
ORIGINAL REQUEST: {user's original request from conversation}
{If RCA context: "BUG-FIX CONTEXT — RCA Diagnosis from plan file:\nRoot Cause: {summary}\nRoot File: {file}:{line}\nFix Constraints: {constraints}"}
---

You are executing the REQUIREMENTS stage.

PESSIMISTIC-FIRST: Before defining what this feature should do, identify what it will BREAK.
1. Identify every file and integration point this change touches (use Glob/Grep)
2. For each, state the specific breakage scenario with affected file:line
3. List all questions the user must answer about failure modes
4. Generate risks with severity, affected files, and mitigation strategies

Then gather requirements:
1. Clear acceptance criteria (Given/When/Then format) with source field
2. Scope (in_scope / out_of_scope)
3. TDD test plan (unit, e2e, skill tests) mapped to ACs — tests come BEFORE planning
4. Risk registry with severity ratings

DO NOT add features not in the original request. Ask 2-3 clarifying questions max.

Write your analysis to {TMPDIR}/.vcp/oneshot/req-{RAND}-{i}.json using the Write tool.
```

---

## Step 5: Dispatch Non-Synthesizer Executors

**Resolve system prompt with stage/role composition:**
```bash
bun -e "
import { loadStageDefinition, getSystemPrompt, composePrompt } from '${CLAUDE_PLUGIN_ROOT}/scripts/system-prompts.ts';
const stage = loadStageDefinition('requirements', '${CLAUDE_PLUGIN_ROOT}/stages');
const role = getSystemPrompt('{executor.system_prompt}', '${CLAUDE_PLUGIN_ROOT}/system-prompts/built-in');
if (!stage) { console.error('FATAL: Stage definition not found'); process.exit(1); }
if (!role) { console.error('FATAL: Role prompt not found'); process.exit(1); }
console.log(composePrompt(stage, role));
"
```

**If single executor:** skip to Step 6 — this executor IS the synthesizer.

**If multiple executors:** dispatch all except the last one in parallel.

Route by provider type:
- **subscription:** `Task(subagent_type: "general-purpose", model: "<model>", prompt: "<composed + task prompt>")`
- **api:** `Bash(run_in_background: true)` → `bun "${CLAUDE_PLUGIN_ROOT}/scripts/one-shot-runner.ts" --type api --output-id req-{RAND}-{i} --preset "{PRESET}" --model "{MODEL}" --cwd "${CLAUDE_PROJECT_DIR}" --task-stdin`
- **cli:** `Bash(run_in_background: true)` → `bun "${CLAUDE_PLUGIN_ROOT}/scripts/one-shot-runner.ts" --type cli --output-id req-{RAND}-{i} --preset "{PRESET}" --model "{MODEL}" --cwd "${CLAUDE_PROJECT_DIR}" --task-stdin`

**Polling background tasks:** The default TaskOutput timeout is 30s — far too short. Use `TaskOutput(task_id, block: true, timeout: 600000)`. If the task is still running when it returns, repeat with `timeout: 600000` until done. Preset timeout is up to 30 minutes.

Wait for all non-synthesizer executors to complete.

---

## Step 6: Dispatch Synthesizer

The synthesizer is either:
- **Single executor mode:** the only executor
- **Multi-executor mode:** the last executor in the list

The synthesizer's job is to **read all prior analyses and the plan file, then append `## Requirements`, `## TDD Test Plan`, and `## Risk Registry` sections directly to the plan file.**

**Construct the synthesizer prompt:**

For **single executor** (no prior analysis files):
```
You are the REQUIREMENTS GATHERER. Analyze the codebase for the following request and produce comprehensive requirements.

ORIGINAL REQUEST: {user's original request}
{If RCA context: "BUG-FIX CONTEXT:\n{rca details}"}

{same requirements instructions from Step 4}

YOUR OUTPUT: Write directly to the plan file at {PLAN_FILE_PATH} using the Edit tool.

If the plan file doesn't have a header yet, create it first:

# Plan: {title}
**Status:** requirements
**Pipeline:** {feature|bug-fix}
**Created:** {date}

---

Then append these three sections:

## Requirements — with user story (As a/I want/So that), acceptance criteria (Given/When/Then with AC IDs), scope, and impact analysis
## TDD Test Plan — with unit tests, e2e tests, and skill tests mapped to AC IDs
## Risk Registry — with risks, severity, affected files, and mitigations

Use clear markdown. Include AC IDs (AC-1, AC-2...), test IDs (UT-1, E2E-1, SK-1...), and risk IDs (R-1, R-2...) for traceability. Format is flexible — use whatever structure is clearest for the content.
```

For **multi-executor** (has prior analysis files):
```
You are the SYNTHESIZER. Read the plan file at {PLAN_FILE_PATH} and all prior analyst outputs listed below.

Prior analysis files (read each with the Read tool):
- {TMPDIR}/.vcp/oneshot/req-{RAND}-0.json
- {TMPDIR}/.vcp/oneshot/req-{RAND}-1.json
{...list all non-synthesizer output files...}

NOTE: API/CLI executor files are wrapped in {"event":"complete","result":"..."} envelope — parse the "result" field to get the analysis. Subscription executor files contain raw analysis text.

Consolidate the best ideas from all analyses. Then write directly to the plan file at {PLAN_FILE_PATH} using the Edit tool.

{same output instructions as single executor above}
```

**Route the synthesizer by provider type:**
- **subscription:** `Task(subagent_type: "general-purpose", model: "<model>", prompt: "<synthesizer prompt>")`
- **api:** `Bash(run_in_background: true)` → one-shot-runner with `--type api --output-id req-{RAND}-synth`
- **cli:** `Bash(run_in_background: true)` → one-shot-runner with `--type cli --output-id req-{RAND}-synth`

**Polling:** same timeout guidance as Step 5.

---

## Step 7: Verify and Handle Clarification

After the synthesizer completes:

1. **Read the plan file** and verify it now contains `## Requirements`, `## TDD Test Plan`, and `## Risk Registry` sections
2. If sections are missing — report failure to user
3. If sections exist — check for open questions

**Handle clarification:** If requirements mention open questions or unresolved items:
1. Present questions to user via AskUserQuestion
2. Edit the plan file directly with the user's answers (update the relevant section inline)

**Handle risk acknowledgment:**
1. Present each unacknowledged risk to user via AskUserQuestion
2. Edit the risk entries in the plan file with acknowledgment status

---

## Step 8: Cleanup and Report

1. Remove temp files: `rm -f "{TMPDIR}/.vcp/oneshot/req-{RAND}-"*`
2. Present to the user:
   - Number of acceptance criteria
   - Key scope items
   - Impact analysis summary
   - TDD test plan summary
   - Risk registry status (how many acknowledged)
3. Suggest next step: `/dev-buddy-plan`

---

## Error Handling

| Scenario | Action |
|----------|--------|
| No executors configured | Report error, suggest `/dev-buddy-config` |
| All executors fail | Report error to user |
| Single executor fails | Continue with remaining |
| Clarification exceeded 3 rounds | Escalate to user |
| Plan file doesn't exist | Create with header |
| Synthesizer didn't write to plan file | Report failure to user |
