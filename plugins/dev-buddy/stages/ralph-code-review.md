---
stage: ralph-code-review
description: Review all implemented units for semantic drift, integration gaps, and missed intent
tools: Read, Glob, Grep
disallowedTools: Edit
---

# Code Review Stage

## Mission

Catch semantic drift, integration gaps, and missed intent that mechanical backpressure cannot detect. This is the gate between "all units pass their tests" and "the feature actually works as intended."

## What Mechanical Backpressure Cannot Catch

- Subtle misinterpretation of requirements (code does something slightly different than asked)
- Integration gaps between units (each unit works alone but they don't work together)
- Missing edge cases not covered by unit tests
- Architectural drift (implementation diverges from patterns identified in discovery)

## Review Process

### 1. AC Tracing
For each acceptance criterion, find the implementing code:
- Cite specific file:line where the AC is implemented
- If no implementing code found → FAIL (missing implementation)
- If code exists but doesn't match AC intent → FAIL (intent mismatch)

### 2. Intent Matching
Does the code do what the AC MEANS, not just what the words say?
- Check the misinterpretation field from requirements — is the code doing the wrong thing?
- Verify the implementation serves the user's actual goal

### 3. Integration Check
Do the units work together?
- Are interfaces between units compatible?
- Is there missing glue code?
- Are there race conditions or ordering issues?

### 4. Pattern Adherence
Does the code follow existing patterns identified in discovery?
- Naming conventions respected?
- Error handling patterns followed?
- Testing patterns matched?

### 5. Edge Cases
What scenarios are NOT tested that should be?
- Error paths
- Boundary conditions
- Concurrent access
- Empty/null states

## Verdict Format

```
## Verdict: approved | needs_changes | rejected

### AC Tracing
- AC-1: PASS — implemented at src/foo.ts:42
- AC-2: FAIL — code at src/bar.ts:15 mismatches intent because {reason}

### Findings
- F-1: {finding} — Severity: {HIGH|MEDIUM|LOW}
  Affected unit: {N}
  Fix: {what to change}

### Integration Issues
- I-1: {issue between units}

### Missing Edge Cases
- E-1: {untested scenario}
```

- **approved** — all ACs traced, no high-severity findings, integration sound
- **needs_changes** — fixable issues found, specify affected units and fixes
- **rejected** — fundamental design issue, escalate to user

## Anti-Patterns

- Do NOT give "looks good" without tracing every AC to code
- Do NOT skip the intent matching step (check misinterpretation fields)
- Do NOT ignore integration between units
- Do NOT approve without checking edge cases
- Do NOT write findings without specific file:line references
