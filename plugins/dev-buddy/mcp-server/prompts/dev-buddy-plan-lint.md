# Plan Lint Stage (§5)

Two checks run in one pass; either failing rejects the plan.

1. **Red-test check.** Runs each unit's first backpressure command against
   HEAD. A passing test (exit 0) means the feature may already exist and the
   unit plan is stale — the plan should be re-decomposed.

2. **Wiring check.** Parses each unit's Contract Manifest JSON block under
   `### Contract Manifest`. Validates that every `consumes[]` entry resolves
   to an earlier unit's `exports[]` entry with the same (symbol, module)
   pair, and that no two units claim ownership of the same export. Units
   without a manifest run in legacy mode (warning, not rejection) so existing
   free-form plans continue to work.

**Orchestrated only.** Dispatched by the Ralph pipeline between decompose-review
approval and the build phase. Not invocable directly.

---

## Execution

Run the plan-lint script:

```bash
bun "<pluginRoot>/scripts/plan-lint.ts" \
  --plan <plan-path> \
  --cwd <project-dir>
```

Read the JSON output. Three fields matter: `event`, `rejections`, `warnings`.

### Pass — both checks clean

```json
{ "event": "pass", "units": [...], "rejections": [], "warnings": [...] }
```

Update the plan file: change `**Status:** plan_lint` to `**Status:** build`.

If `warnings` is non-empty, append them to the plan file under a
`## Plan Lint Warnings` section so the operator sees the legacy-mode units
that the mechanical contract verifier will skip in the build phase.

### Reject — one or more checks failed

```json
{ "event": "reject", "rejections": [{ "unitId": N, "reason": "..." }], "warnings": [...] }
```

Rejections come from any of these sources:

- Backpressure command passes against HEAD (red-test check)
- Contract Manifest JSON malformed
- Two units claim the same `(symbol, module)` export (wiring conflict)
- A `consumes[]` entry references a forward unit (later in plan order)
- A `consumes[]` entry doesn't resolve to any unit's exports (strict mode only;
  becomes a warning in degraded mode when at least one unit is legacy)

Update the plan file: change `**Status:** plan_lint` to `**Status:** decompose`.
Append the rejection reasons (and any warnings) to the plan file so the
decompose stage can address them.
