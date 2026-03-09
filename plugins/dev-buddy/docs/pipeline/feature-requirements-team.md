# Requirements Gathering (Team-Based, Feature Pipeline Only)

> **When to execute:** During the feature pipeline's requirements gathering phase. The orchestrator spawns specialist teammates for parallel exploration, runs an interactive loop, then synthesizes via the requirements-gatherer agent.

---

## Specialist Catalog

| Specialist | Spawn When | Focus | Output File |
|-----------|-----------|-------|-------------|
| **Technical Analyst** | Always | Existing code, patterns, constraints, dependencies, files to change | `.vcp/task/analysis-technical.json` |
| **UX/Domain Analyst** | Always | User workflows, edge cases, industry patterns, accessibility | `.vcp/task/analysis-ux-domain.json` |
| **Security Analyst** | Always | VCP standards + OWASP (when VCP detected), threat model, non-functional requirements | `.vcp/task/analysis-security.json` |
| **Performance Analyst** | Always | Load impact, scalability, resource usage, bottlenecks, caching | `.vcp/task/analysis-performance.json` |
| **Architecture Analyst** | Always | Design patterns, SOLID principles, code organization, maintainability, best practices | `.vcp/task/analysis-architecture.json` |

All 5 core specialists are **always spawned** for every request.

Additional specialists should write their analysis to `.vcp/task/analysis-<type>.json` following the same output format.

---

## Step 1: Analyze the Request

Always spawn all 5 core specialists. Determine if additional specialists are needed.

## Step 1.5: VCP Detection (Pre-Specialist)

Detect whether VCP is configured. Result is used only for the Security Analyst prompt.

1. Read `.vcp/config.json` from the project root. Extract the `pluginRoot` field.
   If `.vcp/config.json` does not exist, try `.vcp.json` as a fallback (legacy location).
   When `generate-context.ts` runs in step 5, its internal `loadConfig()` will auto-migrate
   `.vcp.json` -> `.vcp/config.json` (see `vcp-context-core.ts:112-125`).
2. If neither file exists or `pluginRoot` is missing -> `vcp_detected = false`. Skip to Step 2.
3. **Validate `pluginRoot`:** Must be absolute, contain `/.claude/` (or `\.claude\` on Windows),
   must NOT contain `..` path segments (prevents traversal bypassing the `.claude/` check),
   and contain only safe path characters (letters, digits, `/`, `\`, `-`, `_`, `.`, `:`, spaces).
   Reject shell metacharacters (`;`, `&`, `|`, `$`, `` ` ``, `(`, `)`, `{`, `}`, `<`, `>`, `!`,
   `~`, `#`, `*`, `?`, `[`, `]`, `'`, `"`). If invalid -> `vcp_detected = false`. Skip to Step 2.
4. Verify `<pluginRoot>/lib/vcp-context-core.ts` exists via Glob.
   If missing -> `vcp_detected = false`. Skip to Step 2.
5. Run the VCP context CLI:
   ```bash
   bun "<pluginRoot>/lib/generate-context.ts" "${CLAUDE_PROJECT_DIR}"
   ```
6. Capture stdout as `vcp_context_output`.
   If it starts with `"## VCP Standards Context"` -> `vcp_detected = true`.
   Otherwise (fallback message, init prompt, or empty) -> `vcp_detected = false`. Skip to Step 2.

Detection is silent — do not warn the user if VCP is not detected.

**Trust model:** The `standards_url` (in project or global config) is considered trusted.
Standards content fetched from this URL is injected into the analyst prompt without
sanitization. This is consistent with VCP's existing trust model — `standards_url`
is set by the developer during `/vcp-init` and points to a controlled repository.

## Step 2: Spawn Specialist Teammates [PARALLEL OK]

Read `team_name` from `.vcp/task/pipeline-tasks.json` and spawn specialist teammates:

```
Task(
  name: "technical-analyst",
  team_name: <team_name>,
  subagent_type: "general-purpose",
  model: "opus",
  prompt: "You are a Technical Analyst. Explore the codebase for [feature]. Message findings to lead. Write to .vcp/task/analysis-technical.json."
)
```

Always spawn all 5 core specialists. Spawn additional specialists as warranted.

**Security Analyst spawn (VCP-aware):**

If `vcp_detected == true`:
```
Task(
  name: "security-analyst",
  team_name: <team_name>,
  subagent_type: "general-purpose",
  model: "opus",
  prompt: "You are a Security Analyst. This project uses VCP standards.

VCP STANDARDS (use as your primary analysis checklist):
<vcp_context>
{vcp_context_output}
</vcp_context>

For each VCP standard listed above, evaluate whether [feature] introduces concerns.
The context contains standards in the format: **StandardName** (severity): rule1 | rule2 | ...
Extract every standard name that appears in the context above — those are the standards
you must evaluate and list in your output.

Also perform general OWASP Top 10 analysis for gaps not covered by VCP.
Compliance-tagged rules (GDPR, PCI-DSS, HIPAA) are included above if the
project has those scopes enabled — assess compliance implications where relevant.

Write to .vcp/task/analysis-security.json:
{
  \"specialist\": \"security\",
  \"vcp_active\": true,
  \"vcp_standards_referenced\": [\"Security\", \"Data Flow Security\", \"Dependency Management\"],
  \"summary\": \"Brief overall assessment\",
  \"findings\": [
    {
      \"area\": \"Input Validation\",
      \"severity\": \"high\",
      \"description\": \"User input flows to database query without parameterization\",
      \"vcp_rule\": \"Data Flow Security: Trace every path from source to sink\",
      \"recommendation\": \"Use parameterized queries for all database access\"
    }
  ],
  \"recommendations\": [\"Implement input validation at API boundary\"],
  \"constraints\": [\"Must use parameterized queries, not string concatenation\"],
  \"questions_for_user\": [\"Are there existing validation utilities we should reuse?\"]
}

The vcp_standards_referenced array MUST list every VCP standard name you found
in the context above. findings[].vcp_rule is optional — include it when a finding
maps to a specific VCP rule, omit for generic OWASP findings.

Message key findings to lead as you discover them."
)
```

If `vcp_detected == false`:
```
Task(
  name: "security-analyst",
  team_name: <team_name>,
  subagent_type: "general-purpose",
  model: "opus",
  prompt: "You are a Security Analyst. Perform OWASP Top 10 analysis for [feature].

Write to .vcp/task/analysis-security.json:
{
  \"specialist\": \"security\",
  \"vcp_active\": false,
  \"vcp_standards_referenced\": [],
  \"summary\": \"Brief overall assessment\",
  \"findings\": [
    {
      \"area\": \"Authentication\",
      \"severity\": \"medium\",
      \"description\": \"No rate limiting on login endpoint\",
      \"recommendation\": \"Add rate limiting to prevent brute force attacks\"
    }
  ],
  \"recommendations\": [\"Add rate limiting middleware\"],
  \"constraints\": [\"Follow OWASP authentication guidelines\"],
  \"questions_for_user\": [\"What authentication method is preferred?\"]
}

Message key findings to lead as you discover them."
)
```

**WAIT for ALL spawn calls to return before proceeding to Step 2.1.**

## Step 2.1: Spawn Verification Gate

After ALL Task spawn calls return, verify results:

1. Build `spawned_specialists` list: names of all specialists whose Task call returned successfully
2. Build `failed_specialists` list: names of all specialists whose Task call returned an error or timed out

**If ALL spawned successfully:** Set `approved_specialists = spawned_specialists`. Proceed to Step 3.

**If ANY failed:** STOP. Do NOT proceed. Do NOT decide to "continue with remaining specialists." Escalate:

```
AskUserQuestion:
  "{N} of {TOTAL} specialists failed to spawn: {failed names}.
   Options:
   1. Retry the failed specialists
   2. Continue with {TOTAL - N} specialists (missing: {failed names})
   3. Abort requirements gathering"
```

If user chooses retry: re-spawn only the failed ones, then re-verify.
If user chooses continue: set `approved_specialists = spawned_specialists` (excluding failed). Record which are skipped — this determines the expected files in Step 4.1.

**Carry forward:** The `approved_specialists` list is used by Step 4.1 and the synthesis prompt.

**Name-to-filename mapping:**

| Specialist Name | Expected File |
|----------------|---------------|
| `technical-analyst` | `analysis-technical.json` |
| `ux-domain-analyst` | `analysis-ux-domain.json` |
| `security-analyst` | `analysis-security.json` |
| `performance-analyst` | `analysis-performance.json` |
| `architecture-analyst` | `analysis-architecture.json` |

For additional specialists, the pattern is `analysis-{type}.json` where `{type}` matches the specialist name prefix.

**Note on stale files:** Step 1 runs `orchestrator.ts reset` which clears the entire `.vcp/task/` directory. Files from prior runs cannot exist when Step 4 runs.

## Step 3: Interactive Loop [INTERACTIVE LOOP]

Relay messages between specialists and the user. Each iteration follows a strict sequential order:

1. Receive incoming messages from specialists (automatic)
2. Summarize specialist questions -> call `AskUserQuestion` to ask the user
3. **WAIT** for the user's answer (your response ends here — user's answer starts your next turn)
4. Call `SendMessage` to relay the user's answer to the relevant specialist(s)
5. Repeat from (1)

**Exit condition:** Specialists stop sending new messages AND analysis files should be ready.

**Within each iteration, calls are SEQUENTIAL (receive -> ask -> wait -> send). Do NOT issue AskUserQuestion and SendMessage in the same response.**

**During this loop, do NOT:**
- Spawn any new agents
- Start synthesis (Step 5)
- Run Bash file-check commands
- Make any tool calls other than receiving messages, AskUserQuestion, and SendMessage

## Step 4: Validate Analysis Files

When the interactive loop winds down, validate the analysis files. Check both existence AND JSON shape:

```bash
bun -e "
try {
  const { readdirSync, readFileSync } = require('fs');
  const { join } = require('path');
  const dir = '${CLAUDE_PROJECT_DIR}/.vcp/task';
  const files = readdirSync(dir).filter(f => f.startsWith('analysis-') && f.endsWith('.json'));
  const results = files.map(f => {
    try {
      const data = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
      const valid = typeof data.specialist === 'string'
        && Array.isArray(data.findings)
        && data.findings.length > 0
        && typeof data.findings[0].area === 'string';
      return { file: f, valid, specialist: data.specialist, findings_count: data.findings?.length ?? 0 };
    } catch (e) { return { file: f, valid: false, error: 'invalid JSON: ' + e.message }; }
  });
  console.log(JSON.stringify({ ok: true, found: files, validated: results }, null, 2));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e.message }));
}
"
```

**WAIT** for the Bash result before proceeding.

## Step 4.1: Completion Verification Gate

Compare the validated files against `approved_specialists` from Step 2.1:

For each specialist in `approved_specialists`, check that:
1. The corresponding `analysis-{type}.json` file was found
2. The file has valid JSON with `specialist` and `findings` fields

**If ALL approved specialists have valid files:** Save the validation output. Proceed to Step 5.

**If ANY approved specialist's file is missing or invalid:** STOP. Escalate:

```
AskUserQuestion:
  "Analysis files incomplete:
   - Missing: {list of missing files}
   - Invalid: {list of files with bad JSON}
   Approved specialists: {approved_specialists list}
   Options:
   1. Wait longer (I'll re-check in a moment)
   2. Proceed with available valid analyses (missing: {list})
   3. Abort requirements gathering"
```

If user chooses wait: re-run Step 4.
If user chooses proceed: note the missing/invalid analyses for the synthesis prompt.

## Step 5: Synthesize via Requirements Gatherer

**PRE-CONDITION:** Step 4.1 must have passed. All approved files confirmed valid (or user approved partial).

**This is a single Task call.** Do NOT combine with any other operation.

Include the validation output from Step 4 in the prompt:

```
Task(
  subagent_type: "dev-buddy:requirements-gatherer",
  model: "opus",
  prompt: "Synthesis mode.
    APPROVED SPECIALISTS: {approved_specialists list from Step 2.1}
    VALIDATED ANALYSIS FILES (from Step 4):
    {paste the validation JSON output here}
    {if partial: 'MISSING/INVALID ANALYSES: {list}. Account for gaps in user story.'}
    Read the validated analysis files from .vcp/task/.
    Validate scope with user via AskUserQuestion.
    Get explicit approval before writing user-story/manifest.json."
)
```

**WAIT** for the requirements-gatherer to return before proceeding to Step 6.

**If the requirements-gatherer fails:** STOP. Escalate to user via AskUserQuestion.

## Step 6: Shut Down Specialist Teammates (Phase Cleanup Gate)

**PRE-CONDITION:** Step 5 MUST have returned. Verify user-story/manifest.json exists and is valid:

```bash
bun -e "
try {
  const { readFileSync } = require('fs');
  const data = JSON.parse(readFileSync('${CLAUDE_PROJECT_DIR}/.vcp/task/user-story/manifest.json', 'utf-8'));
  const valid = data.artifact === 'user-story' && typeof data.ac_count === 'number' && data.ac_count > 0;
  console.log(JSON.stringify({ exists: true, valid, title: data.title, ac_count: data.ac_count }));
} catch (e) {
  console.log(JSON.stringify({ exists: false, valid: false, error: e.message }));
}
"
```

**WAIT** for result. If file missing or invalid, STOP and escalate to user via AskUserQuestion.

**If user-story/manifest.json is valid:**
1. Send `shutdown_request` to ALL specialist teammates via SendMessage
2. Track which specialists have confirmed shutdown
3. If any specialist has not confirmed after ~60 seconds (1-2 idle notifications without a shutdown confirmation), re-send `shutdown_request` to that specialist
4. If a specialist still has not confirmed after the retry, **proceed anyway** — mark requirements task as completed. Unresponsive teammates will be cleaned up when the pipeline team is deleted at completion.
5. Mark requirements task as completed via TaskUpdate
6. **Return control to the Main Loop.** Do NOT manually start the next stage — let the main loop call `TaskList()` to find the next unblocked task.

**Rationale:** Teammates may go idle without processing the shutdown request (known edge case). The pipeline team deletion at the end of the pipeline (`TeamDelete`) will clean up any lingering teammates, so it is safe to proceed past unresponsive specialists.
