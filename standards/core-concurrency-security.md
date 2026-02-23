---
id: core-concurrency-security
title: Concurrency Security
scope: core
severity: high
tags: [security, concurrency, race-condition, toctou, atomicity, cwe-367, cwe-362]
references:
  - title: "CWE-367 — Time-of-Check Time-of-Use (TOCTOU) Race Condition"
    url: https://cwe.mitre.org/data/definitions/367.html
  - title: "CWE-362 — Concurrent Execution Using Shared Resource with Improper Synchronization"
    url: https://cwe.mitre.org/data/definitions/362.html
  - title: "OWASP — Race Conditions"
    url: https://owasp.org/www-community/vulnerabilities/Race_Conditions
  - title: "OWASP WSTG — Business Logic Testing"
    url: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/10-Business_Logic_Testing/
---

## Principle

When two operations that should be atomic are separated in time, an attacker can act in the gap. Race conditions are not theoretical — they are exploited in production for privilege escalation, double-spending, and data corruption. Every check-then-act sequence on shared mutable state is a potential vulnerability. Make the check and the action atomic, or accept that the check is advisory.

## Rules

### Time-of-Check-to-Time-of-Use (TOCTOU)

1. **Make check-then-act operations atomic.** If you check a condition (e.g., "does this user have sufficient balance?") and then act on it (e.g., "deduct the balance"), both must happen in a single atomic operation. Between a separate check and a separate act, another request can change the state, invalidating the check. Use database transactions, atomic compare-and-swap operations, or locks to make the pair atomic. (CWE-367)

2. **Never rely on filesystem existence checks before file operations.** `if (file.exists()) { file.open() }` is a classic TOCTOU — the file can be deleted, replaced, or symlinked between the check and the open. Use atomic file operations: `open()` with `O_CREAT|O_EXCL` for exclusive creation, or `rename()` for atomic replacement. (CWE-367)

3. **Use database constraints, not application checks, for uniqueness.** `SELECT` then `INSERT` is a race condition — two concurrent requests can both find no existing row and both insert, creating duplicates. Use `UNIQUE` constraints, `INSERT ... ON CONFLICT`, or `MERGE`/`UPSERT` for atomic uniqueness enforcement. (CWE-367)

### Double-Submit and Idempotency

4. **Use idempotency keys for non-idempotent operations.** Payment processing, account creation, order placement, and any operation with side effects must accept an idempotency key. Store the key with the result. If the same key is submitted again, return the stored result instead of executing again. This prevents double-charges and duplicate records from retries, race conditions, or user double-clicks. (CWE-362)

5. **Enforce idempotency at the database level.** Application-level deduplication is a race condition if two identical requests arrive simultaneously. Use a unique constraint on the idempotency key column, or use `INSERT ... ON CONFLICT DO NOTHING` to let the database enforce uniqueness atomically.

### Database Transactions

6. **Use transactions with appropriate isolation for read-modify-write operations.** If you read a value, modify it, and write it back, wrap the entire sequence in a transaction. Use `SERIALIZABLE` or `REPEATABLE READ` isolation when concurrent modifications would cause data corruption. `READ COMMITTED` is sufficient only when the read and write are independent. (CWE-362)

7. **Use `SELECT ... FOR UPDATE` to lock rows being modified.** When reading rows that will be updated based on their current value, use `SELECT ... FOR UPDATE` (pessimistic locking) to prevent concurrent readers from seeing stale data. Without it, two concurrent transactions can read the same balance, both deduct, and write back — losing one deduction.

### Optimistic Concurrency

8. **Use version fields or ETags for conflict detection.** Add a `version` integer or `updated_at` timestamp to entities that support concurrent modification. On update, include the version in the `WHERE` clause: `UPDATE ... SET version = version + 1 WHERE id = $1 AND version = $2`. If the update affects 0 rows, the entity was modified by another request — reject with a conflict error. This is optimistic concurrency control.

9. **Return HTTP 409 Conflict on version mismatch.** When an optimistic concurrency check fails (version mismatch), return `409 Conflict` with a clear message indicating the resource was modified. Do not silently overwrite — the client needs to re-read and retry. For APIs, include the current version in the response to enable immediate retry.

### Session and State

10. **Do not store mutable state in process memory for concurrent request handling.** In-memory variables (module-level dictionaries, global counters, singleton state) are not safe for concurrent modification in multi-process or multi-instance deployments. Use atomic database operations, Redis with atomic commands (`INCR`, `SETNX`), or distributed locks. (CWE-362)

11. **Use advisory locks for multi-step workflows.** When a workflow spans multiple operations (e.g., "process order → reserve inventory → charge payment → ship"), acquire a named lock on the entity (e.g., `SELECT pg_advisory_lock(order_id)`) to prevent concurrent processing of the same entity. Release the lock when the workflow completes or fails.

## Patterns

### TOCTOU in Balance Checks

#### Do This

```sql
-- Atomic check-and-deduct in a single UPDATE
-- If balance is insufficient, 0 rows affected — no deduction
UPDATE accounts
SET balance = balance - $1
WHERE user_id = $2
  AND balance >= $1
RETURNING balance;
```

```python
# Application code — single atomic operation
async def deduct_balance(user_id: int, amount: Decimal) -> Decimal:
    row = await db.fetchrow(
        "UPDATE accounts SET balance = balance - $1 "
        "WHERE user_id = $2 AND balance >= $1 "
        "RETURNING balance",
        amount, user_id,
    )
    if row is None:
        raise InsufficientFundsError(user_id, amount)
    return row["balance"]
```

#### Not This

```python
# TOCTOU — check and deduct are separate operations (CWE-367)
async def deduct_balance(user_id: int, amount: Decimal) -> Decimal:
    # CHECK: read current balance
    row = await db.fetchrow(
        "SELECT balance FROM accounts WHERE user_id = $1", user_id
    )
    if row["balance"] < amount:
        raise InsufficientFundsError(user_id, amount)

    # GAP: another request can deduct between SELECT and UPDATE

    # ACT: deduct (balance may now be insufficient)
    await db.execute(
        "UPDATE accounts SET balance = balance - $1 WHERE user_id = $2",
        amount, user_id,
    )
    return row["balance"] - amount  # Returns stale value
```

**Why it's wrong:** Between the `SELECT` and the `UPDATE`, a concurrent request can deduct the same balance. Two requests for $50 on a $75 balance both see $75, both proceed, and the balance goes to -$25. The atomic `UPDATE ... WHERE balance >= $1` ensures the check and deduction happen in one step — the second request sees the already-reduced balance and fails.

### Optimistic Concurrency

#### Do This

```javascript
// Optimistic locking with version field
async function updateProfile(userId, changes, expectedVersion) {
  const result = await db.query(
    `UPDATE users
     SET name = $1, bio = $2, version = version + 1
     WHERE id = $3 AND version = $4
     RETURNING version`,
    [changes.name, changes.bio, userId, expectedVersion]
  );

  if (result.rowCount === 0) {
    // Version mismatch — another request modified the row
    throw new ConflictError("Profile was modified by another request. Re-read and retry.");
  }
  return result.rows[0].version;
}
```

#### Not This

```javascript
// Last-write-wins — silently overwrites concurrent changes
async function updateProfile(userId, changes) {
  await db.query(
    "UPDATE users SET name = $1, bio = $2 WHERE id = $3",
    [changes.name, changes.bio, userId]
  );
  // No conflict detection — concurrent edits silently lost
}
```

**Why it's wrong:** If two users edit the same profile simultaneously, the second save silently overwrites the first user's changes. With optimistic locking, the second save detects that the version changed and returns a conflict error, letting the user resolve the conflict instead of losing data.

### Idempotency Keys

#### Do This

```python
# Idempotency key prevents double-charge
@app.post("/payments/charge")
@require_auth
async def charge(request: Request):
    data = await request.json()
    idempotency_key = request.headers.get("Idempotency-Key")
    if not idempotency_key:
        return JSONResponse(status_code=400, content={"error": "Idempotency-Key header required"})

    # Atomic insert — unique constraint on idempotency_key prevents duplicates
    try:
        result = await db.fetchrow(
            "INSERT INTO payments (idempotency_key, user_id, amount, status) "
            "VALUES ($1, $2, $3, 'pending') "
            "ON CONFLICT (idempotency_key) DO NOTHING "
            "RETURNING id",
            idempotency_key, request.state.user_id, data["amount"],
        )
    except Exception:
        raise

    if result is None:
        # Key already exists — return the stored result
        existing = await db.fetchrow(
            "SELECT * FROM payments WHERE idempotency_key = $1",
            idempotency_key,
        )
        return JSONResponse(content={"payment": dict(existing), "deduplicated": True})

    # Process the payment (only happens once per key)
    payment = await payment_service.charge(result["id"])
    return JSONResponse(content={"payment": payment})
```

#### Not This

```python
# No idempotency — retry = double charge (CWE-362)
@app.post("/payments/charge")
@require_auth
async def charge(request: Request):
    data = await request.json()
    # Every call creates a new payment — network retry = double charge
    payment = await payment_service.charge(request.state.user_id, data["amount"])
    return JSONResponse(content={"payment": payment})
```

**Why it's wrong:** Network retries, user double-clicks, and load balancer retransmissions all cause duplicate requests. Without an idempotency key, every request creates a new payment. A single network timeout + retry charges the customer twice. The idempotency key ensures the operation executes exactly once regardless of how many times the request is sent.

## Exceptions

- **Read-only operations** do not need concurrency protection (unless stale reads cause security issues, such as authorization checks on stale data).
- **Append-only operations** (logging, event sourcing) are inherently safe from lost-update race conditions, though ordering may still matter.
- **Single-process, single-threaded applications** (some CLI tools, batch scripts) may not need concurrency controls, but should still use them if there is any possibility of parallel execution (e.g., cron overlap).

## Cross-References

- [Security](core-security) — Deny-by-default authorization that must be checked atomically
- [Data Flow Security](core-data-flow-security) — Tracing tainted data through concurrent code paths
- [Backend Data Access](web-backend-data-access) — Database transaction patterns
- [Error Handling](core-error-handling) — Handling conflict errors and retries
