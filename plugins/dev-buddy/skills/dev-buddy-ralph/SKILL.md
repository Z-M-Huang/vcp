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

   - **`update_tasks`** — For each operation, resolve `ref` (e.g., `"stage:discover"`, `"unit:3"`) to a task ID using the state file's `taskIds` map, then dispatch by `action`:
     - `{action: "update"}` → call `TaskUpdate(taskId, status)` with the specified status.
     - `{action: "set_blocked_by"}` → resolve every ref in the `blockedBy` array to a task ID via the same map, then call `TaskUpdate(taskId, addBlockedBy: [taskIds...])`. If any ref in the operation is unresolvable (no entry in `taskIds`), stop and report the unresolved refs to the user — do not silently skip the op.

   - **`invoke_skill`** — Route by `stageType`:

     **Build stage** (`stageType: "ralph-build"`): CC spawns BLR once per unit and lets it drive the full dispatch → backpressure → contract-verify → (optional) unit-review → commit loop in-process. CC never sees per-attempt state.

     **Per-unit flow:**
     1. TaskUpdate unit task → `in_progress` (action.unitId → ref `unit:{unitId}` → taskId).
     2. Spawn BLR end-to-end:
        ```bash
        bun "${CLAUDE_PLUGIN_ROOT}/scripts/build-loop-runner.ts" \
          --plan "{plan}" --cwd "${CLAUDE_PROJECT_DIR}" --unit {action.unitId}
        ```
        **IMPORTANT:** Use `run_in_background: true` — BLR may run many minutes across retries; the Bash tool hard-caps at 600,000ms.
     3. Poll with `TaskOutput(task_id, block: true, timeout: 600000)`. BLR streams one JSON event per line — `attempt_start`, `review_start`, `review_verdict`, and one final `complete`. Intermediate events are advisory; the terminal `complete` line is authoritative.
     4. The terminal line has shape:
        ```json
        {"event":"complete","status":"done|failed|stuck","unitId":N,"attempts":K,"reason":"...","orchestratorHints":{"claudeCode":{"tool":"TaskUpdate","status":"completed","note":"..."}}}
        ```
        Route on `status`:
        - `done`   → TaskUpdate unit task to `completed` with `reason` as the note.
        - `failed` → TaskUpdate unit task to `completed` with `"failed — " + reason`. TaskUpdate's vocabulary is `in_progress | completed`; the failure semantic lives in the note text.
        - `stuck`  → **Do NOT mark the task completed.** Report `reason` to the user and stop the outer loop — the unit needs manual intervention. `orchestratorHints` is omitted on `stuck` for this reason.
     5. Re-query SM `--action next`. The SM reads unit-N.json (which BLR's in-process calls have already committed via build-actions.ts) and emits the next build action or the stage transition.

     The `orchestratorHints.claudeCode` block is a pre-formatted hint. Use it when present, but the top-level `status`/`reason` is the authoritative contract. Authoritative state lives in `unit-N.json`, not the stdout stream.

     **All other stages**: Use the Skill tool to call the named skill (e.g., `/dev-buddy-discover`). If `unitId` and `unitPath` are present, pass this context to the skill.

     **External consumer API.** Non-CC orchestrators that need attempt-level granularity (debugging, CI wrappers) can call the three SM CLI actions directly — `compose_build_dispatch`, `record_attempt_result`, `record_review_result`. These wrap the same action functions BLR calls in-process.

   - **`user_checkpoint`** — Pass `action.askUserQuestion` to the `AskUserQuestion` tool and dispatch on the user's answer (see **User Checkpoint Handling** below).

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

When the state machine returns a `user_checkpoint` action:

1. Quote the `action.sectionHeading` section from the plan file so the user can see what they are approving. For `decompose-review`, also list the unit files under `.vcp/plan/ralph/{SLUG}/unit-*.md`.
2. Call `AskUserQuestion(action.askUserQuestion)` — forward the payload verbatim.
3. Dispatch on the returned label:
   - **`approve`** → write `action.approveStatus` to `**Status:**`, mark the stage task completed. For `decompose-review`, trigger **Unit Task Creation** before re-querying; otherwise re-query the state machine.
   - **`request changes`** → call `AskUserQuestion(action.feedbackQuestion)`. If the user typed free-text (via `Other`) or picked a preset label, write that body to a `## Feedback` section (create or replace) and write `action.rejectStatus` to `**Status:**`, then re-query. `stage-runner.ts` reads `## Feedback` as context on the re-run. If the user picked `abort pipeline`, stop and report.

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

### Step 2 — Create all tasks, build the graph payload

For each unit, call TaskCreate:
- Subject: `unit.subject` (e.g., `"Unit 1: Discovery probes"`)
- Description: `"Build unit {id}.\nPlan: .vcp/plan/ralph/{SLUG}/unit-{id}.md\nCommand (run_in_background: true): bun \"${CLAUDE_PLUGIN_ROOT}/scripts/build-loop-runner.ts\" --plan \"{plan}\" --cwd \"${CLAUDE_PROJECT_DIR}\" --unit {id} 2>&1"`
- Metadata: `{type: 'unit', unitId: id, slug: '{SLUG}', plan: '{plan path}'}`

Build the `{taskIds, blockedBy}` payload as you go. `taskIds` MUST include every unit ref. `blockedBy` MUST include an entry for every unit — use `[]` for no-deps units (do not omit). The dependency edges — including blocking the Development milestone on all units — are emitted back as ops in Step 3; do not call `TaskUpdate(addBlockedBy)` here.

### Step 3 — Register the graph, execute returned actions

```bash
# File form (recommended — avoids OS argv size limits)
echo '{"taskIds":{...},"blockedBy":{...}}' > /tmp/ralph-graph-{SLUG}.json
bun "${CLAUDE_PLUGIN_ROOT}/scripts/ralph-state-machine.ts" \
  --plan "{plan}" --action register-task-graph \
  --data "@/tmp/ralph-graph-{SLUG}.json"

# Inline form (small payloads only)
bun "${CLAUDE_PLUGIN_ROOT}/scripts/ralph-state-machine.ts" \
  --plan "{plan}" --action register-task-graph \
  --data '{"taskIds":{...},"blockedBy":{...}}'
```

Response shape:
```jsonc
{
  "registered": { "refCount": N, "edgeCount": E },
  "actions": [
    { "type": "update_tasks", "operations": [
        { "action": "set_blocked_by", "ref": "unit:2", "blockedBy": ["unit:1"] },
        { "action": "set_blocked_by", "ref": "stage:build", "blockedBy": ["unit:1","unit:2", ...] }
    ] }
  ]
}
```

Execute every returned action via the standard **`update_tasks` handler** (same loop that processes SM-returned actions in the main orchestration loop). The `actions` key is omitted when there are no edges to emit — that's a successful no-op, not an error.

This is one atomic read-modify-write — never run a per-unit `register-task` loop after Step 3.

### Step 4 — Verify and surface drift

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/ralph-state-machine.ts" \
  --plan "{plan}" --action verify-task-graph
```

Always exits 0 (warn-and-continue). Output:
```json
{ "ok": true, "diff": { "missingRefs": [], "extraRefs": [], "mismatchedEdges": [] } }
```

If `ok: false`, **report the diff to the user verbatim** and continue — do not block the pipeline. The build runner enforces execution order from unit files, so drift is a visibility issue, not a correctness issue. Subsequent `--action next` calls will also surface drift via the `warnings: [...]` field in their JSON output; pass those warnings through to the user when they appear.

After Step 4, re-enter the main orchestration loop — the state machine now returns build actions with specific `unitId`/`unitPath` for each eligible unit.

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

   **Step 2 (create + backfill status + build payload)**: For each unit, TaskCreate with `subject` and metadata `{type: 'unit', unitId: id, slug, plan}`. Immediately reflect persisted status:
   - `done` → TaskUpdate `completed`
   - `failed` → TaskUpdate `failed`
   - `pending` → leave open

   Build the `{taskIds, blockedBy}` payload as you go. `taskIds` MUST include every unit ref. `blockedBy` MUST include an entry for every unit — use `[]` for no-deps units (do not omit). Do not call `TaskUpdate(addBlockedBy)` here; the dep edges come back as ops in Step 3.

   **Step 3 (register + execute returned actions)**: One `--action register-task-graph --data @<path>` call with the full payload. The response's `actions` array is executed via the standard `update_tasks` handler — same dispatch used for SM-returned actions in the main loop. Never run per-unit `register-task` after this.

7. **Verify and surface drift**: `--action verify-task-graph`. Report any non-empty diff to the user; do not block.

8. **Enter the main orchestration loop** — the first `--action next` call is the real one that processes actions. If its JSON includes a `warnings` field, pass those warnings through to the user.
