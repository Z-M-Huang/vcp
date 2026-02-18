---
id: core-secure-defaults
title: Secure Default Configuration
scope: core
severity: critical
tags: [security, configuration, defaults, owasp, cwe-798, cwe-1393, cwe-327, cwe-276, cwe-636, cwe-489, cwe-1188]
references:
  - title: "OWASP Top 10:2025 A02 — Security Misconfiguration"
    url: https://owasp.org/Top10/2025/A02_2025-Security_Misconfiguration/
  - title: "OWASP ASVS 5.0 V13 — Configuration"
    url: https://owasp.org/www-project-application-security-verification-standard/
  - title: "CWE-1188 — Insecure Default Initialization of Resource"
    url: https://cwe.mitre.org/data/definitions/1188.html
---

## Principle

Applications must be secure by default. Every configuration that affects security must fail closed — missing a value must cause a startup error, not a silent fallback to an insecure default. Attackers exploit the gap between development convenience and production safety.

## Rules

1. **No hardcoded fallback secrets.** Env vars must fail, not default to a placeholder like "changeme". Code like `secret = os.getenv("SECRET", "default-secret")` is a vulnerability — the fallback becomes the production secret when the env var is missing. (CWE-798)

2. **No default credentials.** Force explicit credential setup. Never ship with admin/admin, root/password, or similar default logins. Require credential configuration at first boot. (CWE-1393)

3. **Secure crypto defaults.** Default to the strongest available algorithm. No MD5, SHA-1, DES, or RC4 as defaults. Minimum key lengths: RSA 2048, AES-256, ECDSA P-256. (CWE-327)

4. **Default-deny permissions.** New users, roles, and API keys get zero permissions. Access is added explicitly. Never default to admin or write access. (CWE-276)

5. **Fail-secure enforcement.** When a security check fails or errors, deny the operation. Never fall through to allowing access because the auth service timed out or the policy engine threw an exception. (CWE-636)

6. **No debug features in production.** Debug endpoints, verbose error responses, profiling tools, and stack traces must be disabled in production. Gate them behind `NODE_ENV !== "production"` or equivalent. (CWE-489)

7. **Environment-specific configuration.** Separate dev/staging/prod configs. Never reuse development secrets in production. Use different database credentials, API keys, and signing keys per environment. (CWE-1188)

8. **Startup configuration validation.** Validate all security-critical config at boot time. Missing required secrets, invalid key lengths, disallowed algorithms — all must cause a hard startup failure, not a runtime surprise. (CWE-1188)

## Patterns

### No Hardcoded Fallback Secrets (Rule 1)

#### Do This

```python
import os
import sys

# Fail hard when a required secret is missing
def get_required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        print(f"FATAL: Required environment variable {name} is not set", file=sys.stderr)
        sys.exit(1)
    return value

SECRET_KEY = get_required_env("SECRET_KEY")
DATABASE_URL = get_required_env("DATABASE_URL")
```

```typescript
// Fail hard when a required secret is missing
function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`FATAL: Required environment variable ${name} is not set`);
  }
  return value;
}

const SECRET_KEY = getRequiredEnv("SECRET_KEY");
const DATABASE_URL = getRequiredEnv("DATABASE_URL");
```

#### Not This

```python
import os

# Silent fallback — "changeme" becomes the production secret (CWE-798)
SECRET_KEY = os.getenv("SECRET_KEY", "changeme")
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///dev.db")
```

```typescript
// Silent fallback — hardcoded default used in production (CWE-798)
const SECRET_KEY = process.env.SECRET_KEY || "super-secret-key";
const DATABASE_URL = process.env.DATABASE_URL || "postgres://admin:admin@localhost/dev";
```

**Why it's wrong:** When the environment variable is not set — due to a deployment misconfiguration, missing `.env` file, or container orchestration error — the fallback silently becomes the production value. The application starts successfully with a known, guessable secret. Attackers know to try default values first.

### Fail-Secure Enforcement (Rule 5)

#### Do This

```python
def check_permission(user, resource):
    """Deny access if anything goes wrong during the check."""
    try:
        return auth_service.has_access(user, resource)
    except AuthServiceUnavailableError:
        # Auth service down — deny access, don't fail open
        logger.error("Auth service unavailable, denying access for user %s", user.id)
        return False
    except Exception:
        # Unknown error — deny access
        logger.exception("Unexpected error in permission check")
        return False
```

```typescript
async function checkPermission(user: User, resource: Resource): Promise<boolean> {
  try {
    return await authService.hasAccess(user, resource);
  } catch (error) {
    // Any failure in the auth check means deny
    logger.error("Permission check failed, denying access", { userId: user.id, error });
    return false;
  }
}
```

#### Not This

```python
def check_permission(user, resource):
    """Fails open — auth errors grant access (CWE-636)"""
    try:
        return auth_service.has_access(user, resource)
    except Exception:
        # "Temporary" workaround that ships to production
        return True
```

```typescript
async function checkPermission(user: User, resource: Resource): Promise<boolean> {
  try {
    return await authService.hasAccess(user, resource);
  } catch {
    // Fails open — every auth outage becomes a full access bypass (CWE-636)
    return true;
  }
}
```

**Why it's wrong:** When the auth service is unavailable or throws an unexpected error, returning `true` grants access to everyone. A brief network blip or a misconfigured service URL turns into a complete authorization bypass. Attackers can intentionally overload the auth service to trigger this path.

### No Debug Features in Production (Rule 6)

#### Do This

```python
from flask import Flask

app = Flask(__name__)

# Debug routes only exist outside production
if os.environ.get("FLASK_ENV") != "production":
    @app.route("/debug/routes")
    def debug_routes():
        return {rule.rule: rule.methods for rule in app.url_map.iter_rules()}

# Error handler returns safe messages in production
@app.errorhandler(500)
def handle_500(error):
    if os.environ.get("FLASK_ENV") == "production":
        return {"error": "Internal server error"}, 500
    return {"error": str(error), "traceback": traceback.format_exc()}, 500
```

```typescript
import express from "express";

const app = express();

// Debug middleware only in development
if (process.env.NODE_ENV !== "production") {
  app.use("/debug/health", (req, res) => {
    res.json({ uptime: process.uptime(), memory: process.memoryUsage() });
  });
}

// Production error handler — no stack traces
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (process.env.NODE_ENV === "production") {
    res.status(500).json({ error: "Internal server error" });
  } else {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});
```

#### Not This

```python
from flask import Flask

app = Flask(__name__)

# Debug endpoint accessible in all environments (CWE-489)
@app.route("/debug/config")
def debug_config():
    return {
        "database_url": app.config["DATABASE_URL"],
        "secret_key": app.config["SECRET_KEY"],
        "debug": app.debug,
    }

# Stack traces sent to every user
@app.errorhandler(500)
def handle_500(error):
    return {"error": str(error), "traceback": traceback.format_exc()}, 500
```

**Why it's wrong:** Debug endpoints in production expose internal architecture, configuration, and secrets to anyone who discovers the URL. Stack traces reveal file paths, library versions, and internal logic — all useful for an attacker mapping the application. These endpoints are routinely discovered by automated scanners.

### Startup Configuration Validation (Rule 8)

#### Do This

```python
import os
import sys

REQUIRED_CONFIG = {
    "SECRET_KEY": {"min_length": 32},
    "DATABASE_URL": {},
    "JWT_SIGNING_KEY": {"min_length": 64},
}

DISALLOWED_ALGORITHMS = {"md5", "sha1", "des", "rc4"}

def validate_config():
    errors = []
    for var, constraints in REQUIRED_CONFIG.items():
        value = os.environ.get(var)
        if not value:
            errors.append(f"Missing required config: {var}")
            continue
        min_len = constraints.get("min_length")
        if min_len and len(value) < min_len:
            errors.append(f"{var} must be at least {min_len} characters, got {len(value)}")

    hash_algo = os.environ.get("HASH_ALGORITHM", "").lower()
    if hash_algo in DISALLOWED_ALGORITHMS:
        errors.append(f"Disallowed hash algorithm: {hash_algo}")

    if errors:
        for error in errors:
            print(f"CONFIG ERROR: {error}", file=sys.stderr)
        sys.exit(1)

# Call at import time — fail before the app serves any requests
validate_config()
```

```typescript
interface ConfigConstraint {
  minLength?: number;
  required: boolean;
}

const CONFIG_SCHEMA: Record<string, ConfigConstraint> = {
  SECRET_KEY: { required: true, minLength: 32 },
  DATABASE_URL: { required: true },
  JWT_SIGNING_KEY: { required: true, minLength: 64 },
};

const DISALLOWED_ALGORITHMS = new Set(["md5", "sha1", "des", "rc4"]);

function validateConfig(): void {
  const errors: string[] = [];

  for (const [name, constraint] of Object.entries(CONFIG_SCHEMA)) {
    const value = process.env[name];
    if (!value) {
      if (constraint.required) errors.push(`Missing required config: ${name}`);
      continue;
    }
    if (constraint.minLength && value.length < constraint.minLength) {
      errors.push(`${name} must be at least ${constraint.minLength} chars, got ${value.length}`);
    }
  }

  const hashAlgo = (process.env.HASH_ALGORITHM || "").toLowerCase();
  if (DISALLOWED_ALGORITHMS.has(hashAlgo)) {
    errors.push(`Disallowed hash algorithm: ${hashAlgo}`);
  }

  if (errors.length > 0) {
    errors.forEach((e) => console.error(`CONFIG ERROR: ${e}`));
    process.exit(1);
  }
}

// Validate before the server starts
validateConfig();
```

#### Not This

```python
import os

# No validation — discovers missing config at runtime, maybe in production (CWE-1188)
SECRET_KEY = os.getenv("SECRET_KEY")  # Could be None
DATABASE_URL = os.getenv("DATABASE_URL")  # Could be None

# First request that needs a signed token crashes with a confusing error
def sign_token(payload):
    return jwt.encode(payload, SECRET_KEY, algorithm="HS256")  # TypeError: key must not be None
```

**Why it's wrong:** Without startup validation, missing or invalid configuration is discovered at runtime — when a user's request triggers the code path that needs the value. This turns a configuration error into a production incident, often with confusing error messages that don't point to the root cause.

## Exceptions

- **Development environments** may use default values for non-secret configuration (ports, hostnames, log levels) to reduce setup friction. Secret values must still be explicitly set even in development — use `.env` files loaded by a dotenv library, not hardcoded fallbacks.
- **CLI tools and open-source libraries** that have no secrets by design (e.g., a math library, a formatting tool) are exempt from startup secret validation. The rule applies to applications that handle authentication, authorization, or sensitive data.
- **Feature flags and non-security toggles** (e.g., pagination size, cache TTL) may have sensible defaults. The test: would a wrong default cause a security vulnerability? If yes, it must be validated. If no, a default is acceptable.

## Cross-References

- [Security](core-security) — Core security rules including secrets management and cryptography
- [Error Handling](core-error-handling) — Crash-loudly principle and fail-fast patterns
- [Architecture](core-architecture) — Separation of configuration from code
- [Web Backend Security](web-backend-security) — Server-side configuration and secrets management
- [DevOps Container Security](devops-container-security) — Environment-specific container configuration
