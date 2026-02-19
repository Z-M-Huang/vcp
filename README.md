<p align="right"><a href="https://github.com/Z-M-Huang/vcp/wiki/Home.zh">中文文档</a></p>

<div align="center">

# VCP — Vibe Coding Protocol

**Make AI-generated code secure, maintainable, and architecturally sound from the first line.**

![Visitors](https://visitor-badge.laobi.icu/badge?page_id=Z-M-Huang.vcp&style=flat-square)
![GitHub release](https://img.shields.io/github/v/release/Z-M-Huang/vcp?style=flat-square)
![GitHub license](https://img.shields.io/github/license/Z-M-Huang/vcp?style=flat-square)
![GitHub last commit](https://img.shields.io/github/last-commit/Z-M-Huang/vcp?style=flat-square)
![Windows](https://img.shields.io/badge/Windows-0078D6?style=flat-square&logo=windows&logoColor=white)
![macOS](https://img.shields.io/badge/macOS-000000?style=flat-square&logo=apple&logoColor=white)
![Linux](https://img.shields.io/badge/Linux-FCC624?style=flat-square&logo=linux&logoColor=black)

![32 Standards](https://img.shields.io/badge/Standards-32-blue?style=flat-square)
![9 Scopes](https://img.shields.io/badge/Scopes-9-green?style=flat-square)
![OWASP Top 10](https://img.shields.io/badge/OWASP_Top_10-Covered-critical?style=flat-square)

</div>

VCP is a standards enforcement protocol for AI coding assistants. It injects security and architecture rules directly into the AI's context, blocks dangerous patterns in real time, and provides deep on-demand analysis — so the code your AI writes follows the same principles a senior engineer would enforce in code review.

---

## Table of Contents

- [Why VCP Matters](#why-vcp-matters)
- [What You Get](#what-you-get)
  - [Prevention, Not Just Detection](#prevention-not-just-detection)
  - [Coverage Backed by Industry Standards](#coverage-backed-by-industry-standards)
  - [Organization-Wide Enforcement](#organization-wide-enforcement)
- [How It Works](#how-it-works)
  - [Layer 1: Proactive Context](#layer-1-proactive-context--prevent-before-writing)
  - [Layer 2: On-Demand Scanning](#layer-2-on-demand-scanning--deep-analysis)
  - [Layer 3: Real-Time Blocking](#layer-3-real-time-blocking--stop-dangerous-code-instantly)
- [Quick Start](#quick-start)
- [Organization-Wide Standards](#organization-wide-standards)
- [Configuration](#configuration)
- [Standards Coverage](#standards-coverage)
- [Core Philosophy](#core-philosophy)
- [Roadmap](#roadmap)
- [How to Contribute](#how-to-contribute)
- [Repo Structure](#repo-structure)
- [References](#references)
- [License](#license)

---

## Why VCP Matters

AI coding assistants produce code fast. They also produce code that's **2.74x more likely to contain security vulnerabilities**, **40% more complex**, and architecturally unsound at scale. The research is consistent:

| Problem | Data | Source |
|---------|------|--------|
| Security vulnerabilities | 2.74x higher rate than human code; 45% of AI code has vulnerabilities | CodeRabbit 2025, Veracode 2025 |
| Code duplication | 8-fold increase across 211M lines analyzed | GitClear 2024 |
| Complexity growth | 40% increase in AI-assisted repositories | CMU 2025 |
| Hallucinated packages | ~20% of recommendations reference non-existent packages | Lasso Security |
| Refactoring collapse | Dropped from 25% to <10% of changed lines | GitClear 2024 |

**The death spiral:** AI generates working code fast. A bug appears. AI patches the symptom, not the root cause. The patch breaks assumptions elsewhere. Each fix compounds the problem — hack on top of hack. The codebase becomes unmaintainable within months.

VCP breaks this cycle by making the AI aware of engineering principles *before* it writes code, not after.

---

## What You Get

### Prevention, Not Just Detection

Most code quality tools scan after the fact. VCP works at the source — the AI's context window:

- **Standards injected at session start** — The AI internalizes 100+ rules covering security, architecture, root cause analysis, testing, error handling, code quality, dependency management, and secure defaults while it writes code
- **Real-time blocking** — 19 regex patterns across 9 CWEs block hardcoded secrets, SQL injection, eval injection, XSS, insecure deserialization, XPath injection, prototype pollution, and shell obfuscation *before code is written to disk*
- **Deep analysis on demand** — AI-driven scanning traces data flow across variables and understands semantic intent — catches what regex cannot

### Coverage Backed by Industry Standards

VCP standards are mapped against authoritative security frameworks:

- **OWASP Top 10:2025** — All 10 categories covered
- **CWE Top 25:2024** — 19/25 covered (6 uncovered are memory-safety, out of scope for managed languages)
- **OWASP API Security Top 10:2023** — All 10 categories addressed
- **OWASP ASVS v5.0** — 15/17 chapters covered
- **OWASP Docker Security** — 11/13 controls covered

### Organization-Wide Enforcement

VCP's manifest system is designed for teams and organizations. You can host your own standards alongside or instead of the defaults — enforcing company-specific rules, internal security policies, or regulatory requirements across every project and every developer using AI coding tools.

---

## How It Works

VCP enforces standards through three complementary layers:

### Layer 1: Proactive Context — Prevent Before Writing

At session start, VCP injects a compact summary of all applicable rules into the AI's context. The AI internalizes security, architecture, testing, and quality rules *while it writes code* — preventing violations at the source.

Run `/vcp-context` to re-inject rules at any time (useful after context compaction in long sessions).

### Layer 2: On-Demand Scanning — Deep Analysis

Skills scan code against 32 standards across 9 scopes using AI-driven analysis:

| Skill | What It Does |
|-------|-------------|
| `/vcp-audit` | Full audit against all applicable standards — security, architecture, quality, compliance |
| `/vcp-pre-commit-review` | Reviews all changed files before commit, produces PASS/BLOCK verdict |
| `/vcp-dependency-check` | Lockfile hygiene, version ranges, package existence, typosquatting detection |
| `/vcp-review-tests` | Test quality: over-mocking, tautological tests, missing edge cases |
| `/vcp-coverage-gaps` | Maps source to test files, finds untested functions and missing edge cases |
| `/vcp-test-plan` | Generates test plans with unit/integration tests, edge cases, and mock guidance |
| `/vcp-root-cause-check` | Analyzes bug fixes for root cause vs. symptom patching |

### Layer 3: Real-Time Blocking — Stop Dangerous Code Instantly

A security gate hook runs on every `Write`, `Edit`, and `Bash` call, blocking dangerous patterns before they reach disk:

<details>
<summary><strong>19 patterns across 9 CWEs</strong> — click to expand</summary>

| CWE | What It Catches |
|-----|----------------|
| CWE-798 | Hardcoded secrets, AWS keys, private keys, JWT tokens, DB connection strings, Bearer tokens, API key prefixes |
| CWE-89 | SQL injection via string concatenation and template literals |
| CWE-95 | Code injection via `eval()` with user input |
| CWE-79 | XSS via `innerHTML` with variable assignment |
| CWE-502 | Insecure deserialization: pickle, unsafe YAML, node-serialize |
| CWE-643 | XPath injection via string concatenation |
| CWE-1321 | Prototype pollution via `__proto__` or `constructor.prototype` |
| CWE-116 | Encoded data piped to shell execution |

</details>

**No single layer catches everything.** Layer 1 prevents violations at the source. Layer 3 blocks the most dangerous patterns instantly. Layer 2 catches the nuanced issues through deep analysis. Together they provide defense in depth.

---

## Quick Start

```bash
# Install the plugin
claude plugin add vcp

# Initialize your project (creates ~/.vcp/config.json + .vcp.json)
/vcp-init
```

Once initialized:
- Standards are injected into the AI's context automatically at session start
- The security gate blocks dangerous patterns on every write
- Skills (`/vcp-audit`, `/vcp-pre-commit-review`, etc.) are available on demand
- A stop reminder fires before commits, prompting you to run VCP checks

---

## Organization-Wide Standards

VCP's configuration system supports custom standards manifests, enabling organizations to enforce their own rules across all projects and developers.

### How It Works

The manifest is a two-level structure: a **root manifest** points to **scope manifests**, which point to **individual standards**. All references use full HTTPS URLs, so standards can be hosted anywhere — GitHub, internal servers, CDNs, or any mix.

```
Root Manifest (manifest.json)
├── core scope     → https://your-org.github.io/standards/scopes/core.json
│   ├── core-security.md      (VCP default)
│   ├── core-architecture.md  (VCP default)
│   └── org-coding-style.md   (your custom standard)
├── web-backend    → https://your-org.github.io/standards/scopes/web-backend.json
│   ├── web-backend-security.md   (VCP default)
│   └── org-api-conventions.md    (your custom standard)
└── org-internal   → https://your-org.github.io/standards/scopes/org-internal.json
    ├── org-logging-policy.md     (your custom standard)
    └── org-data-classification.md (your custom standard)
```

<details>
<summary><strong>Set up for your organization</strong> — click to expand</summary>

#### 1. Create your standards

Write markdown files following the [VCP format spec](standards/README.md). Each standard has YAML frontmatter, a principle, numbered rules with code examples, and anti-patterns.

#### 2. Create scope manifests

JSON files listing your standards with severity and tags:

```json
{
  "scope": "org-internal",
  "standards": [
    {
      "id": "org-logging-policy",
      "url": "https://your-org.github.io/standards/org-logging-policy.md",
      "severity": "high",
      "tags": ["logging", "compliance"]
    }
  ]
}
```

#### 3. Create a root manifest

Point to your scope manifests (include VCP defaults or replace them):

```json
{
  "version": "2.0",
  "repository": "https://github.com/your-org/vcp-standards",
  "scopes": {
    "core": {
      "manifest": "https://your-org.github.io/standards/scopes/core.json",
      "applies": "always"
    },
    "org-internal": {
      "manifest": "https://your-org.github.io/standards/scopes/org-internal.json",
      "applies": "always"
    }
  }
}
```

#### 4. Point VCP to your manifest

Set the URL globally (applies to all projects) or per-project:

```bash
# Global — all projects on this machine use your org's standards
/vcp-config global set standards_url https://your-org.github.io/standards/manifest.json

# Per-project — override for a specific repo
/vcp-config set standards_url https://your-org.github.io/standards/manifest.json
```

</details>

### What This Enables

- **Consistent enforcement** — Every developer using AI coding tools follows the same rules, regardless of which project they're in
- **Mix and match** — Include VCP's default standards alongside your own, or replace them entirely
- **Central updates** — Update a standard once, and every project picks up the change on next session start
- **Scope targeting** — Custom scopes can be applied always, per-scope toggle, or per-compliance framework
- **Schema validation** — Manifests are validated against [published JSON schemas](schemas/) for correctness

See [`schemas/vcp-manifest.schema.json`](schemas/vcp-manifest.schema.json) and [`schemas/vcp-scope-manifest.schema.json`](schemas/vcp-scope-manifest.schema.json) for the full manifest contract.

---

## Configuration

VCP uses two config files:

| File | Scope | Purpose |
|------|-------|---------|
| `~/.vcp/config.json` | Global (machine-wide) | Standards URL, plugin path, default severity/scopes/compliance/ignore |
| `.vcp.json` | Project | Scopes, compliance frameworks, severity threshold, frameworks, exclude patterns, ignore rules |

Manage via natural language with `/vcp-config`:

<details>
<summary><strong>Configuration examples</strong> — click to expand</summary>

```
/vcp-config ignore core-architecture          # Suppress a standard
/vcp-config ignore core-security/rule-3       # Suppress a specific rule
/vcp-config ignore CWE-798                    # Suppress a security gate pattern
/vcp-config enable database scope             # Toggle a scope
/vcp-config add gdpr compliance               # Add a compliance framework
/vcp-config set severity to high              # Change severity threshold
/vcp-config global show                       # View global config
```

</details>

---

## Standards Coverage

32 standards across 9 scopes:

| Scope | Standards | What They Cover |
|-------|-----------|----------------|
| **Core** (always active) | 9 | Security, architecture, root cause analysis, code quality, error handling, testing, dependency management, secure defaults, API misuse prevention |
| **Web Frontend** | 4 | XSS prevention, CSP, accessibility (WCAG 2.2), performance, component structure |
| **Web Backend** | 5 | Injection prevention, API design, WebSocket/SSE, caching security, backend structure |
| **Database** | 2 | Encryption (TDE, column-level, key management), schema security (RLS, masking, audit) |
| **Mobile** | 1 | Keychain/KeyStore, certificate pinning, deep links, biometrics, attestation |
| **Desktop** | 1 | Electron context isolation, Tauri capabilities, IPC validation, code signing |
| **CLI** | 1 | Shell injection, argument injection, exit codes, signal handling |
| **DevOps** | 4 | Containers, CI/CD, Infrastructure as Code, Kubernetes |
| **Compliance** | 3 | GDPR/CCPA, PCI DSS v4.0, HIPAA |

All standards follow a consistent format: **WHY** (the principle), **WHAT** (numbered actionable rules), **HOW** (code examples and anti-patterns). See [`standards/README.md`](standards/README.md) for the format specification.

---

## Core Philosophy

1. **Security comes first.** No feature is worth a vulnerability.
2. **Architecture comes second.** Every change respects the system's structure.
3. **Fix the root cause, not the symptom.** Trace bugs to where they originate. Break the death spiral.
4. **Principled, not prescriptive.** Explain WHY, not just WHAT. Allow alternatives that satisfy the principle.
5. **AI-parseable.** Standards are structured for machine consumption — consistent format, unambiguous rules.

### Non-Goals

VCP governs **code that AI agents write**, not the surrounding infrastructure or policies:

- Repository controls (branch protection, CODEOWNERS, MFA)
- CI/CD operational config (deployment gates, approval workflows)
- SBOM generation and signed builds
- Incident response and SLAs
- Organizational security policies (training, access reviews)

If a control doesn't affect what code gets written, it's not a VCP standard.

---

## Roadmap

See [GitHub Issues](https://github.com/Z-M-Huang/vcp/issues) for the full backlog. Key upcoming items:

- [ ] [Conformance Model](https://github.com/Z-M-Huang/vcp/issues/25) — MUST/SHOULD/MAY with objective pass/fail criteria
- [ ] [Agentic AI Security](https://github.com/Z-M-Huang/vcp/issues/26) — Prompt injection, tool boundaries, human approval gates
- [ ] [Codex CLI Support](https://github.com/Z-M-Huang/vcp/issues/19) — Adapt for OpenAI Codex CLI
- [ ] [Gemini CLI Support](https://github.com/Z-M-Huang/vcp/issues/20) — Adapt for Google Gemini CLI
- [ ] [Migration Plan Tooling](https://github.com/Z-M-Huang/vcp/issues/21) — Analyze existing codebases against VCP

---

## How to Contribute

- **Report a vibe coding problem** — Encountered a real issue from AI-generated code? [Open a problem report](https://github.com/Z-M-Huang/vcp/issues/new?template=vibe-coding-problem.yml). Your experience directly informs which standards we prioritize.
- **Propose a new standard** — Have an idea that would prevent a class of AI coding problems? [Propose a standard](https://github.com/Z-M-Huang/vcp/issues/new?template=standard-proposal.yml). Review the [format spec](standards/README.md) first.
- **Contribute to existing standards** — Pick an [open issue](https://github.com/Z-M-Huang/vcp/issues), read the requirements, and submit a PR.

---

## Repo Structure

<details>
<summary><strong>Project layout</strong> — click to expand</summary>

```
vcp/
├── standards/           # 32 AI-optimized principled standards across 9 scopes
│   ├── manifest.json    # Root v2 manifest — full HTTPS URLs, org-customizable
│   ├── scopes/          # Per-scope manifest files
│   ├── core-*.md        # Universal: security, architecture, testing, etc.
│   ├── web-*.md         # Frontend and backend web standards
│   ├── database-*.md    # Encryption, schema security
│   ├── mobile-*.md      # Credential storage, cert pinning, biometrics
│   ├── desktop-*.md     # Electron/Tauri isolation, IPC security
│   ├── cli-*.md         # Shell injection, argument injection, exit codes
│   ├── devops-*.md      # Containers, CI/CD, IaC, Kubernetes
│   └── compliance-*.md  # GDPR, PCI DSS, HIPAA
├── schemas/             # JSON schemas for config and manifest validation
├── plugins/vcp/         # Claude Code plugin (skills, hooks, agents)
└── .claude-plugin/      # Marketplace manifest
```

</details>

---

## References

### Research

- [CodeRabbit — State of AI vs Human Code Generation (Dec 2025)](https://www.coderabbit.ai/whitepapers/state-of-AI-vs-human-code-generation-report) — 2.74x vulnerability rate across 470 PRs
- [GitClear — AI Copilot Code Quality 2025](https://www.gitclear.com/ai_assistant_code_quality_2025_research) — 211M lines, 4x growth in code clones
- [Veracode — 2025 GenAI Code Security](https://www.veracode.com/resources/analyst-reports/2025-genai-code-security-report/) — 45% AI code has security vulnerabilities
- [CMU — Speed at the Cost of Quality (arXiv 2511.04427)](https://arxiv.org/abs/2511.04427) — 40.7% complexity increase
- [Spracklen et al. — Package Hallucinations (USENIX Security 2025)](https://arxiv.org/abs/2406.10279) — 205,474 hallucinated package names

### Frameworks

- [OWASP Top 10:2025](https://owasp.org/Top10/2025/) — [OWASP ASVS v5.0](https://owasp.org/www-project-application-security-verification-standard/) — [OWASP API Security Top 10:2023](https://owasp.org/API-Security/) — [CWE Top 25:2024](https://cwe.mitre.org/top25/)

---

## License

[Apache License 2.0](LICENSE.md)
