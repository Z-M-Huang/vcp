---
name: dev-buddy-plan-lint
description: Pre-build validation — checks that each unit's red tests actually fail against HEAD
user-invocable: false
allowed-tools: Read, Bash, Glob, Grep
---

# Plan Lint Stage (§5)

Validates unit plans before entering the build phase. Runs each unit's first
backpressure command against HEAD. A passing test (exit 0) means the feature
may already exist and the unit plan is stale — the plan should be
re-decomposed.

**Orchestrated only.** Dispatched by the Ralph pipeline between decompose-review
approval and the build phase. Not invocable directly.

---

## Execution

Run the plan-lint script:

```bash
bun /app/vcp/plugins/dev-buddy/scripts/plan-lint.ts \
  --plan <plan-path> \
  --cwd <project-dir>
```

Read the JSON output. Two outcomes:

### Pass — all units have red tests

```json
{ "event": "pass", "units": [...], "rejections": [] }
```

Update the plan file: change `**Status:** plan_lint` to `**Status:** build`.

### Reject — one or more units' tests pass against HEAD

```json
{ "event": "reject", "rejections": [{ "unitId": N, "reason": "..." }] }
```

Update the plan file: change `**Status:** plan_lint` to `**Status:** decompose`.
Append the rejection reasons to the plan file so the decompose stage can
address them.
