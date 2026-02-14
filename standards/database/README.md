# Database Standards

Standards for database-layer security patterns — encryption decisions, schema security, access control, and data classification at the database level.

These complement [web-backend/data-access](../web-backend/data-access.md) (which covers application-layer query patterns, migrations, and connection management) with concerns specific to the database layer itself.

Load these when the project has direct database access (ORM configs, migration directories, SQL files, or database connection configuration).

## Standards

| Standard | What It Covers |
|----------|---------------|
| [Encryption](encryption.md) | TDE vs column-level vs application-level encryption decision matrix, envelope encryption with KMS, key rotation without re-encrypting all data, blind indexes for searchable encrypted fields, ORM-layer transparent encryption. |
| [Schema Security](schema-security.md) | Row-level security (RLS) for multi-tenant isolation, data classification markers (PII/PHI/PCI columns), audit triggers with tamper-evident logging, data masking for non-production, least privilege database users (app vs migration separation). |

## File Naming Convention

Standard files use kebab-case: `encryption.md`, `schema-security.md`.

Each file follows the format spec defined in [`standards/README.md`](../README.md).
