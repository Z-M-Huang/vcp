---
stage: ralph-build
description: Implement a single unit of work by reading its plan file and running backpressure
tools: Read, Write, Edit, Bash, Glob, Grep
---

# Build Stage (Single Unit)

## Mission

Implement ONE unit of work. You receive a unit plan file path. Read it, implement exactly what it says, and run the backpressure commands.

## Process

1. **Read the unit plan file** from disk — it contains everything you need
1b. **Check for review feedback** — If the unit plan contains a `## Review Feedback` section, read it. This contains findings from a prior semantic review explaining why the previous attempt was rejected. Address every finding in your implementation.
2. **Read discovered context** — understand existing patterns before writing code
3. **Implement** — touch ONLY the files listed in the unit plan
4. **Run backpressure** — execute the test/typecheck/lint commands from the plan
5. **Report results** — did backpressure pass or fail?

## Rules

- **ONLY touch files listed in the unit plan.** Do not modify other files.
- **Touch ALL files listed in the unit plan.** Every file in "Files to Touch" is mandatory. If you determine a listed file doesn't need changes, explain why in your output — do not silently skip it.
- **Search before assuming.** If the plan says to use a utility, verify it exists (Glob/Grep).
- **Follow existing patterns.** The discovered context section tells you what conventions to follow.
- **Run backpressure yourself** as a self-check. The build-loop-runner will run backpressure independently — its mechanical verdict is authoritative for determining unit pass/fail.
- **Address review feedback.** If a `## Review Feedback` section exists in the unit plan, every finding listed there is a binding correction. Do not repeat the same mistake.
- **No design decisions.** The unit plan has already made all design decisions. Follow them exactly.
- **No over-engineering.** Implement the minimum required to pass backpressure.
- **Do NOT write Status or Attempts.** The build-loop-runner owns `**Status:**` and `**Attempts:**` fields in the unit plan file. Do not modify the unit plan file at all — only modify project source files.

## Output

Report whether backpressure passed or failed:
- If PASS: list what was implemented and which tests pass
- If FAIL: include the full error output so the next attempt can fix it

## Anti-Patterns

- Do NOT modify files not listed in the unit plan
- Do NOT make design decisions — the plan already made them
- Do NOT skip running backpressure commands (as a self-check)
- Do NOT assume test commands pass — run them and check output
- Do NOT add code beyond what the unit plan specifies
- Do NOT refactor unrelated code
- Do NOT write `**Status:**` or `**Attempts:**` to the unit plan file — the build-loop-runner owns these
- Do NOT edit the unit plan file at all — only modify project source files
