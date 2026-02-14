# Compliance Standards

Coding patterns required by regulatory frameworks. These standards cover what code must do to satisfy specific regulations — encryption requirements, data deletion, audit logging, and data handling rules that go beyond general security practices.

Each compliance standard adds framework-specific rules beyond what [core security](../core/security.md) already covers. Core security rules (encryption, logging, secrets) are cross-referenced, not duplicated.

Load these when the project handles regulated data. Compliance scopes must be explicitly declared via `.vcp.json` — they cannot be auto-detected from project structure.

## Standards

| Standard | What It Covers |
|----------|---------------|
| [GDPR & CCPA/CPRA](gdpr.md) | PII identification and classification, data deletion (right to be forgotten), retention policy enforcement, consent tracking per purpose, PII exclusion from logs, data export/portability, Do Not Sell/Share. |
| [PCI DSS v4.0](pci-dss.md) | Client-side tokenization (never store PANs), CVV prohibition, card masking, CDE isolation, payment page CSP, PCI-specific encryption (AES-256, TLS 1.2+), audit trails, MFA for CDE access. |
| [HIPAA](hipaa.md) | PHI field identification (18 HIPAA identifiers), minimum necessary queries, AES-256 encryption with Safe Harbor, tamper-evident audit logging with 6-year retention, break-the-glass emergency access, PHI exclusion from logs and errors. |

## Out of Scope

The following frameworks are primarily organizational/process requirements with minimal coding-level impact. VCP does not cover them:

- **SOC 2** — Audit trails, segregation of duties, change management. Coding overlap is covered by core standards.
- **SOX (Sarbanes-Oxley)** — Financial reporting controls and approval workflows at the CI/CD layer.
- **FERPA** — Education-specific with risk-based (not prescriptive) requirements. General patterns covered by core-security.
- **COPPA** — Child-directed services niche. Deletion/retention requirements are a subset of GDPR/CCPA.

## File Naming Convention

Standard files use kebab-case: `gdpr.md`, `pci-dss.md`, `hipaa.md`.

Each file follows the format spec defined in [`standards/README.md`](../README.md).
