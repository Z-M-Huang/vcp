---
name: dev-buddy-chatroom
description: Multi-model chatroom for collaborative ideation and design discussion
user-invocable: true
allowed-tools: Read, Bash, Task, TaskOutput, AskUserQuestion, Glob, Grep
---

# Multi-Model Chatroom

Spawn a multi-model deliberation "chatroom" where Claude formulates an approach, sends it to N configured AI models for critique, iterates until consensus or max rounds, then presents everything to the user.

This is a **standalone orchestration skill** — it manages its own multi-round deliberation loop directly, unlike pipeline skills which are thin executor loops over `pipeline-driver.ts`.

**Usage:** `/dev-buddy-chatroom <topic>`

**Examples:**
```
/dev-buddy-chatroom How should we architect a caching layer for the API?
/dev-buddy-chatroom Design a retry strategy for the payment service
/dev-buddy-chatroom What's the best approach for migrating from REST to GraphQL?
```

---

## Step 1: Parse Topic

Extract the topic from the user's message after `/dev-buddy-chatroom`. Everything after the skill trigger is the topic. If no topic is provided, ask the user with `AskUserQuestion`.

---

## Step 2: Read and Validate Config

Load the chatroom config through the helper (handles missing file, invalid JSON, structural validation, and defaults):

```bash
bun -e "
import { loadChatroomConfig } from '${CLAUDE_PLUGIN_ROOT}/scripts/chatroom-config.ts';
try {
  const config = loadChatroomConfig();
  console.log(JSON.stringify(config));
} catch (e) {
  console.error(JSON.stringify({ error: e.message }));
  process.exit(1);
}
"
```

If the command exits with code 1, report the error message to the user and suggest `/dev-buddy-config`.

If the config loads successfully but has 0 participants, report an error:
```
No chatroom participants configured. Use /dev-buddy-config to add participants in the Chatroom tab.
```

**Validate at least 1 participant** is configured. The config file allows 0 participants (for saving), but the skill requires at least 1 to execute.

Resolve each participant's preset by reading the presets file:

```bash
bun -e "
import { readPresets } from '${CLAUDE_PLUGIN_ROOT}/scripts/preset-utils.ts';
const presets = readPresets();
console.log(JSON.stringify(Object.entries(presets.presets).map(([k,v]) => ({
  name: k, type: v.type, models: v.models || ['haiku','sonnet','opus'],
  timeout_ms: v.timeout_ms
}))));
"
```

Validate each participant's preset exists and model is valid (same as dev-buddy-once Step 2).

---

## Step 3: Formulate Initial Draft

Think about the topic and write your initial approach/design/analysis. This is the draft that will be sent to all participants for critique. Be substantive — give participants something concrete to react to.

---

## Step 4: Fan Out to Participants (Parallel)

Launch ALL participants in parallel in a single message with multiple tool calls:

### Subscription Participants (`type: "subscription"`)

```
Task(
  subagent_type: "general-purpose",
  model: "<model>",
  prompt: "<deliberation prompt from templates below>"
)
```

Tell the subagent to respond with analysis only — no file editing, no tool use beyond reading.

### API Participants (`type: "api"`)

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/one-shot-runner.ts" \
  --type api \
  --preset "<exact_preset_name>" \
  --model "<model>" \
  --cwd "${CLAUDE_PROJECT_DIR}" \
  --task-stdin <<'TASK_EOF'
<deliberation prompt>
TASK_EOF
```

**MUST use `run_in_background: true`** — API tasks take 2-5 minutes.

### CLI Participants (`type: "cli"`)

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/one-shot-runner.ts" \
  --type cli \
  --preset "<exact_preset_name>" \
  --model "<model>" \
  --cwd "${CLAUDE_PROJECT_DIR}" \
  --task-stdin <<'TASK_EOF'
<deliberation prompt>
TASK_EOF
```

**MUST use `run_in_background: true`** — CLI tasks take 5-20 minutes.

### Timeout Contract (MUST Follow)

For API/CLI participants:

1. Save the returned `task_id` from the Bash tool. If `run_in_background` does not return a `task_id`, report a dispatch failure — do NOT retry in foreground mode.
2. **Derive timeout:** Read `timeout_ms` from preset config (default: 300000 for API, 1200000 for CLI).
3. **Poll with correct timeout (NOT the default 30s):**
   ```
   TaskOutput(task_id: "<task_id>", block: true, timeout: min(timeout_ms + 120000, 600000))
   ```
4. If TaskOutput returns but the task is still running, repeat with `timeout: 600000` until done.
5. NEVER use default 30s TaskOutput timeout.
6. NEVER retry in foreground mode.

---

## Step 5: Collect Responses

For each participant:
- **Subscription**: Read the Task tool result directly
- **API/CLI**: Read `TaskOutput` result, parse the JSON output:
  - `{"event": "complete", ...}` → extract `result` field
  - `{"event": "error", ...}` → note the error, continue with other participants

If a participant errored or timed out, note it in the output but continue with remaining responses.

---

## Step 6: Evaluate Consensus

Read all participant responses and determine:

1. **All agree** → Proceed to Step 7 (synthesis)
2. **Any disagree or partially agree** → If `current_round < max_rounds`:
   - Update your draft based on feedback
   - Go back to Step 4 with the updated draft and conversation history
3. **Max rounds reached** → Proceed to Step 7 regardless

Look for explicit "AGREE" or "DISAGREE" statements at the start of each response. If ambiguous, interpret the overall sentiment.

---

## Step 7: Present Results to User

Show the complete deliberation to the user:

1. **Your initial draft** (brief summary)
2. **Each round's responses** — for each participant per round, show:
   - Participant name (preset + model)
   - Their response (full text)
   - Whether they agreed or disagreed
3. **Final synthesis** — your updated approach incorporating feedback from all rounds
4. **Consensus status** — "All agreed in round N" or "Max rounds reached with partial agreement"

---

## Prompt Templates

### Round 1 Prompt

```
You are participating in a multi-model brainstorming discussion about a software design topic.

Think creatively and explore unconventional approaches. Challenge assumptions freely.
Propose bold alternatives rather than safe incremental suggestions. Play devil's advocate
where appropriate — the goal is to surface ideas the host AI might have missed.

TOPIC: {topic}

The host AI has proposed the following approach:

{claude_draft}

Analyze this approach:
1. State AGREE or DISAGREE clearly at the start
2. What are the strengths?
3. What's missing or could be improved?
4. If you disagree, what alternative do you propose?

Be specific and constructive. Keep your response concise.
```

### Subsequent Round Prompt

```
You are participating in a multi-model brainstorming discussion (Round {N} of {max_rounds}).

Think creatively. Challenge assumptions. Propose bold alternatives where you see opportunity.

TOPIC: {topic}

PREVIOUS ROUNDS:
{conversation_history}

The host has updated their approach based on feedback:

{updated_draft}

Has the updated approach addressed your concerns?
State AGREE or DISAGREE clearly at the start, then explain.
```

---

## Error Handling

| Scenario | Action |
|----------|--------|
| No config file | Report error, suggest `/dev-buddy-config` |
| 0 participants configured | Report error, suggest adding participants in Chatroom tab |
| Preset not found | Report which preset is missing, suggest `/dev-buddy-manage-presets` |
| Model not in preset | Report available models for that preset |
| Participant timeout | Note timeout, continue with other responses |
| Participant error | Note error, continue with other responses |
| All participants failed | Report all failures, suggest checking preset configs |
| No topic provided | Ask user with `AskUserQuestion` |

---

## Anti-Patterns

- Do NOT run a full pipeline — this is a standalone deliberation skill
- Do NOT create pipeline tasks (TaskCreate/TaskUpdate) — no orchestration infrastructure
- Do NOT skip preset resolution — always validate preset and model first
- For subscription: do NOT run the one-shot-runner.ts script — use Task tool directly
- Do NOT fall back to foreground Bash when background TaskOutput returns empty
- Do NOT retry API/CLI tasks in foreground mode
- Do NOT use the default TaskOutput timeout (30s) for API/CLI tasks
- Do NOT suppress participant errors — always report them to the user
- Do NOT hide individual model responses — show everything for transparency
