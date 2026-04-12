---
name: dev-buddy-decompose
description: Decomposition stage — break features into small, independently testable units of work
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent, Task, TaskOutput, TaskCreate, TaskUpdate, TaskList, TaskGet, AskUserQuestion
---

# Decomposition Stage

Break the feature into tiny, independently testable units of work with per-unit plan files.

**Standalone:** `/dev-buddy-decompose` — reads the most recent `ralph-*.md` plan file and creates unit plans.

**Orchestrated:** Called by `/dev-buddy-ralph` via the state machine.

---

## Execution

1. **Run stage-runner script** — dispatches ALL configured executors (subscription, API, CLI) with discovery+requirements as context and synthesizes:
   ```bash
   bun "${CLAUDE_PLUGIN_ROOT}/scripts/stage-runner.ts" \
     --stage-type decomposition --plan {plan} --cwd "${CLAUDE_PROJECT_DIR}" --task "{feature}"
   ```
   Run in background (Bash `run_in_background: true`). Poll with TaskOutput (timeout: max executor timeout + 120s).
   The script handles everything: config loading, prompt composition, parallel dispatch, output collection, synthesis. It automatically reads the `## Discovery` and `## Requirements` sections from the plan file and includes them as context for all executors.

2. **Validate** — check synthesis output against the stage's validation gates (AC coverage, no cycles, completeness, file existence, fresh-context simulation, counterexample, contract completeness, test stub quality, contract compatibility) in the main context. The orchestrator also runs a **mechanical section check** on all unit files (grep for required headings: Entropy, Acceptance Criteria, Interface Contract, Test Stubs, What to Implement, Files to Touch, Backpressure, Done When). Missing sections trigger a hard failure and decomposition re-run.

   Also run a **mechanical AC coverage check**: extract all `AC-\d+` IDs from the `## Requirements` section of the plan file, and all AC references from the unit files' `### Acceptance Criteria` sections. If any AC-N from requirements has no unit covering it, list the orphaned ACs. Write the orphaned ACs to `## Feedback` and re-run decomposition. This is a **hard failure** — every AC must appear in at least one unit.

3. **Present and approve** — after validation passes:
   1. Print all synthesis results to the user
   2. **MUST call AskUserQuestion** with options `['approve', 'request changes']`
   3. **On approval:** create per-unit plan files under `.vcp/plan/ralph/{SLUG}/unit-{N}.md`, update master plan `## Units of Work` section
      - **Orchestrated** (via `/dev-buddy-ralph`): set `**Status:** decompose-review`
      - **Standalone** (direct `/dev-buddy-decompose`): set `**Status:** build`
   4. **On rejection:** collect specific feedback via AskUserQuestion. Write feedback to `## Feedback` section (create or replace). Re-run from step 1 — `stage-runner.ts` reads `## Feedback` and injects it as context for all executors.
   - On rerun: **delete** all existing unit files in `.vcp/plan/ralph/{SLUG}/`, **replace** existing `## Units of Work` section, and clear `## Feedback` section if present.
