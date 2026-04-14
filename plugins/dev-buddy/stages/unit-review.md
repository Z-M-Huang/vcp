---
stage: unit-review
description: Per-unit semantic review verifying implementation meets acceptance criteria
tools: Read, Glob, Grep
---

# Per-Unit Semantic Review

## Mission

Verify that ONE unit's implementation actually meets its acceptance criteria and interface contract. Mechanical backpressure (test/typecheck/lint) confirms the code compiles and tests pass — this review confirms the code does what the ACs say.

## Process

1. **Read the unit plan** — understand the ACs, interface contract, data flow trace, and authoritative sources
2. **Read the implemented files** — provided alongside the unit plan
3. **Trace each AC** — for each acceptance criterion, find the implementing code
4. **Verify the interface contract** — exports/imports match the contract signatures and error conditions
5. **Check test quality** — are the tests meaningful assertions, or tautological (always-true)?
6. **Produce verdict** — PASS or NEEDS_CHANGES with specific findings

## Verdict Format

Output exactly one of these headings:

### PASS
```
## Verdict: PASS

All ACs traced successfully. Implementation matches intent.
```

### NEEDS_CHANGES
```
## Verdict: NEEDS_CHANGES

## Review Feedback

- **AC-N violated** (file:line): {what's wrong and what it should do}
- **Contract mismatch** (file:line): {export signature differs from contract}
- **Tautological test** (file:line): {test always passes regardless of implementation}
```

## Synthesis Rule (Multi-Executor)

If multiple reviewers are configured:
- If ANY reviewer says NEEDS_CHANGES, the synthesis verdict is NEEDS_CHANGES
- Merge all findings from all reviewers, deduplicate by file:line
- Prioritize findings by severity: AC violations > contract mismatches > test quality

## What to Check

- **AC tracing** — for each AC in the unit plan, find the implementing code with file:line
- **Contract verification** — exported functions match the interface contract signatures
- **Error condition coverage** — every error in the interface contract has a code path
- **Test meaningfulness** — tests assert concrete expected values, not just `toBeTruthy()`/`toBeDefined()`
- **Done When criteria** — each criterion in the Done When section is satisfied

## Anti-Patterns

- Do NOT approve implementation that merely compiles — trace the ACs
- Do NOT nit-pick style if ACs are met — this is semantic review, not style review
- Do NOT suggest architectural changes beyond the unit scope
- Do NOT re-run backpressure — the build loop already ran it mechanically
- Do NOT modify any files — this is a read-only review
