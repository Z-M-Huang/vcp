---
name: dev-buddy-discover
description: Discovery stage — multi-AI codebase and running app exploration
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent, Task, TaskOutput, TaskCreate, TaskUpdate, TaskList, TaskGet, AskUserQuestion
---

# Discovery Stage

Explore the codebase and running application to understand what exists before making changes.

**Standalone:** `/dev-buddy-discover` — finds the most recent `ralph-*.md` plan file and appends findings.

**Orchestrated:** Called by `/dev-buddy-ralph` via the state machine.

---

## Execution

1. **Run stage-runner script** — dispatches ALL configured executors (subscription, API, CLI) and synthesizes:
   ```bash
   bun "${CLAUDE_PLUGIN_ROOT}/scripts/stage-runner.ts" \
     --stage-type discovery --plan {plan} --cwd "${CLAUDE_PROJECT_DIR}" --task "{feature}"
   ```
   Run in background (Bash `run_in_background: true`). Poll with TaskOutput (timeout: max executor timeout + 120s).
   The script handles everything: config loading, prompt composition, parallel dispatch, output collection, synthesis.

2. **Validate** — check synthesis output against the stage's validation gates (area coverage, cross-executor agreement, contradictions, counterexample) in the main context.

3. **Present and approve** — after validation passes:
   1. Print all synthesis results to the user
   2. **MUST call AskUserQuestion** with options `['approve', 'request changes']`
   3. **On approval:** write `## Discovery` section to plan file
      - **Orchestrated** (via `/dev-buddy-ralph`): set `**Status:** discover-review`
      - **Standalone** (direct `/dev-buddy-discover`): set `**Status:** requirements`
   4. **On rejection:** collect specific feedback via AskUserQuestion. Write feedback to `## Feedback` section (create or replace). Re-run from step 1 — `stage-runner.ts` reads `## Feedback` and injects it as context for all executors.
   - On rerun: **replace** existing `## Discovery` section and clear `## Feedback` section if present.
