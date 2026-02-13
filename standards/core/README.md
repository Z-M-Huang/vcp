# Core Standards

Universal standards that apply to all code, regardless of language, framework, or target platform. These are always loaded — every project must follow core standards.

## Standards

| Standard | What It Covers |
|----------|---------------|
| [Security](security.md) | Input validation, parameterized queries, secrets management, encryption at rest/in transit, authentication, authorization, dependency verification. OWASP Top 10:2025 coverage map. |
| [Architecture](architecture.md) | Single responsibility, separation of concerns, dependency direction, layer boundaries, service extraction criteria. |
| [Root Cause Analysis](root-cause-analysis.md) | Decision framework for tracing bugs to origin, breaking the fix-creates-new-bug death spiral. |
| [Code Quality](code-quality.md) | Consistency, duplication elimination, dead code removal, naming conventions, code churn reduction. |
| [Error Handling](error-handling.md) | Boundary validation, structured errors, crash-loudly philosophy, edge case coverage. |
| [Testing](testing.md) | Test real behavior not mocked assumptions, boundary testing, mutation-resistant tests. |
| [Dependency Management](dependency-management.md) | Slopsquatting prevention, lockfile hygiene, supply chain verification, behavioral analysis. |

## File Naming Convention

Standard files use kebab-case: `security.md`, `architecture.md`, `root-cause-analysis.md`, etc.

Each file follows the format spec defined in [`standards/README.md`](../README.md).
