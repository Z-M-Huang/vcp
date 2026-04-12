---
stage: decomposition
description: Break feature into small independently testable units of work with dependency ordering
tools: Read, Glob, Grep
---

# Decomposition Stage

## Mission

Break the feature into tiny, independently testable units of work. Each unit becomes its own plan file that an implementer reads in fresh context.

## Constraints

- **READ-ONLY stage.** You MUST NOT create, modify, or delete any files.
- Do NOT use Write, Edit, or Bash tools. You only have access to: Read, Glob, Grep.
- Do NOT make code changes, create files, run commands, install packages, or modify configuration.
- Do NOT update the plan file — the orchestrator handles plan updates.
- Your ONLY job is to produce analysis/output text. The orchestrator writes it to the plan.

## Decomposition Rules

1. **Small units, full coverage:** Each unit should be ~50 lines of production code max — create as many units as needed to cover ALL acceptance criteria
2. **AC mapping:** Each unit maps to at least one acceptance criterion
3. **Independent testability:** Each unit has specific backpressure (tests that validate just this unit)
4. **No forward references:** Each unit is completable without future units existing
5. **Dependency ordering:** Units are ordered by dependency (unit 2 can depend on unit 1, not vice versa)
6. **First unit:** Write the UAT Playwright test files (red — they should fail initially, TDD-style)
7. **Last unit:** Integration glue if needed

## Output Format

For each unit, produce ALL sections below. No section may be omitted.

```
## Unit {N}: {Title}

### Entropy
{LOW | MED | HIGH}
- LOW: Pure transformation, CRUD, single-function — weak model can implement from contract alone
- MED: Business logic, state management, multiple branches — needs contract + test stubs
- HIGH: Novel algorithm, security-critical, integration-heavy — needs full oracle stack

### Acceptance Criteria
- AC-X: {copy exact AC text from master plan, including Given/When/Then}

### Interface Contract
Define the PUBLIC interface this unit exposes or modifies. This is what dependent units and tests code against.

- **Function signatures:**
  ```typescript
  function exampleFn(input: InputType): ResultType
  ```
- **Pre-conditions:** {what must be true before calling — e.g., "input.email is non-empty string"}
- **Post-conditions:** {what is guaranteed after — e.g., "returns Result with valid user or ValidationError"}
- **Error conditions:** {enumerated error cases — e.g., "throws InvalidEmail | DuplicateUser | DatabaseError"}
- **Side effects:** {what external state changes — e.g., "writes row to users table" or "none (pure function)"}

If the unit modifies an existing interface, show BEFORE and AFTER signatures.

### Data Flow Trace
For any AC that involves data moving through multiple components, document the
complete path from trigger to final effect:

- **Trigger:** {what initiates the flow — user action, API call, event, cron}
- **Path:**
  1. `src/triggers/engine.ts:fireTrigger()` — receives {data}, passes to step 2
  2. `src/sessions/task-consumer.ts:handleMessage()` — receives {data}, passes to step 3
  ...
- **Data threaded:** {field names and types that must pass through each hop}

If this unit adds a new field/parameter, list EVERY function in the path whose
signature must be updated. If the path crosses into another unit's territory,
cite the dependency.

Skip this section for units that are self-contained (single file, no cross-component data flow).

### Authoritative Sources
List authoritative documents whose constraints bind this unit:

- **Source:** {ADR, wiki page, API spec — path or URL}
- **Binding constraint:** {what the source requires or prohibits}
- **AC alignment:** {which AC reflects this constraint}

Source precedence when conflicts arise:
`ADR > contract tests/specs > API docs/wiki > README/AGENTS.md`

Skip this section if discovery found no relevant authoritative documents for this unit.

### Test Stubs
Executable test assertions the implementer MUST make pass. These are concrete input→output examples, not descriptions.

```typescript
// test file: tests/example.test.ts
describe('exampleFn', () => {
  it('returns valid user for well-formed input', () => {
    const result = exampleFn({ email: 'a@b.com', name: 'Test' });
    expect(result.ok).toBe(true);
    expect(result.value.email).toBe('a@b.com');
  });

  it('returns InvalidEmail for empty email', () => {
    const result = exampleFn({ email: '', name: 'Test' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('InvalidEmail');
  });
});
```

Stubs must cover: happy path, each error condition, and at least one edge case.

### What to Implement
- **Current state:** {what the code/app looks like now — from discovery findings}
- **Target state:** {what it should look like after — from requirements/ACs}
- **Changes:** {specific functions, components, or changes to make — no design decisions left for implementer}

### Discovered Context
{Relevant findings from discovery — cite F-N IDs, include file:line refs, existing patterns, API signatures, architectural constraints}

### Files to Touch
- `src/foo.ts` -- existing | modify -- {why and what to change}
- `tests/foo.test.ts` -- new | create -- {what to test}

### Backpressure
- Unit tests: `{specific test command for this unit}`
- Typecheck: `{typecheck command}`
- Lint: `{lint command}`

### Dependencies
- Depends on: Unit {M} (if any)
- Required by: Unit {P} (if any)

### Done When
All backpressure commands pass AND all test stubs pass
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
- [ ] Every unit has an Interface Contract with typed signatures and error conditions
- [ ] Every unit has executable Test Stubs covering happy path + error cases
- [ ] Every unit has an Entropy rating (LOW/MED/HIGH)
- [ ] Interface Contracts between dependent units are compatible (Unit B's inputs match Unit A's outputs)
- [ ] Units with cross-component ACs (referencing ≥2 source files) have a Data Flow Trace
- [ ] Units referencing ADRs/wiki/specs have an Authoritative Sources block
- [ ] ACs are copied as full Given/When/Then text, not just AC-N IDs

## Anti-Patterns

- Do NOT create large monolithic units ("implement the whole feature")
- Do NOT leave design decisions for the implementer — the contract IS the design
- Do NOT create units without specific backpressure commands
- Do NOT create circular dependencies between units
- Do NOT skip discovered context — the implementer needs it for fresh-context work
- Do NOT write vague contracts — "takes input and returns output" is not a contract
- Do NOT write test stubs without concrete assertions — `expect(result).toBeTruthy()` is not a stub
- Do NOT leave error conditions as "throws Error" — enumerate specific error types
- Do NOT reduce the number of units to "keep things simple" — if the scope requires 20 units, produce 20 units
- Do NOT drop ACs during decomposition — every AC from requirements must appear in at least one unit
- Do NOT create, modify, or delete any files — this is a read-only analysis stage
- Do NOT run shell commands — you do not have Bash access
