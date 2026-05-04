# Code Review Stage

Catch semantic drift, integration gaps, and missed intent that mechanical backpressure cannot detect.

**Standalone:** `/dev-buddy-code-review` — reads the most recent `ralph-*.md` plan file and reviews all implemented units.

**Orchestrated:** Called by `/dev-buddy-ralph` via the state machine after all units are built.

---

## Execution

This stage is orchestrated by `ralph-state-machine.ts`. When invoked:

1. **Dispatch reviewers** — load config, resolve stage+role prompts, dispatch multi-AI executors with review package (plan, unit files, git diff, review guidelines). Each reviewer gets a focused lens (security, compliance, correctness, etc.)
2. **Synthesize verdict** — collect responses, produce one of: `approved`, `needs_changes`, `rejected`
3. **Write verdict** — write `## Code Review` section with verdict to plan file
4. **Route** — `approved` advances to UAT; `needs_changes` resets affected units and loops back to build; `rejected` escalates to user

The state machine tracks review iteration count and verdict persistence. Each step above maps to a state machine action returned by:
```bash
bun "<pluginRoot>/scripts/ralph-state-machine.ts" --plan {plan} --action next
```
