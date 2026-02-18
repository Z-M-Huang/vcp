---
id: core-api-design-security
title: API Misuse Prevention
scope: core
severity: high
tags: [security, api-design, misuse-prevention, owasp, cwe-242, cwe-676, cwe-252, cwe-636, cwe-843]
references:
  - title: "OWASP Top 10:2025 A06 — Insecure Design"
    url: https://owasp.org/Top10/2025/A06_2025-Insecure_Design/
  - title: "OWASP ASVS 5.0 V15 — Secure Coding/Architecture"
    url: https://owasp.org/www-project-application-security-verification-standard/
  - title: "CWE-242 — Use of Inherently Dangerous Function"
    url: https://cwe.mitre.org/data/definitions/242.html
---

## Principle

The safe path must be the easy path. APIs should be impossible to misuse accidentally — if a developer has to opt out of security to make a mistake, most mistakes won't happen. Secure by default, dangerous by explicit choice.

## Rules

1. **Safe path is the easy path.** Secure defaults, insecure requires explicit opt-in. Functions that skip validation should require an `unsafe_` prefix or explicit parameter like `skip_validation=True`. (CWE-242)

2. **No caller algorithm selection.** Server decides crypto, hashing, signing algorithms. Never accept algorithm choices from client input (JWT `alg` header, encryption negotiation). (CWE-327)

3. **Semantic types over primitives.** Use `UserId`, `Email`, `Token` types, not raw strings. Type systems prevent passing an email where a user ID is expected. (CWE-843)

4. **Never silently ignore security failures.** Auth, authz, validation failures must halt execution. Never `try/except: pass` on permission checks. (CWE-252)

5. **Avoid configuration cliffs.** No single toggle that disables all security. A `DEBUG=true` flag should not turn off auth, CORS, rate limiting, and CSP simultaneously. (CWE-636)

6. **Explicit opt-in for dangerous operations.** Destructive/admin ops require confirmation parameters like `confirm_delete=True` or force flags. (CWE-676)

7. **Document security contracts.** Every public API documents its security assumptions — what it validates, what it trusts, what the caller must guarantee.

## Patterns

### Safe Path Is the Easy Path (Rule 1)

#### Do This

```python
def query_users(filters: dict, *, skip_validation: bool = False) -> list[User]:
    """Query users with filters. Validates input by default.

    Args:
        filters: Query filter dictionary.
        skip_validation: Explicitly opt in to skipping validation.
            Only use for trusted internal batch jobs.
    """
    if not skip_validation:
        validate_filters(filters)
    return db.query(User).filter_by(**filters).all()


# Safe HTML rendering — escaping is the default
def render_html(content: str, *, allow_raw_html: bool = False) -> str:
    """Render content as HTML. Escapes by default.

    Set allow_raw_html=True only for trusted admin-authored content.
    """
    if allow_raw_html:
        return content
    return html.escape(content)
```

```typescript
// Safe by default — dangerous behavior requires explicit opt-in
function renderTemplate(
  template: string,
  data: Record<string, unknown>,
  options?: { unsafeDisableEscaping?: boolean }
): string {
  if (options?.unsafeDisableEscaping) {
    return rawRender(template, data);
  }
  return escapedRender(template, data);
}

// Default call is safe — no XSS possible
const safe = renderTemplate(tmpl, userData);

// Dangerous path is loud and explicit
const raw = renderTemplate(tmpl, trustedData, { unsafeDisableEscaping: true });
```

#### Not This

```python
# Insecure by default — caller must remember to validate (CWE-242)
def query_users(filters: dict, validate: bool = False) -> list[User]:
    if validate:
        validate_filters(filters)
    return db.query(User).filter_by(**filters).all()


# Raw HTML by default — caller must remember to escape
def render_html(content: str, escape: bool = False) -> str:
    if escape:
        return html.escape(content)
    return content
```

**Why it's wrong:** When the safe behavior requires an extra parameter, developers will forget it. The default call — `query_users(filters)` or `render_html(content)` — is the dangerous one. Every new call site is a potential vulnerability until someone remembers to add the safety flag.

### No Caller Algorithm Selection (Rule 2)

#### Do This

```python
import jwt

# Server controls the algorithm — never from the token itself
ALLOWED_ALGORITHM = "HS256"
SECRET_KEY = get_required_env("JWT_SECRET")

def verify_token(token: str) -> dict:
    """Verify JWT with server-controlled algorithm."""
    return jwt.decode(token, SECRET_KEY, algorithms=[ALLOWED_ALGORITHM])


# Hashing — server decides the algorithm
def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12)).decode()
```

```typescript
import jwt from "jsonwebtoken";

const ALLOWED_ALGORITHM = "HS256" as const;
const SECRET_KEY = getRequiredEnv("JWT_SECRET");

function verifyToken(token: string): jwt.JwtPayload {
  // Server controls the algorithm — rejects tokens using other algorithms
  return jwt.verify(token, SECRET_KEY, { algorithms: [ALLOWED_ALGORITHM] }) as jwt.JwtPayload;
}
```

#### Not This

```python
import jwt

def verify_token(token: str) -> dict:
    # Reads algorithm from the token header — attacker-controlled (CWE-327)
    header = jwt.get_unverified_header(token)
    algorithm = header["alg"]  # Attacker sets this to "none" or "HS256" with a public key
    return jwt.decode(token, SECRET_KEY, algorithms=[algorithm])
```

```typescript
import jwt from "jsonwebtoken";

function verifyToken(token: string, algorithm: string): jwt.JwtPayload {
  // Caller picks the algorithm — allows "none" algorithm attack (CWE-327)
  return jwt.verify(token, SECRET_KEY, { algorithms: [algorithm] }) as jwt.JwtPayload;
}
```

**Why it's wrong:** The JWT `alg: "none"` attack is one of the most well-known API vulnerabilities. When the server reads the algorithm from the token, an attacker can set it to `"none"` (no signature required) or switch from RS256 to HS256 (using the public key as the HMAC secret). The server must be the sole authority on which algorithm is valid.

### Never Silently Ignore Security Failures (Rule 4)

#### Do This

```python
def get_document(user: User, document_id: str) -> Document:
    """Fetch a document with mandatory authorization check."""
    document = Document.objects.get(id=document_id)

    if not has_permission(user, document, "read"):
        raise PermissionDeniedError(
            f"User {user.id} lacks read access to document {document_id}"
        )

    return document


def validate_request(request: Request) -> ValidatedRequest:
    """Validate request — failures raise, never return partial results."""
    errors = schema.validate(request.data)
    if errors:
        raise ValidationError(errors)
    return ValidatedRequest(**request.data)
```

```typescript
async function getDocument(user: User, documentId: string): Promise<Document> {
  const document = await Document.findByIdOrFail(documentId);

  if (!hasPermission(user, document, "read")) {
    throw new PermissionDeniedError(
      `User ${user.id} lacks read access to document ${documentId}`
    );
  }

  return document;
}
```

#### Not This

```python
def get_document(user: User, document_id: str) -> Document | None:
    """Silently returns None on auth failure — caller can't tell why (CWE-252)"""
    document = Document.objects.get(id=document_id)
    try:
        check_permission(user, document, "read")
    except PermissionDeniedError:
        return None  # Was it not found, or not authorized? Caller can't tell.
    return document


def validate_request(request: Request) -> dict:
    """Swallows validation errors — invalid data proceeds silently"""
    try:
        return schema.validate(request.data)
    except ValidationError:
        return request.data  # Returns unvalidated data as if it passed
```

**Why it's wrong:** When security failures are silently swallowed, the calling code cannot distinguish between "not found", "not authorized", and "validation failed". The invalid or unauthorized request proceeds as if it succeeded. This makes security bugs invisible — they don't show up in logs, don't trigger alerts, and don't get caught in testing.

### Explicit Opt-In for Dangerous Operations (Rule 6)

#### Do This

```python
def delete_user_account(
    user_id: str,
    *,
    confirm_delete: bool = False,
    admin_override: bool = False,
) -> None:
    """Permanently delete a user account. Requires explicit confirmation.

    Args:
        user_id: The user to delete.
        confirm_delete: Must be True. Prevents accidental deletion.
        admin_override: Required for deleting accounts with active subscriptions.
    """
    if not confirm_delete:
        raise ValueError("confirm_delete must be True to delete an account")

    user = User.objects.get(id=user_id)
    if user.has_active_subscription and not admin_override:
        raise ValueError("Cannot delete account with active subscription without admin_override")

    user.delete()
```

```typescript
interface DeleteOptions {
  confirmDelete: boolean;
  adminOverride?: boolean;
}

async function deleteUserAccount(userId: string, options: DeleteOptions): Promise<void> {
  if (!options.confirmDelete) {
    throw new Error("confirmDelete must be true to delete an account");
  }

  const user = await User.findByIdOrFail(userId);
  if (user.hasActiveSubscription && !options.adminOverride) {
    throw new Error("Cannot delete account with active subscription without adminOverride");
  }

  await user.delete();
}

// Caller must be explicit about the destructive action
await deleteUserAccount(userId, { confirmDelete: true });
```

#### Not This

```python
# No confirmation — one wrong call deletes an account (CWE-676)
def delete_user_account(user_id: str) -> None:
    User.objects.get(id=user_id).delete()

# Accidental call in a loop, typo, or wrong variable — gone
delete_user_account(some_id)
```

```typescript
// No safeguard — a single misrouted API call destroys data (CWE-676)
async function deleteUserAccount(userId: string): Promise<void> {
  await User.findByIdOrFail(userId).then((u) => u.delete());
}
```

**Why it's wrong:** Without a confirmation parameter, a single accidental call — a wrong variable, a loop that should have been filtered, a misrouted API request — permanently destroys data. The confirmation parameter forces the caller to explicitly acknowledge the destructive action at each call site, making accidents visible in code review.

## Exceptions

- **Internal-only utility functions** called from a single, well-tested location may omit confirmation parameters if the calling code already provides the safety check. The safeguard must exist somewhere in the call chain.
- **Semantic types** may not be practical in dynamically-typed languages without runtime overhead. In these cases, use naming conventions (`user_id` vs `email`) and validate at boundaries instead.
- **Algorithm negotiation** is acceptable in protocols like TLS where the server maintains a strict allowlist of acceptable algorithms and the negotiation is part of the protocol spec. The key requirement is that the server controls the final decision and rejects disallowed algorithms.

## Cross-References

- [Security](core-security) — Core input validation and authorization rules
- [Secure Default Configuration](core-secure-defaults) — Fail-closed defaults and startup validation
- [Error Handling](core-error-handling) — Never swallow exceptions, crash loudly on invariant violations
- [Architecture](core-architecture) — API design, separation of concerns, and interface contracts
- [Web Backend API Design](web-backend-api-design) — REST/GraphQL-specific API security patterns
