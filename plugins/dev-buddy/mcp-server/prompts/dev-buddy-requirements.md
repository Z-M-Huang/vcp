# Requirements + UAT Design Stage

Define what "done" looks like — acceptance criteria in Given/When/Then format plus executable UAT scenarios.

**Standalone:** `/dev-buddy-requirements` — reads the most recent `ralph-*.md` plan file and appends requirements.

**Orchestrated:** Called by `/dev-buddy-ralph` via the state machine.

---

## Execution

1. **Run stage-runner script** — dispatches ALL configured executors (subscription, API, CLI) with discovery findings as context and synthesizes:
   ```bash
   bun "<pluginRoot>/scripts/stage-runner.ts" \
     --stage-type ralph-requirements --plan {plan} --cwd "<projectRoot>" --task "{feature}"
   ```
   Run in background (Bash `run_in_background: true`). Poll with TaskOutput (timeout: max executor timeout + 120s).
   The script handles everything: config loading, prompt composition, parallel dispatch, output collection, synthesis. It automatically reads the `## Discovery` section from the plan file and includes it as context for all executors.

2. **Validate** — check synthesis output against the stage's validation gates (completeness, misinterpretation, mapping, edge cases, traceability, counterexample) in the main context.

   Also run a **mechanical format check** on the synthesis output — grep for `### AC-\d+:` and `### UAT-\d+:` headings. **Both must appear at least once.** If either is missing, the output format is wrong — do NOT proceed. Write `## Feedback` with: "Output must use `### AC-N: Title` H3 headings for ACs and `### UAT-N: Title` for UATs. Do NOT use bold text, bullets, or workstream-prefixed numbering (AC-1.1). Use flat sequential numbering (AC-1, AC-2, AC-3)." Re-run from step 1.

   Also run a **mechanical traceability check**: extract all `F-\d+` IDs from the `## Discovery` section of the plan file, and all `Discovery refs:` values from the synthesis ACs. If any F-N from discovery has no corresponding AC referencing it, list the orphaned findings in the validation output. Include this list when presenting results to the user at the checkpoint — the user can then decide whether to approve (some findings may genuinely not need ACs) or request changes to cover them.

3. **Write and hand off** — after validation passes:
   1. Print all synthesis results to the user (include the orphaned-findings list from step 2 if any).
   2. Write the `## Requirements` section to the plan file. On re-run: **replace** any existing `## Requirements` section and clear any `## Feedback` section.
   3. Set `**Status:** requirements-review` and stop. Do not advance the pipeline from this skill — the orchestrator (`/dev-buddy-ralph`) handles the approval gate on the next tick, and standalone users should decide explicitly. Print a one-line next-step hint: `Next: review ## Requirements in the plan file. Run /dev-buddy-ralph to resume orchestrated execution (with the approval gate), /dev-buddy-decompose to proceed standalone, or edit ## Feedback and re-run /dev-buddy-requirements to iterate.`
