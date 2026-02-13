# Web Backend Standards

Standards for server-side web development — APIs, services, and data access layers. These build on [core standards](../core/README.md) with backend-specific guidance.

Load these when the project contains backend code (Express, FastAPI, Django, Spring Boot, Rails, etc.).

## Standards

| Standard | What It Covers |
|----------|---------------|
| [Structure](structure.md) | HTTP/business logic separation, service layers, middleware patterns, route organization. |
| [Security](security.md) | Injection prevention (SQL, NoSQL, OS, LDAP), authentication (bcrypt/Argon2, sessions), authorization (RBAC/ABAC with deny-by-default), secrets management, rate limiting, SSRF prevention. |
| [Data Access](data-access.md) | Parameterized queries, N+1 prevention, migration safety (up/down, zero-downtime), connection pooling, ORM vs raw SQL boundaries. |

## File Naming Convention

Standard files use kebab-case: `structure.md`, `security.md`, `data-access.md`.

Each file follows the format spec defined in [`standards/README.md`](../README.md).
