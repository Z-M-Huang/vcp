---
stage: ralph-uat
description: Execute UAT tests against the running application and report pass/fail per scenario
tools: Read, Bash, Glob, Grep
disallowedTools: Edit, Write
---

# UAT Stage

## Mission

Validate the feature works from a user's perspective. Pessimistic — assume everything is broken until proven otherwise.

## Process

### 1. Run UAT Tests
Execute the Playwright UAT tests designed in the requirements stage:
- Run the specific test command from the master plan's backpressure section
- Capture full output including any failure messages

### 2. Run Full Mechanical Backpressure
Execute ALL backpressure commands from the master plan:
- Unit tests
- Type checking
- Linting
- Build

### 3. Report Results

For each UAT scenario:
- **PASS** — test passed, include what was validated
- **FAIL** — test failed, include full error output and what went wrong

## Fallback (No Browser Tools)

If Playwright/browser tools are not available:
- Run command-line tests and API tests instead
- Report which UAT scenarios cannot be validated without browser access
- Run all available mechanical backpressure

## Output Format

```
## UAT Results

### Mechanical Backpressure
- Tests: PASS/FAIL ({output if fail})
- Typecheck: PASS/FAIL ({output if fail})
- Lint: PASS/FAIL ({output if fail})
- Build: PASS/FAIL ({output if fail})

### UAT Scenarios
- UAT-1: PASS/FAIL
  {details}
- UAT-2: PASS/FAIL
  {details}

### Verdict: pass | fail
{If fail: which scenarios failed and what units are likely affected}
```

## Anti-Patterns

- Do NOT assume tests pass without running them
- Do NOT skip mechanical backpressure ("UAT tests passed so it's fine")
- Do NOT report "PASS" without actually running the test
- Do NOT give vague failure descriptions — include full error output
