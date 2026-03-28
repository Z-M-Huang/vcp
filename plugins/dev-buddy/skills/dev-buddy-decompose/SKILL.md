---
name: dev-buddy-decompose
description: Decomposition stage — break features into small, independently testable units of work
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent, Task, TaskOutput, TaskCreate, TaskUpdate, TaskList, TaskGet, AskUserQuestion
---

# Decomposition Stage

Break the feature into tiny, independently testable units of work. Create per-unit plan files.

**Standalone usage:** `/dev-buddy-decompose` — reads the most recent `ralph-*.md` plan file and creates unit plans.

**Orchestrator usage:** Called by `/dev-buddy-ralph` with plan path already established.

---

## Step 1: Find the plan file

If no plan file path is in current context, find the most recent one:
```bash
ls -t ~/.claude/plans/ralph-*.md 2>/dev/null | head -1
```

Read the plan file. The `## Requirements` section must be populated. If not, tell the user to run `/dev-buddy-requirements` first.

Extract the slug from the filename: `ralph-{SLUG}.md` → `{SLUG}`.

---

## Step 2: Load stage executors

```bash
bun -e "
import { loadDevBuddyConfig } from '${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-config.ts';
import { readPresets } from '${CLAUDE_PLUGIN_ROOT}/scripts/preset-utils.ts';
const config = loadDevBuddyConfig();
const presets = readPresets();
const stage = config.stages['decomposition'];
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
const stage = loadStageDefinition('decomposition', '${CLAUDE_PLUGIN_ROOT}/stages');
const role = getSystemPrompt('{SYSTEM_PROMPT}', '${CLAUDE_PLUGIN_ROOT}/system-prompts/built-in');
if (stage && role) console.log(composePrompt(stage, role));
else console.log('ERROR: Could not resolve prompts');
"
```

## Step 4: Dispatch executors

Each executor receives:
- Discovery findings + Requirements from master plan
- Decomposition rules (max ~50 LOC, AC mapping, dependency ordering, first unit = UAT tests)

**Subscription executors:** `Agent(subagent_type: "general-purpose", model: {model}, prompt: {composed_prompt + plan_context})`

**API/CLI executors:** `Bash(run_in_background: true)` with one-shot-runner.ts using `--stage-type decomposition`

**Dispatch all parallel executors in a single message.**

## Step 5: Collect and synthesize

Collect all responses (sequential TaskOutput polling — one at a time).

Synthesize into a decomposition. Each unit must:
- Map to at least one AC
- Have specific backpressure (tests that validate just this unit)
- Be completable without future units existing
- Be ~50 lines of production code max
- Be ordered by dependency (no forward references)
- **First unit**: write the UAT Playwright test files (red — they should fail initially)
- **Last unit**: integration glue if needed

## Step 6: Create artifacts

### 6a. Update master plan

Append `## Units of Work` table to master plan using Edit tool:

```markdown
## Units of Work
| # | Title | ACs | Depends On | Status |
|---|-------|-----|------------|--------|
| 1 | Write UAT tests | UAT-1,2,3 | — | pending |
| 2 | {title} | AC-1 | — | pending |
| 3 | {title} | AC-2,3 | 2 | pending |
```

### 6b. Create per-unit plan files

For each unit, use Write tool to create `~/.claude/plans/ralph-{SLUG}-unit-{N}.md`:

```markdown
# Unit {N}: {Title}

**Parent:** ralph-{SLUG}
**Status:** pending
**Attempts:** 0
**Max Attempts:** {max_build_attempts from config}

## Acceptance Criteria
{specific ACs from master plan}

## What to Implement
{precise instructions — no design decisions left}

## Discovered Context
{relevant discovery findings}

## Files to Touch
- `src/foo.ts` — why and what
- `tests/foo.test.ts` — what to test

## Backpressure
- Unit tests: `{specific test command}`
- Typecheck: `{command}`
- Lint: `{command}`

## Done When
All listed backpressure passes
```

### 6c. Create unit tasks (if running under orchestrator)

```
TaskCreate("Unit 1: {title} — ralph-{SLUG}", status: "pending", blocked_by: [T-decompose])
TaskCreate("Unit 2: {title} — ralph-{SLUG}", status: "pending", blocked_by: [T-decompose, T-unit-1 if dependency])
...
```

Update Code Review task to depend on all unit tasks.

## Step 7: User approval

Present the decomposition to the user. Ask: "Does this breakdown look right? Any units that should be split further or reordered?"

Wait for user confirmation via AskUserQuestion.

If running under the orchestrator, update tasks:
- `TaskUpdate(T-decompose, status: "completed")`

---

## Known Constraints

1. **Tool constraints are prompt-level guidance for API/CLI executors.** Only subscription executors get structural tool restriction.
2. **Sequential TaskOutput polling:** Do NOT issue multiple TaskOutput calls in the same message.
