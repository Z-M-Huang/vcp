---
id: database-encryption
title: Database Encryption
scope: database
severity: critical
tags: [database, encryption, tde, column-encryption, key-management, pii]
references:
  - title: "OWASP — Cryptographic Storage Cheat Sheet"
    url: https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html
  - title: "OWASP — Key Management Cheat Sheet"
    url: https://cheatsheetseries.owasp.org/cheatsheets/Key_Management_Cheat_Sheet.html
  - title: "CWE-311 — Missing Encryption of Sensitive Data"
    url: https://cwe.mitre.org/data/definitions/311.html
  - title: "CWE-321 — Use of Hard-coded Cryptographic Key"
    url: https://cwe.mitre.org/data/definitions/321.html
---

## Principle

Encryption strategy is a trade-off between security, performance, and queryability — and the right choice depends on the threat model. Transparent Data Encryption protects against disk theft but not against a compromised application. Column-level encryption protects specific fields from database administrators but limits search. Application-level encryption provides the strongest guarantees but requires the most code changes. Choose based on what you are defending against, not what is easiest to implement.

AI-generated code either skips encryption entirely or applies it uniformly without considering the trade-offs. This standard provides a decision framework for choosing the right encryption level and the key management patterns that make encryption actually secure — because encryption without proper key management is just complexity without protection.

## Rules

### Encryption Level Selection

1. **Use the decision matrix to choose the right encryption level.** Do not apply one encryption strategy uniformly. Each level has different trade-offs:

   | Level | Protects Against | Does NOT Protect Against | Performance | Searchability |
   |-------|-----------------|------------------------|-------------|---------------|
   | **TDE** (Transparent Data Encryption) | Disk theft, physical media loss, stolen backups | Compromised application, privileged DB users, in-memory access | Minimal (1-3%) | Full — queries work normally |
   | **Column-level** (database engine encrypts specific columns) | Disk theft + privileged DB users for those columns | Compromised application with decryption permissions | Moderate (5-10% per encrypted column) | Limited — cannot index or search encrypted columns without blind indexes |
   | **Application-level** (encrypt before writing to DB) | Disk theft + DB admins + DB compromise — keys never reach the database | Key compromise in the application tier | Higher (20-30% for encrypted operations) | None without blind indexes |

   Choose TDE when disk-theft protection is sufficient (compliance checkbox). Choose column-level when specific fields need protection from DB admins. Choose application-level when zero-trust is required or when the database infrastructure is shared.

2. **TDE alone does not satisfy field-level encryption requirements.** PCI DSS, HIPAA, and GDPR may require field-level encryption for specific data types (PANs, PHI, PII). TDE encrypts the entire database at the storage layer — it does not protect data from users or applications that can query the database. If compliance requires that specific fields are encrypted, TDE is a baseline, not a solution.

### Key Management

3. **Use envelope encryption: encrypt data with a DEK, encrypt the DEK with a KEK.** Generate a unique Data Encryption Key (DEK) per record or per table. Encrypt the data with the DEK. Encrypt the DEK with a Key Encryption Key (KEK) stored in a KMS (AWS KMS, GCP Cloud KMS, Azure Key Vault, HashiCorp Vault). Store the encrypted DEK alongside the encrypted data. This way, rotating the KEK only requires re-wrapping DEKs — not re-encrypting all data. (CWE-321)

4. **Never store encryption keys in the database alongside encrypted data.** The encryption key and the encrypted data must be in separate systems. A database backup that contains both the encrypted data and the key to decrypt it provides no protection. Keys belong in a KMS, HSM, or at minimum, a separate secret store with independent access controls. (CWE-321)

5. **Rotate encryption keys on a defined schedule without re-encrypting all data.** Key rotation must not require downtime or bulk re-encryption. Use key versioning: new records are encrypted with the current key version, existing records retain their key version. Implement lazy re-encryption (decrypt with old key, re-encrypt with new key when the record is next accessed) or background batch re-encryption for inactive records. Tag every encrypted value with its key version.

### Field-Level Encryption

6. **Use AES-256-GCM for application-level encryption.** GCM mode provides both confidentiality and integrity (authenticated encryption). Generate a unique random IV (96 bits for GCM) for every encryption operation — never reuse an IV with the same key. Store the IV alongside the ciphertext (it is not secret). (CWE-327)

7. **Choose deterministic or randomized encryption based on query requirements.** Deterministic encryption (same input → same ciphertext with the same key) enables exact-match queries but leaks frequency patterns. Randomized encryption (unique ciphertext every time) is more secure but prevents direct querying. Default to randomized. Use deterministic only when exact-match search is a hard requirement and the security trade-off is documented.

8. **Use blind indexes for searching encrypted data.** When you need to search on a field that is randomized-encrypted, store a separate blind index column: compute `HMAC-SHA256(key, plaintext)` and store the result. Query against the HMAC value for exact matches. The HMAC key must be separate from the encryption key and stored in the KMS. This preserves encryption security while enabling search.

### ORM Integration

9. **Encrypt and decrypt at the model layer transparently.** Use ORM-level encryption (custom column types, model middleware, or attribute encryption libraries) so that business logic works with plaintext values and encryption/decryption happens automatically on read/write. This prevents inconsistencies where some code paths encrypt and others forget to.

### Anti-Patterns

10. **Never use ECB mode, static IVs, or Base64 encoding as encryption.** ECB mode leaks plaintext patterns. A static IV with the same key produces identical ciphertext for identical plaintext — equivalent to deterministic encryption without intent. Base64 is encoding, not encryption — it provides zero confidentiality. These are the most common encryption mistakes in AI-generated code. (CWE-327)

## Patterns

### Envelope Encryption with KMS

#### Do This

```python
import os
import boto3
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

kms = boto3.client("kms")
KMS_KEY_ID = os.environ["KMS_KEY_ID"]

def encrypt_field(plaintext: str) -> dict:
    """Envelope encryption: generate DEK, encrypt data, wrap DEK with KMS."""
    # Generate a data key from KMS
    response = kms.generate_data_key(KeyId=KMS_KEY_ID, KeySpec="AES_256")
    dek_plaintext = response["Plaintext"]     # Use to encrypt, then discard
    dek_encrypted = response["CiphertextBlob"]  # Store alongside ciphertext

    # Encrypt the data with the DEK
    nonce = os.urandom(12)  # 96-bit nonce for AES-GCM
    aesgcm = AESGCM(dek_plaintext)
    ciphertext = aesgcm.encrypt(nonce, plaintext.encode(), None)

    return {
        "ciphertext": ciphertext,
        "nonce": nonce,
        "encrypted_dek": dek_encrypted,
        "key_version": KMS_KEY_ID,
    }

def decrypt_field(record: dict) -> str:
    """Decrypt DEK with KMS, then decrypt data with DEK."""
    response = kms.decrypt(CiphertextBlob=record["encrypted_dek"])
    dek_plaintext = response["Plaintext"]

    aesgcm = AESGCM(dek_plaintext)
    plaintext = aesgcm.decrypt(record["nonce"], record["ciphertext"], None)
    return plaintext.decode()
```

#### Not This

```python
# Key stored in code alongside encrypted data (CWE-321)
SECRET_KEY = b"my-secret-key-12345678901234567"  # Hardcoded, no rotation

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

def encrypt_field(plaintext: str) -> bytes:
    iv = b"\x00" * 16  # Static IV — identical plaintext = identical ciphertext
    cipher = Cipher(algorithms.AES(SECRET_KEY), modes.ECB())  # ECB mode leaks patterns
    encryptor = cipher.encryptor()
    return encryptor.update(plaintext.encode().ljust(16)) + encryptor.finalize()
```

**Why it's wrong:** Three critical errors: (1) The key is hardcoded in source code — anyone with code access can decrypt all data. (2) ECB mode encrypts each block independently, so repeated plaintext blocks produce identical ciphertext blocks — patterns in the data are visible. (3) A static IV means the same plaintext always produces the same ciphertext, enabling frequency analysis. Any single one of these makes the encryption ineffective.

### Blind Index for Searchable Encrypted Fields

#### Do This

```python
import hmac
import hashlib
import os

BLIND_INDEX_KEY = os.environ["BLIND_INDEX_KEY"]  # Separate from encryption key

def compute_blind_index(plaintext: str) -> str:
    """HMAC-based blind index for exact-match search on encrypted fields."""
    return hmac.new(
        BLIND_INDEX_KEY.encode(),
        plaintext.lower().strip().encode(),
        hashlib.sha256,
    ).hexdigest()

# Write: encrypt the email, store blind index alongside
encrypted_email = encrypt_field(user_email)
email_blind_index = compute_blind_index(user_email)
db.execute(
    "INSERT INTO users (encrypted_email, email_index) VALUES (%s, %s)",
    [encrypted_email, email_blind_index],
)

# Search: compute blind index from search term, query the index column
def find_user_by_email(email: str):
    index = compute_blind_index(email)
    row = db.execute(
        "SELECT * FROM users WHERE email_index = %s", [index]
    ).fetchone()
    if row:
        row["email"] = decrypt_field(row["encrypted_email"])
    return row
```

#### Not This

```python
# Decrypt all records to search — O(n) scan, DEK exposed for every record
def find_user_by_email(email: str):
    rows = db.execute("SELECT * FROM users").fetchall()
    for row in rows:
        decrypted_email = decrypt_field(row["encrypted_email"])
        if decrypted_email == email:
            return row
    return None
```

**Why it's wrong:** Decrypting every record to find a match is O(n) — unusable at scale. It also means every record's encryption key must be retrieved from KMS on every search, multiplying KMS costs and latency. The blind index enables exact-match queries in O(1) via a standard database index, without ever decrypting the stored data.

### ORM-Layer Transparent Encryption

#### Do This

```python
# SQLAlchemy: custom type that encrypts/decrypts transparently
from sqlalchemy import TypeDecorator, LargeBinary

class EncryptedString(TypeDecorator):
    impl = LargeBinary
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is not None:
            return encrypt_field(value)  # Uses envelope encryption from above
        return value

    def process_result_value(self, value, dialect):
        if value is not None:
            return decrypt_field(value)
        return value

class Patient(Base):
    __tablename__ = "patients"
    id = Column(String, primary_key=True)
    ssn = Column(EncryptedString())          # Transparent encryption
    ssn_index = Column(String(64))            # Blind index for search
    name = Column(EncryptedString())          # Transparent encryption
```

#### Not This

```python
# Manual encrypt/decrypt scattered through business logic
def create_patient(name, ssn):
    encrypted_name = encrypt_field(name)  # Hope you never forget this
    encrypted_ssn = encrypt_field(ssn)
    db.execute("INSERT INTO patients ...", [encrypted_name, encrypted_ssn])

def get_patient(patient_id):
    row = db.execute("SELECT * FROM patients WHERE id = %s", [patient_id])
    row["name"] = decrypt_field(row["name"])  # Hope you never forget this
    # Oops — forgot to decrypt SSN
    return row
```

**Why it's wrong:** When encryption is manual, it is guaranteed to be inconsistent. Some code paths will forget to encrypt on write, others will forget to decrypt on read, and some will log plaintext values that were supposed to be encrypted. ORM-layer encryption centralizes the concern — business logic never sees ciphertext.

### Key Rotation with Versioning

#### Do This

```python
# Tag every encrypted value with its key version
def encrypt_with_version(plaintext: str) -> dict:
    result = encrypt_field(plaintext)
    result["key_version"] = CURRENT_KEY_VERSION  # e.g., "v3"
    return result

def decrypt_with_version(record: dict) -> str:
    key_id = KEY_VERSION_MAP[record["key_version"]]  # Map version to KMS key ID
    return decrypt_field(record, key_id=key_id)

# Lazy re-encryption: upgrade key version on read
def get_and_upgrade(record_id: str) -> str:
    record = db.get(record_id)
    plaintext = decrypt_with_version(record)

    if record["key_version"] != CURRENT_KEY_VERSION:
        new_encrypted = encrypt_with_version(plaintext)
        db.update(record_id, new_encrypted)  # Re-encrypted with current key

    return plaintext
```

#### Not This

```python
# Single key, no versioning — rotation requires re-encrypting everything
ENCRYPTION_KEY = os.environ["ENCRYPTION_KEY"]

# To rotate: decrypt all records with old key, re-encrypt with new key
# During migration: downtime or dual-read complexity with no version tracking
```

**Why it's wrong:** Without key versioning, key rotation requires decrypting and re-encrypting every record in a single operation. For large datasets, this means extended downtime or a complex dual-key migration with no way to track which records use which key. Key versioning makes rotation incremental and safe.

## Exceptions

- **Ephemeral data** (session tokens, temporary caches) that expire within minutes do not need envelope encryption. Standard encryption with a single key is sufficient if the key is rotated regularly.
- **Public data** (published content, public profiles) does not need field-level encryption. TDE for the entire database is sufficient to protect against physical theft.
- **Performance-critical read paths** (high-frequency analytics queries) may use TDE instead of field-level encryption if the threat model permits. Document the trade-off and ensure the most sensitive fields (PII, PHI, PCI) still use field-level encryption.

## Cross-References

- [Security](core-security) — Rule 5 (strong cryptographic algorithms — AES-256, no MD5/SHA-1), Rule 9 (encrypt at rest and in transit)
- [Backend Data Access](web-backend-data-access) — Connection encryption, migration safety for adding encrypted columns
- [PCI DSS](compliance-pci-dss) — PCI-specific encryption requirements for cardholder data
- [HIPAA](compliance-hipaa) — PHI encryption requirements and Safe Harbor provision
- [Database Schema Security](database-schema-security) — Data classification drives encryption decisions
