---
id: compliance-hipaa
title: HIPAA
scope: compliance
severity: critical
tags: [compliance, hipaa, phi, healthcare, audit-logging, encryption]
references:
  - title: "HIPAA Security Rule — 45 CFR Part 164 Subpart C"
    url: https://www.hhs.gov/hipaa/for-professionals/security/index.html
  - title: "HHS — Guidance on HIPAA & Cloud Computing"
    url: https://www.hhs.gov/hipaa/for-professionals/special-topics/cloud-computing/index.html
  - title: "NIST SP 800-66r2 — Implementing the HIPAA Security Rule"
    url: https://csrc.nist.gov/pubs/sp/800/66/r2/final
  - title: "CWE-359 — Exposure of Private Personal Information to an Unauthorized Actor"
    url: https://cwe.mitre.org/data/definitions/359.html
---

## Principle

Protected Health Information (PHI) requires the strictest data handling in any regulated domain. Every access must be auditable, every storage must be encrypted, every query must request only the minimum necessary data, and emergency overrides must be logged more rigorously than normal access — not less.

HIPAA's Security Rule (45 CFR 164.312) mandates technical safeguards that translate directly into coding requirements: access controls, audit controls, integrity controls, and transmission security. Unlike general security practices, HIPAA requires specific retention periods (6 years for audit logs), specific encryption standards (AES-256 at rest for Safe Harbor), and specific access patterns (minimum necessary, break-the-glass). This standard covers the coding patterns that satisfy these requirements.

## Rules

### PHI Identification

1. **Mark all PHI fields in every schema with their HIPAA identifier category.** HIPAA defines 18 identifiers that constitute PHI when linked to health information: names, geographic data (smaller than state), dates (except year), phone/fax numbers, email addresses, SSN, medical record numbers, health plan beneficiary numbers, account numbers, certificate/license numbers, vehicle/device identifiers, web URLs, IP addresses, biometric identifiers, full-face photos, and any other unique identifying number. Every column storing one of these must be tagged in the schema. (45 CFR 164.514(b))

2. **Separate PHI storage from non-PHI storage where architecturally feasible.** PHI columns should be in dedicated tables or schemas that have stricter access controls, encryption, and audit logging than general application data. This reduces the blast radius of a breach and simplifies compliance auditing. At minimum, PHI fields must be identifiable — at best, they are physically isolated.

### Minimum Necessary

3. **Query only the PHI fields required for the specific operation.** Never use `SELECT *` on tables containing PHI. Every query must specify the exact columns needed. A billing function needs name and insurance ID — not diagnosis or treatment history. A scheduling function needs name and appointment time — not medical records. The minimum necessary principle applies to every data access, not just external disclosures. (45 CFR 164.502(b))

4. **Implement role-based field filtering for PHI access.** Define which roles can access which PHI fields. A billing clerk sees different fields than a treating physician. Enforce this in the data access layer — not in the UI. Create database views or query filters per role that expose only the fields that role is authorized to access.

### Encryption

5. **Encrypt all PHI at rest with AES-256.** Use AES-256-GCM for field-level encryption of PHI columns, or ensure full-disk encryption uses AES-256. Field-level encryption is preferred because it protects PHI even from database administrators and in database backups. Encryption keys must be managed through a KMS or HSM — never stored in the database or application configuration. Properly encrypted PHI is exempt from breach notification requirements under the Safe Harbor provision. (45 CFR 164.402)

6. **Encrypt all PHI in transit with TLS 1.2 or higher.** All network connections that transmit PHI — API calls, database connections, internal service communication, file transfers — must use TLS 1.2+ with cipher suites recommended by NIST SP 800-52. TLS 1.3 is preferred for PHI transit. (45 CFR 164.312(e))

### Audit Logging

7. **Log every access to PHI with full attribution.** Every read, write, update, or deletion of PHI must produce an audit log entry containing: the authenticated user ID, their role, the action performed, which PHI fields were accessed, the patient/record identifier, the timestamp, the source IP, and the justification (normal access, emergency, treatment, billing). (45 CFR 164.312(b))

8. **Make audit logs tamper-evident.** Audit logs must not be editable after creation. Use append-only storage (write-once databases, immutable log streams) or chain log entries by including a hash of the previous entry in each new entry. If an attacker or insider modifies PHI, the audit trail must remain intact to prove what happened.

9. **Retain audit logs for a minimum of 6 years.** HIPAA requires documentation (including audit logs) to be retained for 6 years from the date of creation or the date it was last in effect. Implement a `retention_expires_at` field on audit records. Logs must be retrievable and searchable throughout this period — archival storage is acceptable if logs can be recalled. (45 CFR 164.530(j))

### Break-the-Glass Access

10. **Implement emergency access override with mandatory logging and justification.** Healthcare systems must provide a mechanism for authorized personnel to access PHI outside their normal permissions in emergencies (e.g., unconscious patient in the ER). This "break-the-glass" access must: require a written justification (minimum meaningful length), create an elevated audit log entry, notify the compliance team, and auto-expire within a defined window (4–24 hours).

11. **Auto-expire emergency access and trigger compliance review.** Emergency access grants must have a hard expiration time that is enforced in code — not dependent on the user revoking their own access. After expiration (or after use), automatically queue the access event for compliance review. The review queue must track: who accessed what, the stated justification, the access duration, and whether the access was appropriate.

### PHI in Logs and Error Messages

12. **Never include PHI in application logs, error messages, or stack traces.** Application logs must not contain patient names, medical record numbers, SSNs, diagnoses, or any of the 18 HIPAA identifiers. Log opaque identifiers (UUIDs, internal record IDs) for traceability. Implement a PHI redaction filter in the logging pipeline that removes patterns matching known PHI formats before log entries are written. (CWE-359)

13. **Sanitize error responses before returning to clients.** In production, API error responses must never include PHI, even if the error was caused by PHI data (e.g., a validation error on a patient name field). Return generic error identifiers that map to internal logs via a correlation ID — not the data that caused the error.

### Access Controls

14. **Enforce unique user identification — no shared accounts.** Every user who accesses PHI must have a unique identifier. Shared accounts, generic logins, and service accounts used by multiple people violate HIPAA's audit requirements because individual access cannot be attributed. (45 CFR 164.312(a)(2)(i))

15. **Implement automatic session timeout after inactivity.** Sessions that access PHI must expire after a period of inactivity (typically 15 minutes for clinical workstations). Enforce this server-side — client-side timeouts can be bypassed. On timeout, require re-authentication before any further PHI access. (45 CFR 164.312(a)(2)(iii))

## Patterns

### PHI Field Marking

#### Do This

```python
# SQLAlchemy: mark PHI columns with metadata
from sqlalchemy import Column, String, Date, MetaData
from sqlalchemy.orm import DeclarativeBase

class Base(DeclarativeBase):
    pass

class Patient(Base):
    __tablename__ = "patients"

    id = Column(String, primary_key=True)  # Internal ID — not PHI
    # PHI fields — marked with info dict for automated discovery
    name = Column(String(200), info={"phi": True, "category": "name"})
    ssn = Column(String(11), info={"phi": True, "category": "ssn"})
    dob = Column(Date, info={"phi": True, "category": "date"})
    email = Column(String(254), info={"phi": True, "category": "email"})
    mrn = Column(String(20), info={"phi": True, "category": "medical_record_number"})
    # Non-PHI fields
    created_at = Column(Date)
    provider_id = Column(String)  # References provider, not patient identity
```

```sql
-- PostgreSQL: column comments for PHI classification
COMMENT ON COLUMN patients.name IS 'PHI:name — Patient full name (HIPAA identifier #1)';
COMMENT ON COLUMN patients.ssn IS 'PHI:ssn — Social Security Number (HIPAA identifier #7)';
COMMENT ON COLUMN patients.dob IS 'PHI:date — Date of birth (HIPAA identifier #3)';
COMMENT ON COLUMN patients.email IS 'PHI:email — Email address (HIPAA identifier #5)';
COMMENT ON COLUMN patients.mrn IS 'PHI:mrn — Medical record number (HIPAA identifier #8)';
```

#### Not This

```python
# No PHI markers — impossible to audit, encrypt, or delete systematically
class Patient(Base):
    __tablename__ = "patients"
    id = Column(String, primary_key=True)
    name = Column(String(200))
    ssn = Column(String(11))
    dob = Column(Date)
    diagnosis = Column(String(500))
```

**Why it's wrong:** Without PHI markers, there is no way to automatically discover which fields need encryption, which fields must be included in audit logs, which fields must be excluded from non-PHI views, or which fields must be purged when a record is de-identified. Every HIPAA technical control depends on knowing where PHI lives.

### Minimum Necessary Queries

#### Do This

```python
# Role-based field access — billing sees different fields than providers
ROLE_FIELD_ACCESS = {
    "billing": ["id", "name", "insurance_id", "billing_code"],
    "scheduling": ["id", "name", "appointment_time", "provider_id"],
    "provider": ["id", "name", "dob", "mrn", "diagnosis", "treatment_plan"],
    "researcher": ["id", "age_range", "diagnosis_code"],  # De-identified
}

def get_patient(patient_id: str, user_role: str) -> dict:
    allowed_fields = ROLE_FIELD_ACCESS.get(user_role)
    if not allowed_fields:
        raise PermissionError(f"Role '{user_role}' has no PHI access defined")

    columns = ", ".join(allowed_fields)
    row = db.execute(
        f"SELECT {columns} FROM patients WHERE id = %s", (patient_id,)
    ).fetchone()

    audit_log.record(
        user_id=current_user.id,
        role=user_role,
        action="read",
        patient_id=patient_id,
        fields_accessed=allowed_fields,
    )
    return dict(zip(allowed_fields, row)) if row else None
```

#### Not This

```python
# SELECT * — returns all PHI regardless of need (violates minimum necessary)
def get_patient(patient_id: str) -> dict:
    row = db.execute("SELECT * FROM patients WHERE id = %s", (patient_id,)).fetchone()
    return dict(row)  # Billing clerk now has diagnosis, SSN, and treatment plan
```

**Why it's wrong:** A billing clerk who runs this query receives the patient's SSN, diagnosis, treatment plan, and every other field — data they have no business need to see. The minimum necessary principle requires that each role access only the PHI fields required for their specific function. `SELECT *` on a PHI table is a HIPAA violation in any context except direct patient care by the treating provider.

### Tamper-Evident Audit Logging

#### Do This

```python
import hashlib
import json
from datetime import datetime, timedelta

class AuditLogger:
    def __init__(self, db):
        self.db = db

    def record(self, user_id: str, role: str, action: str,
               patient_id: str, fields_accessed: list[str],
               justification: str = "normal_access") -> None:
        # Get hash of previous entry for tamper detection
        prev = self.db.execute(
            "SELECT entry_hash FROM phi_audit_log ORDER BY id DESC LIMIT 1"
        ).fetchone()
        prev_hash = prev["entry_hash"] if prev else "GENESIS"

        entry = {
            "user_id": user_id,
            "role": role,
            "action": action,
            "patient_id": patient_id,
            "fields_accessed": fields_accessed,
            "justification": justification,
            "timestamp": datetime.utcnow().isoformat(),
            "source_ip": get_client_ip(),
        }

        # Hash includes previous hash — creates tamper-evident chain
        entry_hash = hashlib.sha256(
            (json.dumps(entry, sort_keys=True) + prev_hash).encode()
        ).hexdigest()

        retention_expires = datetime.utcnow() + timedelta(days=6 * 365)

        self.db.execute(
            """INSERT INTO phi_audit_log
               (entry_data, entry_hash, prev_hash, retention_expires_at)
               VALUES (%s, %s, %s, %s)""",
            [json.dumps(entry), entry_hash, prev_hash, retention_expires],
        )
```

#### Not This

```python
# Mutable log entries in a regular table — no integrity, no retention
def log_access(user_id, patient_id):
    db.execute(
        "INSERT INTO logs (user_id, patient_id, ts) VALUES (%s, %s, NOW())",
        [user_id, patient_id],
    )
    # No hash chain — logs can be silently modified or deleted
    # No retention_expires_at — logs may be deleted before 6 years
    # No role, no fields_accessed, no justification — insufficient audit detail
```

**Why it's wrong:** A regular table allows UPDATE and DELETE on audit records — an insider who accesses PHI inappropriately can cover their tracks by modifying the log. Without a hash chain, there is no way to detect that logs have been tampered with. Without a retention date, logs may be purged by routine database cleanup before the 6-year HIPAA requirement is met.

### Break-the-Glass Access

#### Do This

```python
from datetime import datetime, timedelta

def grant_emergency_access(
    user_id: str, patient_id: str, justification: str
) -> str:
    if len(justification.strip()) < 20:
        raise ValueError("Emergency access requires a meaningful justification")

    expires_at = datetime.utcnow() + timedelta(hours=4)

    grant_id = db.execute(
        """INSERT INTO emergency_access_grants
           (user_id, patient_id, justification, granted_at, expires_at, revoked)
           VALUES (%s, %s, %s, NOW(), %s, FALSE) RETURNING id""",
        [user_id, patient_id, justification, expires_at],
    ).fetchone()["id"]

    # Elevated audit entry
    audit_log.record(
        user_id=user_id, role="EMERGENCY_OVERRIDE",
        action="break_the_glass_grant", patient_id=patient_id,
        fields_accessed=["ALL"],
        justification=justification,
    )

    # Notify compliance team for post-access review
    notify_compliance_team(
        event="emergency_access_granted",
        user_id=user_id, patient_id=patient_id,
        grant_id=grant_id, expires_at=expires_at.isoformat(),
    )

    return grant_id

def check_emergency_access(user_id: str, patient_id: str) -> bool:
    """Verify an active, non-expired emergency grant exists."""
    grant = db.execute(
        """SELECT id FROM emergency_access_grants
           WHERE user_id = %s AND patient_id = %s
             AND expires_at > NOW() AND revoked = FALSE""",
        [user_id, patient_id],
    ).fetchone()
    return grant is not None
```

#### Not This

```python
# Admin flag bypasses all access controls — no logging, no expiry
def get_patient_data(user_id: str, patient_id: str, is_admin: bool = False):
    if is_admin:
        return db.execute("SELECT * FROM patients WHERE id = %s", [patient_id])
    # Normal access path...
```

**Why it's wrong:** A boolean admin flag provides permanent, unlogged bypass of all access controls. There is no justification requirement, no expiration, no compliance notification, and no audit trail distinguishing emergency access from normal access. HIPAA requires that emergency access be the exception — tightly scoped, time-limited, and audited more rigorously than normal access.

## Exceptions

- **De-identified data** (all 18 HIPAA identifiers removed per 45 CFR 164.514) is not PHI. De-identified datasets for research do not require PHI-level controls. However, the de-identification process itself must be audited and the linkage key (if retained) must be protected as PHI.
- **Treatment, Payment, and Healthcare Operations (TPO)** allow PHI access without patient authorization, but the minimum necessary principle still applies to payment and operations. Treatment access by the treating provider is exempt from minimum necessary restrictions.
- **Psychotherapy notes** (45 CFR 164.508(a)(2)) have stricter protections than general PHI. They must be stored separately from the medical record and require explicit patient authorization for most disclosures, including to other providers.

## Cross-References

- [Security](core-security) — Rule 5 (AES-256, TLS 1.2+), Rule 9 (encrypt at rest/in transit), Rule 10 (log security events)
- [Error Handling](core-error-handling) — Sanitizing error responses to exclude PHI
- [Backend Security](web-backend-security) — Authentication, session management, RBAC enforcement
- [Database Schema Security](database-schema-security) — RLS policies for PHI table access, audit triggers
- [Database Encryption](database-encryption) — Field-level encryption for PHI columns, key management
