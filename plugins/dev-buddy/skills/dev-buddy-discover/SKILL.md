---
name: dev-buddy-discover
description: Discovery stage — multi-AI codebase and running app exploration
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent, Task, TaskOutput, TaskCreate, TaskUpdate, TaskList, TaskGet
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

3. **Write and hand off** — after validation passes:
   1. Print all synthesis results to the user.
   2. Write the `## Discovery` section to the plan file. On re-run: **replace** any existing `## Discovery` section and clear any `## Feedback` section.
   3. Set `**Status:** discover-review` and stop. Do not advance the pipeline from this skill — the orchestrator (`/dev-buddy-ralph`) handles the approval gate on the next tick, and standalone users should decide explicitly. Print a one-line next-step hint: `Next: review ## Discovery in the plan file. Run /dev-buddy-ralph to resume orchestrated execution (with the approval gate), /dev-buddy-requirements to proceed standalone, or edit ## Feedback and re-run /dev-buddy-discover to iterate.`
