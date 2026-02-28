# vcp

Vibe Coding Protocol plugin — project initialization, security enforcement, quality checks, dependency verification, auditing, and test quality analysis for AI-generated code.

## Prerequisites

- **[Bun](https://bun.sh/)** — required for cross-platform hook execution. Hooks are TypeScript files run directly via `bun`.

## Components

### Skills

| Skill | Command | Description |
|-------|---------|-------------|
| vcp-init | `/vcp-init` | Initialize VCP configuration — creates `~/.vcp/config.json` (global) and `.vcp/config.json` (project), detects frameworks, scopes, discovers plugin path |
| vcp-context | `/vcp-context` | Inject VCP rule summaries into context — run after context compaction or at any time to refresh rules |
| vcp-dependency-check | `/vcp-dependency-check` | Verify lockfile hygiene, version ranges, package existence, typosquatting |
| vcp-pre-commit-review | `/vcp-pre-commit-review` | Review all staged/changed files against applicable standards. Produces PASS/BLOCK verdict |
| vcp-audit | `/vcp-audit [path] \| compliance [framework] \| quick` | Comprehensive audit against all standards. Supports full, compliance, and release readiness modes |
| vcp-root-cause-check | `/vcp-root-cause-check [bug or path]` | Analyze a proposed bug fix — determines if it addresses root cause or patches a symptom |
| vcp-review-tests | `/vcp-review-tests [path]` | Review test quality for anti-patterns: over-mocking, tautological tests, missing edge cases |
| vcp-coverage-gaps | `/vcp-coverage-gaps [path]` | Map source files to test files, identify untested functions and edge case gaps |
| vcp-test-plan | `/vcp-test-plan <path>` | Generate a test plan with unit tests, integration tests, edge cases, and mock guidance |

Scanning skills call `resolve-config.ts` via Bash to resolve project config, and fetch standards via WebFetch at runtime. No local standards copy is needed.

### Agents

| Agent | Description |
|-------|-------------|
| migration-planner | Audit a codebase against all VCP standards and produce a phased remediation plan (Security → Architecture → Quality → Compliance) |

### Hooks

| Hook | Event | Trigger | Description |
|------|-------|---------|-------------|
| security-context | SessionStart | Always | Injects VCP rule summaries into AI context at session start |
| security-gate | PreToolUse | `Write\|Edit\|Bash` | Blocks tool calls containing dangerous code patterns (CWE-798, CWE-89, CWE-95, CWE-79, CWE-502, CWE-643, CWE-1321, CWE-1336, CWE-116) |
| test-quality-warning | PostToolUse | `Write\|Edit` | Warns when test files contain mock-abuse patterns (excessive mocking, mock-only assertions, tautological assertions) |
| stop-reminder | Stop | Always | Reminds the user to run VCP checks before committing |

## How It Works

### Global Configuration

VCP uses a global config at `~/.vcp/config.json` to store machine-level settings shared across all projects:

- **`standards_url`** — URL to the standards manifest (default: VCP public repo; can point to internal GitHub Enterprise)
- **`pluginRoot`** — Absolute path to the VCP plugin directory
- **`debug`** — Enable diagnostic logging to `.vcp/vcp.log` in the project root (default: `false`)
- **`defaults`** — Optional defaults: `severity` and `ignore` are applied at runtime; `scopes` and `compliance` are proposed as starting points during `/vcp-init` only

Created by `/vcp-init` on first run. Subsequent project initializations reuse the existing global config. If the global config is missing when a skill runs (e.g., an existing user who hasn't run `/vcp-init` since the global config was introduced), it is auto-created from the project config and defaults. Hooks only read the global config — they never auto-create it (hooks run in untrusted repo context and must stay fast).

### Standards Discovery

Skills call `resolve-config.ts` (via Bash) to resolve project config and applicable standards. The script resolves the standards URL from global config (or per-project override), fetches the manifest, and resolves full URLs for each standard. Skills always apply the latest published rules.

URL resolution order:
1. `standards_url` in `.vcp/config.json` (rare per-project override)
2. `standards_url` in `~/.vcp/config.json` (the normal case)

### Project Configuration

Skills require `.vcp/config.json` (project) with a `pluginRoot` field (set by `/vcp-init`). Global config (`~/.vcp/config.json`) is auto-created if missing (from project config + defaults), so users don't need to run `/vcp-init` again after upgrading. The project config determines:
- Which scopes apply (web-frontend, web-backend, database, mobile, desktop, cli, devops, agentic-ai)
- Which compliance frameworks are active (GDPR, PCI DSS, HIPAA)
- What paths to exclude from scanning
- The minimum severity threshold for reporting
- Which standards or rules to ignore

At runtime, `severity` falls back to the global default when the project omits it, and `ignore` arrays are merged (union of global + project). `scopes` and `compliance` are required project fields — global defaults for these are only used as starting points during `/vcp-init`, not at runtime.

If `.vcp/config.json` is not found, skills stop and tell the user to run `/vcp-init`.

### Security Gate Hook

The `security-gate.ts` hook runs on every `Write`, `Edit`, or `Bash` tool call. It parses the tool input JSON from stdin and checks the content against 21 regex patterns across 9 CWEs:

- **CWE-798** — Hardcoded secrets (passwords, API keys), AWS access keys (AKIA/ASIA/etc.), private keys (all PEM formats), JWT tokens, database connection strings with embedded credentials, hardcoded Bearer tokens, Google/GitHub API key prefixes
- **CWE-89** — SQL string concatenation and template literal injection in query calls, covering Prisma (`$queryRawUnsafe`, `$executeRawUnsafe`) and Knex (`whereRaw`, `havingRaw`, `orderByRaw`, `joinRaw`)
- **CWE-95** — `eval()` with user-controlled input; shell `eval` with dynamic input (Bash only)
- **CWE-79** — `innerHTML` assigned a variable
- **CWE-502** — `pickle.load/loads`, `yaml.load` without Loader, `yaml.unsafe_load`/`full_load`, `node-serialize` `.unserialize()`
- **CWE-643** — XPath injection via string concatenation in `.xpath()` calls
- **CWE-1321** — Prototype pollution via `__proto__` or `constructor.prototype` assignment
- **CWE-1336** — Server-side template injection (SSTI): Jinja2 `Template()`/`.from_string()`, Handlebars `.compile()` with variable input
- **CWE-116** — Encoded data (base64/xxd) piped to shell execution or combined with `sh -c` (Bash only)

If any pattern matches, the hook exits with code 2 (block) and prints the finding to stderr (fed to Claude as error message). If patterns are suppressed via CWE ignore, the hook exits 0 and outputs a JSON warning to stdout (shown to user via `systemMessage`). Otherwise it exits 0 (allow).

### Diagnostic Log

All hooks write diagnostic entries to `.vcp/vcp.log` in the project root via the shared `vcp-logger.ts` module. The log records timestamps, hook names, decisions, and details for every invocation. Add `.vcp/*.log` to your `.gitignore`.

## Known Limitations

- **Standards fetched from mutable `main` branch:** Skills fetch standards from `https://raw.githubusercontent.com/.../main/...`, which is mutable. A force-push or repository compromise could change what all users receive. When VCP reaches v1.0, standards will be pinned to tagged releases. For v0.2.7, the always-latest behavior is intentional while standards are still being written.

- **Regex-based security gate cannot do taint tracking:** The security-gate hook uses regex pattern matching, which cannot follow data flow (e.g., a SQL query built in a variable then passed to `.query()`). Use the `/vcp-audit` or `/vcp-pre-commit-review` skills for AI-driven analysis that can trace data flow across variables.

- **Bash obfuscation via uncommon techniques:** The Bash obfuscation check catches decode-to-execution patterns (pipe to shell, `sh -c` with decode, `$SHELL`), but misses less common techniques like `python -c`, `perl -e`, variable indirection, or `$'\x...'` escaping. The AI skills provide deeper coverage.

- **Prisma `$queryRaw` tagged templates intentionally not flagged:** Prisma's `$queryRaw\`...\`` syntax with tagged template literals is parameterized and safe. Only `$queryRawUnsafe()` and `$executeRawUnsafe()` with parentheses are flagged.

## Installation

This plugin is part of the [VCP](https://github.com/Z-M-Huang/vcp) repository. Install it via the Claude Code marketplace or by adding the plugin source to your Claude Code configuration.
