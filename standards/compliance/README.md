# Compliance Standards

Coding patterns required by regulatory frameworks. These standards cover what code must do to satisfy specific regulations — encryption requirements, data deletion, audit logging, and data handling rules that go beyond general security practices.

Each compliance standard adds framework-specific rules beyond what [core security](../core/security.md) already covers. Core security rules (encryption, logging, secrets) are cross-referenced, not duplicated.

Load these when the project handles regulated data. Compliance scopes must be explicitly declared via `.vcp.json` — they cannot be auto-detected from project structure.

## Standards

*Standards are in development. This scope will contain:*

| Standard | What It Will Cover |
|----------|-------------------|
| GDPR & CCPA/CPRA | Data deletion (right to be forgotten), retention policies, consent tracking, PII identification in schemas, PII exclusion from logs. |
| PCI DSS v4.0 | Cardholder data tokenization, card number masking, CDE isolation, CVV storage prohibition, payment-specific audit trails. |
| HIPAA | PHI encryption (AES-256, TLS 1.3+), minimum necessary queries, 6-year audit log retention, break-the-glass access, PHI exclusion from non-audit logs. |

## Out of Scope

The following frameworks are primarily organizational/process requirements with minimal coding-level impact. VCP does not cover them:

- **SOC 2** — Audit trails, segregation of duties, change management. Coding overlap is covered by core standards.
- **SOX (Sarbanes-Oxley)** — Financial reporting controls and approval workflows at the CI/CD layer.
- **FERPA** — Education-specific with risk-based (not prescriptive) requirements. General patterns covered by core-security.
- **COPPA** — Child-directed services niche. Deletion/retention requirements are a subset of GDPR/CCPA.

## File Naming Convention

Standard files use kebab-case: `gdpr.md`, `pci-dss.md`, `hipaa.md`.

Each file follows the format spec defined in [`standards/README.md`](../README.md).
