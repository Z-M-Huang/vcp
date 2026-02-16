---
id: database-schema-security
title: Database Schema Security
scope: database
severity: high
tags: [database, rls, data-classification, audit, masking, multi-tenant]
references:
  - title: "PostgreSQL — Row Security Policies"
    url: https://www.postgresql.org/docs/current/ddl-rowsecurity.html
  - title: "OWASP — Database Security Cheat Sheet"
    url: https://cheatsheetseries.owasp.org/cheatsheets/Database_Security_Cheat_Sheet.html
  - title: "CWE-284 — Improper Access Control"
    url: https://cwe.mitre.org/data/definitions/284.html
  - title: "CWE-566 — Authorization Bypass Through User-Controlled SQL Primary Key"
    url: https://cwe.mitre.org/data/definitions/566.html
---

## Principle

Access control at the application layer can be bypassed — by bugs, by direct database access, by new code paths that skip authorization checks. Row-level security, audit triggers, and data classification at the schema level create a safety net that enforces access rules even when the application fails to. The database should be the last line of defense, not a dumb storage layer.

AI-generated code puts all access control in application code and trusts the database as an open store. Multi-tenant applications query without tenant filters. Sensitive columns have no classification. Audit trails exist only in application logs that can be disabled. This standard pushes security concerns down to the schema layer where they cannot be bypassed by application-level mistakes.

## Rules

### Row-Level Security

1. **Use RLS policies to enforce tenant isolation in multi-tenant databases.** Every table that contains tenant-specific data must have a row-level security policy that restricts access to rows matching the current tenant context. Set the tenant context via a session variable at the start of each request. RLS policies are enforced by the database engine — they cannot be bypassed by application code that forgets a `WHERE tenant_id = ?` clause. (CWE-284)

2. **Set tenant context at the connection level, not in individual queries.** Use `SET LOCAL` (PostgreSQL) or equivalent to set the tenant ID at the beginning of each transaction. RLS policies reference this session variable. This ensures every query in the transaction is automatically filtered — no developer needs to remember to add a tenant filter. `SET LOCAL` scopes to the current transaction, which is safe for connection pooling.

3. **Enable `FORCE ROW LEVEL SECURITY` on tables where the application user owns the table.** By default, PostgreSQL RLS does not apply to the table owner. If your application connects as the table owner, RLS is silently bypassed. Use `ALTER TABLE ... FORCE ROW LEVEL SECURITY` to enforce policies even for the owner. Test RLS by verifying cross-tenant queries return zero rows — never test as a superuser. (CWE-566)

### Data Classification

4. **Tag every sensitive column with its data classification.** Use database column comments, custom domains, or a classification registry to mark columns as `PII`, `PHI`, `PCI`, `SENSITIVE`, or `PUBLIC`. Classification drives downstream decisions: which columns get encrypted, which are masked in non-production, which require audit logging, and which are excluded from analytics exports.

5. **Use data classification to drive automated policies.** Classification markers should not be passive documentation — they should feed into automated processes: columns tagged `PII` are automatically included in GDPR deletion/export queries; columns tagged `PCI` are automatically masked in non-production environments; columns tagged `PHI` are automatically included in HIPAA audit trigger scope.

### Audit Triggers

6. **Create audit triggers on tables containing sensitive data.** After INSERT, UPDATE, and DELETE triggers should capture: the database user, the application user (from session variable), the operation type, the old values, the new values, the changed fields, and the timestamp. Store audit records in a separate audit table. (CWE-778)

7. **Capture the application user, not just the database user.** Database connections typically use a shared application user. The individual human or service identity must be passed via a session variable (e.g., `SET LOCAL app.current_user_id = '...'`) and captured by the audit trigger. An audit trail that says "app_user performed 10,000 operations" is useless — it must say which individual did what.

8. **Use conditional triggers to audit only sensitive columns.** On tables with many columns, audit triggers that fire on every update add unnecessary overhead. Use the `WHEN` clause (PostgreSQL) to restrict triggers to fire only when sensitive columns change: `WHEN (OLD.ssn IS DISTINCT FROM NEW.ssn OR OLD.email IS DISTINCT FROM NEW.email)`. This keeps audit costs proportional to actual sensitive data changes.

### Data Masking

9. **Mask all sensitive data in non-production environments.** Development, staging, and testing databases must not contain real PII, PHI, or PCI data. Apply static data masking when copying production data to non-production: replace names with faker-generated names, emails with `user_{id}@example.com`, SSNs with random 9-digit numbers. Preserve referential integrity by using deterministic masking (hash-based) for foreign key values.

10. **Use dynamic masking for role-based display in production.** When different roles need to see different levels of detail for the same data (e.g., support sees masked SSN `***-**-1234`, admin sees full SSN), implement dynamic masking views that apply masking functions based on the current user's role. Use `current_setting('app.user_role')` in the masking view to determine the masking level.

### Least Privilege

11. **Separate database users for application runtime and schema migrations.** The application runtime user should have DML permissions only (SELECT, INSERT, UPDATE, DELETE) on the tables it needs. The migration user should have DDL permissions (CREATE, ALTER, DROP). Never run the application with migration-level permissions — a SQL injection vulnerability in the application should not be able to DROP tables.

12. **Grant minimum permissions per schema and table.** Do not grant blanket permissions on all tables. Grant SELECT-only on tables the application reads but does not write. Grant INSERT/UPDATE without DELETE on tables where soft-delete is the policy. Use schema-level grants when multiple tables share the same access pattern.

## Patterns

### Row-Level Security

#### Do This

```sql
-- Enable RLS on tenant-scoped tables
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;  -- Apply even to table owner

-- Policy: rows visible only when tenant_id matches session context
CREATE POLICY tenant_isolation ON orders
    USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Write policy: prevent inserting rows for other tenants
CREATE POLICY tenant_insert ON orders
    FOR INSERT
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
```

```python
# Set tenant context at the start of each request
@app.middleware("http")
async def tenant_context(request: Request, call_next):
    tenant_id = get_tenant_from_auth(request)  # From JWT or session
    async with db.transaction():
        await db.execute(
            "SET LOCAL app.current_tenant_id = :tid", {"tid": str(tenant_id)}
        )
        response = await call_next(request)
    return response

# All queries are now automatically filtered — no WHERE clause needed
async def get_orders(user_id: str) -> list:
    # RLS policy ensures only current tenant's orders are returned
    return await db.fetch_all(
        "SELECT * FROM orders WHERE user_id = :uid", {"uid": user_id}
    )
```

#### Not This

```python
# Application-level tenant filtering — easy to forget, easy to bypass
async def get_orders(user_id: str, tenant_id: str) -> list:
    return await db.fetch_all(
        "SELECT * FROM orders WHERE user_id = :uid AND tenant_id = :tid",
        {"uid": user_id, "tid": tenant_id},
    )
    # What if a new developer writes a query without the tenant_id filter?
    # What if an admin tool queries without it?
    # Every query is a potential cross-tenant data leak
```

**Why it's wrong:** When tenant isolation depends on every query including `AND tenant_id = ?`, a single missed filter exposes all tenants' data. With RLS, the database enforces isolation regardless of what the application sends. A query that forgets the tenant filter simply returns zero unauthorized rows instead of all tenants' data.

### Audit Triggers

#### Do This

```sql
-- Audit table capturing who, what, when, and the full change
CREATE TABLE audit_log (
    id BIGSERIAL PRIMARY KEY,
    table_name TEXT NOT NULL,
    record_id TEXT NOT NULL,
    operation TEXT NOT NULL,  -- INSERT, UPDATE, DELETE
    db_user TEXT NOT NULL DEFAULT current_user,
    app_user TEXT DEFAULT current_setting('app.current_user_id', TRUE),
    old_values JSONB,
    new_values JSONB,
    changed_fields TEXT[],
    client_ip INET DEFAULT inet_client_addr(),
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Trigger function capturing old/new values as JSONB
CREATE OR REPLACE FUNCTION audit_trigger_fn() RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO audit_log (table_name, record_id, operation, old_values, new_values, changed_fields)
    VALUES (
        TG_TABLE_NAME,
        COALESCE(NEW.id::text, OLD.id::text),
        TG_OP,
        CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END,
        CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END,
        CASE WHEN TG_OP = 'UPDATE' THEN
            ARRAY(
                SELECT key FROM jsonb_each(to_jsonb(NEW))
                WHERE to_jsonb(NEW) -> key IS DISTINCT FROM to_jsonb(OLD) -> key
            )
        END
    );
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Attach to sensitive tables — always audit INSERT and DELETE
CREATE TRIGGER patients_audit_insert_delete
    AFTER INSERT OR DELETE ON patients
    FOR EACH ROW
    EXECUTE FUNCTION audit_trigger_fn();

-- For UPDATE, only fire when sensitive columns actually change
CREATE TRIGGER patients_audit_update
    AFTER UPDATE ON patients
    FOR EACH ROW
    WHEN (OLD.ssn IS DISTINCT FROM NEW.ssn
          OR OLD.name IS DISTINCT FROM NEW.name
          OR OLD.email IS DISTINCT FROM NEW.email)
    EXECUTE FUNCTION audit_trigger_fn();
```

#### Not This

```python
# Application-level audit logging — can be bypassed or forgotten
def update_patient(patient_id, data):
    db.execute("UPDATE patients SET ... WHERE id = %s", [patient_id])
    # Forgot to add audit logging for this endpoint
    # Direct database access (admin tools, migrations) is never logged
```

**Why it's wrong:** Application-level audit logging only works when every code path remembers to call it. Database triggers fire regardless of whether the change comes from the application, an admin tool, a migration script, or direct database access. For regulated data (PHI, PCI, PII), the audit trail must be complete — a single unlogged access path is a compliance gap.

### Data Masking for Non-Production

#### Do This

```sql
-- Static masking: create anonymized copy for development
-- Deterministic masking preserves referential integrity
CREATE OR REPLACE FUNCTION mask_email(email TEXT) RETURNS TEXT AS $$
BEGIN
    RETURN 'user_' || md5(email) || '@example.com';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION mask_ssn(ssn TEXT) RETURNS TEXT AS $$
BEGIN
    RETURN '***-**-' || right(ssn, 4);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION mask_name(name TEXT) RETURNS TEXT AS $$
BEGIN
    -- Deterministic: same input = same output (preserves JOINs)
    RETURN 'User_' || left(md5(name), 8);
END;
$$ LANGUAGE plpgsql;

-- Apply masking when exporting to dev database
CREATE TABLE dev_patients AS
SELECT
    id,
    mask_name(name) AS name,
    mask_email(email) AS email,
    mask_ssn(ssn) AS ssn,
    date_trunc('year', dob) AS dob,  -- Generalize DOB to year only
    diagnosis_code  -- Non-PII clinical code can stay
FROM patients;
```

#### Not This

```bash
# Copying production database directly to development
pg_dump prod_db | psql dev_db
# Real names, SSNs, emails, and medical records now on developer laptops
```

**Why it's wrong:** Copying production data to development puts real PII/PHI on developer machines, CI servers, and shared environments. A laptop theft, a CI log, or a developer's screenshot now becomes a data breach. Masked data preserves the structure and relationships needed for testing without exposing real identities.

### Least Privilege Database Users

#### Do This

```sql
-- Application user: DML only, no DDL
CREATE ROLE app_user LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE myapp TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;

-- Read-only user for reporting
CREATE ROLE reporting_user LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE myapp TO reporting_user;
GRANT USAGE ON SCHEMA public TO reporting_user;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO reporting_user;

-- Migration user: full DDL for schema changes
CREATE ROLE migration_user LOGIN PASSWORD '...';
GRANT ALL PRIVILEGES ON DATABASE myapp TO migration_user;
GRANT ALL PRIVILEGES ON SCHEMA public TO migration_user;

-- Revoke dangerous defaults
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
```

#### Not This

```sql
-- Single superuser for everything — application, migrations, reporting
CREATE ROLE app LOGIN SUPERUSER PASSWORD '...';
-- A SQL injection in the application can now: DROP DATABASE, ALTER USER, read pg_shadow
```

**Why it's wrong:** If the application connects with superuser privileges, a SQL injection vulnerability can do anything — drop tables, read password hashes, create new users, access other databases. With a limited `app_user`, the worst a SQL injection can do is read/write within the permitted tables. The blast radius shrinks from "total database compromise" to "data access within the application's scope."

## Exceptions

- **Single-tenant applications** that serve one organization do not need RLS. Application-level authorization is sufficient when there is no risk of cross-tenant data exposure.
- **Local development environments** may use a single database user for convenience. Staging and production environments must always enforce least privilege separation regardless of team size.
- **Audit trigger overhead** on high-write tables (100,000+ writes/second) may justify moving audit logging to an async mechanism (CDC/change data capture, WAL-based replication to an audit database). The audit data must still be captured — only the mechanism changes.

## Cross-References

- [Security](core-security) — Rule 7 (deny by default), Rule 10 (log security events)
- [Backend Security](web-backend-security) — RBAC/ABAC authorization models (rule 9), least privilege (rule 8)
- [Backend Data Access](web-backend-data-access) — ORM integration, migration safety
- [Database Encryption](database-encryption) — Data classification drives encryption decisions
- [GDPR](compliance-gdpr) — PII classification and deletion enforcement
- [HIPAA](compliance-hipaa) — PHI access auditing, minimum necessary enforcement
