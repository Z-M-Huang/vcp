# Build Loop Runner Proposal

## Summary

The current diagnosis is correct, but incomplete.

The stall happened because build-stage progress depends on two prompt-only behaviors that are not enforced in code:

1. The build implementer must write `**Status:** done` into `unit-N.md`.
2. The Ralph orchestrator must keep re-querying `ralph-state-machine.ts` after each build invocation.

Both are currently optional in practice because the enforcement lives in `SKILL.md`, not in code.

The recommended fix is:

- Keep `ralph-state-machine.ts` as the passive selector.
- Keep `stage-runner.ts` as the generic single-stage executor dispatcher.
- Add a new `plugins/dev-buddy/scripts/build-loop-runner.ts` that owns the entire inner build loop mechanically.
- Have `/dev-buddy-ralph` call that script via Bash instead of calling `/dev-buddy-build` via Skill when the state machine enters `build`.

This is option `b`: a new `build-loop-runner.ts` that wraps `stage-runner.ts` per unit.

---

## What The Current Code Actually Does

### Confirmed root cause

These source observations match the failure you described:

- `ralph-state-machine.ts` in `computeNextAction()` returns only:
  - `update_tasks` with `unit:{id} -> in_progress`
  - `invoke_skill` with `skill: dev-buddy-build`
- The build branch does not emit `run_backpressure`.
- The build branch does not mark a unit `done` or `failed`.
- `parseUnitPlan()` defaults missing `**Status:**` to `pending`.
- `/skills/dev-buddy-ralph/SKILL.md` says "Repeat from step 1", but that loop is prompt text, not code.
- `/skills/dev-buddy-ralph/SKILL.md` has post-invocation status verification for discover/requirements/decompose, but not for build.

So if the implementer returns natural-language success and does not edit the unit file, the next state-machine query still sees the unit as `pending`. If Ralph also stops instead of re-querying, the pipeline stalls exactly as you observed.

### Additional failure modes that also exist today

These are separate gaps worth fixing or accounting for in the proposal:

1. `max_build_attempts` is not enforced anywhere in the build path.
   - `ralph-state-machine.ts` accepts `config.max_build_attempts` but never uses it.

2. The state machine CLI hardcodes config instead of reading `~/.vcp/dev-buddy.json`.
   - `main()` uses `{ max_iterations: 10, max_build_attempts: 5, max_outer_iterations: 3 }`.
   - Repo default config says `max_build_attempts: 3`.

3. Unit task completion is not projected mechanically.
   - The state machine only emits `unit:{id} -> in_progress`.
   - There is no matching `unit:{id} -> completed` when a unit becomes `done`.

4. The backpressure parser is weaker than the precondition gate.
   - `checkPreconditions()` accepts both `## Backpressure` and `### Backpressure`.
   - `parseUnitPlan()` only extracts commands from exact `## Backpressure`.
   - Result: a unit can pass build preconditions but expose zero parsed backpressure commands.

5. Build backpressure ownership is contradictory in prompts.
   - `stages/ralph-build.md` tells the executor to run backpressure itself.
   - `skills/dev-buddy-build/SKILL.md` says the orchestrator independently runs backpressure.
   - There is no code path that makes the orchestrator verdict authoritative.

6. The "contract gap -> return to decompose" behavior is not implementable programmatically today.
   - There is no structured signal for contract-gap detection.
   - There is no build-stage state-machine branch that routes from build back to decompose.

7. `state.units` exists in persisted state but is not the source of truth and is not synchronized during build.
   - This is mostly a confusion hazard, not the direct cause of the stall.

---

## Recommended Design

### Choice

Use option `b`:

- Add `build-loop-runner.ts`
- Reuse `stage-runner.ts` for one unit at a time
- Keep `ralph-state-machine.ts` as the selector for "what unit is next?"

### Why not option `a`

Do not extend `stage-runner.ts` with build-loop awareness.

`stage-runner.ts` is currently a generic executor dispatcher:

- load config
- resolve prompts
- run executors
- synthesize output

If build-loop semantics move into `stage-runner.ts`, it stops being generic and starts owning:

- Ralph state-machine polling
- unit markdown mutation
- attempt tracking
- backpressure authority
- build-stage terminal transitions

That is the wrong abstraction boundary.

### Why not option `c`

Do not dispatch build executors directly from `build-loop-runner.ts`.

That would duplicate logic already implemented in `stage-runner.ts`:

- config loading
- preset resolution
- system prompt composition
- subscription/API/CLI provider dispatch
- timeout handling
- output parsing

---

## Proposed Responsibilities

### `ralph-state-machine.ts`

Keep it passive.

It should continue to answer:

- what status the pipeline is in
- whether build can continue
- which unit is next
- when build is complete and review should begin

No inner loop logic should live here.

### `stage-runner.ts`

Keep it single-shot.

For build usage, it should receive a task that says:

- which unit to implement
- where the unit plan file lives
- that this is orchestrated single-unit mode
- that the outer build loop owns the authoritative pass/fail verdict

### `build-loop-runner.ts`

This new script should own:

- repeated state-machine queries while plan status is `build`
- unit attempt counting
- dispatching the build executor for one unit
- authoritative backpressure execution via `runBackpressure()`
- mechanical unit status writes
- terminal build-stage summary JSON for Ralph

### `/dev-buddy-ralph`

Ralph should stop calling `/dev-buddy-build` during orchestrated build.

Instead, when the state machine indicates build work:

- call `build-loop-runner.ts` via Bash
- parse its JSON
- replay returned task updates
- re-query the state machine only after the script finishes successfully

---

## Proposed Script Contract

File:

- `plugins/dev-buddy/scripts/build-loop-runner.ts`

CLI:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/build-loop-runner.ts" \
  --plan "${CLAUDE_PROJECT_DIR}/.vcp/plan/ralph-{SLUG}.md" \
  --cwd "${CLAUDE_PROJECT_DIR}"
```

### TypeScript interfaces

```ts
import type {
  PlanStatus,
  StateMachineOutput,
  SkillAction,
  BackpressureResult,
} from './ralph-state-machine.ts';

export interface BuildLoopRunnerArgs {
  planPath: string;
  cwd: string;
}

export interface TaskProjectionOp {
  ref: string;
  status: 'in_progress' | 'completed';
  note?: string;
}

export interface UnitBuildDispatchResult {
  event: 'complete' | 'error';
  stage: 'ralph-build';
  synthesis?: string | null;
  workerOutputs?: Array<{
    executor_index: number;
    preset: string;
    model: string;
    system_prompt: string;
    result: string;
  }>;
  phase?: string;
  error?: string;
}

export interface UnitBuildOutcome {
  unitId: number;
  unitPath: string;
  attempt: number;
  maxAttempts: number;
  dispatch: UnitBuildDispatchResult;
  backpressure: BackpressureResult[];
  outcome: 'done' | 'retry' | 'failed';
}

export interface BuildLoopRunnerResult {
  event: 'build_loop_complete' | 'build_loop_blocked' | 'build_loop_error';
  slug: string;
  terminalPlanStatus: PlanStatus;
  nextStep: 'requery_state_machine' | 'report_blocked' | 'report_error';
  taskOperations: TaskProjectionOp[];
  units: UnitBuildOutcome[];
  summary: string;
  blocked?: {
    reason: string;
    preconditionError?: string;
  };
  error?: {
    message: string;
  };
}
```

### JSON output shape

Success case:

```json
{
  "event": "build_loop_complete",
  "slug": "auth-jwt",
  "terminalPlanStatus": "review",
  "nextStep": "requery_state_machine",
  "taskOperations": [
    { "ref": "unit:1", "status": "in_progress" },
    { "ref": "unit:1", "status": "completed" },
    { "ref": "unit:2", "status": "in_progress" },
    { "ref": "unit:2", "status": "completed" },
    { "ref": "stage:build", "status": "completed" },
    { "ref": "stage:review", "status": "in_progress" }
  ],
  "units": [
    {
      "unitId": 1,
      "unitPath": "/repo/.vcp/plan/ralph/auth-jwt/unit-1.md",
      "attempt": 1,
      "maxAttempts": 3,
      "dispatch": { "event": "complete", "stage": "ralph-build", "synthesis": "..." },
      "backpressure": [
        { "command": "bun test src/auth.test.ts", "exitCode": 0, "stdout": "", "stderr": "", "passed": true }
      ],
      "outcome": "done"
    }
  ],
  "summary": "Build loop complete: 2 units done, plan advanced to review."
}
```

Blocked case:

```json
{
  "event": "build_loop_blocked",
  "slug": "auth-jwt",
  "terminalPlanStatus": "build",
  "nextStep": "report_blocked",
  "taskOperations": [
    { "ref": "unit:3", "status": "in_progress" }
  ],
  "units": [
    {
      "unitId": 3,
      "unitPath": "/repo/.vcp/plan/ralph/auth-jwt/unit-3.md",
      "attempt": 3,
      "maxAttempts": 3,
      "dispatch": { "event": "complete", "stage": "ralph-build", "synthesis": "..." },
      "backpressure": [
        { "command": "bun test src/session.test.ts", "exitCode": 1, "stdout": "", "stderr": "failing test", "passed": false }
      ],
      "outcome": "failed"
    }
  ],
  "summary": "Build loop blocked: Unit 3 exhausted build attempts.",
  "blocked": {
    "reason": "max_build_attempts_exhausted",
    "preconditionError": "Unit 3 exhausted 3/3 attempts."
  }
}
```

---

## Control Flow

### High-level algorithm

```ts
export async function runBuildLoop(args: BuildLoopRunnerArgs): Promise<BuildLoopRunnerResult> {
  const config = loadDevBuddyConfig();
  const allUnitOutcomes: UnitBuildOutcome[] = [];
  const taskOps: TaskProjectionOp[] = [];

  while (true) {
    const sm = queryStateMachine(args.planPath); // imports main(planPath, 'next')

    const fatal = findErrorAction(sm);
    if (fatal) {
      return makeErrorResult(sm, allUnitOutcomes, taskOps, fatal.message);
    }

    const blocked = findBlockedAction(sm);
    if (blocked) {
      return makeBlockedResult(sm, allUnitOutcomes, taskOps, blocked.reason, blocked.preconditionError);
    }

    const buildAction = findBuildInvokeAction(sm);

    if (!buildAction) {
      // Build stage is finished or transitioned away from build.
      applyWritePlanActions(args.planPath, sm.actions);
      taskOps.push(...collectTaskOps(sm.actions));
      return makeCompleteResult(sm, allUnitOutcomes, taskOps);
    }

    taskOps.push(...collectTaskOps(sm.actions));

    const unit = readUnit(buildAction.unitPath, buildAction.unitId);
    const maxAttempts = Math.min(unit.maxAttempts, config.max_build_attempts);
    const nextAttempt = unit.attempts + 1;

    if (nextAttempt > maxAttempts) {
      writeUnitStatus(buildAction.unitPath, {
        status: 'failed',
        attempts: unit.attempts,
        appendResult: `Attempt budget exhausted before dispatch (${unit.attempts}/${maxAttempts}).`,
      });
      allUnitOutcomes.push({
        unitId: buildAction.unitId!,
        unitPath: buildAction.unitPath!,
        attempt: unit.attempts,
        maxAttempts,
        dispatch: {
          event: 'error',
          stage: 'ralph-build',
          phase: 'attempt_budget',
          error: `Unit ${buildAction.unitId} exhausted ${unit.attempts}/${maxAttempts} attempts before dispatch.`,
        },
        backpressure: [],
        outcome: 'failed',
      });
      continue; // let the state machine decide whether other independent units can still run
    }

    // Crash-safe accounting: consume the attempt before dispatch.
    writeUnitStatus(buildAction.unitPath, {
      status: 'pending',
      attempts: nextAttempt,
      appendResult: `Attempt ${nextAttempt}/${maxAttempts} started.`,
    });

    const dispatch = await dispatchBuildUnit(args, buildAction);

    const refreshedContent = fs.readFileSync(buildAction.unitPath, 'utf-8');
    const commands = extractBackpressureCommands(refreshedContent);

    if (commands.length === 0) {
      writeUnitStatus(buildAction.unitPath, {
        status: nextAttempt >= maxAttempts ? 'failed' : 'pending',
        attempts: nextAttempt,
        appendResult: 'No backpressure commands found under ## or ### Backpressure.',
      });

      const outcome: UnitBuildOutcome = {
        unitId: buildAction.unitId!,
        unitPath: buildAction.unitPath!,
        attempt: nextAttempt,
        maxAttempts,
        dispatch,
        backpressure: [],
        outcome: nextAttempt >= maxAttempts ? 'failed' : 'retry',
      };
      allUnitOutcomes.push(outcome);

      if (outcome.outcome === 'failed') {
        continue; // allow independent units to proceed if state machine permits
      }
      continue;
    }

    const backpressure =
      dispatch.event === 'complete' ? runBackpressure(commands, args.cwd) : [];

    const passed =
      dispatch.event === 'complete' &&
      backpressure.length > 0 &&
      backpressure.every(r => r.passed);

    let outcome: UnitBuildOutcome['outcome'];
    if (passed) {
      outcome = 'done';
      writeUnitStatus(buildAction.unitPath, {
        status: 'done',
        attempts: nextAttempt,
        appendResult: renderAttemptSummary(dispatch, backpressure, outcome),
      });
      taskOps.push({ ref: `unit:${buildAction.unitId}`, status: 'completed' });
    } else if (nextAttempt >= maxAttempts) {
      outcome = 'failed';
      writeUnitStatus(buildAction.unitPath, {
        status: 'failed',
        attempts: nextAttempt,
        appendResult: renderAttemptSummary(dispatch, backpressure, outcome),
      });
    } else {
      outcome = 'retry';
      writeUnitStatus(buildAction.unitPath, {
        status: 'pending',
        attempts: nextAttempt,
        appendResult: renderAttemptSummary(dispatch, backpressure, outcome),
      });
    }

    allUnitOutcomes.push({
      unitId: buildAction.unitId!,
      unitPath: buildAction.unitPath!,
      attempt: nextAttempt,
      maxAttempts,
      dispatch,
      backpressure,
      outcome,
    });
  }
}
```

### Dispatch helper

Use `stage-runner.ts` as a subprocess, not as an import.

Reason:

- `stage-runner.ts` exits the process through `emitSuccess()` / `emitError()`.
- Its export surface is test-friendly, not library-friendly.
- The subprocess boundary is already the correct abstraction for provider execution.

```ts
async function dispatchBuildUnit(
  args: BuildLoopRunnerArgs,
  action: SkillAction,
): Promise<UnitBuildDispatchResult> {
  const task = [
    'Orchestrated single-unit build.',
    `Unit ID: ${action.unitId}`,
    `Unit plan path: ${action.unitPath}`,
    'Read the unit plan from disk.',
    'Implement only that unit.',
    'Do not query the Ralph state machine.',
    'Do not decide pass/fail from your own narrative; the outer runner will run authoritative backpressure.',
  ].join('\n');

  const stageRunnerPath = path.join(path.dirname(import.meta.path), 'stage-runner.ts');

  const { stdout, exitCode } = await spawnAndCapture('bun', [
    stageRunnerPath,
    '--stage-type', 'ralph-build',
    '--plan', args.planPath,
    '--cwd', args.cwd,
    '--task-stdin',
  ], task);

  const parsed = JSON.parse(stdout);

  if (parsed.event === 'complete') {
    return {
      event: 'complete',
      stage: 'ralph-build',
      synthesis: parsed.synthesis ?? null,
      workerOutputs: parsed.worker_outputs ?? [],
    };
  }

  return {
    event: 'error',
    stage: 'ralph-build',
    phase: parsed.phase ?? (exitCode === 1 ? 'validation' : 'dispatch'),
    error: parsed.error ?? `stage-runner exited ${exitCode}`,
  };
}
```

### Unit-file mutation helpers

The runner must not rely on the implementer to update unit metadata.

Recommended helpers:

```ts
interface UnitStatusPatch {
  status: 'pending' | 'done' | 'failed';
  attempts: number;
  appendResult: string;
}

function writeUnitStatus(unitPath: string, patch: UnitStatusPatch): void;
function upsertMetadataLine(content: string, label: 'Status' | 'Attempts' | 'Max Attempts', value: string): string;
function replaceOrAppendSection(content: string, heading: '## Latest Build Attempt', body: string): string;
```

Rules:

1. If `**Status:**` is missing, insert it directly under the unit title.
2. If `**Attempts:**` is missing, insert it directly under status.
3. Preserve existing `**Max Attempts:**` if present.
4. Always overwrite `**Status:**` and `**Attempts:**` mechanically.
5. Always write a machine-generated `## Latest Build Attempt` section with:
   - attempt number
   - dispatch outcome
   - backpressure command results
   - retry/fail/done verdict

This makes retries inspectable and removes dependence on natural-language claims.

### Backpressure extraction

Do not rely on the current `parseUnitPlan()` implementation for this runner until the parser is fixed.

Recommended helper:

```ts
function extractBackpressureCommands(content: string): string[] {
  const match = content.match(/^#{2,3} Backpressure\s*$/m);
  if (!match || match.index === undefined) return [];
  const after = content.slice(match.index + match[0].length);
  const nextHeading = after.search(/\n#{2,3} /);
  const section = nextHeading === -1 ? after : after.slice(0, nextHeading);
  return [...section.matchAll(/`([^`]+)`/g)].map(m => m[1].trim()).filter(Boolean);
}
```

A unit with zero parsed backpressure commands should be treated as a hard failure, not as an automatic pass.

---

## Ralph Handoff

### Current behavior

Today Ralph sees:

```json
{
  "actions": [
    { "type": "update_tasks", "operations": [{ "ref": "unit:1", "status": "in_progress" }] },
    { "type": "invoke_skill", "skill": "dev-buddy-build", "stageType": "ralph-build", "unitId": 1, "unitPath": "..." }
  ]
}
```

Then prompt text tells Ralph to call the Skill tool and remember to loop.

### Proposed behavior

When Ralph sees a build invocation:

1. Do not call the Skill tool for `/dev-buddy-build`.
2. Do not separately process the current build action list.
   - `build-loop-runner.ts` will replay the needed task operations in its JSON.
3. Call Bash instead:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/build-loop-runner.ts" \
  --plan "{plan}" \
  --cwd "${CLAUDE_PROJECT_DIR}"
```

4. Parse the JSON result.
5. Replay `taskOperations` with TaskUpdate.
6. If `event === "build_loop_complete"` and `nextStep === "requery_state_machine"`:
   - re-query `ralph-state-machine.ts`
   - continue the outer Ralph loop
7. If `event === "build_loop_blocked"`:
   - stop and report the blocking summary
8. If `event === "build_loop_error"`:
   - stop and report the error

### Suggested Ralph prompt delta

Add a build-stage special case:

```md
If the state machine returns `invoke_skill` with `stageType: ralph-build`, do not call `/dev-buddy-build`.
Instead invoke `build-loop-runner.ts` via Bash. The script owns the entire inner build loop until plan status leaves `build`, a blocking condition is reached, or an error occurs.
After the script returns, replay its `taskOperations`, then either re-query the state machine or report the blocking/error result.
```

This removes the inner build loop from prompt space and keeps Ralph responsible only for the outer pipeline.

---

## Unit Status Marking

The runner should own this completely.

### Authoritative rules

- `done`:
  - build dispatch completed
  - at least one backpressure command was found
  - every backpressure command passed

- `pending`:
  - build dispatch failed or backpressure failed
  - attempt budget remains

- `failed`:
  - build dispatch failed or backpressure failed
  - no attempt budget remains

### Attempt accounting

Consume the attempt before dispatch.

Reason:

- If the executor hangs or the process crashes, the attempt is still recorded.
- That is better than losing the fact that work was attempted.

Effective budget:

```ts
const effectiveMaxAttempts = Math.min(unit.maxAttempts, config.max_build_attempts);
```

This preserves unit-level ceilings without allowing a unit to exceed the global config.

---

## Small Supporting Changes I Would Make Alongside The Runner

These are not the main proposal, but they close gaps exposed by the same failure:

1. Fix `parseUnitPlan()` backpressure extraction to accept both `## Backpressure` and `### Backpressure`.

2. Read real config inside `ralph-state-machine.ts` instead of hardcoding:
   - `max_iterations`
   - `max_build_attempts`
   - `max_outer_iterations`

3. Clarify prompt ownership:
   - `stages/ralph-build.md` should say the runner's mechanical backpressure result is authoritative
   - `/skills/dev-buddy-build/SKILL.md` should no longer describe itself as the build-loop controller for orchestrated mode

4. Eventually replace the build `invoke_skill` action with a dedicated action type like:

```ts
interface InvokeBuildLoopAction {
  type: 'invoke_build_loop';
  slug: string;
}
```

That is cleaner than special-casing `skill === "dev-buddy-build"` in Ralph, but it is not required for the first implementation.

---

## Bottom Line

The failure is real and the architecture is the cause:

- the state machine is passive
- the build loop is prompt-driven
- the build verdict is not mechanical
- unit status writes are not enforced

The cleanest fix is a new `build-loop-runner.ts` that:

- repeatedly queries the existing state machine
- calls `stage-runner.ts` once per unit
- runs `runBackpressure()` itself
- writes `**Status:**` and `**Attempts:**` itself
- returns structured JSON to Ralph

That removes the fragile inner loop from the LLM control plane without forcing unrelated build semantics into `stage-runner.ts`.
