---
name: dev-buddy-implement
description: Implement a plan using TDD loop. Dispatches implementer executor step-by-step, runs tests after each step, fixes failures. Escalates to user after 5 failures per step.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task, TaskOutput, AskUserQuestion
---

# Implementation Stage Skill

Implement an approved plan using a TDD loop. The skill orchestrates the implementer agent step-by-step, running tests after each step to enforce accuracy.

**Task directory:** `${CLAUDE_PROJECT_DIR}/.vcp/task/`

---

## Step 1: Validate Inputs

```
Required: .vcp/task/user-story/manifest.json
Required: .vcp/task/plan/manifest.json (with step_count > 0)
Required: .vcp/task/plan/test-plan.json (with test_cases[])
```

Read `plan/manifest.json` to get `step_count`. Read `plan/test-plan.json` to get test cases.

If `test-plan.json` is missing or has no `test_cases`, warn the user: "No test cases found. TDD loop will be disabled — implementation will run without automated verification."

## Step 1a: Check for Review Repair Context

If `.vcp/task/review-findings-to-fix.json` exists, this is a re-implementation after code review failure. Read the file and inject its `must_fix` findings into the implementer prompt as additional context:

```
REVIEW FINDINGS TO FIX:
The following must_fix findings were raised by code reviewers. Fix each one during implementation:
{findings from review-findings-to-fix.json}
```

This file is written by `/dev-buddy-review --code` when the review loop triggers a re-implement.

---

## Step 2: Load Config and Resolve Executor

```bash
bun -e "
import { loadDevBuddyConfig, getProviderType } from '${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-config.ts';
const config = loadDevBuddyConfig();
const stage = config.stages['implementation'];
const executors = stage.executors.map(exec => ({
  ...exec,
  providerType: getProviderType(exec.preset)
}));
console.log(JSON.stringify({ executors, max_tdd_iterations: config.max_tdd_iterations }));
"
```

Implementation typically uses a single executor. If multiple are configured, use the first one (implementation is inherently sequential — only one agent should modify code at a time).

---

## Step 3: TDD Loop

**CRITICAL: This loop is orchestrated by this SKILL, NOT the implementer agent. The implementer never interacts with the user.**

```
For each plan step N = 1 to step_count:

  iteration = 0
  step_passed = false

  While NOT step_passed AND iteration < max_tdd_iterations:

    3a. Assemble implementer prompt:
        ORIGINAL REQUEST: {user's original request}
        ---
        SINGLE_STEP_MODE: Implement ONLY step {N} of {step_count}.
        Read the plan step at .vcp/task/plan/steps/{N}.json
        Read the user story at .vcp/task/user-story/manifest.json
        {If iteration > 0: "Previous attempt FAILED. Test failures:\n{failure_output}\nFix the issues."}
        Write implementation result to .vcp/task/impl-steps/impl-step-{N}-v{iteration+1}.json

    3b. Dispatch implementer via provider routing
        (subscription: Task, api: api-task-runner.ts, cli: cli-executor.ts)

    3c. Run relevant tests from test-plan.json:
        - Read test_cases from .vcp/task/plan/test-plan.json
        - Filter: test_cases where steps[] array includes current step N
        - For each matching test_case, run its command via Bash:
          ```
          Bash(command: test_case.command, timeout: 120000)
          ```
        - Check exit code: 0 = pass, non-zero = fail
        - Also check output against test-plan's success_pattern / failure_pattern if defined
        - Collect ALL results: { test_id, ac_ids, command, passed: boolean, output: string }

    3d. If ALL tests pass:
        step_passed = true
        Log: "Step {N}: all {count} tests passed"
        Continue to next step

    3e. If ANY test fails:
        iteration++
        failure_output = concatenate failed test outputs (first 500 chars each)
        Log: "Step {N}: {failed_count}/{total_count} tests failed (iteration {iteration}/{max_tdd_iterations})"

        If iteration >= max_tdd_iterations:
          STOP — escalate to user via AskUserQuestion:
          "Step {N} failed after {max_tdd_iterations} attempts.

           Failed tests:
           {for each failed: - {test_case.description} (ACs: {ac_ids})}

           Last failure output:
           {failure_output}

           How would you like to proceed?"

          Options:
          1. "Fix manually and re-run /dev-buddy-implement"
          2. "Adjust the tests and re-run"
          3. "Skip this step and continue"

          If user picks 3 (skip): mark step as skipped, continue to step N+1
          If user picks 1 or 2: STOP execution, user handles it

After ALL steps complete:
  3f. Run full test suite — execute ALL test commands from test-plan.json:
      ```
      For each test_case in test_plan.test_cases:
        Bash(command: test_case.command, timeout: 120000)
      ```
      Also run the global test commands from test_plan.commands (e.g., "npm test"):
      ```
      For each command in test_plan.commands:
        Bash(command: command, timeout: 120000)
      ```
      Collect results: { total_tests, passed, failed, skipped_steps }

  3g. Write final .vcp/task/impl-result.json:
      ```json
      {
        "status": "complete|partial",
        "steps_completed": N,
        "steps_total": step_count,
        "steps_skipped": [list of skipped step numbers],
        "files_modified": ["list from git diff --name-only"],
        "files_created": ["list of new files"],
        "test_results": {
          "total": N,
          "passed": N,
          "failed": N,
          "details": [{ "test_id": "...", "ac_ids": [...], "passed": true|false }]
        }
      }
      ```
```

---

## Step 4: Verify Output

After the loop completes:
1. `.vcp/task/impl-result.json` exists with `status` field
2. All planned files were created/modified
3. Final test suite results

---

## Step 5: Report Results

Present to the user:
- Steps completed / total
- Test results (passed / failed)
- Files modified/created
- Suggest next step: `/dev-buddy-review --code`

---

## Fallback: No Test Plan

If `test-plan.json` is missing or has no `test_cases`:
- Skip the TDD loop
- Dispatch implementer for ALL steps at once (not single-step mode)
- No automated test verification
- Warn user that anti-drift enforcement is reduced
