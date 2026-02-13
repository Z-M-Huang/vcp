---
id: web-backend-structure
title: Backend Structure
scope: web-backend
severity: high
tags: [backend, api, service-layer, middleware, separation-of-concerns, routes]
references:
  - title: "Martin Fowler — Patterns of Enterprise Application Architecture"
    url: https://martinfowler.com/eaaCatalog/
  - title: "Microsoft — Clean Architecture"
    url: https://learn.microsoft.com/en-us/dotnet/architecture/modern-web-apps-azure/common-web-application-architectures
---

## Principle

Route handlers are the thinnest possible layer between HTTP and your application. They receive a request, call a service, and return a response. Everything else — validation, business logic, data access, authorization — belongs in dedicated layers that can be tested, reused, and maintained independently of the transport protocol.

AI puts everything in route handlers because training data is dominated by tutorial-style APIs where handlers do everything. The result is untestable endpoints where business logic can only be exercised through HTTP, the same logic is duplicated across endpoints, and cross-cutting concerns (auth, logging, rate limiting) are implemented inline instead of as shared infrastructure.

## Rules

### Route Handlers

1. **Route handlers are thin wrappers.** A handler's job is: extract input from the request, call a service method, and format the response. It should not contain business logic, data access, validation rules, or error formatting. If the handler body exceeds ~10-15 lines, logic is leaking into the transport layer.

2. **Route handlers own HTTP concerns only.** Status codes, headers, content negotiation, cookie management, and request parsing belong in the handler. Business decisions ("is this order valid?", "does this user have permission?") belong in the service layer.

3. **One route file per resource or domain concept.** All routes for orders go in one file. All routes for users go in another. Do not put all routes in a single file, and do not split a resource's routes across multiple files without clear reason.

### Service Layer

4. **Business logic lives in services.** Services contain the application's rules: validation, calculations, workflows, authorization checks, and orchestration of multiple data operations. Services are plain functions or classes with no HTTP or framework dependencies — they receive typed inputs and return typed outputs.

5. **Services are testable without HTTP context.** If testing a business rule requires creating a fake HTTP request, the business logic is in the wrong layer. Services should be callable from tests, CLI tools, queue workers, or any entry point — not just route handlers.

6. **Services orchestrate; they don't do everything.** A service method that calls the database directly, sends emails, publishes events, and writes to a cache is doing too much. It should orchestrate calls to repositories, notification services, and cache layers — each with a single responsibility.

### Middleware

7. **Cross-cutting concerns go in middleware.** Authentication, authorization, request logging, rate limiting, CORS, request ID generation, and error handling are infrastructure concerns shared across endpoints. Implement them as middleware that runs before or after handlers — not as code repeated in every handler.

8. **Middleware is composable and ordered intentionally.** Each middleware does one thing. The order matters: authentication before authorization, request logging before error handling. Document the middleware stack order when it's not obvious.

### Data Access Layer

9. **Data access is isolated from business logic.** Database queries, ORM calls, and external API clients live in dedicated repository or data access modules. Services depend on these through interfaces or conventions — they never construct SQL or call ORMs directly.

10. **Data access modules return domain objects, not raw database rows.** The service layer should not know the shape of database rows or ORM entities. Data access modules translate between storage format and domain format, so the service layer works with clean, typed domain objects.

## Patterns

### Thin Route Handler

#### Do This

```python
# Route handler — HTTP concerns only
@app.post("/orders")
async def create_order(request: Request):
    data = await request.json()
    order = order_service.create(CreateOrderInput(**data))
    return JSONResponse(status_code=201, content=order.to_dict())

# Service — business logic, no HTTP awareness
class OrderService:
    def __init__(self, repo: OrderRepository, payment: PaymentGateway):
        self.repo = repo
        self.payment = payment

    def create(self, input: CreateOrderInput) -> Order:
        errors = self._validate(input)
        if errors:
            raise ValidationError(errors)
        order = Order.from_input(input)
        self.payment.charge(order.total, input.payment_method)
        return self.repo.save(order)
```

#### Not This

```python
# Everything in the handler — untestable, unreusable
@app.post("/orders")
async def create_order(request: Request):
    data = await request.json()

    # Validation in handler
    if not data.get("items"):
        return JSONResponse(status_code=400, content={"error": "No items"})
    if not data.get("payment_method"):
        return JSONResponse(status_code=400, content={"error": "No payment"})

    # Business logic in handler
    total = sum(item["price"] * item["qty"] for item in data["items"])
    if total > 10000:
        total *= 0.95  # Bulk discount

    # Data access in handler
    order_id = await db.execute(
        "INSERT INTO orders (total, status) VALUES ($1, 'pending') RETURNING id",
        [total]
    )

    # External service call in handler
    stripe.PaymentIntent.create(amount=int(total * 100), currency="usd")

    # Email in handler
    send_email(data["email"], f"Order {order_id} confirmed!")

    return JSONResponse(status_code=201, content={"id": order_id, "total": total})
```

**Why it's wrong:** Five different concerns in one handler: validation, pricing logic, database access, payment processing, and email sending. Business logic (bulk discount) can't be tested without HTTP. The same pricing logic will be copy-pasted into the "update order" endpoint. If the payment fails after the database insert, there's no transaction management. This handler changes for five different reasons — violating single responsibility at every level.

### Middleware for Cross-Cutting Concerns

#### Do This

```python
# Authentication middleware — runs before all protected routes
@app.middleware("http")
async def authenticate(request: Request, call_next):
    token = request.headers.get("Authorization", "").removeprefix("Bearer ")
    if not token:
        return JSONResponse(status_code=401, content={"error": "Missing token"})
    try:
        request.state.user = auth_service.verify_token(token)
    except InvalidTokenError:
        return JSONResponse(status_code=401, content={"error": "Invalid token"})
    return await call_next(request)

# Handler doesn't deal with auth — it's already done
@app.get("/orders")
async def list_orders(request: Request):
    orders = order_service.list_for_user(request.state.user.id)
    return JSONResponse(content=[o.to_dict() for o in orders])
```

#### Not This

```python
# Auth check duplicated in every handler
@app.get("/orders")
async def list_orders(request: Request):
    token = request.headers.get("Authorization", "").removeprefix("Bearer ")
    user = auth_service.verify_token(token)  # Duplicated in every endpoint
    if not user:
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})
    orders = order_service.list_for_user(user.id)
    return JSONResponse(content=[o.to_dict() for o in orders])

@app.get("/users/me")
async def get_profile(request: Request):
    token = request.headers.get("Authorization", "").removeprefix("Bearer ")
    user = auth_service.verify_token(token)  # Same code, copy-pasted
    if not user:
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})
    return JSONResponse(content=user.to_dict())
```

**Why it's wrong:** Auth extraction and validation is duplicated in every handler. When the auth scheme changes (e.g., moving from Bearer tokens to cookies), every handler must be updated. One missed handler becomes an unauthenticated endpoint. Middleware runs the auth check once, in one place, for all protected routes.

### Data Access Isolation

#### Do This

```python
# Repository — data access only, returns domain objects
class OrderRepository:
    def __init__(self, db: Database):
        self.db = db

    async def find_by_user(self, user_id: str) -> list[Order]:
        rows = await self.db.fetch(
            "SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC",
            [user_id]
        )
        return [Order.from_row(row) for row in rows]

# Service uses repository — doesn't know about SQL or row shapes
class OrderService:
    def __init__(self, repo: OrderRepository):
        self.repo = repo

    async def list_for_user(self, user_id: str) -> list[Order]:
        return await self.repo.find_by_user(user_id)
```

#### Not This

```python
# Service contains raw SQL — business logic and data access mixed
class OrderService:
    async def list_for_user(self, user_id: str) -> list[dict]:
        rows = await db.fetch(
            "SELECT id, total, status, created_at FROM orders "
            "WHERE user_id = $1 ORDER BY created_at DESC",
            [user_id]
        )
        return [dict(row) for row in rows]  # Returns raw rows, not domain objects
```

**Why it's wrong:** The service layer knows the database schema, SQL syntax, and row format. If the schema changes (column renamed, table split), the service must change. If the same query is needed elsewhere, the SQL is duplicated. The service returns raw dictionaries instead of typed domain objects, losing type safety and enabling shape inconsistencies across the codebase.

## Exceptions

- **Simple CRUD endpoints** with no business logic may skip the service layer. If a handler only validates input and saves to the database, a service that does nothing but forward the call adds no value. Add the service layer when business rules emerge.
- **Serverless functions** (AWS Lambda, Cloudflare Workers) are inherently single-handler. Structure the code into modules within the function rather than across files.
- **GraphQL resolvers** replace route handlers but the same principle applies: resolvers are thin, business logic lives in services.

## Cross-References

- [Architecture](core-architecture) — Universal layer boundary and SRP principles
- [Backend Security](web-backend-security) — Auth middleware and authorization patterns
- [Backend Data Access](web-backend-data-access) — Repository patterns and query safety
