# Standards

AI-optimized principled standards for code quality enforcement. Each standard targets a specific class of problems that AI coding assistants produce.

## Contents

| Path | Description |
|------|-------------|
| [`core/`](core/README.md) | Universal standards for all code (security, architecture, testing, etc.) |
| [`web-frontend/`](web-frontend/README.md) | Client-side web development standards |
| [`web-backend/`](web-backend/README.md) | Server-side web development standards |
| [`database/`](database/README.md) | Database-layer security standards (encryption, schema security) |
| [`compliance/`](compliance/README.md) | Regulatory compliance standards (GDPR, PCI DSS, HIPAA) |

## Standard File Format Specification

Every standard file MUST follow this format exactly. Consistent structure enables AI agents to reliably parse and enforce standards.

### YAML Frontmatter

```yaml
---
id: core-security              # Unique ID: {scope}-{topic} in kebab-case
title: Security                 # Human-readable title
scope: core                     # See manifest.json for valid scopes
severity: critical              # One of: critical, high, medium, low
tags: [security, owasp, cwe]    # Searchable tags
references:                     # External references
  - title: OWASP Top 10:2025
    url: https://owasp.org/Top10/2025/
  - title: CWE-79
    url: https://cwe.mitre.org/data/definitions/79.html
---
```

**Field definitions:**

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier. Format: `{scope}-{topic}`. Used for cross-references. |
| `title` | Yes | Human-readable name. |
| `scope` | Yes | One of the values in `manifest.json` scopes array: `core`, `web-frontend`, `web-backend`, `database`, `compliance`. See [manifest.json](manifest.json) for the canonical scope list. |
| `severity` | Yes | `critical` = security/data-loss risk. `high` = major quality impact. `medium` = maintainability. `low` = style/preference. |
| `tags` | Yes | Array of searchable tags for discovery. Include relevant CWE IDs, OWASP references. |
| `references` | No | Array of `{title, url}` objects linking to external standards and research. |

### Required Sections

Every standard file must contain these sections in order:

#### 1. Principle

The **WHY** behind this standard. States the core reasoning in 1-3 sentences. This is the most important section — if an AI agent reads nothing else, this should convey the intent.

```markdown
## Principle

Every user input is hostile until validated. Server-side validation is the security boundary;
client-side validation is a UX convenience, not a defense.
```

#### 2. Rules

Actionable, numbered rules. Each rule is a clear imperative ("Do X", "Never Y"). Where applicable, include a CWE or OWASP reference.

```markdown
## Rules

1. **Parameterize all database queries.** Never concatenate user input into SQL. (CWE-89)
2. **Validate all input at system boundaries.** User input, API responses, file I/O. (CWE-20)
3. **Encode output for its context.** HTML-encode for HTML, URL-encode for URLs. (CWE-79)
```

#### 3. Patterns

Concrete code examples showing the right way and wrong way. Use fenced code blocks with language tags. Always explain WHY the anti-pattern is wrong.

```markdown
## Patterns

### Do This

\`\`\`python
# Parameterized query — user input is never part of the SQL string
cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))
\`\`\`

### Not This

\`\`\`python
# String concatenation — user controls the SQL structure (CWE-89)
cursor.execute(f"SELECT * FROM users WHERE id = {user_id}")
\`\`\`

**Why it's wrong:** The user can inject arbitrary SQL by setting `user_id` to
`1; DROP TABLE users; --`. Parameterized queries treat the value as data, never as code.
```

#### 4. Exceptions

When it's acceptable to deviate from the rules, and what safeguards must be in place.

```markdown
## Exceptions

- Raw SQL is acceptable for migrations and schema management where input is not user-controlled.
- Dynamic query building (e.g., filters) must use a query builder with parameterization, never string templates.
```

#### 5. Cross-References

Links to related VCP standards and external resources.

```markdown
## Cross-References

- [Error Handling](core-error-handling) — How to handle validation failures
- [Testing](core-testing) — How to test security boundaries
```

### Cross-Reference Format

Reference other VCP standards by their `id` field: `[Display Text](standard-id)`. The consuming tool resolves the ID to the correct file path.

### Design Principles

These principles guide how standards are written:

1. **Principled, not prescriptive.** State WHY before WHAT. Allow alternative implementations that satisfy the principle.
2. **AI-parseable.** Consistent structure with clear headings. An AI agent should unambiguously determine if code violates a rule.
3. **Actionable.** "Do X" not "Consider X". Every rule can be checked.
4. **Evidence-based.** Reference real research, CVEs, or industry standards. Not opinions.
5. **Minimal.** Each standard covers one topic. If it's getting long, split it.

### Inspired By

- [OWASP ASVS v5.0](https://owasp.org/www-project-application-security-verification-standard/) — Hierarchical IDs, severity levels, machine-readable format
- [OpenSSF Security-Focused Guide for AI Code Assistants](https://openssf.org/) — AI-readability principles
- [OWASP Secure Coding Practices](https://owasp.org/www-project-secure-coding-practices-quick-reference-guide/) — Imperative checklist format
