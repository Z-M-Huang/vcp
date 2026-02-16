---
id: compliance-gdpr
title: GDPR & CCPA/CPRA Data Protection
scope: compliance
severity: critical
tags: [compliance, gdpr, ccpa, cpra, pii, data-protection, right-to-be-forgotten, data-deletion]
references:
  - title: "GDPR — General Data Protection Regulation (Full Text)"
    url: https://gdpr-info.eu/
  - title: "CCPA — California Consumer Privacy Act (As Amended by CPRA)"
    url: https://oag.ca.gov/privacy/ccpa
  - title: "OWASP — User Privacy Protection Cheat Sheet"
    url: https://cheatsheetseries.owasp.org/cheatsheets/User_Privacy_Protection_Cheat_Sheet.html
  - title: "CWE-359 — Exposure of Private Personal Information to an Unauthorized Actor"
    url: https://cwe.mitre.org/data/definitions/359.html
---

## Principle

Personal data has a lifecycle — it must be collected with consent, stored with purpose, and deleted when that purpose ends. Code that handles personal data must enforce these constraints structurally, not through manual processes or good intentions.

GDPR (EU) and CCPA/CPRA (California) impose coding-level requirements that go beyond general security practices: data must be deletable on request, retention must be enforced automatically, consent must be tracked per purpose, and PII must be identifiable in schemas so it can be found, exported, and purged. This standard covers the coding patterns that address both frameworks. GDPR and CCPA/CPRA overlap significantly in their coding-level requirements (deletion, retention, consent, PII handling), but they are not identical — CCPA/CPRA has requirements with no GDPR equivalent (e.g., "Do Not Sell or Share," Global Privacy Control). Rules that apply specifically to CCPA/CPRA are marked in their own section.

## Rules

### PII Identification

1. **Mark PII fields explicitly in every schema.** Every column, field, or attribute that stores personal data must be tagged with its classification: `direct` (name, email, SSN — identifies a person alone), `indirect` (IP address, device ID — identifies when combined), or `sensitive` (race, health, biometrics — requires explicit consent). Use ORM decorators, column comments, or a classification registry. If you cannot enumerate every PII field in your schema, you cannot comply with a deletion or export request. (CWE-359)

2. **Maintain a PII registry that maps every PII field to its purpose and legal basis.** For each PII field, document: what data it holds, why it is collected (purpose), the legal basis for processing (consent, contract, legal obligation, legitimate interest), and the retention period. This registry drives automated deletion, export, and consent enforcement. It is not optional documentation — it is the source of truth for data lifecycle operations.

### Data Deletion

3. **Implement deletion as a two-phase operation: soft delete with grace period, then hard delete.** On a deletion request, set a `deleted_at` timestamp and stop processing the record. After a grace period (14–30 days, to handle accidental requests), run an automated job that permanently removes the data. Partial indexes (`WHERE deleted_at IS NULL`) maintain query performance and unique constraint behavior for active records.

4. **Cascade deletion across all related tables and systems.** A deletion request applies to all personal data about that person — not just the primary record. Map every table and external system that references the user, and delete or anonymize data in all of them. Use foreign key `ON DELETE CASCADE` for dependent data with no independent business value. For data with independent value (e.g., order history needed for tax records), anonymize by replacing PII fields with null or a placeholder — do not delete the record.

5. **Purge personal data from backups on a defined schedule.** Backups that contain deleted users' PII must not persist indefinitely. Maintain a deletion index (user IDs and deletion timestamps — not PII itself) that is applied when backups are restored. Alternatively, set backup retention periods that align with your grace period so deleted data ages out naturally. Document your backup purging strategy.

### Data Retention

6. **Enforce retention periods automatically in code.** Every data category must have a defined retention period with an automated purging mechanism. Use database-level TTL (MongoDB `expireAfterSeconds` indexes) or scheduled jobs that delete records past their retention date. Manual retention enforcement is not enforcement — it is a compliance gap waiting to happen. (GDPR Article 5(1)(e))

7. **Log retention policy execution.** Every automated purge must produce an audit record: what data category was purged, how many records, the retention policy that triggered it, and the timestamp. This proves to regulators that retention policies are actively enforced, not just documented.

### Consent Management

8. **Track consent per purpose with full metadata.** Store consent as append-only records with: user ID, purpose (marketing, analytics, personalization, third-party sharing), granted/withdrawn status, timestamp, policy version the user consented to, and the method of consent (cookie banner, settings page, signup form). Never update consent records in place — insert new records to maintain a complete history. (GDPR Article 7)

9. **Consent withdrawal must be as easy as consent granting.** Provide a single action (API call, toggle, button) that withdraws consent for a specific purpose. On withdrawal, stop all processing for that purpose immediately — unsubscribe from email lists, stop analytics tracking, suppress ad targeting. The withdrawal must propagate to all downstream systems that relied on that consent.

10. **Never process data without a valid legal basis.** Before any data processing operation, verify that the user has an active, non-withdrawn consent for the specific purpose, OR that a non-consent legal basis applies (contract performance, legal obligation). Consent checks belong in the service layer — not in the UI layer where they can be bypassed.

### PII in Logs and Error Messages

11. **Exclude PII from all application logs and error messages.** Beyond the general prohibition on logging secrets ([core-security](core-security) rule 10), compliance requires that PII never appears in application logs, error messages returned to users, or stack traces. Implement structured logging with a PII filter that redacts fields matching known PII patterns (email, phone, SSN, name) before log entries are written. Log user IDs (opaque identifiers) for traceability — never names, emails, or other personal data.

### Data Export and Portability

12. **Support full data export in a machine-readable format.** On request, assemble all personal data about a user from all systems into a structured export (JSON or CSV). Include: profile data, activity history, consent records, and any other data categories in the PII registry. Provide the export as a downloadable file with a time-limited access URL. (GDPR Article 20)

### CCPA/CPRA-Specific Requirements

13. **Implement "Do Not Sell or Share" as a persistent user preference.** Track `do_not_sell` and `do_not_share` flags per user. Detect the Global Privacy Control (GPC) signal (`Sec-GPC: 1` header) and treat it as an opt-out request. Sync the opt-out to all third-party data sharing integrations (ad platforms, analytics vendors, data brokers). (CCPA §1798.120, CPRA amendments)

14. **Classify and protect sensitive personal information separately.** CCPA/CPRA defines sensitive PI categories (SSN, financial accounts, precise geolocation, race, health, biometrics, sexual orientation) that require additional protections. Encrypt sensitive PI at rest, display a notice at collection that users can limit its use, and restrict processing to purposes the user has explicitly opted into.

## Patterns

### PII Field Marking

#### Do This

```python
# Django: custom field types that carry PII classification
class PIICharField(models.CharField):
    def __init__(self, *args, pii_category="direct", **kwargs):
        self.pii_category = pii_category
        super().__init__(*args, **kwargs)

class PIIEmailField(models.EmailField):
    def __init__(self, *args, pii_category="direct", **kwargs):
        self.pii_category = pii_category
        super().__init__(*args, **kwargs)

class UserProfile(models.Model):
    user_id = models.UUIDField(primary_key=True)          # Not PII — opaque ID
    name = PIICharField(max_length=200, pii_category="direct")
    email = PIIEmailField(pii_category="direct")
    ip_address = models.GenericIPAddressField(pii_category="indirect")
    ethnicity = PIICharField(max_length=100, pii_category="sensitive", blank=True)
```

```sql
-- PostgreSQL: column comments for PII classification
COMMENT ON COLUMN users.email IS 'PII:direct — User email address';
COMMENT ON COLUMN users.name IS 'PII:direct — User full name';
COMMENT ON COLUMN users.ip_address IS 'PII:indirect — Last login IP';
COMMENT ON COLUMN users.ethnicity IS 'PII:sensitive — Self-reported ethnicity';
```

#### Not This

```python
# No PII markers — impossible to find all personal data for deletion/export
class UserProfile(models.Model):
    name = models.CharField(max_length=200)
    email = models.EmailField()
    ip_address = models.GenericIPAddressField()
    ethnicity = models.CharField(max_length=100, blank=True)
```

**Why it's wrong:** Without PII markers, there is no way to programmatically discover which fields contain personal data. When a deletion request arrives, you must manually search every table and field. This is slow, error-prone, and guaranteed to miss data — which is a compliance violation.

### Consent Tracking

#### Do This

```python
# Append-only consent records with full metadata
class ConsentRecord(models.Model):
    class Purpose(models.TextChoices):
        MARKETING_EMAIL = "marketing_email"
        ANALYTICS = "analytics"
        PERSONALIZATION = "personalization"
        THIRD_PARTY_SHARING = "third_party_sharing"

    user_id = models.UUIDField(db_index=True)
    purpose = models.CharField(max_length=50, choices=Purpose.choices)
    granted = models.BooleanField()  # True = consent given, False = withdrawn
    timestamp = models.DateTimeField(auto_now_add=True)
    policy_version = models.CharField(max_length=20)
    consent_method = models.CharField(max_length=50)  # "cookie_banner", "settings_page"

    class Meta:
        indexes = [
            models.Index(fields=["user_id", "purpose", "-timestamp"]),
        ]

def has_active_consent(user_id: str, purpose: str) -> bool:
    """Check if the most recent consent record for this purpose is a grant."""
    latest = (
        ConsentRecord.objects
        .filter(user_id=user_id, purpose=purpose)
        .order_by("-timestamp")
        .first()
    )
    return latest is not None and latest.granted
```

#### Not This

```python
# Mutable consent column — no history, no metadata
class User(models.Model):
    email = models.EmailField()
    consented = models.BooleanField(default=False)  # Consent to what? When? Which policy?
```

**Why it's wrong:** A single boolean field cannot represent granular consent per purpose. There is no history — when consent was given or withdrawn is lost. There is no link to which privacy policy version the user agreed to. A regulator asking "prove this user consented to marketing emails on this date" cannot be answered.

### Two-Phase Deletion

#### Do This

```python
# Phase 1: Soft delete — stop processing, start grace period
def request_deletion(user_id: str) -> None:
    User.objects.filter(id=user_id, deleted_at__isnull=True).update(
        deleted_at=timezone.now()
    )
    # Revoke all active sessions immediately
    Session.objects.filter(user_id=user_id).delete()

# Phase 2: Hard delete — automated job after grace period
def purge_deleted_users() -> int:
    """Run daily. Permanently removes users past the grace period."""
    cutoff = timezone.now() - timedelta(days=30)
    users = User.objects.filter(deleted_at__lte=cutoff)
    count = users.count()

    for user in users.iterator():
        # Cascade to all related tables
        OrderHistory.objects.filter(user_id=user.id).update(
            customer_name=None, customer_email=None  # Anonymize, keep order data
        )
        SupportTicket.objects.filter(user_id=user.id).update(
            submitter_name="[deleted]", submitter_email=None
        )
        ConsentRecord.objects.filter(user_id=user.id).delete()
        UserProfile.objects.filter(user_id=user.id).delete()
        user.delete()  # Final hard delete

    logger.info("purge_completed", count=count, cutoff=cutoff.isoformat())
    return count
```

#### Not This

```python
# Immediate hard delete — no grace period, no cascade, no audit
def delete_user(user_id: str) -> None:
    User.objects.filter(id=user_id).delete()
```

**Why it's wrong:** No grace period means accidental deletion requests are irreversible. No cascade means personal data survives in related tables (orders, support tickets, consent records). No audit logging means you cannot prove the deletion happened. The `DELETE CASCADE` on the User model may not reach every table that stores PII.

### PII Log Filtering

#### Do This

```python
import re
import logging

PII_PATTERNS = {
    "email": re.compile(r"[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+"),
    "ssn": re.compile(r"\b\d{3}-\d{2}-\d{4}\b"),
    "phone": re.compile(r"\b\d{3}[-.]?\d{3}[-.]?\d{4}\b"),
}
SENSITIVE_KEYS = {"name", "email", "phone", "ssn", "address", "dob", "ip_address"}

class PIIFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            for label, pattern in PII_PATTERNS.items():
                record.msg = pattern.sub(f"[REDACTED_{label.upper()}]", record.msg)
        return True

# Attach to all loggers
logging.getLogger().addFilter(PIIFilter())
```

#### Not This

```python
# Logging user data directly — PII in logs (CWE-359)
logger.info(f"User {user.name} ({user.email}) logged in from {user.ip_address}")
logger.error(f"Failed to process order for {user.email}: {error}")
```

**Why it's wrong:** Log aggregation systems (ELK, Datadog, CloudWatch) store data for months or years. PII in logs becomes a compliance liability — it cannot be deleted on request, it is accessible to operations teams who have no need for personal data, and it expands the scope of any data breach to include log storage infrastructure.

## Exceptions

- **Legal holds** override deletion requests. If litigation or a regulatory investigation requires preserving a user's data, the deletion must be suspended until the hold is lifted. Implement a `legal_hold` flag that prevents both soft and hard deletion.
- **Tax and financial records** may have legally mandated retention periods (often 7+ years) that override GDPR/CCPA deletion rights. Anonymize the PII (remove name, email) but retain the financial data for the required period.
- **Aggregated and anonymized data** is not personal data under GDPR or CCPA. If data has been truly anonymized (not just pseudonymized — the original identity cannot be recovered), it is exempt from deletion and export requirements.

## Cross-References

- [Security](core-security) — Rule 9 (encrypt PII at rest and in transit), Rule 10 (log security events, never log secrets)
- [Error Handling](core-error-handling) — How to handle deletion failures and consent validation errors
- [Backend Data Access](web-backend-data-access) — Migration safety for adding PII markers and consent tables
- [Database Schema Security](database-schema-security) — Data classification markers, RLS for access control
