# VCP — Vibe Coding Protocol

**Proactive standards enforcement for AI-generated code — security, architecture, and quality.**

A protocol for AI coding assistants to produce maintainable, secure, and architecturally sound code — instead of the fast-but-fragile output that's becoming the industry default.

---

## The Problem

AI coding assistants are transforming software development. They're also degrading it at scale.

### The data is clear

- **2.74x higher security vulnerability rate** in AI-generated code (CodeRabbit, Dec 2025)
- **1.7x more major issues** than human-written code in the same study
- **45% of AI-generated code** contains security vulnerabilities (Veracode 2025; Java AI code at 70%+ failure)
- **8-fold increase in code duplication** across 211M lines analyzed (GitClear 2024)
- **Refactoring collapsed** from 25% to <10% of changed lines — AI adds, but never cleans up
- **40% complexity increase** in AI-assisted repositories (CMU study)
- **~20% of AI code recommendations** reference non-existent packages — "slopsquatting" (Lasso Security)
- **59% of developers** use AI-generated code they don't fully understand (GitHub survey)
- **16 of 18 CTOs** reported production disasters from AI-generated code

### The specific failures

| Category | What happens | Data |
|----------|-------------|------|
| **Security** | XSS, injection, insecure auth, hardcoded secrets | XSS failure rate 86%, log injection 88%, insecure deserialization 1.82x, password handling 1.88x |
| **Architecture** | God classes, mixed concerns, layer bleeding, no SRP | "Highly functional but systematically lacking in architectural judgment" (SonarSource) |
| **Quality** | Code duplication, dead code, inconsistent patterns | Copy-paste rose from 8.3% to 12.3%, code churn up from 5.5% to 7.9% |
| **Root cause** | Patches where symptoms show, not where bugs originate | "Fix creates new bug" death spiral — each patch breaks new assumptions |
| **Dependencies** | Hallucinated packages, supply chain vulnerabilities | 200,000+ unique hallucinated package names, 43% consistently repeated |
| **Maintainability** | Works today, unmaintainable next month | "Rescue engineering" predicted as hottest discipline in 2026 |

### The death spiral

This is how vibe-coded projects fail:

1. AI generates working code fast — looks great on day one
2. Bug found — AI patches where it manifests, not where it originates
3. Patch violates assumptions elsewhere, creates new bugs
4. Each fix compounds the problem — hack on top of hack
5. Codebase becomes unmaintainable — "rescue engineering" required

No unified quality framework exists for AI coding assistants. VCP fills this gap.

---

## What VCP Is

VCP is a protocol — a set of **principled standards** and **Claude Code plugins** that AI coding assistants follow to produce better code.

### Principled standards

Markdown files that state **WHY** (the principle), **WHAT** (actionable rules), and **HOW** (code examples). AI-parseable structure with YAML frontmatter, consistent headings, and cross-references.

Principled, but concrete. VCP explains the reasoning **and** provides measurable, unambiguous rules. Standards are written so that **Claude Sonnet 4.5** (the baseline target model) can follow them without relying on implicit knowledge or model judgment to fill gaps. If a more capable model is needed to interpret a rule correctly, the rule isn't specific enough.

### Plugins

A Claude Code plugin that bundles skills, hooks, and agents into a single installable package:
- **vcp** — Initialization, enforcement, assessment, and test quality for AI-generated code

---

## How VCP Works

VCP enforces standards through three layers, from proactive to reactive:

### Layer 1: Proactive Context *(planned — [#34](https://github.com/Z-M-Huang/vcp/issues/34))*

Security and architecture standards injected into the AI's context at session start and after context compaction. The AI internalizes rules *while writing code*, preventing violations before they happen rather than catching them after.

### Layer 2: On-Demand Scanning

Skills scan code against 18 standards across security, architecture, quality, data access, and compliance:

- `/vcp-security-check` — Security vulnerabilities (OWASP Top 10, CWE patterns)
- `/vcp-quality-check` — Architecture violations, SRP, duplication, dead code
- `/vcp-dependency-check` — Lockfile hygiene, version ranges, slopsquatting
- `/vcp-pre-commit-review` — All applicable standards in a single pre-commit pass

Skills use AI-driven analysis that can trace data flow across variables — deeper than regex can reach.

### Layer 3: Real-Time Blocking

A security gate hook runs on every `Write`, `Edit`, and `Bash` tool call, blocking dangerous patterns *before code is written to disk*:

- Hardcoded secrets, AWS keys, private keys, JWT tokens (CWE-798)
- SQL string concatenation and template literal injection (CWE-89)
- `eval()` with user input, shell eval with dynamic input (CWE-95)
- `innerHTML` with variable assignment (CWE-79)
- Insecure deserialization: pickle, unsafe YAML, node-serialize (CWE-502)
- Encoded data piped to shell execution (CWE-116)

The layers are complementary: Layer 3 catches the most dangerous patterns instantly, Layer 2 provides deep analysis on demand, and Layer 1 will prevent violations at the source by making the AI aware of rules before it writes.

---

## Core Philosophy

1. **Security comes first.** No feature is worth a vulnerability. Validate at boundaries, parameterize queries, encode output.
2. **Architecture comes second.** Every change must respect the system's structure. SRP, separation of concerns, dependency direction.
3. **Fix the root cause, not the symptom.** Trace bugs to where they originate, not where they manifest. Break the death spiral.
4. **No random patches.** Step back, analyze, implement properly. A 10-minute fix that creates 3 new bugs costs more than a 1-hour proper solution.
5. **Principled, not prescriptive.** Explain WHY, not just WHAT. Allow alternatives that satisfy the principle.
6. **AI-parseable.** Standards are structured for machine consumption — consistent format, clear headings, unambiguous rules.

### Non-Goals

VCP standards govern **code that AI agents write**, not the infrastructure, processes, or policies surrounding that code. The following are explicitly out of scope:

- **Repository security controls** — branch protection rules, CODEOWNERS, MFA requirements for maintainers. These are infrastructure policies, not coding standards.
- **CI/CD pipeline configuration** — required checks, deployment gates, approval workflows. VCP plugins may enforce standards in CI, but pipeline configuration is not a standard.
- **SBOM generation and signed builds** — supply chain provenance at the build/release level. VCP covers dependency verification at coding time (see [dependency management](standards/core/dependency-management.md)), not build attestation.
- **Incident response and SLAs** — patch timelines, escalation procedures, on-call rotations. These are operational policies.
- **Organizational security policies** — security training requirements, access reviews, compliance audits.

If a control doesn't affect what code gets written, it's not a VCP standard.

---

## Repo Structure

```
vcp/
├── standards/           # AI-optimized principled standards (canonical source)
│   ├── manifest.json    # Machine-readable index for AI skill routing
│   ├── core/            # Universal: security, architecture, testing, etc.
│   ├── web-frontend/    # Browser-side: components, XSS, performance
│   ├── web-backend/     # Server-side: APIs, injection, data access
│   ├── database/        # Database-layer: encryption, schema security
│   └── compliance/      # Regulatory: GDPR, PCI DSS, HIPAA
├── plugins/             # Claude Code plugins (created as developed)
│   └── vcp/             # All VCP skills, hooks, and agents
└── .claude-plugin/      # Marketplace manifest
```

See each folder's `README.md` for detailed contents and planned work.

---

## Roadmap

### Phase 1: Core Standards

- [x] [Security](https://github.com/Z-M-Huang/vcp/issues/1) — Security-first checklist derived from OWASP Top 10 and CWE
- [x] [Architecture](https://github.com/Z-M-Huang/vcp/issues/2) — Clean architecture, SRP, separation of concerns
- [x] [Root Cause Analysis](https://github.com/Z-M-Huang/vcp/issues/3) — Decision framework for fixing bugs at the right level
- [x] [Code Quality](https://github.com/Z-M-Huang/vcp/issues/5) — Consistency, duplication elimination, dead code removal
- [x] [Error Handling](https://github.com/Z-M-Huang/vcp/issues/7) — Edge cases, boundary validation, structured errors
- [x] [Testing](https://github.com/Z-M-Huang/vcp/issues/9) — Test real behavior, not AI assumptions
- [x] [Dependency Management](https://github.com/Z-M-Huang/vcp/issues/11) — Prevent slopsquatting and supply chain attacks

### Phase 2: Web Target Standards

- [x] [Frontend Structure](https://github.com/Z-M-Huang/vcp/issues/4) — Component organization, state management, folder conventions
- [x] [Frontend Security](https://github.com/Z-M-Huang/vcp/issues/6) — XSS prevention, auth token handling, CSP, CORS
- [x] [Frontend Performance](https://github.com/Z-M-Huang/vcp/issues/8) — Bundle discipline, lazy loading, rendering optimization
- [x] [Backend Structure](https://github.com/Z-M-Huang/vcp/issues/10) — HTTP/business logic separation, service layers
- [x] [Backend Security](https://github.com/Z-M-Huang/vcp/issues/13) — Injection prevention, auth, secrets management
- [x] [Backend Data Access](https://github.com/Z-M-Huang/vcp/issues/15) — Query safety, migration patterns, connection management

### Phase 3: GitHub Actions

- [ ] [Issue Triage Pipeline](https://github.com/Z-M-Huang/vcp/issues/18) — Auto-label and deduplicate community issues

### Phase 4: Compliance & Database Standards

- [x] [GDPR & CCPA/CPRA](https://github.com/Z-M-Huang/vcp/issues/27) — Data deletion, retention, consent, PII handling
- [x] [PCI DSS v4.0](https://github.com/Z-M-Huang/vcp/issues/28) — Tokenization, card masking, CDE isolation
- [x] [HIPAA](https://github.com/Z-M-Huang/vcp/issues/29) — PHI encryption, audit logging, retention, minimum necessary
- [x] [Database Encryption](https://github.com/Z-M-Huang/vcp/issues/30) — TDE, column-level, key management
- [x] [Database Schema Security](https://github.com/Z-M-Huang/vcp/issues/31) — RLS, data classification, audit triggers, masking

### Phase 5: Manifest & Routing Infrastructure

- [x] [Standards Manifest](https://github.com/Z-M-Huang/vcp/issues/32) — manifest.json for AI skill discovery and routing
- [x] [Skill Routing Design](https://github.com/Z-M-Huang/vcp/issues/33) — Context detection, .vcp.json config, standard loading

### Phase 6: Plugins

- [x] [Guard skills](https://github.com/Z-M-Huang/vcp/issues/22) — Enforcement hooks and skills (4 skills, 2 hooks)
- [ ] [Proactive security context](https://github.com/Z-M-Huang/vcp/issues/34) — SessionStart hook to inject VCP standards into AI awareness
- [ ] [Audit skills](https://github.com/Z-M-Huang/vcp/issues/23) — Codebase assessment (6 skills, 1 agent)
- [ ] [Testing skills](https://github.com/Z-M-Huang/vcp/issues/24) — Test quality enforcement (3 skills, 1 hook)

### Future
- [ ] [Conformance Model](https://github.com/Z-M-Huang/vcp/issues/25) — MUST/SHOULD/MAY with objective pass/fail criteria
- [ ] [Agentic AI Security](https://github.com/Z-M-Huang/vcp/issues/26) — Prompt injection, tool boundaries, and human approval gates
- [ ] [Codex CLI Support](https://github.com/Z-M-Huang/vcp/issues/19) — Adapt standards for OpenAI Codex CLI
- [ ] [Gemini CLI Support](https://github.com/Z-M-Huang/vcp/issues/20) — Adapt standards for Google Gemini CLI
- [ ] [Migration Plan Tooling](https://github.com/Z-M-Huang/vcp/issues/21) — Analyze existing codebases against VCP (separate repo)

---

## How to Adopt

> VCP is in early development. The plugin and standards are functional but not yet published to the Claude Code marketplace. Check the roadmap above for progress.

### Install

1. **Add the plugin** — `claude plugin add vcp` (marketplace, when published) or add the plugin source directly
2. **Initialize your project** — Run `/vcp-init` to detect your frameworks and create `.vcp.json`

### What happens

- **Security gate activates immediately** — Every `Write`, `Edit`, and `Bash` tool call is checked for hardcoded secrets, SQL injection, eval injection, and other dangerous patterns. Violations are blocked before code is written.
- **Skills become available** — `/vcp-security-check`, `/vcp-quality-check`, `/vcp-dependency-check`, and `/vcp-pre-commit-review` scan code against VCP standards on demand.
- **Stop reminder fires** — When Claude finishes a task, it reminds you to run VCP checks before committing.

### Customize

`.vcp.json` controls which scopes (web-frontend, web-backend, database), compliance frameworks (GDPR, PCI DSS, HIPAA), and severity thresholds apply to your project. Use the `ignore` field to suppress specific CWE checks that don't apply.

---

## How to Contribute

### Report a vibe coding problem

Encountered a real problem caused by AI-generated code? [Open a problem report](https://github.com/Z-M-Huang/vcp/issues/new?template=vibe-coding-problem.yml). Your experience directly informs which standards we prioritize.

### Propose a new standard

Have an idea for a standard that would prevent a class of AI coding problems? [Propose a standard](https://github.com/Z-M-Huang/vcp/issues/new?template=standard-proposal.yml). Review the [standards format spec](standards/README.md) first.

### Contribute to existing standards

Pick an open issue from the [roadmap](#roadmap), read the requirements, and submit a PR. Every standard follows the [format specification](standards/README.md).

---

## References

### Research & Data

- [CodeRabbit — State of AI vs Human Code Generation Report (Dec 2025)](https://www.coderabbit.ai/whitepapers/state-of-AI-vs-human-code-generation-report) — 2.74x vulnerability rate, 1.7x more bugs across 470 PRs
- [GitClear — AI Copilot Code Quality 2025 Research](https://www.gitclear.com/ai_assistant_code_quality_2025_research) — 211M lines, 4x growth in code clones, refactoring collapse
- [Veracode — 2025 GenAI Code Security Report](https://www.veracode.com/resources/analyst-reports/2025-genai-code-security-report/) — 45% AI code has security vulnerabilities; XSS failure rate 86%
- [CMU — Speed at the Cost of Quality (arXiv 2511.04427)](https://arxiv.org/abs/2511.04427) — 40.7% complexity increase, 29.7% more static analysis warnings
- [Spracklen et al. — Package Hallucinations by Code Generating LLMs (USENIX Security 2025)](https://arxiv.org/abs/2406.10279) — 205,474 unique hallucinated package names across 16 LLMs

### Standards & Frameworks

- [OWASP Top 10:2025](https://owasp.org/Top10/2025/) — Web application security risks (current version)
- [OWASP ASVS v5.0](https://owasp.org/www-project-application-security-verification-standard/) — Application security verification
- [OWASP Secure Coding Practices](https://owasp.org/www-project-secure-coding-practices-quick-reference-guide/) — Quick reference checklist
- [OWASP Agentic AI Top 10 (Dec 2025)](https://genai.owasp.org/2025/12/09/owasp-genai-security-project-releases-top-10-risks-and-mitigations-for-agentic-ai-security/) — AI agent-specific security risks
- [OpenSSF Security-Focused Guide for AI Code Assistants](https://openssf.org/) — AI-specific security guidance
- [CWE (Common Weakness Enumeration)](https://cwe.mitre.org/) — Vulnerability taxonomy

---

## License

[MIT](LICENSE)
