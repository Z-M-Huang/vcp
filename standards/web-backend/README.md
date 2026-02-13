# Web Backend Standards

Standards specific to server-side web development (APIs, services, data access).

These build on the [core standards](../core/README.md) with backend-specific guidance.

## Planned Standards

| Standard | Description | Issue | Status |
|----------|-------------|-------|--------|
| [Structure](structure.md) | HTTP/business logic separation, service layers, middleware | [#10](https://github.com/Z-M-Huang/vcp/issues/10) | Draft |
| Security | Injection prevention, auth, secrets management, rate limiting | [#13](https://github.com/Z-M-Huang/vcp/issues/13) | Planned |
| Data Access | Query safety, migration patterns, connection management | [#15](https://github.com/Z-M-Huang/vcp/issues/15) | Planned |

## File Naming Convention

Standard files use kebab-case: `structure.md`, `security.md`, `data-access.md`.

Each file follows the format spec defined in [`standards/README.md`](../README.md).
