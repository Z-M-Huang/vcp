# Database Standards

Standards for database-layer security patterns — encryption decisions, schema security, access control, and data classification at the database level.

These complement [web-backend/data-access](../web-backend/data-access.md) (which covers application-layer query patterns, migrations, and connection management) with concerns specific to the database layer itself.

Load these when the project has direct database access (ORM configs, migration directories, SQL files, or database connection configuration).

## Standards

*Standards are in development. This scope will contain:*

| Standard | What It Will Cover |
|----------|-------------------|
| Encryption | TDE vs column-level vs application-level encryption trade-offs, key management (envelope encryption, KMS), field-level encryption for searchable encrypted storage, ORM-layer encryption. |
| Schema Security | Row-level security (RLS) for multi-tenant databases, data classification markers (PII/PHI/PCI columns), audit triggers, data masking for non-production, least privilege database users. |

## File Naming Convention

Standard files use kebab-case: `encryption.md`, `schema-security.md`.

Each file follows the format spec defined in [`standards/README.md`](../README.md).
