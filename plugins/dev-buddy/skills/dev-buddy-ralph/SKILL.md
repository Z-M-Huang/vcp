---
name: dev-buddy-ralph
description: Full feature development pipeline — Ralph loop orchestrator chaining 6 stage skills
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent, Task, TaskOutput, TaskCreate, TaskUpdate, TaskList, TaskGet, AskUserQuestion, Skill
---

# Ralph Loop — Feature Development Orchestrator

Chains 6 stage skills through the Ralph loop architecture: discover → requirements → decompose → build → code review → UAT, with two nested loops and multi-AI diversity.

**Usage:** `/dev-buddy-ralph <feature description>`

**Config:** `~/.vcp/dev-buddy.json` — use `/dev-buddy-config` web portal or edit manually.

Each stage is a standalone skill that can also be invoked independently. This orchestrator manages initialization, TaskManagement, and the loop logic that connects them.

---

## Resume Protocol (after context compaction)

If you have lost context (conversation compressed), immediately:
1. Call `TaskList()` to see all tasks and their statuses
2. Read the master plan file (path is in the first task's description: `ralph-{SLUG}`)
3. Check plan `**Status:**` — this is the source of truth for which stage to run
4. Find the task matching the current plan status. If it is `completed` but the plan status indicates it should run again (loop-back from code review or UAT), reset it to `in_progress`
5. Use the Skill tool to invoke the skill named in the task description (e.g., "invoke /dev-buddy-build")
6. After the skill returns, run the VERIFY commands from the task description
7. If any VERIFY check fails: fix the issue with Edit tool, re-run VERIFY
8. Determine next action based on plan status:
   - Status advanced forward (e.g., build→review): `TaskUpdate` current task to `completed`, go to step 1
   - Status looped back (e.g., review→build): reset downstream tasks to `pending`, go to step 1
   - Status is `done`: `TaskUpdate` current task to `completed`, report success to user

---

## Step 1: Initialize

Extract the feature description from the arguments after the skill trigger.

### 1a. Load config

```bash
bun -e "
import { loadDevBuddyConfig } from '${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-config.ts';
const config = loadDevBuddyConfig();
console.log(JSON.stringify({
  stages: Object.fromEntries(Object.entries(config.stages).map(([k, v]) => [k, { executor_count: v.executors.length }])),
  max_iterations: config.max_iterations,
  max_build_attempts: config.max_build_attempts,
  max_outer_iterations: config.max_outer_iterations,
}));
"
```

### 1b. Generate slug

Generate a URL-safe slug from the feature description (first 4-5 words, lowercase, hyphens):
```bash
bun -e "console.log(process.argv[1].toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40))" -- "{first 4-5 words of feature}"
```
Store as `{SLUG}`.

### 1c. Initialize plan directory

```bash
mkdir -p "${CLAUDE_PROJECT_DIR}/.vcp/plan"
if ! grep -qF '.vcp/plan/' "${CLAUDE_PROJECT_DIR}/.gitignore" 2>/dev/null; then
  echo '.vcp/plan/' >> "${CLAUDE_PROJECT_DIR}/.gitignore"
fi
```

### 1d. Create master plan file

Use the Write tool to create `${CLAUDE_PROJECT_DIR}/.vcp/plan/ralph-{SLUG}.md`:

```markdown
# Ralph: {Feature Title}

**Status:** discover
**Created:** {today's date}

---

## Discovery
(pending)

## Requirements
(pending)

## Units of Work
(pending)

## Code Review
(pending)

## UAT Results
(pending)
```

### 1e. Create stage tasks

```
TaskCreate("Stage: Discovery — invoke /dev-buddy-discover — ralph-{SLUG}
VERIFY BEFORE COMPLETING:
  grep -v '(pending)' .vcp/plan/ralph-{SLUG}.md | grep -q '## Discovery'
  grep '^\*\*Status:\*\* requirements' .vcp/plan/ralph-{SLUG}.md", status: "in_progress")

TaskCreate("Stage: Requirements + UAT — invoke /dev-buddy-requirements — ralph-{SLUG}
VERIFY BEFORE COMPLETING:
  grep -v '(pending)' .vcp/plan/ralph-{SLUG}.md | grep -q '## Requirements'
  grep -c '### AC-' .vcp/plan/ralph-{SLUG}.md | grep -v '^0$'
  grep -c '### UAT-' .vcp/plan/ralph-{SLUG}.md | grep -v '^0$'
  grep '^\*\*Status:\*\* decompose' .vcp/plan/ralph-{SLUG}.md", status: "pending", blocked_by: [T-discover])

TaskCreate("Stage: Decompose — invoke /dev-buddy-decompose — ralph-{SLUG}
VERIFY BEFORE COMPLETING:
  ls .vcp/plan/ralph/{SLUG}/unit-*.md
  grep -v '(pending)' .vcp/plan/ralph-{SLUG}.md | grep -q '## Units of Work'
  grep '^\*\*Status:\*\* build' .vcp/plan/ralph-{SLUG}.md", status: "pending", blocked_by: [T-requirements])

TaskCreate("Stage: Build — invoke /dev-buddy-build — ralph-{SLUG}
VERIFY BEFORE COMPLETING:
  grep -c '^\*\*Status:\*\* pending' .vcp/plan/ralph/{SLUG}/unit-*.md | grep '^0$'
  grep '^\*\*Status:\*\* review' .vcp/plan/ralph-{SLUG}.md", status: "pending", blocked_by: [T-decompose])

TaskCreate("Stage: Code Review — invoke /dev-buddy-code-review — ralph-{SLUG}
VERIFY BEFORE COMPLETING:
  grep '^\*\*Verdict:\*\*' .vcp/plan/ralph-{SLUG}.md
  grep '^\*\*Status:\*\* uat\|^\*\*Status:\*\* build' .vcp/plan/ralph-{SLUG}.md", status: "pending", blocked_by: [T-build])

TaskCreate("Stage: UAT — invoke /dev-buddy-uat — ralph-{SLUG}
VERIFY BEFORE COMPLETING:
  grep '## UAT Results' .vcp/plan/ralph-{SLUG}.md | grep -v '(pending)'
  grep '^\*\*Status:\*\* done\|^\*\*Status:\*\* build' .vcp/plan/ralph-{SLUG}.md", status: "pending", blocked_by: [T-review])
```

Note: Build tasks (T-unit-N) are created during decomposition when units are known.
Each task description includes the skill to invoke and VERIFY commands — these survive context compaction and serve as both breadcrumbs and completion checklists.

---

## Step 2: DISCOVER

Use the Skill tool to invoke `/dev-buddy-discover`.

After the skill returns — run VERIFY from task description:
1. Confirm `## Discovery` section is no longer `(pending)` in plan file
2. Confirm `**Status:**` is `requirements`:
   ```bash
   grep '^\*\*Status:\*\* requirements' "${CLAUDE_PROJECT_DIR}/.vcp/plan/ralph-{SLUG}.md"
   ```
3. If status was not updated: fix with Edit tool, then re-verify
4. `TaskUpdate(T-discover, status: "completed")`
5. `TaskUpdate(T-requirements, status: "in_progress")`

---

## Step 3: REQUIREMENTS + UAT DESIGN

Use the Skill tool to invoke `/dev-buddy-requirements`.

After the skill returns — run VERIFY from task description:
1. Confirm `## Requirements` section is no longer `(pending)` in plan file
2. Confirm ACs and UATs exist:
   ```bash
   grep -c '### AC-' "${CLAUDE_PROJECT_DIR}/.vcp/plan/ralph-{SLUG}.md"
   grep -c '### UAT-' "${CLAUDE_PROJECT_DIR}/.vcp/plan/ralph-{SLUG}.md"
   ```
3. Confirm `**Status:**` is `decompose`:
   ```bash
   grep '^\*\*Status:\*\* decompose' "${CLAUDE_PROJECT_DIR}/.vcp/plan/ralph-{SLUG}.md"
   ```
4. If status was not updated: fix with Edit tool, then re-verify
5. `TaskUpdate(T-requirements, status: "completed")`
6. `TaskUpdate(T-decompose, status: "in_progress")`

---

## Step 4: DECOMPOSE

Use the Skill tool to invoke `/dev-buddy-decompose`.

After the skill returns — run VERIFY from task description:
1. Confirm unit plan files exist:
   ```bash
   ls "${CLAUDE_PROJECT_DIR}/.vcp/plan/ralph/{SLUG}/unit-"*.md
   ```
2. Confirm `## Units of Work` table is no longer `(pending)` in plan file
3. Confirm `**Status:**` is `build`:
   ```bash
   grep '^\*\*Status:\*\* build' "${CLAUDE_PROJECT_DIR}/.vcp/plan/ralph-{SLUG}.md"
   ```
4. If status was not updated: fix with Edit tool, then re-verify
5. `TaskUpdate(T-decompose, status: "completed")`
6. All unit tasks created with dependencies

---

## Step 5: BUILD (Inner Ralph Loop)

Use the Skill tool to invoke `/dev-buddy-build`.

On entry:
- `TaskUpdate(T-build, status: "in_progress")`

After the skill returns — run VERIFY from task description:
1. Check all unit files are done:
   ```bash
   grep -l '^\*\*Status:\*\* pending' "${CLAUDE_PROJECT_DIR}/.vcp/plan/ralph/{SLUG}/unit-"*.md 2>/dev/null
   ```
   If any are still pending but master plan Units table shows them as done, update the unit files.
2. Verify plan status:
   ```bash
   grep '^\*\*Status:\*\* review' "${CLAUDE_PROJECT_DIR}/.vcp/plan/ralph-{SLUG}.md"
   ```
   If not `review`: update with Edit tool.
3. `TaskUpdate(T-build, status: "completed")`
4. `TaskUpdate(T-review, status: "in_progress")`

---

## Step 6: CODE REVIEW (Review Gate)

Use the Skill tool to invoke `/dev-buddy-code-review`.

### Verdict handling (orchestrator's responsibility):

**approved** → proceed to Step 7.

**needs_changes** → loop back to Step 5 (BUILD for affected units only). Max: `max_iterations` from config.

**rejected** → stop and report to user.

After the skill returns — run VERIFY from task description:
1. Verify verdict is recorded:
   ```bash
   grep '^\*\*Verdict:\*\*' "${CLAUDE_PROJECT_DIR}/.vcp/plan/ralph-{SLUG}.md"
   ```
2. Verify plan status matches verdict:
   ```bash
   grep '^\*\*Status:\*\*' "${CLAUDE_PROJECT_DIR}/.vcp/plan/ralph-{SLUG}.md"
   ```
   - If approved: expected `uat`. If not: fix with Edit.
   - If needs_changes: expected `build`. If not: fix with Edit.
3. If status doesn't match: fix with Edit tool
4. Update tasks per verdict:
   - approved:
     - `TaskUpdate(T-review, status: "completed")`
     - `TaskUpdate(T-uat, status: "in_progress")`
   - needs_changes (loop back):
     - `TaskUpdate(T-build, status: "in_progress")`
     - Do NOT complete T-review — leave it in_progress for the next review round
     - Go back to Step 5

---

## Step 7: UAT (Outer Ralph Loop)

Use the Skill tool to invoke `/dev-buddy-uat`.

### Result handling (orchestrator's responsibility):

**ALL pass** → done.

**ANY fail** → loop back to Step 5. Max: `max_outer_iterations` from config.

After the skill returns — run VERIFY from task description:
1. Verify UAT results recorded:
   ```bash
   grep '## UAT Results' "${CLAUDE_PROJECT_DIR}/.vcp/plan/ralph-{SLUG}.md" | grep -v '(pending)'
   ```
2. Verify plan status:
   ```bash
   grep '^\*\*Status:\*\*' "${CLAUDE_PROJECT_DIR}/.vcp/plan/ralph-{SLUG}.md"
   ```
   - If all pass: expected `done`. If not: fix with Edit.
   - If any fail: expected `build`. If not: fix with Edit.
3. Update tasks per result:
   - all pass:
     - `TaskUpdate(T-uat, status: "completed")`
     - Report success to user
   - any fail (loop back):
     - `TaskUpdate(T-build, status: "in_progress")`
     - `TaskUpdate(T-review, status: "pending")`
     - Do NOT complete T-uat — leave it in_progress for the next UAT round
     - Go back to Step 5

---

## Loop Summary

```
Step 2: /dev-buddy-discover
Step 3: /dev-buddy-requirements
Step 4: /dev-buddy-decompose
Step 5: /dev-buddy-build ◄──────────────────────┐
Step 6: /dev-buddy-code-review                   │
         ├─ approved → Step 7                    │
         ├─ needs_changes → back to Step 5 ──────┤
         └─ rejected → stop                      │
Step 7: /dev-buddy-uat                           │
         ├─ all pass → done                      │
         └─ any fail → back to Step 5 ───────────┘
```
