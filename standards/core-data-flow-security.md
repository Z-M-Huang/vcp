---
id: core-data-flow-security
title: Data Flow Security
scope: core
severity: critical
tags: [security, taint-analysis, data-flow, injection, source-sink, owasp, cwe-20, cwe-89, cwe-78, cwe-79, cwe-1333]
references:
  - title: "CWE-20 — Improper Input Validation"
    url: https://cwe.mitre.org/data/definitions/20.html
  - title: "CWE-89 — SQL Injection"
    url: https://cwe.mitre.org/data/definitions/89.html
  - title: "CWE-78 — OS Command Injection"
    url: https://cwe.mitre.org/data/definitions/78.html
  - title: "CWE-79 — Cross-Site Scripting"
    url: https://cwe.mitre.org/data/definitions/79.html
  - title: "CWE-1333 — Inefficient Regular Expression Complexity"
    url: https://cwe.mitre.org/data/definitions/1333.html
  - title: "OWASP — Injection Prevention Cheat Sheet"
    url: https://cheatsheetseries.owasp.org/cheatsheets/Injection_Prevention_Cheat_Sheet.html
  - title: "OWASP — Input Validation Cheat Sheet"
    url: https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html
---

## Principle

Every security vulnerability is a data flow problem: untrusted data from a source reaches a dangerous sink without adequate validation, sanitization, or parameterization along the path. Trace the flow systematically — identify sources of untrusted input, identify dangerous sinks, and verify that every path between them includes appropriate defenses. This is the same analysis that SonarQube and Checkmarx perform with taint engines, applied as a thinking discipline.

## Rules

### Source Identification

1. **Identify all sources of untrusted input.** Sources include: HTTP request bodies (`req.body`, `request.json()`), query parameters (`req.query`, `request.args`), URL path parameters (`req.params`), HTTP headers (including `Host`, `Referer`, `X-Forwarded-For`), cookies, form data, file uploads (name, content, MIME type), WebSocket messages, CLI arguments (`process.argv`, `sys.argv`), environment variables from untrusted contexts, data read from files written by external processes, database values that originated from user input, and messages from external APIs or message queues. (CWE-20)

2. **Treat data as tainted until explicitly validated.** A variable assigned from a source is tainted. A variable assigned from a tainted variable is tainted. A function return value is tainted if any of its inputs are tainted. Taint propagates through: variable assignments, function parameters, return values, string concatenation, template literals, array/object spreading, and destructuring.

### Sink Identification

3. **Identify all dangerous sinks.** Sinks are operations where tainted data causes harm:
   - **SQL/NoSQL queries:** `.execute()`, `.query()`, `.raw()`, `.find()` with dynamic predicates (CWE-89)
   - **OS commands:** `exec()`, `spawn()`, `system()`, `popen()`, subprocess calls (CWE-78)
   - **HTML rendering:** `innerHTML`, `document.write()`, template engines without auto-escaping (CWE-79)
   - **File operations:** `fs.readFile()`, `open()`, `path.join()` with user input (CWE-22)
   - **URL redirects:** `res.redirect()`, `Location` header with user input (CWE-601)
   - **Deserialization:** `pickle.loads()`, `yaml.load()`, `JSON.parse()` followed by type-unsafe operations (CWE-502)
   - **Code evaluation:** `eval()`, `Function()`, `setTimeout(string)` (CWE-95)
   - **Template rendering:** `Template()`, `.from_string()`, `Handlebars.compile()` with dynamic templates (CWE-1336)
   - **Regular expression construction:** `new RegExp()`, `re.compile()` with user input (CWE-1333)
   - **LDAP queries:** string-built LDAP filters (CWE-90)
   - **XPath queries:** `.xpath()` with string concatenation (CWE-643)

### Path Tracing

4. **Trace every path from source to sink.** For each sink that handles potentially tainted data, trace backwards to find the source. Follow the data through: variable assignments, function calls (parameters and return values), property access, destructuring, and array/object operations. If a tainted source can reach a sink, verify that adequate defense exists on the path.

5. **Flag any undefended source-to-sink path.** A path is undefended if tainted data reaches a sink without: parameterization (for query sinks), escaping/encoding (for output sinks), allowlisting (for command/path sinks), or validation that constrains the value to a known-safe shape (for redirect/file sinks). An undefended path is a vulnerability.

### Defense Points

6. **Defend at the closest point to the sink.** Validate at the trust boundary (entry point) for format and type. Apply sink-specific defense (parameterization, escaping, allowlisting) immediately before the sink call. Defense at the entry point alone is insufficient — data may be transformed between entry and sink. Defense at the sink alone is fragile — a new code path may bypass it.

7. **Do not rely on intermediary variable names for safety.** A variable named `sanitizedInput` or `safeQuery` is not safe unless the code that assigned it actually performed validation. Follow the actual data flow, not variable names. Verify the validation logic, not the naming convention.

### Regular Expression Security (ReDoS)

8. **Never pass untrusted input directly to regex constructors.** `new RegExp(userInput)` and `re.compile(user_input)` allow attackers to inject malicious regex patterns that cause catastrophic backtracking (ReDoS). If dynamic regex construction is needed: escape all regex special characters first using a dedicated function (`escapeRegExp()` in JS, `re.escape()` in Python), or validate that the input matches a strict allowlist of characters. (CWE-1333)

9. **Avoid nested quantifiers in regex patterns.** Patterns like `(a+)+`, `(a*)*`, `(a|b*)+`, or `(\d+)+` cause exponential backtracking on crafted input. Use atomic groups, possessive quantifiers, or rewrite the pattern to eliminate nesting. When using regex on untrusted input, set a timeout or character limit on the input before matching.

## Patterns

### Source-to-Sink Tracing

#### Do This

```python
# TRACE: req.body.email → validate_email() → parameterized query
# Source: request body (tainted)
# Defense: validation + parameterization
# Sink: database query (parameterized — safe)

@app.post("/users")
async def create_user(request: Request):
    data = await request.json()           # SOURCE: tainted
    email = data.get("email", "")         # Still tainted (assigned from source)
    validate_email(email)                 # DEFENSE: format validation
    name = data.get("name", "")           # Still tainted
    validate_name(name)                   # DEFENSE: format validation

    user = await db.fetchrow(
        "INSERT INTO users (email, name) VALUES ($1, $2) RETURNING *",
        email, name                       # SINK: parameterized query (safe)
    )
    return JSONResponse({"id": user["id"]})
```

#### Not This

```python
# TRACE: req.body.email → variable → string concatenation → query
# Source: request body (tainted)
# Defense: NONE
# Sink: SQL query via string concatenation — VULNERABLE

@app.post("/users")
async def create_user(request: Request):
    data = await request.json()           # SOURCE: tainted
    email = data["email"]                 # Still tainted
    query = f"INSERT INTO users (email) VALUES ('{email}')"  # Taint reaches sink
    await db.execute(query)               # SINK: unparameterized (CWE-89)
```

**Why it's wrong:** The tainted `email` flows through a variable assignment into string concatenation, reaching the SQL execution sink with no defense. The variable `query` carries the taint from `email`. Even though the concatenation and execution are on different lines, the data flow is continuous and undefended.

### Taint Propagation Through Functions

#### Do This

```javascript
// Function explicitly validates and returns safe value
function getValidatedRedirectUrl(userUrl) {
  const ALLOWED_HOSTS = new Set(["example.com", "app.example.com"]);
  const parsed = new URL(userUrl, "https://example.com");  // SOURCE: tainted
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {                // DEFENSE: allowlist
    throw new Error("Invalid redirect target");
  }
  return parsed.href;                                        // Validated — safe for sink
}

app.get("/callback", (req, res) => {
  const target = getValidatedRedirectUrl(req.query.redirect); // Defense applied
  res.redirect(target);                                       // SINK: redirect (safe)
});
```

#### Not This

```javascript
// Function passes tainted data through without validation
function buildRedirectUrl(path) {
  return `https://example.com${path}`;  // Tainted path embedded directly
}

app.get("/callback", (req, res) => {
  const target = buildRedirectUrl(req.query.path);  // Taint propagates through function
  res.redirect(target);                              // SINK: open redirect (CWE-601)
});
```

**Why it's wrong:** The function `buildRedirectUrl` accepts tainted input and returns it embedded in a string without validation. The taint propagates through the function call. An attacker sets `path` to `/../@evil.com` or `/.evil.com` — depending on the redirect implementation and downstream URL parsing, this can result in an open redirect. Even when the base URL prevents a full host redirect, attackers can craft paths that redirect to unexpected locations within the application or exploit URL parser inconsistencies between the server and browser.

### ReDoS Prevention

#### Do This

```javascript
// Escape user input before using in regex
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function searchByPattern(userQuery, items) {
  const safePattern = escapeRegExp(userQuery);  // DEFENSE: escape special chars
  const regex = new RegExp(safePattern, "i");    // Safe — no special regex chars
  return items.filter(item => regex.test(item.name));
}
```

#### Not This

```javascript
// User input directly in regex constructor — ReDoS (CWE-1333)
function searchByPattern(userQuery, items) {
  const regex = new RegExp(userQuery, "i");  // Attacker sends "(a+)+" → catastrophic backtracking
  return items.filter(item => regex.test(item.name));
}
```

**Why it's wrong:** An attacker provides a pattern like `(a+)+$` with input `"aaaaaaaaaaaaaaaaaaaaaaaa!"`. The regex engine enters catastrophic backtracking, consuming CPU for minutes or hours on a single request. This is a denial-of-service attack using regex — ReDoS.

## Exceptions

- **Data from trusted internal systems** (not user-originated) may have reduced validation requirements, but should still be validated at trust boundaries between services. A compromised internal service can become a source of tainted data.
- **Static configuration values** loaded at startup from trusted config files are not tainted. However, configuration loaded from environment variables in shared hosting environments should be treated with caution.
- **ORM and query builder abstractions** that automatically parameterize may eliminate the need for explicit parameterization at the call site, but verify the ORM actually parameterizes (some methods like `raw()` bypass it).

## Cross-References

- [Security](core-security) — Input validation and parameterization rules
- [Attack Surface Analysis](core-attack-surface) — Mapping entry points that serve as data sources
- [Backend Security](web-backend-security) — Server-side injection prevention patterns
- [Error Handling](core-error-handling) — Secure error handling that does not leak internal state
- [API Design Security](core-api-design-security) — Safe API designs that prevent misuse
