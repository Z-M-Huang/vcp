# Claude Code - Multi-Session Orchestrator Pipeline

> **IMPORTANT**: This project uses a **Multi-Session Orchestrator Architecture** with Task + Resume pattern. The orchestrator coordinates specialized worker agents, handles decision escalation, and uses Codex as an independent final gate.

## Path Reference

| Variable | Purpose | Example |
|----------|---------|---------|
| `${CLAUDE_PLUGIN_ROOT}` | Plugin installation directory | `~/.claude/plugins/dev-buddy/` |
| `${CLAUDE_PROJECT_DIR}` | Your project directory | `/path/to/your/project/` |

**Important:** The `.vcp/task/` directory is created in your **project directory**, not the plugin directory.

## Architecture Overview

```
Multi-Session Orchestrator Pipeline (Task-Based Enforcement, Configurable)
  |
  +-- Orchestrator (Main Session)
  |     +-- Load config, resolve stages from feature_pipeline/bugfix_pipeline
  |     +-- Create Pipeline Team (TeamCreate)
  |     |     +-- Idempotent: TeamDelete + TeamCreate("pipeline-{BASENAME}-{HASH}")
  |     |     +-- Verify: TaskList() probe
  |     |     +-- Fails fast if task tools unavailable
  |     +-- Creates pipeline task chain dynamically from resolved config stages
  |     +-- Executes data-driven main loop (TaskList → Execute → Complete)
  |     +-- Handles decision escalation from workers
  |     +-- Creates dynamic fix tasks on review failures
  |
  +-- Requirements (INTERACTIVE) [feature pipeline only]
  |     +-- Task: "Requirements 1"
  |     +-- requirements-gatherer agent
  |     -> .vcp/task/user-story.json
  |
  +-- Planning (SEMI-INTERACTIVE) [feature pipeline only]
  |     +-- Task: "Planning 1"
  |     +-- planner agent
  |     -> .vcp/task/plan-refined.json
  |
  +-- Plan Reviews (TASK-ENFORCED, SEQUENTIAL OR PARALLEL)
  |     +-- TaskCreate + TaskUpdate(addBlockedBy) for each plan-review stage in config
  |     +-- Sequential by default; stages with parallel: true form parallel groups
  |     +-- e.g., Plan Review 1 → (Plan Review 2 + Plan Review 3) parallel → sequential
  |     -> .vcp/task/plan-review-{provider}-{model}-{N}-v{V}.json (versioned, append-only)
  |
  +-- Implementation
  |     +-- TaskUpdate(addBlockedBy) blocks until last plan review completes
  |     +-- implementer agent
  |     +-- Resume for iterative fixes
  |     -> .vcp/task/impl-result.json
  |
  +-- Code Reviews (TASK-ENFORCED, SEQUENTIAL OR PARALLEL)
  |     +-- TaskCreate + TaskUpdate(addBlockedBy) for each code-review stage in config
  |     +-- Sequential by default; stages with parallel: true form parallel groups
  |     +-- e.g., Code Review 1 → (Code Review 2 + Code Review 3) parallel → sequential
  |     -> .vcp/task/code-review-{provider}-{model}-{N}-v{V}.json (versioned, append-only)
  |
  +-- Completion
  |     +-- Report results
  |     +-- TeamDelete (read team_name from .vcp/task/pipeline-tasks.json)
  ```

---

## Team-Based Requirements Gathering (v1.5.0)

Requirements gathering uses Agent Teams (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) to explore from multiple perspectives in parallel, producing richer user stories from the start.

### How It Works

```
User provides initial description via /dev-buddy-feature-implement
         |
         v
    Lead (orchestrator/main session)
    ├── Spawns 5 core specialists + additional as needed
    ├── Specialists join the pipeline team as teammates
    │    ├── Technical Analyst     (always) → explores codebase
    │    ├── UX/Domain Analyst     (always) → user workflows, best practices
    │    ├── Security Analyst      (always) → security analysis
    │    ├── Performance Analyst   (always) → load, scalability, resources
    │    ├── Architecture Analyst  (always) → design patterns, SOLID, maintainability
    │    └── [Additional specialists as needed]
    ├── Receives specialist messages (auto-delivered)
    ├── Uses findings to AskUserQuestion (informed questions)
    ├── Waits for specialists to complete analysis files
    ├── Spawns requirements-gatherer in synthesis mode (one-shot Task)
    │    └── Reads analysis files → writes user-story.json
    └── Shuts down specialist teammates (pipeline team persists), continues pipeline
```

### Specialist Analysis Files

| Specialist | Output File |
|-----------|------------|
| Technical Analyst | `.vcp/task/analysis-technical.json` |
| UX/Domain Analyst | `.vcp/task/analysis-ux-domain.json` |
| Security Analyst | `.vcp/task/analysis-security.json` (VCP-enhanced when detected) |
| Performance Analyst | `.vcp/task/analysis-performance.json` |
| Architecture Analyst | `.vcp/task/analysis-architecture.json` |

### Sub-Phases

| Phase | Description |
|-------|------------|
| `requirements_team_pending` | Pipeline initialized, specialists not yet spawned. Spawn specialist teammates into pipeline team. |
| `requirements_team_exploring` | Team active: specialists exploring, lead asking questions. Do NOT synthesize until ALL specialists complete. |
| `requirements_gathering` | Fallback: no team, direct requirements-gatherer (when teams unavailable) |

### Windows Compatibility

In-process mode works on any terminal (Windows Terminal, VS Code, etc.). Use Shift+Up/Down to cycle between teammates. Split-pane mode requires tmux/iTerm2 (macOS/Linux only) but is not required.

---

### VCP-Aware Security Analysis

When `.vcp/config.json` (or legacy `.vcp.json`) exists with a valid `pluginRoot`,
the orchestrator runs `generate-context.ts` to get formatted VCP rules before
spawning specialists. The Security Analyst receives the context as prompt input
and uses VCP standards as a structured checklist alongside OWASP Top 10 analysis.

Detection flow: read config (with `.vcp.json` fallback) → validate pluginRoot → Glob check → run CLI → inject into prompt.
Any failure → silent fallback to generic OWASP analysis. Does not block the pipeline.
Legacy `.vcp.json` is auto-migrated to `.vcp/config.json` when the CLI runs.

The `vcp_standards_referenced` field in analysis-security.json lists the standard
names that were evaluated. This flows through to user-story.json for downstream traceability.

---

## Task-Based Pipeline Enforcement

### Why Task-Based?

The pipeline uses Claude Code's TaskCreate/TaskUpdate/TaskList tools to create **structural enforcement** via explicit task dependencies, rather than relying on instruction-following.

| Instruction-Based (Old) | Task-Based (New) |
|-------------------------|------------------|
| "Run Sonnet → Opus → Codex" | `blockedBy` prevents Codex until Opus completes |
| LLM can skip "redundant" steps | LLM queries TaskList() for next available task |
| No audit trail | Complete task history with metadata |
| Hidden progress | User sees real-time task progress |

**Key Insight:** `blockedBy` is **data**, not an instruction. When the orchestrator calls `TaskList()`, blocked tasks cannot be claimed. The prompt becomes "find next unblocked task" - a data query, not instruction following.

**Task API:** TaskCreate returns a task object with an `id` field. Dependencies are set via `TaskUpdate(id, addBlockedBy: [...])` — TaskCreate itself does NOT accept a blockedBy parameter.

**Team Context Required:** TaskCreate/TaskUpdate/TaskList require a team context (via `TeamCreate`) to become available. The pipeline creates a persistent `pipeline-{BASENAME}-{HASH}` team at startup that provides these tools for the entire pipeline lifecycle. The team name is unique per project via path hash. Same-project concurrent runs are unsupported.

### Pipeline Task Chain (Dynamic)

After loading the config and creating the pipeline team, tasks are created **dynamically** by iterating over the resolved pipeline array. Every `TaskCreate` includes a rich `description` with AGENT, MODEL, INPUT, OUTPUT, and key instructions. The main loop calls `TaskGet()` to read the full description before spawning each agent.

**Example for default feature pipeline (9 stages):**
```
T1 = TaskCreate(subject: "Requirements 1", description: "AGENT: requirements-gatherer ...")
T2 = TaskCreate(subject: "Planning 1", description: "...")         → TaskUpdate(T2.id, addBlockedBy: [T1.id])
T3 = TaskCreate(subject: "Plan Review 1", description: "...")      → TaskUpdate(T3.id, addBlockedBy: [T2.id])
T4 = TaskCreate(subject: "Plan Review 2", description: "...")      → TaskUpdate(T4.id, addBlockedBy: [T3.id])
T5 = TaskCreate(subject: "Plan Review 3", description: "...")      → TaskUpdate(T5.id, addBlockedBy: [T4.id])  <- last plan-review gate
T6 = TaskCreate(subject: "Implementation 1", description: "...")   → TaskUpdate(T6.id, addBlockedBy: [T5.id])
T7 = TaskCreate(subject: "Code Review 1", description: "...")      → TaskUpdate(T7.id, addBlockedBy: [T6.id])
T8 = TaskCreate(subject: "Code Review 2", description: "...")      → TaskUpdate(T8.id, addBlockedBy: [T7.id])
T9 = TaskCreate(subject: "Code Review 3", description: "...")      → TaskUpdate(T9.id, addBlockedBy: [T8.id])  <- final gate
```

**Number of tasks = length of the configured pipeline array** — adding/removing stages adds/removes tasks.

**Output file naming (versioned, append-only):**
- Singleton stages: canonical names (`user-story.json`, `plan-refined.json`, `impl-result.json`)
- Multi-instance stages: `{type}-{provider}-{model}-{index}-v{version}.json` (e.g., `plan-review-anthropic-subscription-sonnet-1-v1.json`)
- Re-reviews create new files with incremented version (e.g., `...-v2.json`), preserving all previous versions

**CLI preset stages** (e.g., Codex): the task description instructs the `cli-executor` agent to call `cli-executor.ts` with `--preset <preset_name>`, `--model <model>`, and `--output-file <computed_path>` so the output lands in the correct type-indexed file.

Returned IDs are stored in `.vcp/task/pipeline-tasks.json` alongside the `resolved_config` snapshot.

**Progressive enrichment:** Before marking each task completed, the orchestrator reads its output file, extracts key context (≤ 500 chars), and appends a `CONTEXT FROM PRIOR TASK` block to the next task's description via `TaskUpdate`. This gives each agent relevant context from the previous phase without re-reading full artifacts. Enrichment is best-effort — failure does not block the pipeline.

### Dynamic Fix Tasks

When a review returns `needs_changes`, the orchestrator creates fix + re-review tasks with the same rich `description` contract (AGENT/MODEL/INPUT/OUTPUT/ISSUES):

1. `fix = TaskCreate(subject: "Fix Plan Review 2 v1", description: "AGENT: ... ISSUES TO FIX: ...")`
   - Subject format: `Fix {Stage Type} {Index} v{N}` (e.g., "Fix Code Review 3 v2")
2. `TaskUpdate(fix.id, addBlockedBy: [current_review_id])`
3. `rerev = TaskCreate(subject: "Plan Review 2 v2", description: "AGENT: ... NOTE: Re-review after fix...")`
   - Subject format: `{Stage Type} {Index} v{N+1}` (e.g., "Code Review 3 v3")
4. `TaskUpdate(rerev.id, addBlockedBy: [fix.id])`
5. Group-aware successor rewiring: compute successor index (if stage is in a parallel group, successor = group end + 1; otherwise successor = stage index + 1). If successor exists: `TaskUpdate(successor_task_id, addBlockedBy: [rerev.id])`. Skip if last stage.
6. `TaskUpdate(current_review_id, status: "completed")`
7. After `max_iterations` re-reviews (from resolved config), escalates to user

Re-review always targets **the same stage index** (not the next one). If Code Review 2 requests changes, fixes are validated by Code Review 2 again before the successor stage can proceed.

This maintains the dependency chain and ensures the same reviewer validates fixes before the next stage (or the stage after the parallel group) can proceed.

---

## Quick Start

```
/dev-buddy-feature-implement [description of what you want]    # Feature development
/dev-buddy-bug-fix [description of the bug]           # Bug fix
/dev-buddy-once use <provider> [model <model>] <task>          # One-shot task
```

### Feature Development (`/dev-buddy-feature-implement`)

The pipeline will:
1. **Reset, create pipeline team & task chain** with dependencies
2. **Gather requirements** (team-based) - Specialist teammates explore in parallel, lead asks informed questions, then synthesize
3. **Plan** (semi-interactive) - Custom agent with Architect expertise
4. **Review plan** (task-enforced) - Per config: sequential by default, parallel groups where configured
5. **Implement** - Iterates until reviews approve
6. **Review code** (task-enforced) - Per config: sequential by default, parallel groups where configured
7. **Complete** - Report results

**No phase skipping:** Every pipeline run executes ALL phases in order. Exception: Resume path (Step 0) skips already-completed stages by creating pre-completed tasks. Pre-existing plans or context from plan mode are input to the specialists, not a substitute for the pipeline. Never skip team-based requirements gathering.

### Bug Fix (`/dev-buddy-bug-fix`)

The bug-fix pipeline uses a different early-phase approach optimized for diagnosing and fixing bugs:

1. **Sequential RCA** — Root-cause-analyst agents run one after another (configurable count)
2. **Inline Consolidation** — After the last RCA stage, the orchestrator consolidates findings inline, writes `user-story.json` + `plan-refined.json` (fixed canonical names)
3. **Plan Validation** — Optional plan-review stage(s) for Codex RCA+plan validation
4. **Implementation** — Minimal fix targeting the root cause
5. **Code Reviews** (task-enforced) — Sequential by default, parallel groups where configured

**Key differences from `/dev-buddy-feature-implement`:**
- No requirements-gatherer or planner agents — RCA stages replace them
- Orchestrator consolidates RCA findings inline (not via a separate task) before the next non-RCA stage
- Output files: `rca-{provider}-{model}-{N}-v{V}.json`, `plan-review-{provider}-{model}-{N}-v{V}.json`, `code-review-{provider}-{model}-{N}-v{V}.json` (versioned naming)
- Fix plan emphasizes smallest possible change, not architectural design
- Non-review stages (RCA, implementation) execute **sequentially**. Review stages (plan-review, code-review) can be configured for parallel execution via `parallel: true` on each StageEntry.

### One-Shot Task (`/dev-buddy-once`)

Run a single arbitrary task using any configured provider — no pipeline, no reviews:

```
/dev-buddy-once use <provider> [model <model>] <task description>
```

- **subscription** → Spawns a Claude subagent with the specified model
- **api** → Runs `api-task-runner.ts` with the task, collects result from stdout
- **cli** → Runs the CLI tool directly with the task as prompt

Model defaults to `sonnet` (subscription) or `preset.models[0]` (api/cli) if omitted.

Provider is matched by exact name first, then unique prefix. Run `/dev-buddy-manage-presets list` to see available presets.

The one-shot runner script (`scripts/one-shot-runner.ts`) handles API and CLI lifecycle:
- **API:** Spawns `api-task-runner.ts` with `--preset`, `--model`, `--task-stdin`, `--cwd`, `--task-timeout` → pipes task text via stdin (avoids argv size limits) → reads result JSON from stdout → process exits on its own
- **CLI:** Uses the preset's `one_shot_args_template` (required for CLI presets in one-shot mode). Tokenizes it, substitutes `{model}`, `{prompt}`, `{reasoning_effort}` → platform-aware execution (CWE-78 safe) → wall-clock timeout. If `one_shot_args_template` is not configured, the runner exits with a validation error directing the user to configure it.

**CLI Preset Templates:**
- `args_template` — used by the pipeline's `cli-executor.ts`. Must contain `{model}`, `{prompt}`, `{output_file}`. May also use `{schema_path}` and `{reasoning_effort}`.
- `one_shot_args_template` — used by `/dev-buddy-once`. Must contain `{model}` and `{prompt}`. Only supports `{model}`, `{prompt}`, `{reasoning_effort}` (no `{output_file}` or `{schema_path}`).

---

## Custom Agents

The pipeline uses specialized agents defined in `agents/` directory. Model selection is controlled by the orchestrator via Task tool, not hardcoded in agent definitions.

| Agent | Recommended Model | Purpose |
|-------|-------------------|---------|
| **requirements-gatherer** | opus | Business Analyst + Product Manager hybrid (supports synthesis mode with specialist analyses) |
| **planner** | opus | Architect + Fullstack Developer hybrid |
| **plan-reviewer** | sonnet/opus | Architect + Security + QA hybrid |
| **implementer** | sonnet | Fullstack + TDD + Quality hybrid |
| **code-reviewer** | sonnet/opus | Security + Performance + QA hybrid |
| **root-cause-analyst** | sonnet/opus | Debugging + fault isolation for autonomous bug diagnosis |

See `AGENTS.md` for detailed agent specifications.

---

## Key Features

### Task + Resume Architecture

Workers can be resumed with preserved context:
- **Resume for context** - Maintains conversation history across iterations
- **Fresh analysis** - Reviews start fresh for unbiased perspective

### Task-Based Dependency Enforcement

Reviews are enforced via `blockedBy` dependencies:
- Sequential stages: each review **cannot start** until the previous completes
- Parallel groups: stages with matching `parallel_group_id` run concurrently, and the next stage waits for all group members
- This is data-driven, not instruction-driven

### Codex as Final Gate

Codex (independent AI) provides final approval:
- Different AI family catches different issues
- Not "Claude reviewing Claude"
- Required before implementation can start

---

## Skills

| Skill | Purpose | Phase |
|-------|---------|-------|
| `/dev-buddy-feature-implement` | Start feature development pipeline (entry point) | All |
| `/dev-buddy-bug-fix` | Start bug-fix pipeline — dual RCA, consolidation, Codex validation, fix, code review | All |
| `/dev-buddy-once` | Run a single task with a specific provider and model (no pipeline) | Any |

**Note:** Requirements gathering, planning, review (sonnet/opus), and implementation are handled by custom agents via Task tool. CLI provider stages (e.g., Codex final gate) use the `cli-executor` agent via `Task(subagent_type: "dev-buddy:cli-executor")` — model is passed to the CLI tool via `--preset` and `--model` flags, not the Task tool's model parameter.

---

## Hook Enforcement

Pipeline enforcement uses two hooks:

### UserPromptSubmit Hook (Guidance)
- **File:** `hooks/guidance-hook.ts`
- **Purpose:** Reads `.vcp/task/*.json` files to determine phase, injects advisory guidance
- **No state tracking:** Phase is implicit from which artifact files exist

### SubagentStop Hook (Enforcement)
- **File:** `hooks/review-validator.ts`
- **Purpose:** Validates reviewer outputs when agents finish
- **Can block:** Returns `{"decision": "block", "reason": "..."}` if:
  - Review doesn't verify all acceptance criteria
  - Review approves with unimplemented ACs

Max 10 re-reviews per reviewer before escalating to user.

---

## Output Formats

### User Story (`.vcp/task/user-story.json`)
```json
{
  "id": "story-YYYYMMDD-HHMMSS",
  "title": "Feature title",
  "requirements": {...},
  "acceptance_criteria": [...],
  "scope": {...},
  "test_criteria": {...},
  "implementation": { "max_iterations": 10 }
}
```

### Plan Refined (`.vcp/task/plan-refined.json`)
```json
{
  "id": "plan-YYYYMMDD-HHMMSS",
  "title": "Plan title",
  "technical_approach": {...},
  "steps": [...],
  "test_plan": {...},
  "risk_assessment": {...},
  "completion_promise": "<promise>IMPLEMENTATION_COMPLETE</promise>"
}
```

### Pipeline Tasks (`.vcp/task/pipeline-tasks.json`)

Format includes a `resolved_config` snapshot, `config_hash` for resume drift detection, and a `stages` array with task IDs and `parallel_group_id`:

```json
{
  "team_name": "pipeline-vibe-pipe-a1b2c3",
  "pipeline_type": "feature-implement",
  "config_hash": "<sha256-of-JSON.stringify(loadPipelineConfig())>",
  "resolved_config": {
    "feature_pipeline": [
      { "type": "requirements", "provider": "anthropic-subscription", "model": "opus" },
      { "type": "planning", "provider": "anthropic-subscription", "model": "opus" },
      { "type": "plan-review", "provider": "anthropic-subscription", "model": "sonnet", "parallel": true },
      { "type": "plan-review", "provider": "anthropic-subscription", "model": "opus", "parallel": true },
      { "type": "plan-review", "provider": "anthropic-subscription", "model": "sonnet" },
      { "type": "implementation", "provider": "anthropic-subscription", "model": "sonnet" },
      { "type": "code-review", "provider": "anthropic-subscription", "model": "sonnet", "parallel": true },
      { "type": "code-review", "provider": "anthropic-subscription", "model": "opus", "parallel": true },
      { "type": "code-review", "provider": "anthropic-subscription", "model": "sonnet" }
    ],
    "bugfix_pipeline": [...],
    "max_iterations": 10,
    "team_name_pattern": "pipeline-{BASENAME}-{HASH}"
  },
  "stages": [
    { "type": "requirements", "provider": "anthropic-subscription", "providerType": "subscription", "model": "opus", "output_file": "user-story.json", "current_version": 1, "task_id": "task-id-1", "parallel_group_id": null },
    { "type": "planning", "provider": "anthropic-subscription", "providerType": "subscription", "model": "opus", "output_file": "plan-refined.json", "current_version": 1, "task_id": "task-id-2", "parallel_group_id": null },
    { "type": "plan-review", "provider": "anthropic-subscription", "providerType": "subscription", "model": "sonnet", "output_file": "plan-review-anthropic-subscription-sonnet-1-v1.json", "current_version": 1, "task_id": "task-id-3", "parallel_group_id": 1 },
    { "type": "plan-review", "provider": "anthropic-subscription", "providerType": "subscription", "model": "opus", "output_file": "plan-review-anthropic-subscription-opus-2-v1.json", "current_version": 1, "task_id": "task-id-4", "parallel_group_id": 1 },
    { "type": "plan-review", "provider": "anthropic-subscription", "providerType": "subscription", "model": "sonnet", "output_file": "plan-review-anthropic-subscription-sonnet-3-v1.json", "current_version": 1, "task_id": "task-id-5", "parallel_group_id": null },
    { "type": "implementation", "provider": "anthropic-subscription", "providerType": "subscription", "model": "sonnet", "output_file": "impl-result.json", "current_version": 1, "task_id": "task-id-6", "parallel_group_id": null },
    { "type": "code-review", "provider": "anthropic-subscription", "providerType": "subscription", "model": "sonnet", "output_file": "code-review-anthropic-subscription-sonnet-1-v1.json", "current_version": 1, "task_id": "task-id-7", "parallel_group_id": 2 },
    { "type": "code-review", "provider": "anthropic-subscription", "providerType": "subscription", "model": "opus", "output_file": "code-review-anthropic-subscription-opus-2-v1.json", "current_version": 1, "task_id": "task-id-8", "parallel_group_id": 2 },
    { "type": "code-review", "provider": "anthropic-subscription", "providerType": "subscription", "model": "sonnet", "output_file": "code-review-anthropic-subscription-sonnet-3-v1.json", "current_version": 1, "task_id": "task-id-9", "parallel_group_id": null }
  ]
}
```

- `config_hash`: SHA-256 of `JSON.stringify(loadPipelineConfig())` at pipeline creation time. Used for resume drift detection.
- `parallel_group_id`: Integer for tasks in a parallel group (same ID = same group), `null` for sequential tasks. Dynamic fix/re-review tasks always get `null`.

Hooks and phase detection read `resolved_config` from this file to derive dynamic stage lists — they never read `~/.vcp/dev-buddy.json` directly (prevents TOCTOU races).

---

## Config Format

The pipeline is driven by `~/.vcp/dev-buddy.json`. Two ordered arrays of stages for feature and bug-fix pipelines.

### Stage Types

| Type | Singleton | Allowed In | Agent | Output File Pattern |
|------|-----------|-----------|-------|---------------------|
| `requirements` | yes | feature | requirements-gatherer | `user-story.json` |
| `planning` | yes | feature | planner | `plan-refined.json` |
| `plan-review` | no | feature, bugfix | plan-reviewer | `plan-review-{provider}-{model}-{index}-v{version}.json` |
| `implementation` | yes | feature, bugfix | implementer | `impl-result.json` |
| `code-review` | no | feature, bugfix | code-reviewer | `code-review-{provider}-{model}-{index}-v{version}.json` |
| `rca` | no | bugfix | root-cause-analyst | `rca-{provider}-{model}-{index}-v{version}.json` |

### Config Structure

```json
{
  "feature_pipeline": [
    { "type": "requirements", "provider": "anthropic-subscription", "model": "opus" },
    { "type": "planning", "provider": "anthropic-subscription", "model": "opus" },
    { "type": "plan-review", "provider": "anthropic-subscription", "model": "sonnet", "parallel": true },
    { "type": "plan-review", "provider": "anthropic-subscription", "model": "opus", "parallel": true },
    { "type": "plan-review", "provider": "my-codex-preset", "model": "o3" },
    { "type": "implementation", "provider": "anthropic-subscription", "model": "sonnet" },
    { "type": "code-review", "provider": "anthropic-subscription", "model": "sonnet", "parallel": true },
    { "type": "code-review", "provider": "anthropic-subscription", "model": "opus", "parallel": true },
    { "type": "code-review", "provider": "my-codex-preset", "model": "o3" }
  ],
  "bugfix_pipeline": [
    { "type": "rca", "provider": "anthropic-subscription", "model": "sonnet" },
    { "type": "rca", "provider": "anthropic-subscription", "model": "opus" },
    { "type": "plan-review", "provider": "my-codex-preset", "model": "o3" },
    { "type": "implementation", "provider": "anthropic-subscription", "model": "sonnet" },
    { "type": "code-review", "provider": "anthropic-subscription", "model": "sonnet", "parallel": true },
    { "type": "code-review", "provider": "anthropic-subscription", "model": "opus", "parallel": true },
    { "type": "code-review", "provider": "my-codex-preset", "model": "o3" }
  ],
  "max_iterations": 10,
  "team_name_pattern": "pipeline-{BASENAME}-{HASH}"
}
```

In the example above, plan-review stages 1+2 run in parallel, then stage 3 runs sequentially. Code-review stages 1+2 run in parallel, then stage 3 runs sequentially. The `parallel` field is optional (defaults to false) and only applies to `plan-review` and `code-review` types.

See `docs/schemas/dev-buddy.schema.json` for the full JSON Schema.

### Constraints

- Singleton stages (`requirements`, `planning`, `implementation`) may appear **at most once** per pipeline
- `requirements` and `planning` are **feature-only** — not allowed in bugfix pipeline
- `rca` is **bugfix-only** — not allowed in feature pipeline
- Each pipeline must have **at least one** `implementation` stage
- `model` is **required** on every stage entry — values must match `/^[a-zA-Z0-9._-]+$/` (prevents shell metacharacter injection)
- `parallel` is **optional** (boolean, default false) — only meaningful on `plan-review` and `code-review` stages. Setting `parallel: true` on non-review stages fails validation. `parallel: false` (or omitted) is accepted on any stage type.

### Config Validation

`loadPipelineConfig()` validates the config file:
- Each stage must have `type`, `provider`, and `model` (all required)
- Singleton constraints are enforced (e.g., at most 1 `requirements` stage)
- Stage types are validated against the 6 allowed types
- Pipeline-specific stage restrictions (e.g., `rca` only in bugfix)
- `parallel: true` rejected on non-review stages
- If the file is missing, factory defaults are returned

---

## Web Portal API Endpoints

The config server (`scripts/config-server.ts`) exposes these REST endpoints:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/presets` | List all presets (API keys masked) |
| GET | `/api/presets/:name` | Get preset (masked, or `?reveal=true` for full key) |
| PUT | `/api/presets/:name` | Create or update a preset |
| DELETE | `/api/presets/:name` | Remove a preset |
| POST | `/api/presets/:name/test` | Test a saved preset's connectivity (reads credentials from disk) |
| POST | `/api/test-preset` | Test unsaved preset credentials from form data (accepts credentials in body) |
| GET | `/api/stage-definitions` | Return all 6 stage type definitions from registry |
| GET | `/api/pipeline-config` | Get current pipeline config |
| PUT | `/api/pipeline-config` | Save pipeline config |
| GET | `/api/preset-models/:name` | Model list for a preset (subscription: sonnet/opus/haiku; api/cli: from preset) |
---

## API Task Runner Architecture

The API task runner (`scripts/api-task-runner.ts`) is a per-invocation script that creates a V2 Agent SDK session, runs one task, outputs the result as JSON to stdout, and exits. Each invocation is an independent process with its own V2 session — no shared state, no ports, no file locks. Multiple instances can run in parallel safely.

### Env Var Mapping

The subprocess env is built from an allowlist of safe host vars
(PATH, HOME, proxy, TLS certs, Windows essentials) plus provider overrides.
Not `...process.env` (avoids leaking full host env), not Linux-hardcoded
(handles Windows via USERPROFILE/APPDATA allowlist).

| Env Var | Source | Purpose |
|---------|--------|---------|
| `ANTHROPIC_BASE_URL` | `preset.base_url` | Route SDK to external provider |
| `ANTHROPIC_API_KEY` | `preset.api_key` | Authenticate with provider |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `preset.models[0]` | Map haiku alias |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | `preset.models[0]` | Map sonnet alias |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | `preset.models[0]` | Map opus alias |
| `CLAUDE_CODE_SUBAGENT_MODEL` | `preset.models[0]` | Model for nested subagents |

All aliases set to the same provider model name (case-sensitive).
Claude Code only accepts `haiku`/`sonnet`/`opus` as model identifiers.

### Per-Invocation Lifecycle

1. Parse args (`--preset`, `--model`, `--task`, `--cwd`, `--task-timeout`)
2. Load + validate preset from `readPresets()`
3. Build env: `buildSessionEnv(preset, model)` — platform-aware allowlist
4. Create V2 session: `unstable_v2_createSession({ model, env, permissionMode: 'default', allowedTools })`
5. Warmup: `session.send('Respond with OK')` + `collectSessionResult()`
6. Send actual task: `session.send(task)` + `collectSessionResult(session, taskTimeoutMs)`
7. Output result JSON to stdout: `{ event: "complete", result: "..." }` or `{ event: "error", error: "..." }`
8. `session.close()`, exit (0=success, 1=validation, 2=execution, 3=timeout)

### Key Design Decisions

- **`permissionMode: 'default'`** (not `bypassPermissions`) — security-first; explicit `allowedTools` list
- **Per-invocation isolation** — no shared state between tasks; parallel execution is naturally safe
- **Warmup failure exits with non-zero** — prevents running on a broken session
- **Timeout via `Promise.race`** — wall-clock timeout fires even if `session.stream()` yields nothing; on timeout, `session.close()` kills the orphaned stream consumer
- **Platform-aware env allowlist** — handles Windows (USERPROFILE, APPDATA, SystemRoot), proxy (HTTP_PROXY, HTTPS_PROXY), and TLS certs (NODE_EXTRA_CA_CERTS)
- **Bash tool timeout constraint** — The Bash tool has a hard max timeout of 600,000ms (10 min). API tasks with `timeout_ms` > 8 min must use `run_in_background: true` on the Bash tool, then poll with `TaskOutput(task_id, block: true, timeout: 600000)`. Pipeline SKILL.md files always use this pattern for API dispatch to avoid premature process termination.

---

## Scripts

| Script | Purpose |
|--------|---------|
| `orchestrator.ts` | Initialize/reset pipeline, show status (`bun orchestrator.ts [cmd]`) |
| `json-tool.ts` | Cross-platform JSON operations (`bun json-tool.ts [cmd]`) |
| `api-task-runner.ts` | Per-invocation V2 Agent SDK task runner for API presets |

### API Task Runner CLI

```
bun api-task-runner.ts --preset <name> --model <model> --task "<text>" --cwd <dir> [--task-timeout <ms>]
bun api-task-runner.ts --preset <name> --model <model> --task-stdin --cwd <dir> [--task-timeout <ms>]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--preset` | string | *required* | Preset name from `~/.vcp/ai-presets.json` |
| `--model` | string | *required* | Model name (must be in preset's `models[]` list) |
| `--task` | string | *required*\* | The task/prompt to execute |
| `--task-stdin` | flag | — | Read task from stdin (avoids argv size limits and ps exposure) |
| `--cwd` | string | `process.cwd()` | Working directory for the session |
| `--task-timeout` | ms | `300000` (5 min) | Per-task wall-clock timeout (from `ApiPreset.timeout_ms`) |

\* Either `--task` or `--task-stdin` is required. `one-shot-runner.ts` uses `--task-stdin` to avoid OS argv limits.

---

## Emergency Controls

If stuck:

1. **Check task state:** `TaskList()` to see blocked tasks (requires pipeline team to be active)
2. **Check artifacts:** Read `.vcp/task/*.json` files to understand progress
3. **Reset pipeline:** `bun "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.ts" reset --cwd "${CLAUDE_PROJECT_DIR}"`
4. **If TaskList() doesn't work:** Check that the pipeline team exists — team creation may need to be re-run

---

## Default Model Assignment (Default Config)

Model assignments are **configurable** via `~/.vcp/dev-buddy.json`. The defaults are shown below.

### Feature Pipeline Default

| Stage | Type | Agent | Provider | Model |
|-------|------|-------|----------|-------|
| 1 | requirements | requirements-gatherer | anthropic-subscription | opus |
| 2 | planning | planner | anthropic-subscription | opus |
| 3 | plan-review | plan-reviewer | anthropic-subscription | sonnet |
| 4 | plan-review | plan-reviewer | anthropic-subscription | opus |
| 5 | plan-review | plan-reviewer | anthropic-subscription | sonnet |
| 6 | implementation | implementer | anthropic-subscription | sonnet |
| 7 | code-review | code-reviewer | anthropic-subscription | sonnet |
| 8 | code-review | code-reviewer | anthropic-subscription | opus |
| 9 | code-review | code-reviewer | anthropic-subscription | sonnet |

### Bug-Fix Pipeline Default

| Stage | Type | Agent | Provider | Model |
|-------|------|-------|----------|-------|
| 1 | rca | root-cause-analyst | anthropic-subscription | sonnet |
| 2 | rca | root-cause-analyst | anthropic-subscription | opus |
| 3 | plan-review | plan-reviewer | anthropic-subscription | sonnet |
| 4 | implementation | implementer | anthropic-subscription | sonnet |
| 5 | code-review | code-reviewer | anthropic-subscription | sonnet |
| 6 | code-review | code-reviewer | anthropic-subscription | opus |
| 7 | code-review | code-reviewer | anthropic-subscription | sonnet |

Use the web portal (`/dev-buddy-config`) to reconfigure stages, swap providers (e.g., use a Codex CLI preset for final gates), or change models.
