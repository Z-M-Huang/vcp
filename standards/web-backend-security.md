---
id: web-backend-security
title: Backend Security
scope: web-backend
severity: critical
tags: [security, injection, authentication, authorization, secrets, rate-limiting, ssrf, path-traversal, file-upload, owasp, cwe, xxe, jwt, oauth, request-smuggling, cwe-611, cwe-444, cwe-347, cwe-613, cwe-601, cwe-922]
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
  - title: "CWE-22 — Path Traversal"
    url: https://cwe.mitre.org/data/definitions/22.html
  - title: "CWE-434 — Unrestricted Upload of File with Dangerous Type"
    url: https://cwe.mitre.org/data/definitions/434.html
  - title: "OWASP — Path Traversal"
    url: https://owasp.org/www-community/attacks/Path_Traversal
  - title: "OWASP — File Upload Cheat Sheet"
    url: https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html
  - title: "CWE-611 — XML External Entity (XXE)"
    url: https://cwe.mitre.org/data/definitions/611.html
  - title: "CWE-347 — Improper Verification of Cryptographic Signature"
    url: https://cwe.mitre.org/data/definitions/347.html
  - title: "OWASP ASVS 5.0 V9 — Self-Contained Tokens"
    url: https://owasp.org/www-project-application-security-verification-standard/
  - title: "OWASP ASVS 5.0 V10 — OAuth and OIDC"
    url: https://owasp.org/www-project-application-security-verification-standard/
  - title: "RFC 7636 — Proof Key for Code Exchange (PKCE)"
    url: https://www.rfc-editor.org/rfc/rfc7636
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

### Path Traversal Prevention

16. **Canonicalize paths and verify they remain within the intended base directory.** When serving files or accessing the filesystem based on user input, always: (1) resolve the full canonical path using `path.resolve()` or `os.path.realpath()`, (2) verify the resolved path starts with the expected base directory, (3) reject the request if the path escapes the base. Never use `path.join()` alone — it does not prevent `../` traversal. Block URL-encoded variants (`%2e%2e%2f`, `%2e%2e/`, `..%2f`, `..%5c`), null bytes (`%00`), and backslash sequences (`..\\`). Where possible, use an allowlist of permitted filenames or map user input to an index rather than using it as a path component. (CWE-22)

### File Upload Security

17. **Validate uploaded files server-side by content, not by name or Content-Type header.** File extensions and MIME types sent by the client are attacker-controlled and must not be trusted for security decisions. Enforce all of the following:
    - **Magic byte validation:** Check the file's actual content (magic bytes / file signature) against an allowlist of permitted types. Libraries: `file-type` (Node.js), `python-magic` (Python), Apache Tika (Java).
    - **File size limits:** Enforce maximum file size at both the web server level (e.g., Nginx `client_max_body_size`) and the application level. Set per-file and per-request limits.
    - **Storage isolation:** Store uploads outside the webroot. Never store uploads in a directory that the web server serves directly. Serve files through an access-controlled handler that checks authorization.
    - **Rename to UUID:** Generate a random UUID for the stored filename. Store the original filename as metadata in the database. This prevents path traversal via filenames and prevents overwriting existing files.
    - **Never execute uploaded files.** Do not set execute permissions. Do not store uploads in directories scanned by interpreters (e.g., PHP's include path). Strip or quarantine executable content.
    - **Scan for malicious content** when feasible. For images, re-encode them (strips embedded scripts). For documents, use sandboxed processing. (CWE-434)

### Advanced Injection Prevention

18. **Prevent XML External Entity (XXE) attacks.** Disable external entities and DTD processing in ALL XML parsers. Most XML libraries enable external entities by default. In Python: use `defusedxml` instead of `xml.etree`. In Java: `factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)`. In Node.js: use `fast-xml-parser` with `processEntities: false` and `allowBooleanAttributes: true`, or avoid XML parsing entirely and use JSON. `xml2js` delegates to `sax` and does not expose DTD/entity controls — it is not safe for untrusted XML without wrapping in a sanitizer. (CWE-611)

19. **Prevent HTTP request smuggling.** Normalize `Transfer-Encoding` headers. Reject requests with both `Content-Length` and `Transfer-Encoding`. Reject malformed chunked encoding. Use HTTP/2 end-to-end where possible. Configure your reverse proxy and application server to agree on request boundary parsing. (CWE-444)

20. **Strip server information from responses.** Remove `Server`, `X-Powered-By`, `X-AspNet-Version`, `X-AspNetMvc-Version` headers from all responses. These expose framework and version information that attackers use to target known vulnerabilities. In Express: `app.disable('x-powered-by')`. In Nginx: `server_tokens off`. (CWE-200)

21. **Enforce TLS for database connections.** Require SSL/TLS for all database connections. Verify server certificates. Do not use `sslmode=disable` or `ssl=false`. Configure connection strings with `sslmode=verify-full` (PostgreSQL) or `ssl: { rejectUnauthorized: true }` (Node.js). (CWE-319)

22. **Limit GraphQL batch and alias attacks.** Limit the number of queries in a single batch request (max 5-10). Limit alias count per query. Detect and reject alias-based field duplication attacks that bypass per-field rate limiting. Cross-reference [API Design](web-backend-api-design) R7-R9.

### JWT and Token Security

23. **Prevent JWT algorithm confusion.** Never trust the `alg` header from the token. Always specify the expected algorithm server-side when verifying. Reject `alg: none`. If using RS256, reject HS256 — an attacker can use the public key as an HMAC secret to forge tokens. (CWE-347)

24. **Enforce token expiration.** Always validate the `exp` claim. Set reasonable TTLs: 15 minutes for access tokens, 7 days for refresh tokens. Reject tokens with missing `exp`. Reject tokens with `exp` more than a maximum allowed lifetime in the future — this prevents "forever" tokens. (CWE-613)

25. **Validate token audience and issuer.** Validate `aud` and `iss` claims on every token verification. A token issued for Service A must not be accepted by Service B. Reject tokens with missing `aud` or `iss` when these claims are expected. (CWE-347)

26. **Implement JWK Set rotation and kid verification.** Fetch public keys from a JWKS endpoint. Cache with TTL. Support key rotation by matching the `kid` header to keys in the set. Handle key rollover gracefully — accept both old and new keys during the rotation window. (CWE-327)

27. **Choose signed vs encrypted JWTs correctly.** Use JWS (signed) when you need integrity verification but the payload is not sensitive. Use JWE (encrypted) when the token contains PII, roles, or other sensitive data that should not be readable by intermediaries. Never send sensitive claims in an unencrypted JWT. (CWE-311)

### OAuth and OIDC

28. **Enforce PKCE for all OAuth authorization code flows.** Use PKCE (Proof Key for Code Exchange) for all clients — not just public clients. Generate a cryptographic random `code_verifier`, derive `code_challenge` with S256 method. Reject authorization flows without PKCE. (RFC 7636, CWE-352)

29. **Validate the state parameter.** Generate a cryptographic random `state` parameter for every authorization request. Bind it to the user's session. Validate it on the callback. This prevents CSRF attacks in the OAuth flow. (CWE-352)

30. **Enforce strict redirect URI matching.** Register exact redirect URIs. Do not use wildcard patterns or prefix matching. Reject callbacks to unregistered URIs. A permissive redirect URI allows attackers to steal authorization codes. (CWE-601)

31. **Store tokens server-side in a BFF pattern.** Store access and refresh tokens server-side in a backend-for-frontend. The browser gets an httpOnly session cookie pointing to the BFF session. The BFF proxies API calls with the stored token. Tokens never reach client-side JavaScript. (CWE-922)

32. **Rotate refresh tokens on every use.** Issue a new refresh token with every refresh request. Invalidate the old one. If a previously-used refresh token is presented again, invalidate the entire token family (assume compromise). This limits the window of refresh token theft. (CWE-613)

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

### Path Traversal Prevention

#### Do This

```javascript
import path from "path";

const UPLOADS_DIR = "/var/app/uploads";

function getSecureFilePath(userFilename) {
  // Resolve the full canonical path
  const resolved = path.resolve(UPLOADS_DIR, userFilename);

  // Verify it stays within the base directory
  if (!resolved.startsWith(UPLOADS_DIR + path.sep) && resolved !== UPLOADS_DIR) {
    throw new Error("Path traversal detected");
  }

  return resolved;
}
```

```python
import os

UPLOADS_DIR = "/var/app/uploads"

def get_secure_file_path(user_filename: str) -> str:
    # Resolve to canonical absolute path (resolves symlinks too)
    resolved = os.path.realpath(os.path.join(UPLOADS_DIR, user_filename))

    # Verify it stays within the base directory
    if not resolved.startswith(UPLOADS_DIR + os.sep):
        raise ValueError("Path traversal detected")

    return resolved
```

#### Not This

```javascript
// path.join does NOT prevent traversal — "../../etc/passwd" escapes (CWE-22)
app.get("/files/:name", (req, res) => {
  const filePath = path.join(UPLOADS_DIR, req.params.name);
  res.sendFile(filePath);
});
```

**Why it's wrong:** `path.join("/var/app/uploads", "../../etc/passwd")` resolves to `/var/etc/passwd`, escaping the uploads directory. An attacker reads arbitrary files on the server. `path.resolve()` + `startsWith()` check is the minimum safe pattern.

### File Upload Validation

#### Do This

```javascript
import { fileTypeFromBuffer } from "file-type";
import { randomUUID } from "crypto";

const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

async function handleUpload(fileBuffer, originalName) {
  if (fileBuffer.length > MAX_FILE_SIZE) {
    throw new Error("File too large");
  }

  // Check actual content type via magic bytes — not the extension or Content-Type header
  const detected = await fileTypeFromBuffer(fileBuffer);
  if (!detected || !ALLOWED_TYPES.has(detected.mime)) {
    throw new Error("File type not allowed");
  }

  // Store with random UUID name, outside webroot
  const storedName = `${randomUUID()}.${detected.ext}`;
  await writeFile(`/var/app/storage/uploads/${storedName}`, fileBuffer);

  // Save original name as metadata, not as the filename on disk
  await db.insert("uploads", { stored_name: storedName, original_name: originalName });
}
```

#### Not This

```javascript
// Trusting the extension and storing in webroot (CWE-434)
app.post("/upload", (req, res) => {
  const file = req.files.document;
  // Attacker uploads "shell.php" or "payload.html" — extension is attacker-controlled
  file.mv(`./public/uploads/${file.name}`);
  res.json({ url: `/uploads/${file.name}` });
});
```

**Why it's wrong:** The attacker controls the filename and extension. Uploading `shell.php` to a directory served by Apache/Nginx with PHP enabled gives the attacker remote code execution. Uploading `exploit.html` enables stored XSS. Storing in the webroot with the original name is a double vulnerability: path traversal via the filename and arbitrary file execution.

### XXE Prevention

#### Do This

```python
# Python — use defusedxml to prevent XXE (CWE-611)
import defusedxml.ElementTree as ET

def parse_xml_safely(xml_string: str):
    """Parse XML with external entities and DTDs disabled."""
    return ET.fromstring(xml_string)
```

```typescript
// Node.js — use fast-xml-parser with entity processing disabled
import { XMLParser } from "fast-xml-parser";

function parseXmlSafely(xmlString: string) {
  // Reject input containing DOCTYPE declarations (external entity vector)
  if (/<!DOCTYPE/i.test(xmlString)) {
    throw new Error("DOCTYPE declarations are not allowed");
  }

  const parser = new XMLParser({
    processEntities: false,       // Do not resolve XML entities
    allowBooleanAttributes: true,
    ignoreAttributes: false,
  });
  return parser.parse(xmlString);
}
```

#### Not This

```python
# Standard library with default settings — XXE enabled (CWE-611)
import xml.etree.ElementTree as ET

def parse_xml(xml_string: str):
    # External entities are processed by default — attacker can read local files
    # <!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
    return ET.fromstring(xml_string)
```

**Why it's wrong:** The default XML parser processes external entities. An attacker sends XML containing `<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>` and the parser reads the local file, exfiltrating its contents in the response. `defusedxml` disables external entities, DTD processing, and entity expansion by default.

### JWT Algorithm Confusion Prevention

#### Do This

```python
# Python — specify algorithm explicitly, reject alg:none and HS256 when using RS256
import jwt

PUBLIC_KEY = load_rsa_public_key()  # Load from JWKS or config
EXPECTED_ALGORITHM = "RS256"

def verify_token(token: str) -> dict:
    """Verify JWT with explicit algorithm — never trust the token's alg header."""
    return jwt.decode(
        token,
        key=PUBLIC_KEY,
        algorithms=[EXPECTED_ALGORITHM],  # Allowlist — only RS256 accepted
        options={
            "require": ["exp", "iss", "aud"],  # Reject tokens missing these claims
        },
        audience="https://api.example.com",
        issuer="https://auth.example.com",
    )
```

```typescript
// Node.js — jose library with explicit algorithm enforcement
import { jwtVerify } from "jose";

const JWKS = createRemoteJWKSet(new URL("https://auth.example.com/.well-known/jwks.json"));

async function verifyToken(token: string) {
  const { payload } = await jwtVerify(token, JWKS, {
    algorithms: ["RS256"],           // Only accept RS256
    audience: "https://api.example.com",
    issuer: "https://auth.example.com",
    requiredClaims: ["exp", "iss", "aud"],
  });
  return payload;
}
```

#### Not This

```python
# Trusting the token's alg header — algorithm confusion attack (CWE-347)
import jwt

PUBLIC_KEY = load_rsa_public_key()

def verify_token(token: str) -> dict:
    # No algorithms parameter — library reads alg from the token header
    # Attacker sets alg: HS256 and signs with the public key (which is public!)
    return jwt.decode(token, key=PUBLIC_KEY)
```

**Why it's wrong:** When the server expects RS256 but does not enforce it, an attacker sets `alg: HS256` in the token header and signs the token using the RSA public key as the HMAC secret. Since the public key is public, the attacker can forge valid tokens. Always specify `algorithms=["RS256"]` server-side and never trust the `alg` claim from the token.

### PKCE for OAuth Authorization Code Flow

#### Do This

```python
# Python — PKCE implementation for OAuth authorization code flow (RFC 7636)
import secrets
import hashlib
import base64

def generate_pkce_pair() -> tuple[str, str]:
    """Generate code_verifier and code_challenge for PKCE S256."""
    # 32 bytes = 43 characters in base64url — meets RFC 7636 minimum (43) and maximum (128)
    code_verifier = secrets.token_urlsafe(32)
    # S256: SHA-256 hash of the verifier, base64url-encoded without padding
    digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
    code_challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return code_verifier, code_challenge

# Authorization request — send the challenge
code_verifier, code_challenge = generate_pkce_pair()
session["pkce_verifier"] = code_verifier  # Store verifier in session

auth_url = (
    f"https://auth.example.com/authorize"
    f"?response_type=code"
    f"&client_id={CLIENT_ID}"
    f"&redirect_uri={REDIRECT_URI}"
    f"&code_challenge={code_challenge}"
    f"&code_challenge_method=S256"
    f"&state={generate_state_param()}"
)

# Token exchange — send the verifier
async def exchange_code(code: str, session_verifier: str) -> dict:
    response = await httpx.post("https://auth.example.com/token", data={
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": REDIRECT_URI,
        "client_id": CLIENT_ID,
        "code_verifier": session_verifier,  # Server verifies SHA256(verifier) == challenge
    })
    return response.json()
```

```typescript
// Node.js — PKCE with openid-client
import { generators } from "openid-client";

const codeVerifier = generators.codeVerifier();
const codeChallenge = generators.codeChallenge(codeVerifier);

// Store codeVerifier in session, send codeChallenge in auth request
const authUrl = client.authorizationUrl({
  scope: "openid profile",
  code_challenge: codeChallenge,
  code_challenge_method: "S256",
  state: generators.state(),
});

// On callback — exchange code with verifier
const tokenSet = await client.callback(REDIRECT_URI, params, {
  code_verifier: codeVerifier,
  state: expectedState,
});
```

#### Not This

```python
# OAuth without PKCE — authorization code interception attack (CWE-352)
auth_url = (
    f"https://auth.example.com/authorize"
    f"?response_type=code"
    f"&client_id={CLIENT_ID}"
    f"&redirect_uri={REDIRECT_URI}"
    # No code_challenge — authorization code can be intercepted and exchanged by attacker
)

async def exchange_code(code: str) -> dict:
    response = await httpx.post("https://auth.example.com/token", data={
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": REDIRECT_URI,
        "client_id": CLIENT_ID,
        # No code_verifier — server cannot verify the caller is the same entity that started the flow
    })
    return response.json()
```

**Why it's wrong:** Without PKCE, an attacker who intercepts the authorization code (via malicious app on the device, open redirect, or referrer leakage) can exchange it for tokens. PKCE binds the token exchange to the original authorization request — only the party that generated the `code_verifier` can complete the exchange, because the authorization server verifies `SHA256(code_verifier) == code_challenge`.

### BFF Token Storage Pattern

#### Do This

```typescript
// Node.js/Express — BFF pattern: tokens stored server-side, browser gets httpOnly cookie
import session from "express-session";
import RedisStore from "connect-redis";

app.use(session({
  store: new RedisStore({ client: redisClient }),
  secret: process.env.SESSION_SECRET,
  cookie: {
    httpOnly: true,    // Not accessible to JavaScript
    secure: true,      // HTTPS only
    sameSite: "lax",   // CSRF protection
    maxAge: 3600000,   // 1 hour
  },
  resave: false,
  saveUninitialized: false,
}));

// After OAuth callback — store tokens in session, never send to browser
app.get("/auth/callback", async (req, res) => {
  const tokens = await exchangeCodeForTokens(req.query.code);
  req.session.accessToken = tokens.access_token;
  req.session.refreshToken = tokens.refresh_token;
  res.redirect("/dashboard");  // Browser gets session cookie, not tokens
});

// BFF proxy — attach stored token to upstream API calls
app.use("/api", async (req, res) => {
  if (!req.session.accessToken) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  const response = await fetch(`${API_BASE}${req.path}`, {
    method: req.method,
    headers: {
      "Authorization": `Bearer ${req.session.accessToken}`,
      "Content-Type": "application/json",
    },
    body: ["GET", "HEAD"].includes(req.method) ? undefined : JSON.stringify(req.body),
  });
  res.status(response.status).json(await response.json());
});
```

```python
# Python/FastAPI — BFF pattern with server-side token storage
from starlette.middleware.sessions import SessionMiddleware

app.add_middleware(SessionMiddleware, secret_key=os.environ["SESSION_SECRET"])

@app.get("/auth/callback")
async def auth_callback(request: Request, code: str):
    tokens = await exchange_code_for_tokens(code)
    request.session["access_token"] = tokens["access_token"]
    request.session["refresh_token"] = tokens["refresh_token"]
    return RedirectResponse("/dashboard")

@app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
async def bff_proxy(request: Request, path: str):
    token = request.session.get("access_token")
    if not token:
        return JSONResponse(status_code=401, content={"error": "Not authenticated"})
    response = await httpx.request(
        method=request.method,
        url=f"{API_BASE}/{path}",
        headers={"Authorization": f"Bearer {token}"},
        content=await request.body(),
    )
    return JSONResponse(status_code=response.status_code, content=response.json())
```

#### Not This

```typescript
// Storing tokens in localStorage — accessible to any XSS (CWE-922)
app.get("/auth/callback", async (req, res) => {
  const tokens = await exchangeCodeForTokens(req.query.code);
  // Sending tokens to the browser — any XSS can steal them
  res.json({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
  });
});

// Client stores in localStorage:
// localStorage.setItem("access_token", data.access_token);
// Any XSS payload can read localStorage and exfiltrate tokens
```

**Why it's wrong:** Tokens stored in `localStorage` or non-httpOnly cookies are accessible to any JavaScript running on the page. A single XSS vulnerability — in your code, a third-party script, or an injected ad — can steal the access and refresh tokens and send them to an attacker's server. The BFF pattern keeps tokens entirely server-side: the browser only holds an httpOnly session cookie that JavaScript cannot read, and all API calls flow through the backend proxy.

## Exceptions

- **Internal microservices** communicating over a private network with mutual TLS may use lighter authentication (service tokens) than public-facing APIs. Rate limiting may also be relaxed for internal traffic if the network boundary is secure.
- **Read-only public APIs** (package registries, documentation) may use API keys for tracking without full session management. Rate limiting still applies.
- **Webhook receivers** need request signature verification instead of traditional authentication. Validate the HMAC signature from the sending service.

## Cross-References

- [Security](core-security) — Universal security principles (input validation, cryptography, secrets)
- [Backend Structure](web-backend-structure) — Auth middleware and handler separation
- [Backend Data Access](web-backend-data-access) — Query parameterization and connection security
- [Frontend Security](web-frontend-security) — Client-side token handling and CSP
