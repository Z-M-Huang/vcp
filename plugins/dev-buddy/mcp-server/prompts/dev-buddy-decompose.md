# Decomposition Stage

Break the feature into tiny, independently testable units of work with per-unit plan files.

**Standalone:** `/dev-buddy-decompose` — reads the most recent `ralph-*.md` plan file and creates unit plans.

**Orchestrated:** Called by `/dev-buddy-ralph` via the state machine.

---

## Execution

1. **Run stage-runner script** — dispatches ALL configured executors (subscription, API, CLI) with discovery+requirements as context and synthesizes:
   ```bash
   bun "<pluginRoot>/scripts/stage-runner.ts" \
     --stage-type decomposition --plan {plan} --cwd "<projectRoot>" --task "{feature}"
   ```
   Run in background (Bash `run_in_background: true`). Poll with TaskOutput (timeout: max executor timeout + 120s).
   The script handles everything: config loading, prompt composition, parallel dispatch, output collection, synthesis. It automatically reads the `## Discovery` and `## Requirements` sections from the plan file and includes them as context for all executors.

2. **Validate** — check synthesis output against the stage's validation gates (AC coverage, no cycles, completeness, file existence, fresh-context simulation, counterexample, contract completeness, test stub quality, contract compatibility) in the main context. The orchestrator also runs a **mechanical section check** on all unit files (grep for required headings: Entropy, Acceptance Criteria, Interface Contract, Test Stubs, What to Implement, Files to Touch, Backpressure, Done When). Missing sections trigger a hard failure and decomposition re-run.

   Also run a **mechanical AC coverage check**: extract all `AC-\d+` IDs from the `## Requirements` section of the plan file, and all AC references from the unit files' `### Acceptance Criteria` sections. If any AC-N from requirements has no unit covering it, list the orphaned ACs. Write the orphaned ACs to `## Feedback` and re-run decomposition. This is a **hard failure** — every AC must appear in at least one unit.

3. **Write and hand off** — after validation passes:
   1. Print all synthesis results to the user.
   2. Create per-unit plan files under `.vcp/plan/ralph/{SLUG}/unit-{N}.md` and update the master plan's `## Units of Work` section. On re-run: **delete** all existing unit files in `.vcp/plan/ralph/{SLUG}/`, **replace** the existing `## Units of Work` section, and clear any `## Feedback` section.
   3. Set `**Status:** decompose-review` and stop. Do not advance the pipeline from this skill — the orchestrator (`/dev-buddy-ralph`) handles the approval gate and the unit-task creation on the next tick, and standalone users should decide explicitly. Print a one-line next-step hint: `Next: review unit files under .vcp/plan/ralph/{SLUG}/. Run /dev-buddy-ralph to resume orchestrated execution (with the approval gate + unit task creation), or edit ## Feedback and re-run /dev-buddy-decompose to iterate.`
