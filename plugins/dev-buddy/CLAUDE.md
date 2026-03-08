# Claude Code - Multi-Session Orchestrator Pipeline

> Pipeline orchestration logic lives in `scripts/pipeline-driver.ts` (the TypeScript state machine).
> SKILL.md files are thin executor loops that call the driver and execute its JSON commands.
> **Exception:** `/dev-buddy-chatroom` is a standalone orchestration skill that manages its own multi-round deliberation loop directly (no pipeline-driver).

## Path Reference

| Variable | Purpose | Example |
|----------|---------|---------|
| `${CLAUDE_PLUGIN_ROOT}` | Plugin installation directory | `~/.claude/plugins/dev-buddy/` |
| `${CLAUDE_PROJECT_DIR}` | Your project directory | `/path/to/your/project/` |

**Important:** The `.vcp/task/` directory is created in your **project directory**, not the plugin directory.

## Quick Start

```
/dev-buddy-feature-implement [description]    # Feature development pipeline
/dev-buddy-bug-fix [description]              # Bug fix pipeline
/dev-buddy-once use <provider> [model] <task> # One-shot task (no pipeline)
/dev-buddy-chatroom <topic>                   # Multi-model deliberation chatroom
```

## Architecture

```
pipeline-driver.ts (TypeScript State Machine)
  ├── Loads config, resolves stages, manages state
  ├── Emits ONE JSON command per `next` call
  ├── Tracks command acknowledgment (replay on crash)
  └── Updates pipeline-tasks.json (hook contract) + pipeline-state.json (internal)

SKILL.md (Thin Executor Loop)
  ├── Calls: bun pipeline-driver.ts init|next
  ├── Parses JSON command → executes tool call
  ├── Reports: bun pipeline-driver.ts report --id <cmd_id> --result-file <path>
  └── Repeats until action === "done"
```

## Custom Agents

| Agent | Purpose |
|-------|---------|
| **requirements-gatherer** | Business Analyst + Product Manager hybrid (supports synthesis mode) |
| **planner** | Architect + Fullstack Developer hybrid |
| **plan-reviewer** | Architect + Security + QA hybrid |
| **implementer** | Fullstack + TDD + Quality hybrid (supports SINGLE_STEP_MODE) |
| **code-reviewer** | Security + Performance + QA hybrid |
| **root-cause-analyst** | Debugging + fault isolation for bug diagnosis |
| **phased-reviewer** | Lightweight per-step/batch reviewer for incremental verification |
| **cli-executor** | Thin wrapper that invokes external CLI tools (e.g., Codex) for reviews |

## Hook Enforcement

### UserPromptSubmit Hook (Guidance)
- **File:** `hooks/guidance-hook.ts`
- Reads `.vcp/task/*.json` to determine phase, injects advisory guidance

### SubagentStop Hook (Enforcement)
- **File:** `hooks/review-validator.ts`
- Validates reviewer outputs; returns `{"decision": "block"}` if review doesn't verify acceptance criteria
- Max 10 re-reviews per reviewer before escalating

## Output Formats

### User Story (`.vcp/task/user-story/`)

```
user-story/
├── manifest.json             # Index + metadata (written LAST)
├── meta.json                 # id, title, description
├── requirements.json         # functional, non_functional, constraints
├── acceptance-criteria.json  # AC array
├── scope.json                # in_scope, out_of_scope, assumptions
└── test-criteria.json        # test commands, patterns
```

### Plan (`.vcp/task/plan/`)

```
plan/
├── manifest.json             # Index + metadata (written LAST)
├── meta.json                 # id, title, summary, technical_approach
├── steps/1.json, 2.json...   # Individual step files
├── test-plan.json
├── risk-assessment.json
├── dependencies.json
└── files.json
```

### Pipeline Tasks (`.vcp/task/pipeline-tasks.json`)

Hook contract file. Contains `resolved_config`, `config_hash`, `team_name`, and `stages[]` array with `task_id`, `output_file`, `parallel_group_id`, `current_version`. Hooks read this file — never `pipeline-state.json`.

### Output File Naming

- Singleton stages: `user-story/manifest.json`, `plan/manifest.json`, `impl-result.json`
- Multi-instance: `{type}-{provider}-{model}-{index}-v{version}.json`
- Phased steps: `.vcp/task/impl-steps/impl-step-{N}-v{V}.json`
- Phased reviews: `.vcp/task/phased-reviews/phased-review-{provider}-{model}-step-{N}-v{V}.json`

## Config Format

Pipeline driven by `~/.vcp/dev-buddy.json`. Two ordered arrays for feature and bug-fix.

### Stage Types

| Type | Singleton | Pipeline | Agent | Output |
|------|-----------|----------|-------|--------|
| `requirements` | yes | feature | requirements-gatherer | `user-story/manifest.json` |
| `planning` | yes | feature | planner | `plan/manifest.json` |
| `plan-review` | no | both | plan-reviewer | `plan-review-{p}-{m}-{i}-v{v}.json` |
| `implementation` | yes | both | implementer | `impl-result.json` |
| `code-review` | no | both | code-reviewer | `code-review-{p}-{m}-{i}-v{v}.json` |
| `rca` | no | bugfix | root-cause-analyst | `rca-{p}-{m}-{i}-v{v}.json` |

### Constraints

- Singleton stages appear at most once per pipeline
- `requirements`/`planning` feature-only; `rca` bugfix-only
- `parallel: true` only on `plan-review` and `code-review`
- `phased_reviews` only on `implementation` stages (array, max 10)
- `max_iterations` (default 10), `max_phased_iterations` (default 3), `review_interval` (default 1)
- `model` required, must match `/^[a-zA-Z0-9._-]+$/`

See `docs/schemas/dev-buddy.schema.json` for full JSON Schema.

## Web Portal API

Config server (`scripts/config-server.ts`) endpoints:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/presets` | List presets (keys masked) |
| GET | `/api/presets/:name` | Get preset (`?reveal=true` for full key) |
| PUT | `/api/presets/:name` | Create/update preset |
| DELETE | `/api/presets/:name` | Remove preset |
| POST | `/api/presets/:name/test` | Test saved preset connectivity |
| POST | `/api/test-preset` | Test unsaved preset from form data |
| GET | `/api/stage-definitions` | Stage type definitions |
| GET | `/api/pipeline-config` | Current pipeline config |
| PUT | `/api/pipeline-config` | Save pipeline config |
| GET | `/api/preset-models/:name` | Model list for preset |
| GET | `/api/chatroom-config` | Current chatroom config |
| GET | `/api/chatroom-config/defaults` | Factory default chatroom config |
| PUT | `/api/chatroom-config` | Save chatroom config |

## Chatroom Config

Separate config file `~/.vcp/dev-buddy-chatroom.json` for multi-model deliberation:

```json
{
  "participants": [{ "preset": "minimax", "model": "MiniMax-M2.5" }],
  "max_rounds": 3
}
```

- `participants`: 0-10 `{ preset, model }` objects (0 valid for saving; skill validates >=1 at runtime)
- `max_rounds`: 1-10, default 3
- CLI presets require `one_shot_args_template`
- Config helper: `scripts/chatroom-config.ts`

## API Task Runner

`scripts/api-task-runner.ts` runs one task per invocation. Independent process — parallel-safe.

Two runners implementing `AgentRunner` interface:
- **`AnthropicRunner`** (default) — V2 Agent SDK with 6 tools
- **`OpenAIRunner`** (`protocol: 'openai'`) — function-calling loop via `fetch()` with 6 tools

### Env Var Mapping (Anthropic)

| Env Var | Source |
|---------|--------|
| `ANTHROPIC_BASE_URL` | `preset.base_url` |
| `ANTHROPIC_API_KEY` | `preset.api_key` |
| `ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL` | `preset.models[0]` |
| `CLAUDE_CODE_SUBAGENT_MODEL` | `preset.models[0]` |

All aliases → same provider model (case-sensitive). OpenAI runner uses direct HTTP headers.

### CLI

```
bun api-task-runner.ts --preset <name> --model <model> --task "<text>" --cwd <dir>
  [--task-stdin] [--task-timeout <ms>] [--system-prompt <path>]
```

`--system-prompt`: file under `docs/` appended to system prompt (review stages).

### One-Shot Runner

`scripts/one-shot-runner.ts` handles `/dev-buddy-once` and `/dev-buddy-chatroom` for API and CLI presets:
- API: spawns `api-task-runner.ts` with `--task-stdin`, parses JSON result from stdout
- CLI: uses `one_shot_args_template` from preset config
- `--output-id <token>`: writes result JSON to `/tmp/.vcp/oneshot/{token}.json` (via `os.tmpdir()`) for reliable retrieval by background tasks (bypasses unreliable stdout capture in Claude Code's background task system). Token must match `/^[a-zA-Z0-9._-]+$/` (no paths). Convention: `{preset}-{model}-{timestamp}-{pid}`

## Scripts

| Script | Purpose |
|--------|---------|
| `pipeline-driver.ts` | State machine: `init`, `next`, `report`, `status`, `reset` |
| `orchestrator.ts` | Human-readable CLI: `status`, `reset`, `dry-run`, `phase` |
| `api-task-runner.ts` | Per-invocation task runner (Anthropic/OpenAI) |
| `one-shot-runner.ts` | One-shot task runner for `/dev-buddy-once` |
| `config-server.ts` | Web portal backend |
| `pipeline-config.ts` | Config loading + validation |
| `chatroom-config.ts` | Chatroom config loading + validation |
| `json-tool.ts` | Cross-platform JSON operations |
| `preset-utils.ts` | Preset file I/O |
| `cli-executor.ts` | CLI preset execution wrapper |

## Emergency Controls

1. **Status:** `bun "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-driver.ts" status --cwd "${CLAUDE_PROJECT_DIR}"`
2. **Reset:** `bun "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.ts" reset --cwd "${CLAUDE_PROJECT_DIR}"`
3. **Check artifacts:** Read `.vcp/task/*.json` files
4. **Check tasks:** `TaskList()` (requires active pipeline team)
