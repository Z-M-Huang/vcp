---
stage: decomposition
description: Break feature into small independently testable units of work with dependency ordering
tools: Read, Glob, Grep
---

# Decomposition Stage

## Mission

Break the feature into tiny, independently testable units of work. Each unit becomes its own plan file that an implementer reads in fresh context.

## Decomposition Rules

1. **Small scope:** Each unit should be ~50 lines of production code max
2. **AC mapping:** Each unit maps to at least one acceptance criterion
3. **Independent testability:** Each unit has specific backpressure (tests that validate just this unit)
4. **No forward references:** Each unit is completable without future units existing
5. **Dependency ordering:** Units are ordered by dependency (unit 2 can depend on unit 1, not vice versa)
6. **First unit:** Write the UAT Playwright test files (red — they should fail initially, TDD-style)
7. **Last unit:** Integration glue if needed

## Output Format

For each unit, produce:

```
## Unit {N}: {Title}

### Acceptance Criteria
- AC-X: {from master plan}

### What to Implement
{Precise instructions — no design decisions left for the implementer}
{What the app currently looks like (from discovery)}
{What it should look like after (from requirements)}

### Discovered Context
{Relevant findings from discovery — existing patterns, files that handle similar concerns, architectural constraints}

### Files to Touch
- `src/foo.ts` — why and what to change
- `tests/foo.test.ts` — what to test

### Backpressure
- Unit tests: `{specific test command for this unit}`
- Full: typecheck + lint commands

### Dependencies
- Depends on: Unit {M} (if any)
- Required by: Unit {P} (if any)

### Done When
All listed backpressure commands pass
```

## Quality Checklist

Before completing, verify:
- [ ] Every AC maps to at least one unit
- [ ] Every unit maps to at least one AC
- [ ] No unit exceeds ~50 LOC of production code
- [ ] Each unit has specific test commands (not just "run all tests")
- [ ] Dependencies form a DAG (no cycles)
- [ ] First unit is the UAT test scaffolding
- [ ] Each unit includes discovered context from the discovery stage

## Anti-Patterns

- Do NOT create large monolithic units ("implement the whole feature")
- Do NOT leave design decisions for the implementer
- Do NOT create units without specific backpressure commands
- Do NOT create circular dependencies between units
- Do NOT skip discovered context — the implementer needs it for fresh-context work
