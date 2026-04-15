---
name: dev-buddy-ralph
description: Full feature development pipeline — Ralph loop orchestrator chaining 6 stage skills
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent, Task, TaskOutput, TaskCreate, TaskUpdate, TaskList, TaskGet, AskUserQuestion, Skill
---

# Ralph Loop — Feature Development Orchestrator

Chains 6 stage skills through the Ralph loop: discover → requirements → decompose → build → code review → UAT.

**Usage:** `/dev-buddy-ralph <feature description>`

**Config:** `~/.vcp/dev-buddy.json` — use `/dev-buddy-config` web portal or edit manually.

---

## Core Invariant

**Plan file + state machine = source of truth. Tasks = derived projection.**

ALWAYS query the state machine first, THEN update tasks to match. Tasks provide visibility and resume capability. The state machine drives all decisions.

---

## Initialization

On first run:

1. **Generate slug** from the feature description (lowercase, hyphens, no special chars).

2. **Check for existing plan** at `${CLAUDE_PROJECT_DIR}/.vcp/plan/ralph-{SLUG}.md`.
   If it exists → follow **Cross-Session Resume** instead of continuing here.

3. **Create plan directory and file:**
   ```bash
   mkdir -p "${CLAUDE_PROJECT_DIR}/.vcp/plan"
   ```
   Write initial plan at `${CLAUDE_PROJECT_DIR}/.vcp/plan/ralph-{SLUG}.md` with `**Status:** discover`.

4. **Create 6 pipeline stage tasks** with dependency chain:

   Use TaskCreate for each, then TaskUpdate to set `addBlockedBy`. Track the returned task IDs.

   | # | Subject | blockedBy | metadata |
   |---|---------|-----------|----------|
   | 1 | Ralph: Discovery | — | `{type:'stage', stage:'discover', slug, plan}` |
   | 2 | Ralph: Requirements | [1] | `{type:'stage', stage:'requirements', slug, plan}` |
   | 3 | Ralph: Decomposition | [2] | `{type:'stage', stage:'decompose', slug, plan}` |
   | 4 | Ralph: Development | [3] | `{type:'stage', stage:'build', slug, plan}` |
   | 5 | Ralph: Code Review | [4] | `{type:'stage', stage:'review', slug, plan}` |
   | 6 | Ralph: UAT | [5] | `{type:'stage', stage:'uat', slug, plan}` |

   Where `plan` = absolute path to the plan file, `slug` = generated slug.

   **Task 4 (Development) is a passthrough milestone.** It has no work of its own — it exists to preserve the 6-stage linear chain. It will be blocked by all unit tasks after decompose.

   Each task description should include:
   - What the stage does (one line)
   - The state machine query command: `bun "${CLAUDE_PLUGIN_ROOT}/scripts/ralph-state-machine.ts" --plan "{plan}" --action next`
   - Resume instruction: "Read plan file, query state machine, continue loop."

5. **Register task IDs** in the state file for resume persistence:
   ```bash
   bun "${CLAUDE_PLUGIN_ROOT}/scripts/ralph-state-machine.ts" \
     --plan "{plan}" --action register-task --ref "stage:{stage}" --task-id "{id}"
   ```
   Run once per task (6 calls total).

6. **Enter the main orchestration loop.**

---

## Main Orchestration Loop

1. **Query the state machine** for the next action:
   ```bash
   bun "${CLAUDE_PLUGIN_ROOT}/scripts/ralph-state-machine.ts" \
     --plan "${CLAUDE_PROJECT_DIR}/.vcp/plan/ralph-{SLUG}.md" --action next
   ```

2. **Process the returned `actions` array in order.** Each action has a `type`:

   - **`update_tasks`** — For each operation, resolve `ref` (e.g., `"stage:discover"`, `"unit:3"`) to a task ID using the state file's `taskIds` map, then call TaskUpdate with the specified status.

   - **`invoke_skill`** — Route by `stageType`:

     **Build stage** (`stageType: "ralph-build"`): Drive unit-by-unit. The runner owns the full retry loop per unit.
     The state machine's `invoke_skill` action includes `unitId` and `unitPath`. Process the `update_tasks` action normally (marks unit `in_progress`), then dispatch via Bash with `run_in_background: true`:
     ```bash
     bun "${CLAUDE_PLUGIN_ROOT}/scripts/build-loop-runner.ts" \
       --plan "{plan}" --cwd "${CLAUDE_PROJECT_DIR}" --unit {unitId} 2>&1
     ```
     **IMPORTANT:** The Bash tool has a hard max timeout of 600,000ms (10 min). Units with large implementations or multiple retry attempts can take much longer. Always use `run_in_background: true` to prevent the Bash tool from killing the process prematurely.

     After launching:
     1. Save the returned `task_id` from the Bash tool.
     2. Poll with `TaskOutput(task_id, block: true, timeout: 600000)`.
     3. If TaskOutput returns but the task is still running (not complete), repeat `TaskOutput` with `timeout: 600000` until done.

     The script outputs JSON when the unit is done or failed (all retries are internal):
     ```json
     {"event": "unit_done", "unitId": 3, "outcome": "done", "attempt": 1, "maxAttempts": 3, "summary": "..."}
     ```
     After the script completes:
     1. **Evaluate `event`**: `unit_done` → TaskUpdate unit task to `completed`. `unit_failed` → TaskUpdate unit task to `failed`. `unit_error` → TaskUpdate unit task to `failed`, report error to user.
     2. **Re-query the state machine** — it returns the next build action (another unit) or transitions to review.

     **All other stages**: Use the Skill tool to call the named skill (e.g., `/dev-buddy-discover`). If `unitId` and `unitPath` are present, pass this context to the skill.

   - **`user_checkpoint`** — Present stage output and ask user for approval (see **User Checkpoint Handling** below).

   - **`write_plan`** — Apply the `edits` array to the plan file using the Edit tool. Each edit has `old_string` and `new_string`.

   - **`run_backpressure`** — Run the listed shell commands via Bash and report pass/fail results.

   - **`done`** — Pipeline complete. Mark all remaining in_progress tasks as completed. Report the summary to the user.

   - **`error`** / **`blocked`** — Stop and report to the user.

3. **Post-invocation status verification** (after `invoke_skill` for discover/requirements/decompose):
   1. Read the plan file, extract `**Status:**`
   2. The stage skill MUST write the `*-review` status (e.g., `discover-review`). If the skill wrote the wrong status, correct it before re-querying.

4. **Post-decomposition unit plan validation** (BLOCKING GATE — after decompose skill writes `decompose-review`):

   Before proceeding to the user checkpoint, validate ALL unit files mechanically:
   ```bash
   for f in ${CLAUDE_PROJECT_DIR}/.vcp/plan/ralph/{SLUG}/unit-*.md; do
     for section in "### Entropy" "### Acceptance Criteria" "### Interface Contract" \
                    "### Test Stubs" "### What to Implement" "### Files to Touch" \
                    "### Backpressure" "### Done When"; do
       count=$(grep -c "$section" "$f" 2>/dev/null || echo 0)
       if [ "$count" -eq 0 ]; then echo "MISSING: $section in $(basename $f)"; fi
     done
   done
   ```

   Also check `## Entropy` and `## Interface Contract` (some LLMs use H2 instead of H3).

   **If ANY required section is missing:**
   1. Do NOT proceed to `decompose-review` user checkpoint
   2. Write the plan status back to `decompose`
   3. Write a `## Feedback` section listing the missing sections per unit file
   4. Re-query the state machine (triggers decomposition re-run with feedback)

   This is a **hard failure**, not a warning. It prevents the primary failure mode where the decomposition LLM produces abbreviated unit files without contracts or test stubs.

   Also validate test stub quality in each unit file:
   ```bash
   for f in ${CLAUDE_PROJECT_DIR}/.vcp/plan/ralph/{SLUG}/unit-*.md; do
     stubs=$(sed -n '/^### Test Stubs/,/^###/p' "$f" | head -100)
     expect_count=$(echo "$stubs" | grep -c 'expect(' 2>/dev/null || echo 0)
     if [ "$expect_count" -eq 0 ]; then
       echo "WEAK_STUBS: No expect() assertions in $(basename $f)"
     fi
   done
   ```

   **If ANY unit has zero `expect()` calls in its Test Stubs section:**
   1. Do NOT proceed to `decompose-review` user checkpoint
   2. Write the plan status back to `decompose`
   3. Write a `## Feedback` section listing the weak stubs per unit file
   4. Re-query the state machine (triggers decomposition re-run with feedback)

5. **Post-review source verification** (after code review returns `approved`, before transitioning to UAT):

   If any unit files contain `### Authoritative Sources` blocks:
   1. Read all Authoritative Sources blocks from unit files
   2. For each binding constraint, READ the referenced source document
   3. Read the implementing code at the file:line cited in the code review's AC Tracing
   4. Verify the implementation honors the binding constraint
   5. If any constraint appears violated, downgrade the code review verdict to `needs_changes` with a specific finding: "Authoritative source {X} requires {Y}, but code does {Z}"

6. **Repeat** from step 1 until the state machine returns `done`, `error`, or `blocked`.

---

## User Checkpoint Handling

When the state machine returns a `user_checkpoint` action (for `discover-review`, `requirements-review`, or `decompose-review`):

The stage skill already obtained user approval via AskUserQuestion before writing the `-review` status. **Auto-advance without re-asking:**

1. Write `action.approveStatus` to the plan's `**Status:**` line. Mark the current stage task as completed.
2. If this was **decompose-review**: trigger **Unit Task Creation** (below) before re-querying.
3. Otherwise: re-query the state machine.

**Do NOT call AskUserQuestion here** — the user already approved in the stage skill. Re-asking creates a redundant gate.

---

## Unit Task Creation (Post-Decompose Approval)

After decompose-review is approved and the Decomposition task is marked completed, run the **four-step deterministic flow**. Each step has an explicit purpose; do not reorder or skip.

### Step 1 — List units (read-only)

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/ralph-state-machine.ts" \
  --plan "{plan}" --action list-units
```

Returns JSON with structured fields per unit:
```json
{ "units": [
  { "id": 1, "title": "...", "status": "pending", "dependsOn": [],
    "ref": "unit:1", "subject": "Unit 1: ...", "blockedByRefs": [] },
  { "id": 2, "title": "...", "status": "pending", "dependsOn": [1],
    "ref": "unit:2", "subject": "Unit 2: ...", "blockedByRefs": ["unit:1"] }
] }
```

Use `subject`, `ref`, and `blockedByRefs` directly — do not re-derive them.

### Step 2 — Create all tasks, collect IDs

For each unit, call TaskCreate:
- Subject: `unit.subject` (e.g., `"Unit 1: Discovery probes"`)
- Description: `"Build unit {id}.\nPlan: .vcp/plan/ralph/{SLUG}/unit-{id}.md\nCommand (run_in_background: true): bun \"${CLAUDE_PLUGIN_ROOT}/scripts/build-loop-runner.ts\" --plan \"{plan}\" --cwd \"${CLAUDE_PROJECT_DIR}\" --unit {id} 2>&1"`
- Metadata: `{type: 'unit', unitId: id, slug: '{SLUG}', plan: '{plan path}'}`

Collect every returned `taskId` into a local map keyed by `ref` (i.e., `refToTaskId["unit:1"] = "<id>"`). Do not register anything yet.

Also TaskUpdate the Development milestone (task 4) with `addBlockedBy: [all unit task IDs]` so Development cannot complete until every unit is done.

### Step 3 — Apply addBlockedBy for every unit with dependencies

For each unit where `blockedByRefs.length > 0`, call TaskUpdate on its task ID with `addBlockedBy` mapping each ref in `blockedByRefs` to the corresponding task ID from the local map built in Step 2. Skip units with empty `blockedByRefs`.

This is the step that makes the dependency edges visible on the task board.

### Step 4 — Bulk-register the task graph (one call)

Build the payload:
```json
{
  "taskIds": { "unit:1": "<id1>", "unit:2": "<id2>", ... },
  "blockedBy": { "unit:2": ["unit:1"], ... }
}
```

`taskIds` includes every unit. `blockedBy` includes every unit with non-empty dependencies (omit empty entries — the verify step treats them the same).

Pass via the `@path` form when the JSON is large (≥ a few KB); otherwise the inline form is fine:
```bash
# Inline form
bun "${CLAUDE_PLUGIN_ROOT}/scripts/ralph-state-machine.ts" \
  --plan "{plan}" --action register-task-graph \
  --data '{"taskIds":{...},"blockedBy":{...}}'

# File form (avoids OS argv size limits)
echo '{"taskIds":{...},"blockedBy":{...}}' > /tmp/ralph-graph-{SLUG}.json
bun "${CLAUDE_PLUGIN_ROOT}/scripts/ralph-state-machine.ts" \
  --plan "{plan}" --action register-task-graph \
  --data "@/tmp/ralph-graph-{SLUG}.json"
```

This is one atomic read-modify-write — never run a per-unit `register-task` loop after Step 4.

### Step 5 — Verify and surface drift

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/ralph-state-machine.ts" \
  --plan "{plan}" --action verify-task-graph
```

Always exits 0 (warn-and-continue). Output:
```json
{ "ok": true, "diff": { "missingRefs": [], "extraRefs": [], "mismatchedEdges": [] } }
```

If `ok: false`, **report the diff to the user verbatim** and continue — do not block the pipeline. The build runner enforces execution order from unit files, so drift is a visibility issue, not a correctness issue. Subsequent `--action next` calls will also surface drift via the `warnings: [...]` field in their JSON output; pass those warnings through to the user when they appear.

### Step 6 — Re-enter the main loop

The state machine now returns build actions with specific `unitId`/`unitPath` for each eligible unit.

---

## Loop-back Handling

When the state machine returns `write_plan` that changes status from `review` or `uat` back to `build`:

1. **Stage tasks stay `in_progress`** — Do NOT mark Code Review or UAT tasks as completed. They stay `in_progress` through the entire loop-back cycle.

2. **Re-enter the main loop** — The state machine will handle the loop-back internally. It will return build actions with specific units that need rebuilding.

3. **If units were reset to pending** (the review/UAT skill reset affected unit plan files):
   - Call `--action list-units` to get current unit statuses
   - For any unit that is `pending` but whose task was already completed: create a new rework task
     - Subject: `"Unit {id}: {title} (rework)"`
     - Metadata: `{type: 'unit', unitId: id, slug, plan, reworkIteration: N}`
   - Register new task IDs via `--action register-task`

4. **Continue the main loop** — The state machine drives all branching logic. Tasks reflect state.

---

## Resume Protocol

After context compaction:

1. **TaskList()** — See all tasks with their status and metadata.

2. **Read the state file** — Query the state machine to get `taskIds` mapping:
   ```bash
   bun "${CLAUDE_PLUGIN_ROOT}/scripts/ralph-state-machine.ts" \
     --plan "{plan}" --action next
   ```
   The returned `state.taskIds` contains the ref→taskId mapping.

3. **If state file is missing or stale**: Rebuild the mapping from TaskList metadata — match tasks by `type`, `stage`/`unitId`, and `slug`.

4. **Read the plan file** for current `**Status:**`.

5. **Re-enter the main loop** at step 1 (query state machine). The state machine reads the plan file and returns the correct next action.

---

## Cross-Session Resume

When `/dev-buddy-ralph` is invoked in a new session and a plan file already exists:

1. **Generate slug** from the feature description.
2. **Check for existing plan** at `${CLAUDE_PROJECT_DIR}/.vcp/plan/ralph-{SLUG}.md`.
   If no → normal initialization (first run). If yes → continue below.

3. **Check if tasks already exist** — `TaskList()`.
   - If tasks exist with matching slug metadata → use existing **Resume Protocol** (context compaction case). Skip to step 8.
   - If no matching tasks → cross-session restart (below).

4. **Read plan status directly** — do NOT use `--action next` for probing (it has side effects).
   ```bash
   grep '^\*\*Status:\*\*' "${CLAUDE_PROJECT_DIR}/.vcp/plan/ralph-{SLUG}.md"
   ```
   Extract the status value (e.g., `build`, `review`, `uat`, `done`).

5. **Recreate stage tasks** — Create all 6 stage tasks via TaskCreate with dependency chain.
   Determine completed stages from the extracted status:

   | Plan Status | Completed Stages |
   |-------------|-----------------|
   | `discover` / `discover-review` | none |
   | `requirements` / `requirements-review` | Discovery |
   | `decompose` / `decompose-review` | Discovery, Requirements |
   | `build` | Discovery, Requirements, Decomposition |
   | `review` | Discovery, Requirements, Decomposition (Development stays `in_progress`) |
   | `uat` | Discovery, Requirements, Decomposition (Development, Code Review stay `in_progress` per loop-back rules) |
   | `done` | All 6 completed |

   Mark completed stage tasks immediately via TaskUpdate. For `in_progress` stages (review/UAT loop-back), mark them `in_progress`.

6. **Recreate unit tasks** (if status >= `build`) — follow the same four-step deterministic flow as **Unit Task Creation** above, with status backfill in Step 2:

   **Step 1 (list)**: `--action list-units` returns the structured units (with `ref`, `subject`, `blockedByRefs`).

   **Step 2 (create + backfill status)**: For each unit, TaskCreate with `subject` and metadata `{type: 'unit', unitId: id, slug, plan}`. Then immediately reflect persisted status:
   - `done` → TaskUpdate `completed`
   - `failed` → TaskUpdate `failed`
   - `pending` → leave open

   Collect every returned `taskId` into a local `refToTaskId` map. TaskUpdate the Development milestone (task 4) with `addBlockedBy: [all unit task IDs]`.

   **Step 3 (addBlockedBy)**: For each unit with non-empty `blockedByRefs`, TaskUpdate with `addBlockedBy` mapping refs to task IDs.

   **Step 4 (bulk register)**: One `--action register-task-graph --data <json|@path>` call with the full `{ taskIds, blockedBy }` payload — never per-unit `register-task`.

7. **Verify and surface drift**: `--action verify-task-graph`. Report any non-empty diff to the user; do not block.

8. **Enter the main orchestration loop** — the first `--action next` call is the real one that processes actions. If its JSON includes a `warnings` field, pass those warnings through to the user.
