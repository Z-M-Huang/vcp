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
3. Find the first non-completed task — its description contains the skill to invoke (e.g., "run /dev-buddy-code-review")
4. If the task is blocked but all its blockers are completed, update it to `in_progress`
5. Invoke the skill named in the task description and continue the pipeline
6. After decompose, the pipeline must run to completion without stopping — do NOT yield to the user between stages

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

### 1c. Create master plan file

Use the Write tool to create `~/.claude/plans/ralph-{SLUG}.md`:

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

## UAT Results
(pending)
```

### 1d. Create stage tasks

```
TaskCreate("Stage: Discovery — ralph-{SLUG}", status: "in_progress")
TaskCreate("Stage: Requirements + UAT — ralph-{SLUG}", status: "pending", blocked_by: [T-discover])
TaskCreate("Stage: Decompose — ralph-{SLUG}", status: "pending", blocked_by: [T-requirements])
TaskCreate("Stage: Code Review — run /dev-buddy-code-review — DO NOT STOP, continue pipeline — ralph-{SLUG}", status: "pending", blocked_by: [T-decompose])
TaskCreate("Stage: UAT — run /dev-buddy-uat — DO NOT STOP, continue pipeline — ralph-{SLUG}", status: "pending", blocked_by: [T-review])
```

Note: Build tasks (T-unit-N) are created during decomposition when units are known.
Post-decompose task descriptions include the skill to invoke and a continuation hint — these survive context compaction and serve as breadcrumbs when checking TaskList.

---

## Step 2: DISCOVER

Run `/dev-buddy-discover`. The skill reads the plan file, dispatches multi-AI exploration, synthesizes findings, runs internal adversarial validation, and gets user confirmation.

After completion:
- `TaskUpdate(T-discover, status: "completed")`
- `TaskUpdate(T-requirements, status: "in_progress")`

---

## Step 3: REQUIREMENTS + UAT DESIGN

Run `/dev-buddy-requirements`. The skill reads discovery from the plan, dispatches multi-AI requirements analysis, synthesizes ACs + UAT scenarios, runs internal adversarial validation, and gets user approval through batched AC/UAT review rounds.

After completion:
- `TaskUpdate(T-requirements, status: "completed")`
- `TaskUpdate(T-decompose, status: "in_progress")`

---

## Step 4: DECOMPOSE

Run `/dev-buddy-decompose`. The skill reads requirements from the plan, dispatches multi-AI decomposition, runs internal adversarial validation (including fresh-context simulation), gets user approval FIRST, and only then creates per-unit plan files and unit tasks.

After completion:
- `TaskUpdate(T-decompose, status: "completed")`
- All unit tasks created with dependencies

---

## Step 5: BUILD (Inner Ralph Loop)

Run `/dev-buddy-build`. The skill iterates through all pending units, dispatching fresh-context implementers with independent backpressure verification.

After all units complete:
- `TaskUpdate(T-review, status: "in_progress")`

---

## Step 6: CODE REVIEW (Review Gate)

Run `/dev-buddy-code-review`. The skill dispatches multi-AI reviewers who trace ACs to code with file:line evidence.

### Verdict handling (orchestrator's responsibility):

**approved** → proceed to Step 7.

**needs_changes** →
1. The skill has already updated affected unit plans and reset statuses
2. Loop back to Step 5 (BUILD for affected units only)
3. After rebuilds, loop back to Step 6 (fresh CODE REVIEW)
4. Max review iterations: `max_iterations` from config

**rejected** → stop and report to user.

After approval:
- `TaskUpdate(T-review, status: "completed")`
- `TaskUpdate(T-uat, status: "in_progress")`

---

## Step 7: UAT (Outer Ralph Loop)

Run `/dev-buddy-uat`. The skill runs all mechanical backpressure and UAT tests.

### Result handling (orchestrator's responsibility):

**ALL pass** →
- `TaskUpdate(T-uat, status: "completed")`
- Report success to user. Done.

**ANY fail** →
1. The skill has already updated affected unit plans and reset statuses
2. Loop back: Step 5 (BUILD) → Step 6 (CODE REVIEW) → Step 7 (UAT)
3. Max outer iterations: `max_outer_iterations` from config
4. After exhaustion: report to user

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
