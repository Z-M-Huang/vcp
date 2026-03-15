---
name: dev-buddy-rca
description: Root cause analysis for bugs. Dispatches RCA executors in parallel, consolidates findings into a diagnosis. Outputs diagnosis only — does NOT create user-story or plan.
user-invocable: true
allowed-tools: Read, Write, Bash, Glob, Grep, Task, TaskOutput, AskUserQuestion
---

# RCA Stage Skill

Diagnose a bug by dispatching root cause analysis executors. Consolidates findings into a single diagnosis artifact. Does NOT create user-story or plan — user chains to `/dev-buddy-requirements` → `/dev-buddy-plan` next.

**Task directory:** `${CLAUDE_PROJECT_DIR}/.vcp/task/`

---

## Step 1: Load Config and Resolve Executors

```bash
bun -e "
import { loadDevBuddyConfig, getProviderType } from '${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-config.ts';
const config = loadDevBuddyConfig();
const stage = config.stages['rca'];
const executors = stage.executors.map(exec => ({
  ...exec,
  providerType: getProviderType(exec.preset)
}));
console.log(JSON.stringify({ executors }));
"
```

---

## Step 2: Prompt Assembly (Anti-Drift)

For each RCA executor:

```
ORIGINAL REQUEST: {user's bug description from conversation}
---

You are executing the ROOT CAUSE ANALYSIS stage.

Diagnose the bug described above. Do NOT fix it — diagnosis only.

1. Reproduce the bug (if possible)
2. Trace the data flow from symptom to source
3. Identify the root cause with evidence
4. Document affected files and fix constraints

Write output to .vcp/task/{output_file}

Output JSON format:
{
  "root_cause": { "summary": "...", "category": "logic|config|dependency|concurrency|..." },
  "root_file": "path/to/file.ts",
  "root_line": 42,
  "confidence": "high|medium|low",
  "affected_files": ["..."],
  "fix_constraints": ["minimal change", "..."],
  "evidence": ["trace of how you found it"],
  "excluded_hypotheses": ["things you ruled out and why"]
}
```

---

## Step 3: Determine Output Filenames

For each executor, compute the output filename:

```bash
bun -e "
import { getV3OutputFileName } from '${CLAUDE_PLUGIN_ROOT}/types/stage-definitions.ts';
console.log(getV3OutputFileName('rca', '{executor-name}', {index}, '{preset}', '{model}', 1));
"
```

---

## Step 4: Dispatch Executors

**Resolve system prompt** for each executor via `system-prompts.ts`, then route by provider type:

- **subscription:** `Task(subagent_type: "general-purpose", model: "<model>", prompt: "<system_prompt_content>\n---\n<assembled RCA prompt>")`
- **api:** `Bash(run_in_background: true)` → `api-task-runner.ts`
- **cli:** `Task(subagent_type: "general-purpose", prompt: "Run: bun cli-executor.ts ...")`

Group adjacent `parallel: true` executors → dispatch simultaneously. Sequential executors → dispatch one at a time.

---

## Step 5: Consolidate Findings

After all RCA executors complete, read all output files and consolidate:

**Multi-executor with synthesizer:**
When multiple executors are configured, all analysts (including the synthesizer — the last executor) write individual RCA files using the existing v3 output pattern. The synthesizer does its own root cause analysis AND reads prior outputs to form its diagnosis.

The consolidation logic below then runs across ALL RCA outputs (including the synthesizer's). The synthesizer CANNOT override the disagreement arbitration — if diagnoses conflict, the skill still escalates to the user via AskUserQuestion.

1. **If RCAs agree** (same root_file, similar root_cause):
   - Use the most detailed diagnosis
   - Merge evidence from all

2. **If RCAs disagree** (different root_file or contradictory causes):
   - Present both diagnoses to the user via AskUserQuestion
   - Ask: "Two analyses disagree on the root cause. Which is correct?"
   - Include summaries from each
   - Use the user's choice

3. **Write consolidated diagnosis** to `.vcp/task/rca-diagnosis.json`:
```json
{
  "root_cause": "...",
  "root_file": "path/to/file.ts",
  "root_line": 42,
  "confidence": "high",
  "affected_files": ["..."],
  "fix_constraints": ["..."],
  "evidence": ["..."],
  "sources": ["rca-executor1-...", "rca-executor2-..."]
}
```

---

## Step 6: Report Results

Present the consolidated diagnosis to the user:
- Root cause summary
- Root file and line
- Confidence level
- Affected files
- Fix constraints

Suggest next steps:
- `/dev-buddy-requirements` (create minimal user story from RCA context)
- Then `/dev-buddy-plan` → `/dev-buddy-implement`
