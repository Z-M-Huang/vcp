# RCA Consolidation (Bug-Fix Pipeline Only)

> **When to execute:** From the main loop, after completing the LAST consecutive RCA stage (i.e., completed stage is `rca` and next stage is non-`rca` or null). This is an INLINE ORCHESTRATOR ACTION — NOT a task, NOT delegated to an agent.

---

## Trigger Detection

After each task completion, check the `stages` array in `pipeline-tasks.json`:

```
completedStageIndex = find index in stages where task_id matches current task
completedStage = stages[completedStageIndex]
nextStage = stages[completedStageIndex + 1]  // may be null if last

if completedStage.type === 'rca' AND (nextStage === null OR nextStage.type !== 'rca'):
    -> Run Orchestrator Consolidation NOW (inline, before dispatching next task)
    -> Write user-story/ and plan/ multi-file artifacts
    -> Then proceed to next task
```

This trigger correctly handles any number of consecutive RCA stages (not just 2). It fires after the LAST RCA in a consecutive sequence.

---

## Step 1: Read All RCA Outputs

Find all rca-*.json files from `stages` array entries with `type === 'rca'`:
```
rcaFiles = stages.filter(s => s.type === 'rca').map(s => s.output_file)
// e.g., ['rca-anthropic-subscription-sonnet-1-v1.json', 'rca-anthropic-subscription-opus-2-v1.json']
Read each file from .vcp/task/ using the output_file from stages[]
```

## Step 2: Consolidate Findings

**If all RCAs agree on root cause** (same file, same general diagnosis):
- Use the shared diagnosis — high confidence
- Take the most detailed explanation
- Merge affected files, fix constraints, and impact analysis from all RCAs

**If RCAs disagree** (different root files, different categories):
- Present diagnoses to user via AskUserQuestion:
  ```
  "The RCA analyses disagree on the root cause:
   RCA 1 (Sonnet): [summary] in [file]:[line]
   RCA 2 (Opus): [summary] in [file]:[line]
   Which diagnosis is more likely correct?"
  Options: Each RCA's diagnosis, or "All may be contributing factors"
  ```
- Use user's chosen diagnosis, or merge if "all contributing"

## Step 3: Write user-story/ multi-file artifact

Write the user-story as individual section files. **These paths are FIXED — not configurable.** Write files in this order (manifest LAST):

**3a. `.vcp/task/user-story/meta.json`**
```json
{
  "id": "story-YYYYMMDD-HHMMSS",
  "title": "Fix: [Bug title from RCA]",
  "pipeline_type": "bug-fix"
}
```

**3b. `.vcp/task/user-story/requirements.json`**
```json
{
  "root_cause": "[Consolidated root cause summary]",
  "root_file": "[path/to/file.ts]",
  "root_line": 42
}
```

**3c. `.vcp/task/user-story/acceptance-criteria.json`**
```json
[
  { "id": "AC1", "description": "Bug is resolved — expected behavior is restored" },
  { "id": "AC2", "description": "Regression test covers the exact bug scenario" },
  { "id": "AC3", "description": "No existing tests are broken by the fix" },
  { "id": "AC4", "description": "Root cause is addressed, not just symptoms patched" }
]
```

**3d. `.vcp/task/user-story/scope.json`**
```json
{
  "affected_files": ["[merged from all RCAs]"],
  "blast_radius": "[from RCA impact analysis]",
  "fix_constraints": {
    "must_preserve": ["[merged from all RCAs]"],
    "safe_to_change": ["[merged from all RCAs]"]
  }
}
```

**3e. `.vcp/task/user-story/test-criteria.json`**
```json
{
  "implementation": { "max_iterations": 10 }
}
```

**3f. `.vcp/task/user-story/manifest.json`** (write LAST)
```json
{
  "id": "story-YYYYMMDD-HHMMSS",
  "title": "Fix: [Bug title from RCA]",
  "pipeline_type": "bug-fix",
  "artifact": "user-story",
  "ac_count": 4,
  "sections": {
    "meta": "meta.json",
    "requirements": "requirements.json",
    "acceptance_criteria": "acceptance-criteria.json",
    "scope": "scope.json",
    "test_criteria": "test-criteria.json"
  }
}
```

## Step 4: Write plan/ multi-file artifact

Write the plan as individual section files. **These paths are FIXED — not configurable.** Write files in this order (manifest LAST):

**4a. `.vcp/task/plan/meta.json`**
```json
{
  "id": "plan-YYYYMMDD-HHMMSS",
  "title": "Fix: [Bug title]",
  "pipeline_type": "bug-fix",
  "technical_approach": {
    "root_cause": "[Consolidated root cause]",
    "fix_strategy": "[From recommended_approach of chosen RCA]",
    "complexity": "[From estimated_complexity]"
  }
}
```

**4b. `.vcp/task/plan/steps/{N}.json`** (one file per step, N = 1, 2, 3, ...)
```json
// .vcp/task/plan/steps/1.json
{ "description": "Write regression test that reproduces the bug", "files": ["path/to/test.ts"] }

// .vcp/task/plan/steps/2.json
{ "description": "Apply minimal fix to [root_file] at line [root_line]", "files": ["path/to/file.ts"] }

// .vcp/task/plan/steps/3.json
{ "description": "Verify regression test passes, all existing tests pass", "files": [] }
```

**4c. `.vcp/task/plan/test-plan.json`**
```json
{
  "commands": ["npm test", "npm run lint"],
  "regression_test": "Specific regression test to write",
  "success_pattern": "All tests pass",
  "failure_pattern": "FAIL|ERROR"
}
```

**4d. `.vcp/task/plan/risk-assessment.json`**
```json
{
  "blast_radius": "[from RCA]",
  "regression_risk": "[from RCA]",
  "mitigation": "Regression test covers the exact bug scenario"
}
```

**4e. `.vcp/task/plan/dependencies.json`**
```json
{
  "completion_promise": "<promise>IMPLEMENTATION_COMPLETE</promise>"
}
```

**4f. `.vcp/task/plan/files.json`**
```json
{
  "affected_files": ["[all files from steps]"]
}
```

**4g. `.vcp/task/plan/manifest.json`** (write LAST)
```json
{
  "id": "plan-YYYYMMDD-HHMMSS",
  "title": "Fix: [Bug title]",
  "pipeline_type": "bug-fix",
  "artifact": "plan",
  "step_count": 3,
  "sections": {
    "meta": "meta.json",
    "steps": ["steps/1.json", "steps/2.json", "steps/3.json"],
    "test_plan": "test-plan.json",
    "risk_assessment": "risk-assessment.json",
    "dependencies": "dependencies.json",
    "files": "files.json"
  }
}
```

**Key principle:** The fix plan must be the **smallest possible change** that addresses the root cause. No refactoring, no cleanup beyond the fix itself.

## Step 5: Continue Main Loop

After writing both multi-file artifacts, the consolidation is complete. Continue the main loop — the next task (plan-review or implementation, depending on config) is now unblocked.
