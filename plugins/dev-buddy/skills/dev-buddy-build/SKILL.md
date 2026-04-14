---
name: dev-buddy-build
description: Build stage — per-unit implementation with fresh context and mechanical backpressure
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent, Task, TaskOutput, TaskCreate, TaskUpdate, TaskList, TaskGet, AskUserQuestion
---

# Build Stage (Inner Ralph Loop)

Implement each unit of work with fresh context per iteration. Orchestrator independently runs backpressure.

**Standalone:** `/dev-buddy-build` — reads the most recent `ralph-*.md` plan file and builds all pending units.

**Orchestrated:** Dispatched by `build-loop-runner.ts` during the Ralph pipeline (not called directly by `/dev-buddy-ralph`).

---

## Execution Modes

### Standalone Mode

When invoked directly via `/dev-buddy-build`, this skill reads the most recent `ralph-*.md` plan file and builds all pending units. It queries the state machine, dispatches implementation, runs backpressure, and evaluates results.

### Orchestrated Mode (via build-loop-runner.ts)

When dispatched by the mechanical build loop runner, the executor receives a single unit plan via stdin. The executor's job is **implementation only**:

1. **Read the unit plan** — it contains everything needed (interface contract, data flow trace, authoritative sources, files to touch, backpressure commands)
2. **Implement** — touch ONLY the files listed in the unit plan
3. **Report results** — describe what was implemented

**The executor does NOT:**
- Write `**Status:**` or `**Attempts:**` to the unit file — the build-loop-runner owns these fields mechanically
- Decide pass/fail — the runner runs backpressure independently and determines the outcome
- Query the state machine — the runner already determined which unit to build
- Edit the unit plan file itself — only project source files

The build-loop-runner handles single-unit execution with internal retries: executor dispatch (via `stage-runner.ts` to the configured preset), mechanical backpressure, status writes, and retry logic.

### How It Works (Both Modes)

For each pending unit in dependency order:

1. **Verify contract** — check interface contract and test stubs are complete; if incomplete, return to decompose for contract strengthening. Unit plans also contain **Data Flow Trace** (hop-by-hop wiring instructions) and **Authoritative Sources** (binding constraints from ADRs/wiki).
2. **Dispatch implementer** — fresh-context executor receives only the unit plan file content
3. **Verify files touched** — mechanically check every file in "Files to Touch" was created/modified
4. **Run backpressure** — runner independently runs unit test, typecheck, and lint commands
5. **Evaluate** — on pass, mark unit `done`; on fail, retry up to `max_build_attempts`

The state machine tracks per-unit attempts, status, and contract gap detection.
