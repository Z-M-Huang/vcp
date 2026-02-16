---
id: web-backend-api-design
title: API Design and Security
scope: web-backend
severity: high
tags: [api, rest, graphql, grpc, pagination, versioning, idempotency, owasp]
references:
  - title: "RFC 7807 — Problem Details for HTTP APIs"
    url: https://www.rfc-editor.org/rfc/rfc7807
  - title: "OWASP API Security Top 10 (2023)"
    url: https://owasp.org/API-Security/editions/2023/en/0x11-t10/
  - title: "RFC 9457 — Problem Details for HTTP APIs (updated)"
    url: https://www.rfc-editor.org/rfc/rfc9457
  - title: "Google API Design Guide"
    url: https://cloud.google.com/apis/design
---

## Principle

An API is a contract. Every endpoint must behave predictably, fail informatively, and resist abuse. Correct HTTP semantics, structured errors, pagination that works at scale, and idempotent mutations are not optional polish — they are the foundation that every client, integration, and internal service depends on.

AI-generated APIs consistently get these wrong: 200 responses with error bodies, offset pagination on large tables, ad-hoc error formats that change between endpoints, no idempotency keys, and GraphQL schemas with no depth or complexity limits. This standard covers the API design decisions that prevent these failures across REST, GraphQL, and gRPC.

## Rules

### REST API Design

1. **Use correct HTTP methods and status codes.** GET for reads (idempotent), POST for creates, PUT/PATCH for updates, DELETE for deletes. Return 201 for creates, 204 for successful deletes, 400 for validation errors, 401 for unauthenticated, 403 for unauthorized, 404 for not found, 409 for conflicts, 422 for unprocessable entity, 429 for rate limited. Never return 200 for errors with an error body.

2. **Implement cursor-based pagination for list endpoints.** Offset pagination breaks under concurrent writes and performs poorly at large offsets. Use cursor-based (keyset) pagination with opaque cursors. Return `next_cursor` in responses. Accept `cursor` and `limit` parameters. Set and enforce a maximum page size.

3. **Return structured error responses using RFC 9457 (Problem Details).** Every error response must include: `type` (URI identifying the error category), `title` (short human-readable summary), `status` (HTTP status code), `detail` (specific explanation). Include `instance` for request tracing. Never expose stack traces, internal paths, or database errors in production responses.

4. **Version your API.** Use URL path versioning (`/v1/`, `/v2/`) or header versioning (`Accept: application/vnd.api+json;version=2`). Support the previous version for a documented deprecation period. Never make breaking changes to a published version.

5. **Use idempotency keys for non-idempotent operations.** POST and PATCH endpoints that create or modify resources should accept an `Idempotency-Key` header. Store the key and response — if the same key is received again, return the stored response. This prevents duplicate charges, double-creates, and retry corruption.

6. **Include correlation IDs in all requests and responses.** Generate a unique request ID (UUID) for each incoming request. Propagate it through all internal service calls. Return it in the response as `X-Request-Id`. Log it with every log entry. This enables end-to-end request tracing.

### GraphQL Security

7. **Limit query depth and complexity.** Set a maximum query depth (typically 7-10 levels). Implement complexity analysis that scores each field and enforces a per-query budget. Without these limits, a single nested query can trigger exponential database joins and crash the server. (OWASP API8:2023)

8. **Disable introspection in production.** GraphQL introspection exposes the entire schema — all types, fields, arguments, and relationships. Disable it in production. If API documentation is needed, publish it through a documentation tool, not via introspection.

9. **Enforce per-field authorization.** Do not rely on resolver-level auth alone. Each field that returns sensitive data must check the caller's permissions. Use schema directives (`@auth`, `@hasRole`) to declare requirements. Batch requests must not bypass per-query auth.

### gRPC Security

10. **Enforce TLS and auth metadata on all gRPC channels.** Never use insecure channels in production. Authenticate via metadata (bearer tokens, mTLS certificates). Validate auth metadata in server interceptors before the request reaches the handler. Disable server reflection in production.

11. **Validate protobuf messages at the application boundary.** Protobuf encoding does not guarantee business-rule validity. Validate field values, required fields (proto3 defaults zero/empty), and message sizes. Set maximum message size limits. Reject unknown fields if schema evolution is not expected.

### Cross-Cutting

12. **Validate all request schemas against a published specification.** Use OpenAPI/Swagger (REST), GraphQL schema validation (GraphQL), or protobuf definitions (gRPC) to validate incoming requests. Reject requests with unknown fields, missing required fields, or type mismatches. Never silently accept malformed requests.

## Patterns

### Cursor-Based Pagination

#### Do This

```python
# Cursor-based pagination — stable under concurrent writes, O(1) seek
from base64 import b64encode, b64decode
from datetime import datetime

def encode_cursor(created_at: datetime, item_id: str) -> str:
    """Opaque cursor encoding the keyset position."""
    raw = f"{created_at.isoformat()}|{item_id}"
    return b64encode(raw.encode()).decode()

def decode_cursor(cursor: str) -> tuple[datetime, str]:
    raw = b64decode(cursor.encode()).decode()
    ts, item_id = raw.rsplit("|", 1)
    return datetime.fromisoformat(ts), item_id

MAX_PAGE_SIZE = 100

async def list_items(cursor: str | None, limit: int = 20) -> dict:
    limit = min(limit, MAX_PAGE_SIZE)  # Enforce maximum

    if cursor:
        created_at, last_id = decode_cursor(cursor)
        # Keyset pagination: seek to position using indexed columns
        rows = await repo.find_items_after(created_at, last_id, limit + 1)
    else:
        rows = await repo.find_items_first_page(limit + 1)

    has_more = len(rows) > limit
    items = rows[:limit]

    return {
        "items": [item.to_dict() for item in items],
        "next_cursor": encode_cursor(items[-1].created_at, items[-1].id) if has_more else None,
    }
```

#### Not This

```python
# Offset pagination — breaks under concurrent writes, slow at large offsets
async def list_items(page: int = 1, limit: int = 20) -> dict:
    offset = (page - 1) * limit
    # OFFSET 1000000 forces the database to scan and skip 1M rows
    rows = await repo.find_items_with_offset(offset, limit)
    total = await repo.count_all_items()  # Extra query on every page load
    return {
        "items": [item.to_dict() for item in rows],
        "page": page,
        "total": total,
        "pages": (total + limit - 1) // limit,
    }
```

**Why it's wrong:** At offset 1,000,000, the database scans and discards a million rows before returning results. Under concurrent inserts or deletes, rows shift position — users see duplicates or miss items between pages. The separate `COUNT(*)` query adds load on every page request. Cursor-based pagination seeks directly to the last-seen position using an indexed column, giving constant-time performance regardless of page depth.

### RFC 9457 Error Responses

#### Do This

```python
# Structured error response following RFC 9457 (Problem Details)
from starlette.responses import JSONResponse
import uuid

def problem_response(
    status: int,
    error_type: str,
    title: str,
    detail: str,
    request_id: str | None = None,
) -> JSONResponse:
    body = {
        "type": f"https://api.example.com/errors/{error_type}",
        "title": title,
        "status": status,
        "detail": detail,
        "instance": f"urn:request:{request_id or uuid.uuid4()}",
    }
    return JSONResponse(
        status_code=status,
        content=body,
        media_type="application/problem+json",
    )

# Usage in a handler
async def get_order(request, order_id: str):
    order = await order_service.find(order_id)
    if order is None:
        return problem_response(
            status=404,
            error_type="order-not-found",
            title="Order Not Found",
            detail=f"No order exists with ID {order_id}.",
            request_id=request.state.request_id,
        )
    if order.owner_id != request.state.user.id:
        return problem_response(
            status=403,
            error_type="forbidden",
            title="Forbidden",
            detail="You do not have permission to view this order.",
            request_id=request.state.request_id,
        )
    return JSONResponse(content=order.to_dict())
```

#### Not This

```python
# Ad-hoc error format — inconsistent, no traceability, leaks internals
async def get_order(request, order_id: str):
    order = await order_service.find(order_id)
    if order is None:
        # 200 with error body — clients cannot distinguish success from failure by status code
        return JSONResponse(content={"success": False, "error": "not found"})
    if order.owner_id != request.state.user.id:
        # Different error shape than the one above
        return JSONResponse(status_code=403, content={"msg": "forbidden"})
    return JSONResponse(content=order.to_dict())
```

**Why it's wrong:** The first error returns 200 with an error body — HTTP clients, load balancers, and monitoring tools treat it as a successful request. The two error responses use different field names (`error` vs `msg`) and different shapes, forcing clients to handle each endpoint's errors as a special case. Neither includes a request ID for tracing. RFC 9457 provides a standard format that every error in the API follows, with machine-readable type URIs and human-readable detail.

### Idempotency Key Handling

#### Do This

```python
# Idempotency middleware — prevents duplicate creates on retries
import hashlib
import json

class IdempotencyMiddleware:
    def __init__(self, cache):
        self.cache = cache  # Redis or database-backed store

    async def process(self, request, handler):
        idempotency_key = request.headers.get("Idempotency-Key")
        if not idempotency_key:
            return await handler(request)

        # Namespace the key to the user + endpoint to prevent collisions
        user_id = request.state.user.id
        namespace = f"idempotency:{user_id}:{request.url.path}:{idempotency_key}"

        # Check for existing response
        cached = await self.cache.get(namespace)
        if cached is not None:
            stored = json.loads(cached)
            return JSONResponse(
                status_code=stored["status"],
                content=stored["body"],
                headers={"X-Idempotent-Replayed": "true"},
            )

        # Execute the handler and store the response
        response = await handler(request)
        response_body = response.body.decode()
        await self.cache.set(
            namespace,
            json.dumps({"status": response.status_code, "body": json.loads(response_body)}),
            ex=86400,  # 24-hour TTL
        )
        return response
```

#### Not This

```python
# No idempotency protection — retries cause duplicates
async def create_payment(request):
    data = await request.json()
    # If the client retries (network timeout, 502, etc.), a second charge is created
    charge = await payment_service.charge(
        amount=data["amount"],
        card_token=data["card_token"],
    )
    order = await order_service.create(charge_id=charge.id)
    return JSONResponse(status_code=201, content=order.to_dict())
```

**Why it's wrong:** Network failures, load balancer timeouts, and client retries are normal in distributed systems. Without an idempotency key, a POST that times out and is retried creates two payments and two orders. The user is charged twice. Idempotency keys let the server recognize a retry and return the original response instead of executing the operation again.

### GraphQL Depth Limiting

#### Do This

```javascript
// Depth and complexity limiting — prevents resource-exhaustion attacks
import { createServer } from "@graphql-yoga/node";
import depthLimit from "graphql-depth-limit";
import { createComplexityLimitRule } from "graphql-validation-complexity";

const server = createServer({
  schema,
  validationRules: [
    depthLimit(7),  // Max 7 levels of nesting
    createComplexityLimitRule(1000, {
      // Score each field type — lists and connections cost more
      scalarCost: 1,
      objectCost: 2,
      listFactor: 10,
    }),
  ],
  // Disable introspection in production (Rule 8)
  graphiql: process.env.NODE_ENV !== "production",
  maskedErrors: process.env.NODE_ENV === "production",
});
```

```python
# Python (Strawberry) — custom depth check
from strawberry.extensions import QueryDepthLimiter

schema = strawberry.Schema(
    query=Query,
    mutation=Mutation,
    extensions=[
        QueryDepthLimiter(max_depth=7),
    ],
)
```

#### Not This

```javascript
// No depth or complexity limits — single query can crash the server
const server = createServer({
  schema,
  // No validation rules — default accepts any query depth/complexity
  // Introspection enabled in production — schema fully exposed
  graphiql: true,
});

// An attacker sends:
// { user { friends { friends { friends { friends { friends { ... } } } } } } }
// This triggers exponential JOINs and exhausts server memory
```

**Why it's wrong:** Without depth limits, an attacker constructs a deeply nested query that causes exponential database lookups. A 10-level nested `friends` query on a social graph generates millions of rows. Without complexity scoring, a single query selecting every field on every type can return gigabytes of data. These are Denial of Service attacks through the query language itself (OWASP API8:2023 — Security Misconfiguration).

### gRPC TLS and Auth Enforcement

#### Do This

```python
# gRPC server with TLS and auth interceptor
import grpc

class AuthInterceptor(grpc.ServerInterceptor):
    """Validates auth metadata before the request reaches the handler."""

    def intercept_service(self, continuation, handler_call_details):
        metadata = dict(handler_call_details.invocation_metadata)
        token = metadata.get("authorization", "")
        if not token.startswith("Bearer "):
            return grpc.unary_unary_rpc_method_handler(
                lambda req, ctx: ctx.abort(grpc.StatusCode.UNAUTHENTICATED, "Missing token")
            )
        # Validate the token (implementation depends on auth provider)
        try:
            auth_service.verify(token.removeprefix("Bearer "))
        except InvalidTokenError:
            return grpc.unary_unary_rpc_method_handler(
                lambda req, ctx: ctx.abort(grpc.StatusCode.UNAUTHENTICATED, "Invalid token")
            )
        return continuation(handler_call_details)

# Load TLS credentials from files (never hardcode certs/keys)
server_credentials = grpc.ssl_server_credentials(
    [(open("server.key", "rb").read(), open("server.crt", "rb").read())],
)

server = grpc.server(
    futures.ThreadPoolExecutor(max_workers=10),
    interceptors=[AuthInterceptor()],
    options=[
        ("grpc.max_receive_message_length", 4 * 1024 * 1024),  # 4 MB max (Rule 11)
    ],
)
server.add_secure_port("[::]:50051", server_credentials)
```

#### Not This

```python
# Insecure gRPC — no TLS, no auth, no message size limit
server = grpc.server(futures.ThreadPoolExecutor(max_workers=10))
# add_insecure_port: traffic is unencrypted, no client authentication
server.add_insecure_port("[::]:50051")
# No interceptor — handlers must each check auth (or don't)
# No message size limit — clients can send unbounded payloads
```

**Why it's wrong:** `add_insecure_port` transmits all data in plaintext — credentials, PII, and business data are visible to anyone on the network. Without an auth interceptor, every handler must independently check authentication, and missing one check creates an unauthenticated endpoint. Without message size limits, a client can send a multi-gigabyte protobuf message and exhaust server memory.

### Request Schema Validation

#### Do This

```python
# Validate request body against a strict schema — reject unknown fields
from pydantic import BaseModel, ConfigDict
from typing import Literal

class CreateOrderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")  # Reject unknown fields

    items: list[OrderItemInput]
    shipping_method: Literal["standard", "express", "overnight"]
    idempotency_key: str | None = None

class OrderItemInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    product_id: str
    quantity: int  # Pydantic validates type automatically

@app.post("/v1/orders")
async def create_order(request: Request):
    try:
        body = CreateOrderRequest(**(await request.json()))
    except ValidationError as e:
        return problem_response(
            status=422,
            error_type="validation-error",
            title="Unprocessable Entity",
            detail=str(e),
            request_id=request.state.request_id,
        )
    order = await order_service.create(body)
    return JSONResponse(status_code=201, content=order.to_dict())
```

#### Not This

```python
# No schema validation — accepts any shape, trusts all fields
@app.post("/v1/orders")
async def create_order(request: Request):
    data = await request.json()
    # No type checks, no required field enforcement, no unknown field rejection
    # data["quantity"] could be "abc", data["price"] could be -1000
    # Attacker can add {"is_free": true, "discount": 100} and hope the service respects it
    order = await order_service.create(data)
    return JSONResponse(status_code=201, content=order.to_dict())
```

**Why it's wrong:** Without schema validation, the endpoint accepts any JSON shape. A string where an integer is expected causes a runtime crash deep in the service layer. Extra fields (`is_admin`, `price_override`) may be inadvertently respected downstream. Missing required fields cause confusing errors far from the entry point. Schema validation at the API boundary catches malformed requests immediately and returns clear, structured errors.

## Exceptions

- **Internal service-to-service APIs** behind a service mesh or private network may use simpler error formats and skip idempotency keys if the transport layer guarantees exactly-once delivery.
- **Streaming APIs** (Server-Sent Events, WebSocket) use their own pagination model (event ordering, sequence numbers) rather than cursor-based pagination. See the realtime standard for those patterns.
- **Legacy API migration:** When wrapping a legacy system, it may be impractical to return RFC 9457 errors if the upstream system returns unstructured errors. In these cases, map legacy errors to Problem Details at the API gateway layer and document the limitation.
- **GraphQL introspection** may remain enabled in staging/preview environments for developer tooling, but must be disabled in production.

## Cross-References

- [Backend Security](web-backend-security) — Rate limiting (R13-14), SSRF prevention (R15)
- [Backend Structure](web-backend-structure) — Service layer patterns
- [Backend Data Access](web-backend-data-access) — Query patterns for pagination
