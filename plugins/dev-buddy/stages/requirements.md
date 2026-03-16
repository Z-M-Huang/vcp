---
stage: requirements
description: Gather and document requirements through structured elicitation and user story development
tools: Read, Write, Glob, Grep, AskUserQuestion, WebSearch
---

# Requirements Stage

## Output Contract (MANDATORY)

Your output MUST be 4 separate JSON files written in this order. The manifest file MUST be written LAST to signal completion.

**Required files:**
- `.vcp/task/user-story/meta.json` — story metadata
- `.vcp/task/user-story/acceptance-criteria.json` — testable acceptance criteria
- `.vcp/task/user-story/scope.json` — scope boundaries and assumptions
- `.vcp/task/user-story/manifest.json` — manifest (written LAST, signals completion)

**Required fields per file — see Output Format section below.**

## Standard Mode (No Specialist Analyses)

### Phase 1: Discovery
1. Analyze the initial request for ambiguities and unstated assumptions
2. Research existing codebase for related implementations
3. Identify technical constraints and dependencies
4. Map stakeholder needs (user, developer, system)

### Phase 2: Elicitation
1. Ask clarifying questions (ONE topic at a time, max 3 questions per round)
2. Validate understanding with concrete examples
3. Explore edge cases and error scenarios
4. Confirm acceptance criteria with measurable outcomes

### Phase 3: Documentation
1. Structure requirements in user story format
2. Define clear acceptance criteria (Given/When/Then format)
3. Document assumptions and decisions made
4. Identify test scenarios for TDD

## Output Format

Write each section as a separate file using the Write tool, in this order:

1. **Write `.vcp/task/user-story/meta.json`**
```json
{
  "id": "story-YYYYMMDD-HHMMSS",
  "title": "Concise feature title",
  "description": "User story in As a/I want/So that format",
  "questions_resolved": ["List of clarified questions"],
  "vcp_standards_referenced": []
}
```

2. **Write `.vcp/task/user-story/acceptance-criteria.json`**

Each AC MUST include a `source` field for provenance tracking (anti-drift):
```json
[
  {
    "id": "AC1",
    "scenario": "Scenario name",
    "given": "Initial context",
    "when": "Action taken",
    "then": "Expected outcome",
    "source": "original_request|user_answer|specialist_suggestion"
  }
]
```

3. **Write `.vcp/task/user-story/scope.json`**

Suggestions beyond the original request go to `candidate_additions` — NOT into ACs or `in_scope`:
```json
{
  "in_scope": ["Explicitly included items"],
  "out_of_scope": ["Explicitly excluded items"],
  "assumptions": ["Documented assumptions"],
  "candidate_additions": ["Items suggested by analysis that need explicit user approval before becoming ACs"]
}
```

4. **Write `.vcp/task/user-story/manifest.json` (LAST — signals completion)**
```json
{
  "artifact": "user-story",
  "format_version": "3.0",
  "id": "story-YYYYMMDD-HHMMSS",
  "title": "Concise feature title",
  "description": "User story in As a/I want/So that format",
  "ac_count": 5,
  "sections": {
    "meta": "meta.json",
    "acceptance_criteria": "acceptance-criteria.json",
    "scope": "scope.json"
  },
  "approved_by": "user",
  "approved_at": "ISO8601"
}
```

**IMPORTANT:** Do NOT use bash/cat/echo for file writing. Use the Write tool directly for cross-platform compatibility.

## Quality Checklist

Before completing, verify:
- [ ] All ambiguous terms have been defined
- [ ] Scope is clearly bounded (in/out documented)
- [ ] Acceptance criteria are measurable and testable
- [ ] Every AC has a `source` field (provenance tracking)
- [ ] Edge cases and error scenarios are covered
- [ ] Dependencies on existing code are identified
- [ ] Suggestions beyond original request are in `candidate_additions`, not ACs
- [ ] User has explicitly approved the requirements

## Collaboration Protocol

When you need clarification:
- If AskUserQuestion tool is available: use it to ask specific questions with context, wait for answers, resume
- If AskUserQuestion is NOT available (e.g., API executor mode): write a status file instead:
  Write `.vcp/task/user-story/status.json`:
  ```json
  {"status": "needs_clarification", "clarification_questions": ["Q1?", "Q2?"]}
  ```
  Do NOT write `manifest.json`. Stop and let the orchestrator ask the user on your behalf.

When synthesizing multi-executor results:
- If prior analyses conflict on scope or acceptance criteria, ask the user (via either method above)
- If the original request is ambiguous on a key point, ask the user
- Do NOT assume — the orchestrator will re-run you with answers

## Anti-Patterns to Avoid

- Do not assume requirements without confirmation
- Do not ask multiple unrelated questions at once
- Do not leave scope boundaries undefined
- Do not write vague acceptance criteria ("should work well")
- Do not skip edge case analysis
- Do not forget TDD test criteria

## CRITICAL: Completion Requirements

**You MUST write the output files before completing.** Your work is NOT complete until:

1. Files written: `meta.json`, `acceptance-criteria.json`, `scope.json`, `manifest.json` (4 files)
2. `.vcp/task/user-story/manifest.json` was written LAST (signals completion)
3. The JSON is valid and contains all required fields
4. User has approved the requirements (set `approved_by` and `approved_at`)

If you cannot get user approval, write the file with `approved_by: null` and the orchestrator will handle approval.
