---
name: dev-buddy-bug-fix
description: Dev Buddy bug-fix pipeline. Data-driven sequential RCA -> Consolidation -> Validation -> Implementation -> Code Reviews. Configurable pipeline.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task, TaskOutput, AskUserQuestion, Skill, TaskCreate, TaskUpdate, TaskList, TaskGet, TeamCreate, TeamDelete, SendMessage
---

# Bug-Fix Pipeline — Driver-Based Executor

You are a thin executor loop. The pipeline-driver.ts state machine decides what to do; you execute the tool calls it commands.

**Driver:** `${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-driver.ts`
**Task dir:** `${CLAUDE_PROJECT_DIR}/.vcp/task/`

---

## Execution Model

1. **ONE command at a time.** The driver returns ONE JSON command. Execute it, report, get next.
2. **WAIT for result.** After each tool call, WAIT for the result before reporting.
3. **NEVER skip steps.** If a command fails, report the failure. The driver decides recovery.
4. **User interruption = FULL STOP.** If the user sends a message mid-pipeline, report `{interrupted: true}`.

---

## Step 1: Initialize

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-driver.ts" init --pipeline bugfix --cwd "${CLAUDE_PROJECT_DIR}"
```

Parse the JSON output. This is your first command.

---

## Step 2: Execute-Report Loop

Repeat until `action === "done"`:

### 2a. Execute the command

Map `action` to the corresponding tool call:

| Action | Tool | Key Fields |
|--------|------|-----------|
| `create_team` | TeamCreate | `team_name` |
| `delete_team` | TeamDelete | `team_name` |
| `create_task` | TaskCreate | `subject`, `description`, `activeForm` |
| `update_task` | TaskUpdate | `taskId`, `status`, `description`, `activeForm`, `addBlockedBy` |
| `list_tasks` | TaskList | — |
| `get_task` | TaskGet | `taskId` |
| `spawn_agent` | Task | `subagent_type`, `name`, `model`, `prompt_file` (read file for prompt) |
| `spawn_background` | Bash | `command` with `run_in_background: true`, `timeout_ms` |
| `wait_for_task` | TaskOutput | `task_id`, `timeout_ms`, `poll_on_still_running` |
| `send_message` | SendMessage | `recipient`, `content_file` (read for content), `summary` |
| `shutdown_teammate` | SendMessage | type: `shutdown_request`, `recipient` |
| `ask_user` | AskUserQuestion | `question`, `options`, `context` |
| `show_status` | *(display)* | Show `message` to user |
| `read_file` | Read | `path` |
| `write_file` | Write | `path`, `content_file` (read for content) |
| `write_multi_file` | Write (multiple) | `files[]`, `manifest_path` + `manifest_content_file` written LAST |
| `parallel_batch` | *(multiple)* | Execute all `commands[]` in parallel |
| `noop` | *(skip)* | Driver handled internally; proceed to report |
| `done` | *(exit loop)* | Pipeline complete. Show `summary` to user. |
| `escalate` | AskUserQuestion | Show `error` + `context`, present `recovery_options` |
| `pause` | *(stop)* | Show `reason`. Wait for user to resume. |

### 2b. Report result

Write result to a temp file:

```bash
echo '<json>' > /tmp/vcp-report.json
bun "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-driver.ts" report \
  --cwd "${CLAUDE_PROJECT_DIR}" \
  --id "<command_id>" \
  --result-file /tmp/vcp-report.json
```

**Report JSON fields:**

```json
{
  "command_id": "<must match>",
  "ok": true,
  "taskId": "<from TaskCreate>",
  "task_id": "<from Bash run_in_background>",
  "answer": "<from AskUserQuestion>",
  "content": "<from Read file>",
  "tasks": [],
  "messages": [{"from": "...", "summary": "..."}],
  "batch_results": {"<sub_cmd_id>": {"ok": true, "taskId": "...", "task_id": "...", "content": "..."}},
  "interrupted": false,
  "exit_code": 0,
  "still_running": false,
  "error": "<if ok=false>"
}
```

Include only the fields relevant to the action. `command_id` and `ok` are always required.
For `parallel_batch`, include `batch_results` keyed by each sub-command's `command_id` with that sub-command's result fields.

### 2c. Get next command

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-driver.ts" next --cwd "${CLAUDE_PROJECT_DIR}"
```

Parse the JSON output. Go to 2a.

---

## Action-Specific Notes

### spawn_agent

Read the prompt from `prompt_file` path. Pass to Task tool:

```
Task(subagent_type: cmd.subagent_type, name: cmd.name, model: cmd.model, prompt: <file_content>)
```

For `cli` provider types (e.g., Codex): use `subagent_type: "dev-buddy:cli-executor"`. Do NOT pass `model` on the Task tool — the CLI tool receives it via flags in the prompt.

### spawn_background

Run the command with `Bash(command: cmd.command, run_in_background: true, timeout: cmd.timeout_ms)`. Report back the `task_id` from the Bash result.

### wait_for_task

Poll with `TaskOutput(task_id: cmd.task_id, block: true, timeout: min(cmd.timeout_ms, 600000))`. If result shows `still_running` and `poll_on_still_running` is true, re-poll up to `max_poll_attempts`. **Always include `task_id` (the background task ID from `cmd.task_id`) in the report.**

### parallel_batch

Execute all commands in `commands[]` as parallel tool calls in a single response. Collect all results. Report as a batch.

### write_multi_file

Write all `files[]` first, then write `manifest_path` + `manifest_content_file` LAST. The manifest signals completion.

### escalate

Present `error` and `context` to the user via AskUserQuestion. If `recovery_options` are provided, present them as choices. Report the user's answer.

---

## Emergency Controls

- **Reset:** `bun "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.ts" reset --cwd "${CLAUDE_PROJECT_DIR}"`
- **Status:** `bun "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-driver.ts" status --cwd "${CLAUDE_PROJECT_DIR}"`
- **Check artifacts:** Read `.vcp/task/*.json` files directly
