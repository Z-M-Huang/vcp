---
id: web-backend-caching
title: Caching Security
scope: web-backend
severity: high
tags: [caching, cache-poisoning, cache-deception, cdn, redis, http-caching, cwe]
references:
  - title: "CWE-525 — Use of Web Browser Cache Containing Sensitive Information"
    url: https://cwe.mitre.org/data/definitions/525.html
  - title: "CWE-444 — HTTP Request/Response Smuggling"
    url: https://cwe.mitre.org/data/definitions/444.html
  - title: "PortSwigger — Web Cache Poisoning"
    url: https://portswigger.net/research/practical-web-cache-poisoning
  - title: "PortSwigger — Web Cache Deception"
    url: https://portswigger.net/research/web-cache-deception
---

## Principle

Caching amplifies both performance and mistakes. A single misconfigured cache entry can serve one user's private data to thousands of others, or let an attacker poison responses for every visitor. Cache configuration is a security decision — not just a performance optimization. Every cached response must be explicitly opted in, correctly keyed, and verified safe for sharing.

## Rules

### Cache Poisoning Prevention

1. **Include all inputs that affect response content in the cache key.** Cache poisoning occurs when an unkeyed input (headers, cookies, query parameters not in the cache key) changes the response, and that poisoned response is served to other users. Audit your cache configuration: if a header or parameter changes the response, it must be in the cache key. Use `Vary` headers to key on headers like `Accept-Language`, `Accept-Encoding`, `Authorization`. (CWE-444)

2. **Normalize URLs before caching.** Different URL representations (trailing slashes, case differences, duplicate slashes, encoded characters) can create separate cache entries for the same resource, or cause cache misses that expose poisoning opportunities. Normalize URLs at the CDN/proxy level. (CWE-444)

3. **Protect against Cache Poisoning Denial of Service (CPDoS).** CPDoS attacks poison the cache with error responses. Ensure your cache only stores successful responses (2xx). Do not cache 4xx or 5xx responses. Configure `Cache-Control: no-store` on error responses. (CWE-444)

### Cache Deception Prevention

4. **Do not cache responses based on URL path extensions alone.** Cache deception tricks the cache into storing a user's private page by appending a cacheable extension (e.g., `/profile.css`, `/account/settings.js`). Configure caching based on explicit response headers (`Cache-Control`), not URL patterns. If path-based rules are unavoidable, only cache paths under designated static asset directories. (CWE-525)

5. **Set explicit cache eligibility on every response.** Every endpoint must set `Cache-Control` headers. Authenticated endpoints must use `Cache-Control: private, no-store`. Public static assets use `Cache-Control: public, max-age=31536000, immutable` with content-hashed filenames. Never rely on cache defaults — they vary between CDNs and proxies. (CWE-525)

### Sensitive Data Protection

6. **Never cache authenticated API responses in shared caches.** Responses that contain user-specific data must include `Cache-Control: private, no-store`. If a CDN caches an authenticated response, other users receive it. After logout, clear any client-side cached data. (CWE-525)

7. **Use the `Vary` header correctly.** If a response differs based on `Authorization`, `Cookie`, or `Accept-Language`, include the relevant header in `Vary`. Omitting `Vary` on a personalized response causes one user's data to be served to another. But avoid `Vary: *` — it effectively disables caching. (CWE-525)

### Shared Cache Infrastructure

8. **Segment cache keys by tenant in multi-tenant systems.** In multi-tenant applications, prefix cache keys with the tenant identifier. Without tenant segmentation, a cache hit for Tenant A may serve Tenant B's data. Use separate Redis databases or key namespaces per tenant. (CWE-525)

9. **Authenticate and restrict access to cache infrastructure.** Redis, Memcached, and other cache stores must require authentication and be network-isolated. Redis must use ACLs (Redis 6+) to restrict which commands each client can run. Never expose cache infrastructure to the public internet. (CWE-284)

### Client-Side Storage

10. **Never store sensitive data in localStorage or sessionStorage.** These are accessible to any JavaScript running on the page — including XSS payloads. Auth tokens belong in HttpOnly cookies. Sensitive application data belongs on the server. If client-side caching is needed for performance, use encrypted IndexedDB with per-session keys. (CWE-922)

## Patterns

### Cache-Control Headers for Authenticated vs. Public Endpoints

#### Do This

```python
# Authenticated endpoint — never cache in shared caches
@app.route("/api/me/profile")
@require_auth
def get_profile(request):
    response = make_response(get_user_profile(request.user))
    response.headers["Cache-Control"] = "private, no-store"
    return response

# Public static asset — aggressive caching with content hash in filename
@app.route("/static/<path:filename>")
def serve_static(filename):
    response = send_from_directory("static", filename)
    response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return response
```

```javascript
// Express middleware — set cache headers based on route type
function noCacheForAuth(req, res, next) {
  if (req.user) {
    res.set("Cache-Control", "private, no-store");
  }
  next();
}

function cacheStatic(req, res, next) {
  res.set("Cache-Control", "public, max-age=31536000, immutable");
  next();
}

app.use("/api", noCacheForAuth);
app.use("/static", cacheStatic);
```

#### Not This

```python
# Missing Cache-Control — relies on CDN/browser defaults (CWE-525)
@app.route("/api/me/profile")
@require_auth
def get_profile(request):
    return make_response(get_user_profile(request.user))
```

**Why it's wrong:** Without explicit `Cache-Control` headers, CDNs and proxies apply their own defaults — many default to caching GET responses. An authenticated user's profile data ends up in the shared cache and is served to the next requestor.

### Vary Header Usage

#### Do This

```python
# Response varies by language and encoding — key the cache on both
@app.route("/api/products")
def get_products(request):
    lang = request.headers.get("Accept-Language", "en")
    products = get_products_for_locale(lang)
    response = make_response(products)
    response.headers["Cache-Control"] = "public, max-age=600"
    response.headers["Vary"] = "Accept-Language, Accept-Encoding"
    return response
```

```javascript
// Node.js — Vary on Authorization for endpoints that differ per user
app.get("/api/dashboard", (req, res) => {
  const data = getDashboardData(req.user);
  res.set("Cache-Control", "private, no-store");
  res.set("Vary", "Authorization, Accept-Encoding");
  res.json(data);
});
```

#### Not This

```python
# Personalized response without Vary — one user's data cached for all (CWE-525)
@app.route("/api/products")
def get_products(request):
    lang = request.headers.get("Accept-Language", "en")
    products = get_products_for_locale(lang)
    response = make_response(products)
    response.headers["Cache-Control"] = "public, max-age=600"
    # Missing: Vary: Accept-Language
    return response
```

**Why it's wrong:** The response changes based on `Accept-Language`, but the cache does not key on that header. A French user makes the first request, and every subsequent user — regardless of language — receives the French response from cache.

### Redis Key Segmentation for Multi-Tenant

#### Do This

```python
import redis

r = redis.Redis(host="cache.internal", port=6379)

def get_cached_settings(tenant_id: str, settings_key: str) -> dict | None:
    """Retrieve tenant-specific settings with namespace isolation."""
    # Prefix every key with tenant ID to prevent cross-tenant leakage
    cache_key = f"tenant:{tenant_id}:settings:{settings_key}"
    cached = r.get(cache_key)
    if cached is not None:
        return json.loads(cached)
    return None

def set_cached_settings(tenant_id: str, settings_key: str, value: dict, ttl: int = 300):
    """Store tenant-specific settings with TTL."""
    cache_key = f"tenant:{tenant_id}:settings:{settings_key}"
    r.setex(cache_key, ttl, json.dumps(value))
```

```javascript
// Node.js — tenant-scoped cache with ioredis
const Redis = require("ioredis");
const cache = new Redis({ host: "cache.internal", port: 6379 });

async function getCachedData(tenantId, resourceKey) {
  // Tenant prefix prevents cross-tenant cache collisions
  const key = `tenant:${tenantId}:${resourceKey}`;
  const cached = await cache.get(key);
  return cached ? JSON.parse(cached) : null;
}

async function setCachedData(tenantId, resourceKey, value, ttlSeconds = 300) {
  const key = `tenant:${tenantId}:${resourceKey}`;
  await cache.setex(key, ttlSeconds, JSON.stringify(value));
}
```

#### Not This

```python
import redis

r = redis.Redis(host="cache.internal", port=6379)

def get_cached_settings(settings_key: str) -> dict | None:
    # No tenant prefix — all tenants share the same key space (CWE-525)
    cached = r.get(f"settings:{settings_key}")
    if cached is not None:
        return json.loads(cached)
    return None
```

**Why it's wrong:** Without tenant-scoped keys, Tenant A's `settings:theme` and Tenant B's `settings:theme` resolve to the same cache entry. Tenant A writes their configuration; Tenant B reads it. This is a data leakage vulnerability that gets worse under load because cache hits increase.

### Error Response Caching Prevention (CPDoS)

#### Do This

```python
# Ensure error responses are never cached
@app.errorhandler(404)
def not_found(error):
    response = make_response({"error": "Not found"}, 404)
    response.headers["Cache-Control"] = "no-store"
    return response

@app.errorhandler(500)
def internal_error(error):
    response = make_response({"error": "Internal server error"}, 500)
    response.headers["Cache-Control"] = "no-store"
    return response
```

#### Not This

```python
# Error responses without Cache-Control — CDN may cache the 404
@app.errorhandler(404)
def not_found(error):
    return {"error": "Not found"}, 404
```

**Why it's wrong:** CPDoS attacks trick the origin into returning an error (e.g., via oversized headers or malformed requests), and the cache stores that error response. Every subsequent user requesting the same resource receives the cached error — effectively a denial of service that persists until the cache entry expires.

## Exceptions

- **Internal health check endpoints** may use permissive caching for load balancer checks. These endpoints do not return user data and are not reachable from the public internet.
- **Pre-rendered public pages** (marketing, documentation) may use aggressive caching without per-user checks, since the content is identical for all visitors.
- **Single-tenant deployments** may skip tenant-based key segmentation, since there is only one tenant. Document this assumption explicitly so it is revisited if the application becomes multi-tenant.

## Cross-References

- [Backend Security](web-backend-security) — Authentication, authorization, and secrets management
- [Frontend Security](web-frontend-security) — XSS and client-side storage concerns
- [Backend API Design](web-backend-api-design) — HTTP headers and response formatting
