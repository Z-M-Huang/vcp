# UAT Stage (Outer Ralph Loop)

Validate the feature works from a user's perspective. Pessimistic — assume everything is broken.

**Standalone:** `/dev-buddy-uat` — reads the most recent `ralph-*.md` plan file and runs UAT.

**Orchestrated:** Called by `/dev-buddy-ralph` via the state machine after code review passes.

---

## Execution

This stage is orchestrated by `ralph-state-machine.ts`. When invoked:

1. **Run backpressure** — execute all mechanical checks (test, typecheck, lint, build) from the plan's Backpressure Commands section
2. **Run UAT tests** — execute Playwright tests or fall back to integration tests if Playwright is unavailable
3. **Evaluate** — all pass advances status to `done`; any failure resets affected units and loops back to build
4. **Write results** — record UAT results in the plan file

The state machine tracks outer iteration count and UAT pass/fail state. Each step above maps to a state machine action returned by:
```bash
bun "<pluginRoot>/scripts/ralph-state-machine.ts" --plan {plan} --action next
```
