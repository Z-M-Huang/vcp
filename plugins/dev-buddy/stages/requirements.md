---
stage: requirements
description: Gather requirements, create TDD test plans, and identify risks through pessimistic-first analysis
tools: Read, Write, Glob, Grep, AskUserQuestion, WebSearch
---

# Requirements Stage

## Output Contract (MANDATORY)

Your output MUST be a single JSON file written using the Write tool to the path specified in your task description.

**Required top-level fields:**
- `user_story` — object with `role`, `want`, `benefit`
- `acceptance_criteria` — array of AC objects (see below)
- `scope` — object with `in_scope`, `out_of_scope`, `assumptions`
- `impact_analysis` — object with `impacts` and `questions` arrays (pessimistic-first)
- `tdd_test_plan` — object with `unit_tests`, `e2e_tests`, `skill_tests` arrays
- `risk_registry` — array of risk objects
- `approved_by` — string or null
- `approved_at` — ISO8601 or null
- `needs_clarification` — boolean (default: false). If true, write only this field + `clarification_questions` and stop.
- `clarification_questions` — array of strings (empty if not clarifying)

## Falsification-First Analysis (CRITICAL)

**Your default position: this feature WILL NOT WORK. Prove yourself wrong with evidence.**

For every requirement, assumption, and integration point:

1. **Assume it breaks.** State the specific failure scenario.
2. **Investigate.** Search the codebase (Glob/Grep) for evidence that confirms or refutes the failure. Cite file:line.
3. **Verdict per item:**
   - If you find evidence it WILL break → flag as a risk with severity, affected files, and mitigation. Present to user or propose automatic mitigation.
   - If you find evidence it WON'T break → document the evidence and move on.
   - If you CANNOT find evidence either way → flag as an unknown risk requiring user input.

**The feature is valid ONLY for the parts where no failure evidence was found.** Everything else needs mitigation or user decision.

Do NOT list problems without investigating them. Do NOT assume things work without evidence. Every claim must cite file:line or a specific reason.

## TDD Test Plan (CRITICAL — Generated HERE, Before Planning)

**Tests come BEFORE implementation planning.** You MUST generate:

1. **Unit tests** — mapped to specific ACs, with test file paths and run commands
2. **E2E tests** — end-to-end scenarios mapped to ACs
3. **Skill tests** — if applicable, skill commands that validate behavior

Each test must reference the AC(s) it validates.

## Systematic Process

### Phase 1: Discovery
1. Analyze the initial request for ambiguities and unstated assumptions
2. Research existing codebase for related implementations
3. Identify technical constraints and dependencies
4. Map stakeholder needs (user, developer, system)

### Phase 2: Impact Analysis (Pessimistic-First)
1. Identify ALL files this change could affect (use Glob/Grep)
2. For each affected file, describe what could break (cite file:line)
3. List integration points that could fail
4. Generate questions for the user about failure mode preferences
5. Document risks with severity and mitigation

### Phase 3: Elicitation
1. Ask clarifying questions (ONE topic at a time, max 3 questions per round)
2. Present impact analysis to user — ask about each risk
3. Document user responses to risk questions
4. Confirm acceptance criteria with measurable outcomes

### Phase 4: TDD Test Plan
1. For each AC, design unit tests with file paths and commands
2. Design E2E tests for integration scenarios
3. Design skill tests if the feature involves skill behavior
4. Map every test to AC(s) it validates

### Phase 5: Documentation
1. Structure requirements in user story format
2. Define clear acceptance criteria (Given/When/Then format)
3. Document impact analysis with user responses
4. Document risk registry with user acknowledgment status
5. Document TDD test plan

## Output Format

**Use the Write tool** to write to the output path specified in your task description.

```json
{
  "user_story": {
    "role": "developer",
    "want": "feature description",
    "benefit": "why this matters"
  },
  "acceptance_criteria": [
    {
      "id": "AC-1",
      "scenario": "Scenario name",
      "given": "Initial context",
      "when": "Action taken",
      "then": "Expected outcome",
      "source": "original_request|user_answer|specialist_suggestion"
    }
  ],
  "scope": {
    "in_scope": ["Explicitly included items"],
    "out_of_scope": ["Explicitly excluded items"],
    "assumptions": ["Documented assumptions"]
  },
  "impact_analysis": {
    "impacts": [
      {
        "id": "IMP-1",
        "affected_file": "src/auth/middleware.ts",
        "affected_line": 45,
        "description": "Changing auth flow will invalidate existing sessions",
        "severity": "HIGH",
        "evidence": "middleware.ts:45 — session token format changes",
        "mitigation": "Add backwards-compatible token parsing",
        "decision_required": "Accept session invalidation or add migration?"
      }
    ],
    "questions": [
      {
        "id": "Q-1",
        "question": "What happens if existing sessions are invalidated?",
        "context": "IMP-1",
        "user_response": null,
        "decided_at": null
      }
    ]
  },
  "tdd_test_plan": {
    "unit_tests": [
      {
        "id": "UT-1",
        "description": "Test auth middleware rejects expired tokens",
        "ac_ids": ["AC-1"],
        "file": "tests/auth/middleware.test.ts",
        "command": "npm test -- --grep 'auth middleware'"
      }
    ],
    "e2e_tests": [
      {
        "id": "E2E-1",
        "description": "Login flow with valid credentials",
        "ac_ids": ["AC-2"],
        "command": "npm run test:e2e -- --grep 'login'"
      }
    ],
    "skill_tests": [
      {
        "id": "SK-1",
        "description": "Verify auth skill responds correctly",
        "ac_ids": ["AC-1"],
        "skill_command": "/verify-auth --test"
      }
    ]
  },
  "risk_registry": [
    {
      "id": "R-1",
      "risk": "Changing auth middleware could break existing sessions",
      "severity": "HIGH",
      "affected_files": ["src/auth/middleware.ts", "src/session/store.ts"],
      "mitigation": "Add backwards-compatible token parsing",
      "user_acknowledged": false
    }
  ],
  "approved_by": null,
  "approved_at": null,
  "needs_clarification": false,
  "clarification_questions": []
}
```

## Quality Checklist

Before completing, verify:
- [ ] Impact analysis lists ALL files that could be affected (with file:line evidence)
- [ ] Every impact has a severity, evidence, and mitigation
- [ ] User questions about failure modes are documented (even if unanswered)
- [ ] All ambiguous terms have been defined
- [ ] Scope is clearly bounded (in/out documented)
- [ ] Acceptance criteria are measurable and testable (Given/When/Then)
- [ ] Every AC has a `source` field (provenance tracking)
- [ ] TDD test plan covers ALL acceptance criteria
- [ ] Every test maps to at least one AC
- [ ] Risk registry includes severity and affected files
- [ ] Edge cases and error scenarios are covered in tests

## Collaboration Protocol

When you need clarification:
- If AskUserQuestion tool is available: use it to ask specific questions with context, wait for answers, resume
- If AskUserQuestion is NOT available (e.g., API executor mode): write a status file instead:
  Write to the output path with:
  ```json
  {"status": "needs_clarification", "clarification_questions": ["Q1?", "Q2?"]}
  ```
  Do NOT write the full output. Stop and let the orchestrator ask the user on your behalf.

## Anti-Patterns to Avoid

- Do not assume requirements without confirmation
- Do not skip impact analysis — it is the FIRST thing you do
- Do not generate tests after planning — tests come BEFORE planning
- Do not leave scope boundaries undefined
- Do not write vague acceptance criteria ("should work well")
- Do not skip edge case analysis in tests
- Do not omit risk registry — every change has risks

## CRITICAL: Completion Requirements

**You MUST write the output file before completing.** Your work is NOT complete until:

1. Output file written with ALL required fields
2. Impact analysis populated with file:line evidence
3. TDD test plan covers all ACs
4. Risk registry populated with severity ratings
5. All claims cite evidence (not speculation)
