---
name: dev-buddy-requirements
description: Requirements + UAT design stage — acceptance criteria and Playwright test scenario authoring
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent, Task, TaskOutput, TaskCreate, TaskUpdate, TaskList, TaskGet, AskUserQuestion
---

# Requirements + UAT Design Stage

Define what "done" looks like — acceptance criteria in Given/When/Then format plus executable UAT scenarios.

**Standalone:** `/dev-buddy-requirements` — reads the most recent `ralph-*.md` plan file and appends requirements.

**Orchestrated:** Called by `/dev-buddy-ralph` via the state machine.

---

## Execution

1. **Run stage-runner script** — dispatches ALL configured executors (subscription, API, CLI) with discovery findings as context and synthesizes:
   ```bash
   bun "${CLAUDE_PLUGIN_ROOT}/scripts/stage-runner.ts" \
     --stage-type ralph-requirements --plan {plan} --cwd "${CLAUDE_PROJECT_DIR}" --task "{feature}"
   ```
   Run in background (Bash `run_in_background: true`). Poll with TaskOutput (timeout: max executor timeout + 120s).
   The script handles everything: config loading, prompt composition, parallel dispatch, output collection, synthesis. It automatically reads the `## Discovery` section from the plan file and includes it as context for all executors.

2. **Validate** — check synthesis output against the stage's validation gates (completeness, misinterpretation, mapping, edge cases, traceability, counterexample) in the main context.

   Also run a **mechanical format check** on the synthesis output — grep for `### AC-\d+:` and `### UAT-\d+:` headings. **Both must appear at least once.** If either is missing, the output format is wrong — do NOT proceed. Write `## Feedback` with: "Output must use `### AC-N: Title` H3 headings for ACs and `### UAT-N: Title` for UATs. Do NOT use bold text, bullets, or workstream-prefixed numbering (AC-1.1). Use flat sequential numbering (AC-1, AC-2, AC-3)." Re-run from step 1.

3. **Present and approve** — after validation passes:
   1. Print all synthesis results to the user
   2. **MUST call AskUserQuestion** with options `['approve', 'request changes']`
   3. **On approval:** write `## Requirements` section to plan file
      - **Orchestrated** (via `/dev-buddy-ralph`): set `**Status:** requirements-review`
      - **Standalone** (direct `/dev-buddy-requirements`): set `**Status:** decompose`
   4. **On rejection:** collect specific feedback via AskUserQuestion. Write feedback to `## Feedback` section (create or replace). Re-run from step 1 — `stage-runner.ts` reads `## Feedback` and injects it as context for all executors.
   - On rerun: **replace** existing `## Requirements` section and clear `## Feedback` section if present.
