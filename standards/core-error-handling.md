---
id: core-error-handling
title: Error Handling
scope: core
severity: high
tags: [error-handling, validation, edge-cases, boundaries, exceptions]
references:
  - title: "OWASP — Improper Error Handling"
    url: https://owasp.org/www-community/Improper_Error_Handling
  - title: "CWE-754 — Improper Check for Unusual or Exceptional Conditions"
    url: https://cwe.mitre.org/data/definitions/754.html
  - title: "CWE-390 — Detection of Error Condition Without Action"
    url: https://cwe.mitre.org/data/definitions/390.html
---

## Principle

Errors are information, not inconveniences. A crash with a clear message is better than silent corruption. Every error that is swallowed, generalized, or ignored becomes a bug that is harder to find later.

AI excels at building happy paths but "cuts corners on edge cases" — missing validation, empty catch blocks, and silent fallbacks are the norm. 45% of AI-generated code has security vulnerabilities partly because error conditions at boundaries are not handled. This standard ensures errors are handled honestly: detected early, reported clearly, and propagated intentionally.

## Rules

### Error Philosophy

1. **Crash loudly rather than fail silently.** An unhandled error that crashes the process tells you exactly what went wrong and where. A swallowed error that returns a default value hides the problem until it corrupts data or produces wrong results far from the original failure. Prefer crashes over silent fallbacks.

2. **Handle errors at the level that can do something useful about them.** If a function cannot meaningfully recover from an error, it should propagate it — not catch and suppress it. Catch errors where you can retry, fall back to an alternative, inform the user, or log and clean up. Catching everywhere else is noise.

### Boundary Validation

3. **Validate at every trust boundary.** Mandatory validation points where data enters or leaves your control:
   - **User input** — forms, query parameters, request bodies, headers
   - **External API responses** — status codes, response shapes, missing fields
   - **Database results** — null results, unexpected row counts, constraint violations
   - **File I/O** — missing files, permission errors, malformed content
   - **Environment variables** — missing values, wrong types, empty strings
   - **Deserialized data** — JSON parsing failures, schema mismatches

4. **Validate type, presence, range, and format.** Checking only for null/undefined is not validation. Validate that the value is the correct type, is present when required, falls within acceptable bounds, and matches the expected format. Reject everything else explicitly.

### Error Propagation

5. **Preserve error context when propagating.** When catching an error to wrap or transform it, always include the original error as the cause. Error chains are how you trace a user-facing "Something went wrong" back to the actual root cause.

6. **Use typed or structured errors, not strings.** Errors should carry machine-readable information: an error code, the field that failed, the constraint that was violated. String-only error messages force consumers to parse human-readable text to determine what happened.

### What to Expose, Log, and Propagate

7. **Never expose internal details to end users.** Users get a safe, generic message ("Something went wrong, please try again") and an error reference ID. They never see stack traces, SQL errors, file paths, internal service names, or server configuration details. (CWE-209)

8. **Log the full error with context internally.** Internal logs must include: the error message, stack trace, relevant input values (excluding secrets), the request/operation ID, and timestamp. Without this context, debugging production issues requires reproduction instead of analysis.

9. **Propagate errors with their original type when possible.** Do not catch a `ConnectionError` and re-raise as a generic `Exception`. The error type carries meaning — callers may handle connection failures differently than validation failures. Only generalize error types at architectural boundaries (e.g., service layer → HTTP response).

### Anti-Patterns

10. **Never use empty catch blocks.** A catch block that does nothing — no logging, no re-raise, no alternative action — is a bug. It tells the runtime "I have handled this error" when in fact the error is being discarded. If you genuinely intend to ignore an error (rare), add an explicit comment explaining why. (CWE-390)

11. **Never use fallback defaults to mask errors.** Returning `0`, `""`, `[]`, or `null` when an operation fails disguises the failure as a valid result. Downstream code processes the fallback as real data, producing silently wrong behavior. If a function fails, it must signal failure — not return a plausible-looking lie.

12. **Never catch broad exception types at the top of a function.** Catching `Exception`, `Error`, or the language equivalent at the top of a function body suppresses every possible failure — including bugs you haven't thought of. Catch specific error types, as close to the failing operation as practical.

## Patterns

### Crash Loudly vs Silent Fallback

#### Do This

```python
def get_config_value(key: str) -> str:
    value = os.environ.get(key)
    if value is None:
        raise EnvironmentError(f"Required environment variable '{key}' is not set")
    return value

# Caller knows immediately if config is missing
database_url = get_config_value("DATABASE_URL")
```

#### Not This

```python
def get_config_value(key: str) -> str:
    # Silent fallback — returns empty string if env var is missing
    return os.environ.get(key, "")

# Caller gets empty string, tries to connect to database with ""
# Fails later with a confusing "invalid connection string" error
database_url = get_config_value("DATABASE_URL")
```

**Why it's wrong:** The error surfaces at database connection time as "invalid connection string" — not at config loading time as "DATABASE_URL is not set." Debugging requires tracing backward from the connection failure to discover the missing environment variable. The crash-loudly version tells you exactly what's wrong and where.

### Error Context Preservation

#### Do This

```python
class OrderServiceError(Exception):
    def __init__(self, message: str, order_id: str, cause: Exception = None):
        super().__init__(message)
        self.order_id = order_id
        self.__cause__ = cause

def place_order(order_data):
    try:
        payment = payment_gateway.charge(order_data["total"])
    except PaymentGatewayError as e:
        raise OrderServiceError(
            message="Payment failed while placing order",
            order_id=order_data["id"],
            cause=e,  # Original error preserved
        )
```

#### Not This

```python
def place_order(order_data):
    try:
        payment = payment_gateway.charge(order_data["total"])
    except PaymentGatewayError:
        raise Exception("Something went wrong")  # Original error lost
```

**Why it's wrong:** The original `PaymentGatewayError` had details — was it a timeout? Declined card? Invalid amount? Wrapping it as `Exception("Something went wrong")` destroys all diagnostic information. The ops team sees a generic error and has no way to determine what actually failed.

### Boundary Validation

#### Do This

```typescript
interface CreateUserRequest {
  email: string;
  name: string;
  age: number;
}

function validateCreateUser(data: unknown): CreateUserRequest {
  if (typeof data !== "object" || data === null) {
    throw new ValidationError("Request body must be an object");
  }
  const { email, name, age } = data as Record<string, unknown>;

  if (typeof email !== "string" || !EMAIL_REGEX.test(email)) {
    throw new ValidationError("Invalid email", { field: "email" });
  }
  if (typeof name !== "string" || name.length < 1 || name.length > 200) {
    throw new ValidationError("Name must be 1-200 characters", { field: "name" });
  }
  if (typeof age !== "number" || !Number.isInteger(age) || age < 0 || age > 150) {
    throw new ValidationError("Age must be an integer 0-150", { field: "age" });
  }

  return { email, name, age };
}
```

#### Not This

```typescript
function createUser(data: any) {
  // No validation — trusts client data has correct types and values
  const user = new User(data.email, data.name, data.age);
  return userRepo.save(user);
}
```

**Why it's wrong:** `data.age` could be `"twenty-five"`, `-1`, or `999999`. `data.email` could be missing entirely. Without validation, bad data enters the system and corrupts the database or crashes downstream operations where the error will be harder to diagnose.

### Empty Catch Block

#### Do This

```java
try {
    cache.set(key, value);
} catch (CacheUnavailableException e) {
    // Cache is a performance optimization, not a correctness requirement.
    // Log and continue — the operation succeeds without cache.
    logger.warn("Cache unavailable, proceeding without cache", e);
}
```

#### Not This

```java
try {
    cache.set(key, value);
} catch (Exception e) {
    // Swallows ALL exceptions — including NullPointerException, OutOfMemoryError
}
```

**Why it's wrong:** The empty catch with broad `Exception` type suppresses every possible error — not just cache unavailability. A `NullPointerException` from a bug in the cache key logic, or an `OutOfMemoryError` from a serialization issue, would be silently discarded. The system continues with corrupted state.

## Exceptions

- **Cleanup operations** (closing files, releasing locks, rolling back transactions) should not throw over the original error. If cleanup itself fails, log the cleanup failure but let the original error propagate.
- **Best-effort operations** (analytics, telemetry, non-critical cache writes) may catch and log errors without propagation, when the failure doesn't affect correctness. Always log, never empty-catch.
- **Retry-eligible transient errors** (network timeouts, rate limits) may be caught and retried with backoff. Apply a retry limit — infinite retries are a different failure mode.

## Cross-References

- [Security](core-security) — Validation failures as security boundaries
- [Root Cause Analysis](core-root-cause-analysis) — How error context enables root cause tracing
- [Testing](core-testing) — Testing error paths and edge cases
