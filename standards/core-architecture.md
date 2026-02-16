---
id: core-architecture
title: Architecture
scope: core
severity: high
tags: [architecture, srp, separation-of-concerns, dependency-direction, duplication]
references:
  - title: "SonarSource — AI Code Quality Research"
    url: https://www.sonarsource.com/
  - title: "GitClear 2024 — AI Coding Assistants Code Quality"
    url: https://www.gitclear.com/
  - title: "CMU — AI-Assisted Coding Complexity Study"
    url: https://www.cmu.edu/
---

## Principle

Every module, class, and function should have one reason to change. Architecture is the system's immune system — when it's healthy, local changes stay local. When it degrades, every change risks breaking something unrelated.

AI code is "highly functional but systematically lacking in architectural judgment" (SonarSource). It optimizes locally without global context, producing code that works today but compounds into unmaintainable systems. An 8-fold increase in code duplication (GitClear 2024) and 40% complexity increase (CMU) are symptoms of this architectural neglect.

## Rules

### Single Responsibility

1. **One module, one job.** A function does one thing. A class manages one concern. A file addresses one topic. If you need the word "and" to describe what a module does, it has too many responsibilities.

2. **Separate what changes for different reasons.** UI rendering changes for design reasons. Business logic changes for domain reasons. Data access changes for infrastructure reasons. These should not live in the same module — a design change should never require touching database code.

### Separation of Concerns

3. **Enforce layer boundaries.** Presentation logic must not call the database. Business logic must not format HTTP responses. Data access must not contain validation rules. Each layer talks only to the layer directly below it, through defined interfaces.

4. **Cross-cutting concerns go in infrastructure, not inline.** Logging, authentication, authorization, error handling, caching, and rate limiting are infrastructure concerns. Implement them as middleware, decorators, interceptors, or shared modules — not scattered through business logic.

### Dependency Direction

5. **Dependencies point inward.** High-level policy (business rules) must not depend on low-level detail (databases, HTTP frameworks, file systems). Outer layers depend on inner layers, never the reverse. If swapping a database requires changing business logic, the dependency direction is wrong.

6. **Depend on abstractions at boundaries.** Where a module needs an external service (database, API, file system), depend on an interface or protocol — not the concrete implementation. This makes testing possible and swapping implementations practical.

### Code Reuse

7. **Search before you create.** Before writing a new utility, helper, or pattern, search the existing codebase for something that already does it. AI defaults to creating new code for every prompt — this is the primary driver of the 8x duplication increase. Reuse existing modules. Extend them if needed.

8. **Extract duplication only when the pattern is stable.** Two instances of similar code are not necessarily duplication — they may evolve differently. Three instances with the same structure and the same reason to change are duplication worth extracting. Premature abstraction is as damaging as duplication.

### Complexity Management

9. **Prefer the simplest structure that solves the current problem.** Do not add abstractions, patterns, or indirection for hypothetical future requirements. A direct function call is better than a strategy pattern with one implementation. Complexity must be earned by actual need, not speculated requirements.

10. **Flat is better than nested.** Prefer early returns over nested conditionals. Prefer composition over deep inheritance hierarchies. Prefer explicit data flow over implicit state mutation. Each level of nesting is a cognitive burden that compounds.

### Architecture Scope Decisions

11. **Start with a monolith unless you have documented evidence to distribute.** A monolith is simpler to develop, test, deploy, and debug. Microservices add network boundaries, distributed transactions, deployment complexity, and observability requirements. "It might need to scale" is not evidence. A valid reason to distribute requires at least one of the following **with supporting data:**
    - **Measured scaling bottleneck:** profiling or load test data showing a specific module is the bottleneck and cannot be scaled with the rest of the application (e.g., "media transcoding consumes 90% of CPU and needs 10x the instances of the API layer").
    - **Organizational boundary:** a separate team owns the module, has a different release cadence (documented in sprint/release history), and coordination costs of shared deployment exceed the cost of a network boundary.
    - **Availability isolation:** the module has a different SLA that is documented and enforced (e.g., "payment processing requires 99.99% uptime while reporting tolerates 99.9%").

12. **Service extraction requires a written justification referencing evidence.**
    - **Extract when:** you can cite specific metrics, team structures, or SLA documents that satisfy rule 11. The justification must reference concrete data, not assertions.
    - **Do not extract when:** the justification relies on subjective terms ("cleaner", "better separation"), predictions ("might need to scale"), or trend-following ("microservices are best practice"). These are not evidence.
    - **Test for premature extraction:** If removing the network boundary between the proposed services would make the system simpler with no measurable downside, the extraction is premature.

## Patterns

### Single Responsibility

#### Do This

```python
# Each class has one job
class OrderValidator:
    def validate(self, order: Order) -> list[str]:
        errors = []
        if not order.items:
            errors.append("Order must have at least one item")
        if order.total < 0:
            errors.append("Order total cannot be negative")
        return errors

class OrderRepository:
    def save(self, order: Order) -> None:
        self.db.execute("INSERT INTO orders ...", order.to_dict())

class OrderService:
    def __init__(self, validator: OrderValidator, repository: OrderRepository):
        self.validator = validator
        self.repository = repository

    def place_order(self, order: Order) -> None:
        errors = self.validator.validate(order)
        if errors:
            raise ValidationError(errors)
        self.repository.save(order)
```

#### Not This

```python
# God class — validates, saves, sends emails, formats responses (SRP violation)
class OrderManager:
    def place_order(self, request):
        # Validation mixed in
        if not request.data["items"]:
            return {"error": "No items"}, 400
        # Business logic
        total = sum(item["price"] for item in request.data["items"])
        # Direct database access
        self.db.execute(f"INSERT INTO orders VALUES ({total})")
        # Email sending
        send_email(request.data["email"], "Order placed!")
        # HTTP response formatting
        return {"status": "ok", "total": total}, 200
```

**Why it's wrong:** This class changes when validation rules change, when the database schema changes, when email templates change, and when the API response format changes. Four different reasons to change in one class means every change risks breaking unrelated functionality.

### Layer Boundaries

#### Do This

```typescript
// Route handler — thin wrapper, HTTP concerns only
router.post("/orders", async (req, res) => {
  const result = await orderService.placeOrder(req.body);
  res.status(201).json(result);
});

// Service — business logic, no HTTP or DB awareness
class OrderService {
  constructor(private repo: OrderRepository) {}

  async placeOrder(data: CreateOrderDTO): Promise<Order> {
    const order = Order.create(data);
    return this.repo.save(order);
  }
}

// Repository — data access only
class OrderRepository {
  async save(order: Order): Promise<Order> {
    const row = await db.query("INSERT INTO orders ... RETURNING *", [order.total]);
    return Order.fromRow(row);
  }
}
```

#### Not This

```typescript
// Everything in the route handler — untestable, unreusable
router.post("/orders", async (req, res) => {
  const total = req.body.items.reduce((sum, i) => sum + i.price, 0);
  const row = await db.query(`INSERT INTO orders VALUES ($1) RETURNING *`, [total]);
  await sendEmail(req.body.email, "Order placed!");
  res.status(201).json(row);
});
```

**Why it's wrong:** Business logic can only be tested through HTTP. The same order logic can't be reused from a CLI, queue worker, or different endpoint. Changing the database requires touching route handlers. The layers are collapsed into one.

### Reuse Before Recreate

#### Do This

```python
# Search the codebase first: "Does a date formatting utility already exist?"
from app.utils.formatting import format_currency  # Found existing utility

def format_order_summary(order):
    return f"Order #{order.id}: {format_currency(order.total)}"
```

#### Not This

```python
# Creating a new utility that already exists elsewhere in the codebase
def format_order_summary(order):
    # Reimplementing currency formatting (already exists in app.utils.formatting)
    formatted = f"${order.total:,.2f}"
    return f"Order #{order.id}: {formatted}"
```

**Why it's wrong:** Now two implementations of currency formatting exist. When the format needs to change (e.g., supporting multiple currencies), only one gets updated. The other silently produces wrong output.

### Simplicity Over Speculation

#### Do This

```python
# Direct call — there's only one notification channel today
def notify_user(user, message):
    send_email(user.email, message)
```

#### Not This

```python
# Over-engineered for hypothetical future channels (YAGNI)
class NotificationStrategy(ABC):
    @abstractmethod
    def send(self, user, message): ...

class EmailStrategy(NotificationStrategy):
    def send(self, user, message):
        send_email(user.email, message)

class NotificationService:
    def __init__(self, strategy: NotificationStrategy):
        self.strategy = strategy

    def notify(self, user, message):
        self.strategy.send(user, message)

# Used with only one implementation
service = NotificationService(EmailStrategy())
```

**Why it's wrong:** The strategy pattern adds three classes and an interface to do what a single function does. If a second notification channel is needed later, refactoring a function into a pattern takes 10 minutes. Maintaining an unnecessary pattern forever costs more than that one-time refactoring.

## Exceptions

- **Performance-critical paths** may justify breaking layer boundaries (e.g., a handler directly querying a database to avoid overhead). Document the tradeoff and keep it isolated.
- **Prototypes and spikes** can ignore structure to explore feasibility. They must be rewritten before merging into production code.
- **Small scripts and utilities** (under ~100 lines, single purpose) don't need layer separation. Apply SRP at the function level.

## Cross-References

- [Code Quality](core-code-quality) — Duplication detection, consistency patterns
- [Root Cause Analysis](core-root-cause-analysis) — Why architectural violations cause cascading bugs
- [Web Frontend Structure](web-frontend-structure) — Component organization and state management
- [Web Backend Structure](web-backend-structure) — API layers, middleware, service patterns
