---
id: core-attack-surface
title: Attack Surface Analysis
scope: core
severity: high
tags: [security, attack-surface, threat-modeling, ptes, owasp, entry-points]
references:
  - title: "PTES — Penetration Testing Execution Standard"
    url: http://www.pentest-standard.org/index.php/Main_Page
  - title: "OWASP Attack Surface Analysis Cheat Sheet"
    url: https://cheatsheetseries.owasp.org/cheatsheets/Attack_Surface_Analysis_Cheat_Sheet.html
  - title: "OWASP Threat Modeling"
    url: https://owasp.org/www-community/Threat_Modeling
  - title: "CWE-1059 — Insufficient Technical Documentation"
    url: https://cwe.mitre.org/data/definitions/1059.html
---

## Principle

Think like an attacker before writing security-sensitive code. Every application has an attack surface — the sum of all points where an attacker can interact with the system. Security effort must be proportional to exposure: a public unauthenticated endpoint handling file uploads needs more hardening than an internal admin endpoint behind VPN + MFA. Map the surface first, then defend it systematically.

Penetration testers (PTES) always start by mapping entry points and modeling threats before looking for specific vulnerabilities. AI coding assistants should do the same — understand what is exposed before deciding what to protect.

## Rules

### Entry Point Mapping

1. **Identify all entry points before writing security logic.** Every route handler, API endpoint, WebSocket listener, GraphQL resolver, CLI argument parser, file import handler, message queue consumer, and cron job is an entry point. List them explicitly. You cannot defend what you have not identified. (CWE-1059)

2. **Classify each entry point by access level.** Assign one of: `public` (no authentication required), `authenticated` (requires valid session/token), `privileged` (requires specific role or permission), `internal` (not exposed to external networks). The classification determines the minimum security controls required.

3. **Map what each entry point can reach.** For every entry point, document: which databases it queries, which filesystem paths it accesses, which external APIs it calls, which internal services it invokes, and which admin functions it can trigger. An entry point that can reach the payment system needs more scrutiny than one that returns static content.

### Security Prioritization

4. **Apply security effort proportional to exposure.** Public endpoints get the full treatment: input validation, rate limiting, output encoding, logging, and abuse prevention. Internal endpoints behind authentication still need authorization checks and input validation, but may not need rate limiting or CAPTCHA. Never apply uniform security — it wastes effort on low-risk paths and under-protects high-risk ones.

5. **Treat unauthenticated endpoints as highest priority.** Any endpoint reachable without authentication is the first thing an attacker probes. These must have: strict input validation, rate limiting, output encoding, and abuse prevention. If an endpoint does not need to be public, make it authenticated.

6. **Reduce the attack surface by default.** Do not expose endpoints, services, or admin interfaces unless explicitly required. Disable unused features, close unnecessary ports, remove debug endpoints from production. Every additional entry point is additional risk.

### Documentation and Maintenance

7. **Document the security surface when adding new endpoints.** When adding a new route, API endpoint, or external-facing handler, document: its access level, what it can reach, what input it accepts, and what security controls are applied. This is not optional documentation — it is a security requirement that enables review and audit.

8. **Re-evaluate the attack surface after significant changes.** Adding a new public API, integrating a third-party service, or changing authentication flows changes the attack surface. Re-map entry points and access paths after these changes. What was safe before may not be safe after the change.

## Patterns

### Entry Point Mapping

#### Do This

```python
# Document entry points and their security classification
# ENTRY POINTS:
# POST /api/auth/login       — public, rate-limited, reaches: users DB
# POST /api/auth/register    — public, rate-limited, reaches: users DB, email service
# GET  /api/users/me         — authenticated, reaches: users DB
# PUT  /api/users/me         — authenticated, reaches: users DB
# POST /api/payments/charge  — authenticated + verified, reaches: payments DB, Stripe API
# GET  /admin/users          — privileged (admin role), reaches: users DB
# POST /admin/config         — privileged (admin role), reaches: config DB, cache

@app.post("/api/auth/login")
@rate_limit("5/minute")
async def login(request: LoginRequest):
    """Public endpoint — full input validation + rate limiting."""
    validate_email(request.email)
    validate_password_format(request.password)
    return await auth_service.authenticate(request.email, request.password)

@app.post("/api/payments/charge")
@require_auth
@require_verified_email
async def charge(request: ChargeRequest):
    """Authenticated + verified — handles financial data."""
    validate_amount(request.amount)
    validate_currency(request.currency)
    return await payment_service.charge(request.user_id, request.amount)
```

#### Not This

```python
# No classification, no documentation — every endpoint gets the same treatment
@app.post("/api/auth/login")
async def login(request):
    return await auth_service.authenticate(request.json["email"], request.json["password"])

@app.post("/api/payments/charge")
async def charge(request):
    # Same level of security as login — no additional verification for financial operations
    return await payment_service.charge(request.json["user_id"], request.json["amount"])
```

**Why it's wrong:** Without classifying entry points, the developer applies the same (often insufficient) security to all endpoints. The login endpoint has no rate limiting. The payment endpoint has no additional verification despite handling financial data. An attacker can brute-force credentials and trigger unauthorized charges.

### Attack Surface Reduction

#### Do This

```javascript
// Only expose what is needed — admin routes are separate and gated
const publicRouter = express.Router();
publicRouter.get("/health", healthCheck);
publicRouter.post("/auth/login", rateLimiter, loginHandler);

const authenticatedRouter = express.Router();
authenticatedRouter.use(requireAuth);
authenticatedRouter.get("/users/me", getUserProfile);

const adminRouter = express.Router();
adminRouter.use(requireAuth);
adminRouter.use(requireRole("admin"));
adminRouter.get("/users", listAllUsers);

// Debug endpoints only in development
if (process.env.NODE_ENV !== "production") {
  app.use("/debug", debugRouter);
}
```

#### Not This

```javascript
// Everything on one router, debug endpoints in production
app.get("/health", healthCheck);
app.post("/auth/login", loginHandler);
app.get("/users/me", getUserProfile);
app.get("/admin/users", listAllUsers);  // No auth check
app.get("/debug/routes", (req, res) => res.json(listRoutes()));  // Exposed in production
```

**Why it's wrong:** The admin endpoint has no authentication or authorization — any user can list all users. Debug endpoints expose internal routing information in production, giving attackers a map of the application. Grouping routes by access level with middleware enforcement prevents these gaps.

## Exceptions

- **Prototyping and proof-of-concept code** may skip formal attack surface documentation, but must add it before the code moves to staging or production.
- **Internal tools** on isolated networks with no external access may use simplified classification, but still need authentication and authorization checks.

## Cross-References

- [Security](core-security) — Input validation, authentication, and authorization rules
- [Secure Defaults](core-secure-defaults) — Default-deny permissions and environment-specific configuration
- [Backend Security](web-backend-security) — Server-side security enforcement
- [Data Flow Security](core-data-flow-security) — Tracing untrusted input from entry points to dangerous sinks
