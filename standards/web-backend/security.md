---
id: web-backend-security
title: Backend Security
scope: web-backend
severity: critical
tags: [security, injection, authentication, authorization, secrets, rate-limiting, ssrf, owasp, cwe]
references:
  - title: "OWASP Top 10:2025"
    url: https://owasp.org/Top10/2025/
  - title: "CWE-89 — SQL Injection"
    url: https://cwe.mitre.org/data/definitions/89.html
  - title: "CWE-78 — OS Command Injection"
    url: https://cwe.mitre.org/data/definitions/78.html
  - title: "OWASP — Authentication Cheat Sheet"
    url: https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
  - title: "OWASP — Secrets Management Cheat Sheet"
    url: https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html
  - title: "CWE-918 — Server-Side Request Forgery (SSRF)"
    url: https://cwe.mitre.org/data/definitions/918.html
  - title: "OWASP — SSRF Prevention Cheat Sheet"
    url: https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
---

## Principle

The server is the security boundary. Every security check the client performs must be independently enforced server-side. Assume every request is from an attacker — validate input, authenticate the caller, authorize the action, parameterize queries, and never trust client-supplied data for security decisions.

AI-generated backend code has severe gaps: improper password handling (1.88x more likely), insecure deserialization (1.82x), log injection (88% failure rate), and SQL injection still present despite being a solved problem. This standard covers the server-side defenses that prevent the most common and dangerous backend vulnerabilities.

## Rules

### Injection Prevention

1. **Parameterize all SQL queries. No exceptions.** Never concatenate, interpolate, or format user-controlled values into SQL strings. Use parameterized queries (`$1`, `?`, `%s` with parameter arrays) or ORM query builders. This applies to all query types — SELECT, INSERT, UPDATE, DELETE, and DDL. (CWE-89)

2. **Parameterize all interpreter inputs.** SQL injection is one instance of a general class. The same rule applies to NoSQL queries, LDAP queries, XML queries (XPath), OS commands, and template engines. If user input reaches an interpreter, it must be through a parameterized interface. (CWE-78, CWE-90, CWE-643)

3. **Never pass user input to OS command execution.** Avoid `exec()`, `system()`, `spawn()`, `popen()`, or equivalent with user-controlled arguments. If shell interaction is unavoidable, use an allowlist of permitted commands and arguments — never construct command strings from user input. (CWE-78)

### Authentication

4. **Hash passwords with bcrypt, scrypt, or Argon2.** Never store passwords in plain text, MD5, SHA-1, or unsalted SHA-256. Use adaptive hashing algorithms designed for password storage: bcrypt (cost factor 12+), scrypt, or Argon2id. These are intentionally slow and include per-hash salts. (CWE-916)

5. **Implement proper session management.** Sessions must: use cryptographically random IDs (min 128 bits of entropy), expire after a reasonable inactivity period, be invalidated server-side on logout, be regenerated after authentication (prevent session fixation), and be transmitted only over HTTPS with Secure, HttpOnly, and SameSite cookie flags. (CWE-384, CWE-614)

6. **Rate-limit authentication endpoints.** Login, registration, password reset, and MFA verification endpoints must have rate limiting. Without it, attackers can brute-force credentials, enumerate users, or exhaust MFA codes. Implement per-IP and per-account limits with progressive backoff. (CWE-307)

### Authorization

7. **Check authorization on every request, server-side.** Every API endpoint that accesses a resource must verify the authenticated user has permission to perform the requested action on that specific resource. Do not trust client-supplied roles, permissions, or resource IDs without server-side verification. (CWE-862)

8. **Apply the principle of least privilege.** Users, services, and database connections should have the minimum permissions required for their function. A read-only endpoint should use a read-only database connection. An admin action should require admin-level authorization checked per-request — not a globally-scoped admin token. (CWE-250)

9. **Use a structured authorization model with deny-by-default.** Choose and implement a consistent model:
   - **RBAC (Role-Based Access Control):** Assign users to roles (admin, editor, viewer), roles to permissions. Use when permissions map cleanly to job functions and the number of roles is small and stable.
   - **ABAC (Attribute-Based Access Control):** Evaluate permissions based on attributes of the user, resource, and context (e.g., "user can edit documents they created" or "managers can approve expenses under $10,000"). Use when access rules depend on resource ownership, relationships, or dynamic conditions that roles alone cannot express.
   - **Mandatory safety properties (both models):**
     - **Deny-by-default:** If no policy explicitly grants access, the request is denied. Never use permissive fallbacks like "allow if permission is not defined" or "allow if role lookup fails."
     - **Centralized enforcement:** Define permissions in one place, enforce in shared middleware or a policy service. Never scatter ad-hoc `if (user.role === "admin")` checks across handlers.
     - **Policy tests required:** Authorization policies must have unit tests that verify: (1) unauthenticated users are denied, (2) users without the required role/attribute are denied, (3) only the intended roles/attributes grant access, (4) deny-by-default holds when a permission or role is undefined. (CWE-862, CWE-863)

10. **Prevent mass assignment.** Do not bind request bodies directly to database models or domain objects. Explicitly define which fields a request is allowed to set. An attacker adding `"role": "admin"` to a profile update request should not be able to escalate privileges. (CWE-915)

### Secrets Management

11. **Never store secrets in source code or version control.** Passwords, API keys, tokens, connection strings, and encryption keys belong in environment variables, secret managers (AWS Secrets Manager, HashiCorp Vault, GCP Secret Manager), or encrypted configuration — never in `.env` files committed to git, hardcoded in source, or stored in comments. (CWE-798)

12. **Rotate secrets on a schedule and after any suspected compromise.** API keys, database passwords, and signing keys should have a defined rotation period. After a suspected breach, employee departure, or accidental exposure (secret in a commit), rotate immediately. Secrets should be rotatable without downtime.

### Rate Limiting and Abuse Prevention

13. **Rate-limit all public-facing endpoints.** Not just authentication — any endpoint accessible without authentication (public APIs, search, webhooks) needs rate limiting to prevent denial-of-service, scraping, and abuse. Use progressive penalties: warn, throttle, block.

14. **Validate request size and depth.** Set maximum request body sizes, maximum JSON nesting depth, maximum query string length, and maximum header sizes. Unbounded inputs enable denial-of-service via memory exhaustion or parser abuse. (CWE-400)

### Server-Side Request Forgery (SSRF) Prevention

15. **Validate and restrict all server-side outbound requests.** When the server fetches a URL based on user input (webhooks, image proxies, URL previews, OAuth callbacks, PDF generators), enforce all of the following:
    - **Protocol allowlist:** Only allow `https://` (and `http://` only if explicitly required). Block `file://`, `gopher://`, `ftp://`, `dict://`, `data://`, and all other schemes.
    - **IP blocklist — block these ranges before the request is sent:** `127.0.0.0/8` (loopback), `10.0.0.0/8` (private), `172.16.0.0/12` (private), `192.168.0.0/16` (private), `169.254.0.0/16` (link-local, includes cloud metadata at `169.254.169.254`), `::1` (IPv6 loopback), `fc00::/7` (IPv6 private), `fe80::/10` (IPv6 link-local).
    - **DNS resolution check:** Resolve the hostname **before** making the request and check the resolved IP against the blocklist. This prevents DNS rebinding attacks where a hostname resolves to a public IP initially but resolves to `127.0.0.1` on subsequent lookups.
    - **Disable redirects or re-validate after each redirect.** An attacker can point to a public URL that 302-redirects to `http://169.254.169.254/latest/meta-data/`. If redirects are followed, re-validate the destination URL and resolved IP at each hop.
    - **Domain allowlist (preferred):** When the set of valid external hosts is known (e.g., webhook targets), use an explicit allowlist of permitted domains rather than relying on blocklists alone. (CWE-918, OWASP A01:2025)

## Patterns

### Injection Prevention

#### Do This

```python
# Parameterized query — user input is data, never SQL structure
async def get_user(email: str):
    row = await db.fetchrow(
        "SELECT id, email, name FROM users WHERE email = $1", email
    )
    return User.from_row(row) if row else None
```

```javascript
// Parameterized query with pg (Node.js)
async function getUser(email) {
  const { rows } = await pool.query(
    "SELECT id, email, name FROM users WHERE email = $1",
    [email]
  );
  return rows[0] || null;
}
```

#### Not This

```python
# String interpolation — SQL injection vulnerability (CWE-89)
async def get_user(email: str):
    row = await db.fetchrow(
        f"SELECT id, email, name FROM users WHERE email = '{email}'"
    )
    return row
```

**Why it's wrong:** Setting `email` to `' OR '1'='1' --` returns all users. Setting it to `'; DROP TABLE users; --` destroys the table. AI still generates string-interpolated SQL in 2025 despite parameterized queries being available in every language and framework for 20+ years.

### Password Hashing

#### Do This

```python
import bcrypt

async def register_user(email: str, password: str) -> User:
    # bcrypt: adaptive cost, per-hash salt, designed for passwords
    hashed = bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12))
    return await db.fetchrow(
        "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING *",
        [email, hashed.decode()]
    )

async def verify_password(email: str, password: str) -> bool:
    user = await db.fetchrow("SELECT password_hash FROM users WHERE email = $1", [email])
    if not user:
        # Constant-time comparison even on missing user — prevent timing attacks
        bcrypt.checkpw(b"dummy", bcrypt.gensalt())
        return False
    return bcrypt.checkpw(password.encode(), user["password_hash"].encode())
```

#### Not This

```python
import hashlib

async def register_user(email: str, password: str):
    # SHA-256: fast hash, no salt, not designed for passwords (CWE-916)
    hashed = hashlib.sha256(password.encode()).hexdigest()
    await db.execute(
        f"INSERT INTO users (email, password) VALUES ('{email}', '{hashed}')"
    )  # Also SQL injection (CWE-89)
```

**Why it's wrong:** Two vulnerabilities in three lines. SHA-256 is fast — an attacker can compute billions of hashes per second. Without salting, identical passwords produce identical hashes, enabling rainbow table attacks. The string-formatted SQL is injectable. bcrypt is intentionally slow (cost factor 12 ≈ ~250ms per hash) and includes a unique salt per hash.

### Mass Assignment Prevention

#### Do This

```python
# Explicitly pick allowed fields from request
@app.put("/users/me")
async def update_profile(request: Request):
    data = await request.json()
    allowed = {
        "name": data.get("name"),
        "bio": data.get("bio"),
        "avatar_url": data.get("avatar_url"),
    }
    # "role", "is_admin", "email_verified" are NOT picked — even if sent
    filtered = {k: v for k, v in allowed.items() if v is not None}
    await user_repo.update(request.state.user.id, filtered)
```

#### Not This

```python
# Binding entire request body to the model — mass assignment (CWE-915)
@app.put("/users/me")
async def update_profile(request: Request):
    data = await request.json()
    await db.execute(
        "UPDATE users SET %s WHERE id = $1",
        [{**data}],  # Attacker sends {"role": "admin", "is_admin": true}
    )
```

**Why it's wrong:** An attacker adds `"role": "admin"` to the request body. The handler blindly passes all fields to the database update, escalating the attacker to admin. Mass assignment is preventable by explicitly allowlisting which fields a request can modify.

### Rate Limiting

#### Do This

```python
from slowapi import Limiter

limiter = Limiter(key_func=get_remote_address)

@app.post("/auth/login")
@limiter.limit("5/minute")  # 5 attempts per minute per IP
async def login(request: Request):
    # Also implement per-account limiting in the auth service
    return await auth_service.login(request)
```

#### Not This

```python
# No rate limiting — unlimited login attempts
@app.post("/auth/login")
async def login(request: Request):
    data = await request.json()
    user = await auth_service.authenticate(data["email"], data["password"])
    if not user:
        return JSONResponse(status_code=401, content={"error": "Invalid credentials"})
    return JSONResponse(content={"token": create_token(user)})
```

**Why it's wrong:** Without rate limiting, an attacker can make millions of login attempts per hour, brute-forcing passwords. They can also enumerate valid email addresses by timing differences in responses. Rate limiting is a basic defense that AI almost never adds proactively.

### SSRF Prevention

#### Do This

```python
import ipaddress
import socket
from urllib.parse import urlparse

BLOCKED_NETWORKS = [
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
]

def validate_outbound_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in ("https", "http"):
        raise ValueError(f"Blocked scheme: {parsed.scheme}")

    # Resolve hostname BEFORE making the request
    hostname = parsed.hostname
    resolved_ips = socket.getaddrinfo(hostname, parsed.port or 443)
    for _, _, _, _, sockaddr in resolved_ips:
        ip = ipaddress.ip_address(sockaddr[0])
        for network in BLOCKED_NETWORKS:
            if ip in network:
                raise ValueError(f"Blocked internal IP: {ip}")
    return url

# Usage: validate before every outbound request
url = validate_outbound_url(user_supplied_url)
response = httpx.get(url, follow_redirects=False)  # Disable auto-redirects
```

#### Not This

```python
# Directly fetching user-supplied URL — SSRF (CWE-918)
@app.post("/preview")
async def preview_url(request: Request):
    data = await request.json()
    response = httpx.get(data["url"])  # Fetches anything: file://, internal IPs, cloud metadata
    return {"content": response.text}
```

**Why it's wrong:** The server will fetch any URL the attacker provides. `https://169.254.169.254/latest/meta-data/iam/security-credentials/` exposes cloud IAM credentials. `http://localhost:6379/` probes internal Redis. `file:///etc/passwd` reads local files. This is OWASP A01:2025 and the leading cause of cloud infrastructure compromise.

## Exceptions

- **Internal microservices** communicating over a private network with mutual TLS may use lighter authentication (service tokens) than public-facing APIs. Rate limiting may also be relaxed for internal traffic if the network boundary is secure.
- **Read-only public APIs** (package registries, documentation) may use API keys for tracking without full session management. Rate limiting still applies.
- **Webhook receivers** need request signature verification instead of traditional authentication. Validate the HMAC signature from the sending service.

## Cross-References

- [Security](core-security) — Universal security principles (input validation, cryptography, secrets)
- [Backend Structure](web-backend-structure) — Auth middleware and handler separation
- [Backend Data Access](web-backend-data-access) — Query parameterization and connection security
- [Frontend Security](web-frontend-security) — Client-side token handling and CSP
