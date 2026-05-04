# Dev Buddy Scripts

Runtime scripts that power the legacy `/dev-buddy-*` stage-skill path. Claude Code invokes these from skills today; Codex reaches the same plugin through skills and the Dev Buddy MCP skeleton. Each script is a short-lived process.

## Top-level scripts

| Script | Role |
|--------|------|
| `ralph-state-machine.ts` | Passive state machine. Queried by CC between stages via `--action next` (and explicit CLI actions: `compose_build_dispatch`, `record_attempt_result`, `record_review_result`, `register-task-graph`, `verify-task-graph`, etc.). Reads plan + unit state; returns next-action JSON. Never drives execution. |
| `stage-runner.ts` | Multi-executor dispatch. Loads config, resolves system prompts (stage + role), spawns executors (subscription / API / CLI), synthesizes outputs. Owns the `unit-review` branch — composes the review task from unit file + files-touched when invoked with `--stage-type unit-review --unit N`. |
| `build-loop-runner.ts` | **Per-unit driver.** Runs one unit's full loop in-process by calling the three `ralph/build-actions.ts` action functions: `composeBuildDispatch` → subprocess dispatch → backpressure + contract-verify → `recordAttemptResultAction` → (optional) unit-review dispatch → `recordReviewResultAction`. Zero state-transition policy; zero direct writes to `unit-N.json` or `unit-N.md`. Streams `attempt_start`/`review_start`/`review_verdict`/`complete` JSON events. |
| `contract-verifier.ts` | Verifies the implementation honors the `Interface Contract` section of the unit plan (Class-A bug gate — e.g., missing `export`, wrong signature). Used by BLR between backpressure and state commit. |
| `api-task-runner.ts` | One-shot Vercel AI SDK session for API-type presets. Spawned by `stage-runner.ts` (and `one-shot-runner.ts`) per task. |
| `one-shot-runner.ts` | Entry point for `/dev-buddy-once` — routes to API or CLI runner based on preset type. |
| `plan-lint.ts` | Sandbox validation for decomposition output before build attempts are consumed. Rejects already-satisfied tests, uncompilable tests, and invalid unit shape. |
| `chatroom-config.ts` | CLI helpers for `/dev-buddy-chatroom`. |
| `config-server.ts` | Serves the `/dev-buddy-config` web portal. |
| `pipeline-config.ts` | Loads and validates `~/.vcp/dev-buddy.json` (config v5 with auto-migration from v2/v3/v4). |
| `preset-utils.ts` | Reads/writes `~/.vcp/ai-presets.json`. |
| `system-prompts.ts` | Resolves `<stage>.md + <role>.md` combinations into assembled system prompts. |
| `@vcp-lib/logging` | Structured logger used by Dev Buddy scripts (`createLogger('dev-buddy.log')`). |

## `ralph/` — build-stage state and transitions

| Module | Role |
|--------|------|
| `build-actions.ts` | **The single writer.** Three action functions (`composeBuildDispatch`, `recordAttemptResultAction`, `recordReviewResultAction`) own all state transitions during the build stage. Both BLR (in-process) and the SM CLI (subprocess) call these functions — one policy, one write path. |
| `unit-state.ts` | Low-level per-unit state helpers (`reserveAttempt`, `commitAttemptResult`, `markUnitDone`, `markUnitFailed`, `setReviewFeedback`, etc.). Called only by `build-actions.ts`; BLR must NOT import from here. |
| `state.ts` | Plan-level state (`plan.json`): DAG, status, iterations. |
| `types.ts` | Shared types, constants (`UNIT_REVIEW_FILES_MAX_BYTES`, `REVIEW_FEEDBACK_MAX_BYTES`, `MAX_DISPATCH_MS`). |
| `paths.ts` | `resolveRalphSlug` / `resolveUnitPath` — shared by BLR and stage-runner so the plan layout convention lives in one place. |
| `prompt-assembly.ts` | `composeBuildDispatchPrompt` + variants — assembles static plan + PRIOR MECHANICAL FAILURE + PRIOR REVIEW FEEDBACK + INSTRUCTION. |
| `parsers.ts` | Parses unit-file headers, unit-plan metadata. |
| `preconditions.ts` | Pre-stage gate checks. |
| `compute-action.ts` | Used by `ralph-state-machine.ts` to decide next action. |
| `backpressure.ts` | Runs configured backpressure commands (test/typecheck/lint). |
| `task-graph.ts` | TaskUpdate projection of the unit DAG. |
| `unit-file.ts` | Read helpers for `unit-N.md` (immutable after decompose). |
| `retention.ts` | Archives completed plans after `retention_days`. |
| `migrate.ts` | Config + state schema migrations. |

## Enforcement boundaries

- **BLR drives, build-actions.ts decides.** BLR owns I/O (subprocess spawn, backpressure, contract-verify, event streaming). All state-transition decisions (attempt reserved, retry vs done vs failed, stuck detection, hash-guarded review feedback) live in `build-actions.ts`. A lint rule (`no-restricted-imports` targeting `./ralph/unit-state.ts` from `build-loop-runner.ts`) prevents regression to the pre-v0.5.6 dual-write-path bug.
- **Unit plan files (`unit-N.md`) are immutable after decompose.** Dynamic state is in `.vcp/plan/.state/ralph-{slug}/units/unit-N.json`.
- **`ralph-state-machine.ts` is the legacy stage-skill consumer API.** Non-Claude orchestrators that need attempt-level granularity can call the three SM CLI actions (`compose_build_dispatch`, `record_attempt_result`, `record_review_result`) directly. BLR is the internal in-process consumer of the same functions. The cross-host MCP skeleton has its own state under `.vcp/ralph/<run-id>/`.
