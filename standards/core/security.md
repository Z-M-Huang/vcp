---
id: core-security
title: Security
scope: core
severity: critical
tags: [security, owasp, cwe, input-validation, authentication, cryptography]
references:
  - title: OWASP Top 10 2025
    url: https://owasp.org/Top10/2025/
  - title: OWASP ASVS v5.0
    url: https://owasp.org/www-project-application-security-verification-standard/
  - title: OpenSSF Security Guide for AI Code Assistants
    url: https://openssf.org/
  - title: CWE Top 25 Most Dangerous Software Weaknesses
    url: https://cwe.mitre.org/top25/archive/2024/2024_cwe_top25.html
  - title: OWASP Agentic AI Top 10 (Dec 2025)
    url: https://genai.owasp.org/2025/12/09/owasp-genai-security-project-releases-top-10-risks-and-mitigations-for-agentic-ai-security/
---

## Principle

Every input from outside the trust boundary is hostile until validated. Security is a non-negotiable constraint applied from the first line of code — not a feature bolted on before release. When security and convenience conflict, security wins.

AI-generated code has a **2.74x higher security vulnerability rate** than human-written code (CodeRabbit 2025). 45% of AI-generated code contains security vulnerabilities (Veracode 2025). This standard exists to close that gap.

## Rules

### Input and Output

1. **Validate all input at system boundaries.** Every value crossing a trust boundary — user input, API responses, file contents, environment variables, database results — must be validated for type, length, format, and range before use. Reject by default; accept only what matches the expected shape. (CWE-20)

2. **Encode output for its destination context.** Data rendered into HTML must be HTML-encoded. Data inserted into URLs must be URL-encoded. Data embedded in SQL must use parameterized queries. The encoding method must match the output context — there is no universal encoding. (CWE-116)

3. **Parameterize all data queries.** Never concatenate, interpolate, or format user-controlled values into query strings — SQL, NoSQL, LDAP, OS commands, or any interpreter. Use the language's parameterized query mechanism. No exceptions. (CWE-89, CWE-78, CWE-90)

### Secrets and Cryptography

4. **Never hardcode secrets.** No passwords, API keys, tokens, connection strings, or cryptographic keys in source code, configuration files committed to version control, or log output. Use environment variables, secret managers, or vault services. (CWE-798, CWE-259)

5. **Use strong, current cryptographic algorithms.** Use bcrypt, scrypt, or Argon2 for password hashing — never MD5, SHA-1, or plain SHA-256. Use AES-256-GCM for symmetric encryption. Use TLS 1.2+ for transport. Use `crypto.getRandomValues()` or `/dev/urandom` for random values — never `Math.random()` or similar non-cryptographic PRNGs for security-sensitive operations. (CWE-327, CWE-328, CWE-338)

### Authentication and Authorization

6. **Use proven authentication libraries.** Do not implement login, session management, password hashing, JWT validation, or OAuth flows from scratch. Use established, maintained libraries (e.g., Passport.js, Spring Security, Django auth, NextAuth). Custom implementations introduce vulnerabilities that established libraries have already fixed. (CWE-287)

7. **Deny by default.** Every resource is inaccessible unless explicitly granted. Check authorization on every request, on the server side, against the authenticated user's actual permissions — not a client-supplied role or ID. Never trust client-side authorization checks as a security boundary. (CWE-284, CWE-862, CWE-639)

### Data Protection

8. **Never deserialize untrusted data without validation.** Deserialization of user-controlled input enables remote code execution. If deserialization is required, use safe formats (JSON over native serialization), validate schemas before processing, and never deserialize with classes/types that have dangerous side effects. (CWE-502)

9. **Encrypt sensitive data at rest and in transit.** PII, credentials, financial data, and health records must be encrypted in storage and transmitted over TLS. Identify what data is sensitive before writing code — not after a breach. (CWE-311, CWE-312)

### Logging and Monitoring

10. **Log security events. Never log secrets.** Log authentication attempts, authorization failures, input validation failures, and access to sensitive resources. Never log passwords, tokens, API keys, session IDs, PII, or full credit card numbers. Sanitize log inputs to prevent log injection. (CWE-117, CWE-532, CWE-778)

### Dependencies

11. **Verify every dependency exists and is legitimate before using it.** Before adding any package: confirm it exists on the official registry, check download counts, verify the publisher, and review the last publish date. AI hallucinates package names ~20% of the time — installing an unverified package is a supply chain attack vector. (CWE-829)

## Patterns

### Input Validation

#### Do This

```python
# Validate at system boundary — reject invalid input early
def create_user(request):
    email = request.data.get("email", "")
    if not isinstance(email, str) or len(email) > 254:
        raise ValidationError("Invalid email format")
    if not EMAIL_REGEX.match(email):
        raise ValidationError("Invalid email format")
    # Proceed with validated input
    return user_service.create(email=email)
```

#### Not This

```python
# No validation — trusts user input directly (CWE-20)
def create_user(request):
    email = request.data["email"]
    return user_service.create(email=email)
```

**Why it's wrong:** The email field could contain anything — an empty string, a 10MB payload, injection characters, or a missing key entirely. Without validation, this data propagates through the system as a trusted value.

### Parameterized Queries

#### Do This

```python
# Parameterized query — user input is data, never code
cursor.execute("SELECT * FROM users WHERE email = %s", (email,))
```

```javascript
// Parameterized query with pg (Node.js)
const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
```

#### Not This

```python
# String interpolation — user controls the query structure (CWE-89)
cursor.execute(f"SELECT * FROM users WHERE email = '{email}'")
```

**Why it's wrong:** Setting `email` to `' OR '1'='1` returns all users. Setting it to `'; DROP TABLE users; --` destroys the table. Parameterized queries treat the value as data, never as part of the SQL structure.

### Secrets Management

#### Do This

```python
import os

# Read from environment — secrets never in source code
database_url = os.environ["DATABASE_URL"]
api_key = os.environ["STRIPE_API_KEY"]
```

#### Not This

```python
# Hardcoded secrets in source code (CWE-798)
DATABASE_URL = "postgresql://admin:s3cret@prod-db.internal:5432/app"
STRIPE_API_KEY = "sk_live_abc123xyz789"
```

**Why it's wrong:** Source code is stored in version control, visible to every developer, often pushed to GitHub, and included in build artifacts. A secret in code is a secret shared with everyone who has access to the repo — including public if the repo is open source.

### Cryptography

#### Do This

```python
import bcrypt

# bcrypt — purpose-built for password hashing with adaptive cost
hashed = bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12))
```

```javascript
// Crypto-safe random values
const token = crypto.getRandomValues(new Uint8Array(32));
```

#### Not This

```python
import hashlib

# Plain SHA-256 — fast hash, not designed for passwords (CWE-327)
hashed = hashlib.sha256(password.encode()).hexdigest()
```

```javascript
// Math.random() — not cryptographically secure (CWE-338)
const token = Math.random().toString(36).substring(2);
```

**Why it's wrong:** SHA-256 is fast by design — an attacker can compute billions of hashes per second to brute-force passwords. bcrypt/Argon2 are intentionally slow and salted. `Math.random()` is a PRNG not designed for security — its output is predictable and must never be used for tokens, session IDs, or any security-sensitive value.

### Authorization

#### Do This

```python
# Check server-side on every request against the authenticated user
def get_document(request, document_id):
    document = Document.objects.get(id=document_id)
    if document.owner_id != request.user.id:
        raise PermissionDenied("Access denied")
    return document
```

#### Not This

```python
# No authorization check — any authenticated user can access any document (CWE-862)
def get_document(request, document_id):
    return Document.objects.get(id=document_id)
```

**Why it's wrong:** Without an authorization check, any authenticated user can access any document by guessing or iterating IDs. This is an Insecure Direct Object Reference (IDOR) — OWASP A01:2025 Broken Access Control.

## Exceptions

- **Input validation strictness:** Internal service-to-service communication within a trusted network boundary may use lighter validation, but MUST still validate type and bounds. Trust boundaries should be explicitly documented.
- **Hardcoded configuration:** Non-secret configuration (port numbers, feature flags, default timeouts) may be in code. The test is: would this value being public cause harm? If yes, it's a secret.
- **Logging PII:** Some compliance requirements mandate logging user identifiers for audit trails. In these cases, log the minimum necessary identifiers, never passwords or tokens, and ensure logs are access-controlled and encrypted.

## OWASP Top 10:2025 Coverage Map

| OWASP 2025 Category | VCP Coverage |
|----------------------|-------------|
| **A01 — Broken Access Control** | Rule 7 (deny by default, server-side authZ). Expanded in [web-backend-security](web-backend-security) rules 7-10 (RBAC/ABAC with deny-by-default, mass assignment) and SSRF rule 15 (CWE-918 is classified under A01:2025). |
| **A02 — Security Misconfiguration** | Rule 4 (no secrets in code). Expanded in [web-frontend-security](web-frontend-security) CSP/CORS rules and [web-backend-security](web-backend-security) secrets management. |
| **A03 — Software Supply Chain Failures** | Rule 11 (verify dependencies). Full coverage in [core-dependency-management](core-dependency-management) rules 1-13 (slopsquatting, lockfile hygiene, behavioral analysis). |
| **A04 — Cryptographic Failures** | Rule 4 (no hardcoded secrets), Rule 5 (strong algorithms, no MD5/SHA-1, crypto-safe random). |
| **A05 — Injection** | Rule 3 (parameterize all queries — SQL, NoSQL, OS, LDAP). Expanded in [web-backend-security](web-backend-security) rules 1-3. |
| **A06 — Insecure Design** | Rule 1 (validate at boundaries), Rule 7 (deny by default). Broader coverage in [core-architecture](core-architecture). |
| **A07 — Authentication Failures** | Rule 5 (strong crypto for passwords), Rule 6 (use proven auth libraries). Expanded in [web-backend-security](web-backend-security) rules 4-6. |
| **A08 — Software or Data Integrity Failures** | Rule 8 (no untrusted deserialization), Rule 11 (verify dependency integrity). |
| **A09 — Security Logging & Alerting Failures** | Rule 10 (log security events, never log secrets). |
| **A10 — Mishandling of Exceptional Conditions** | Rules 1-2 (validate and reject invalid input). Full coverage in [core-error-handling](core-error-handling) (crash loudly, boundary validation, structured errors, never swallow exceptions). |

## Cross-References

- [Error Handling](core-error-handling) — How to handle validation failures and security exceptions
- [Testing](core-testing) — How to test security boundaries and edge cases
- [Dependency Management](core-dependency-management) — Full dependency verification and supply chain security
- [Web Frontend Security](web-frontend-security) — XSS prevention, CSP, auth token handling
- [Web Backend Security](web-backend-security) — Injection prevention, auth implementation, secrets management
