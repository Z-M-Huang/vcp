---
id: web-backend-data-access
title: Backend Data Access
scope: web-backend
severity: high
tags: [database, queries, migrations, connection-pooling, orm, sql, data-access]
references:
  - title: "CWE-89 — SQL Injection"
    url: https://cwe.mitre.org/data/definitions/89.html
  - title: "OWASP — Query Parameterization Cheat Sheet"
    url: https://cheatsheetseries.owasp.org/cheatsheets/Query_Parameterization_Cheat_Sheet.html
  - title: "Martin Fowler — Repository Pattern"
    url: https://martinfowler.com/eaaCatalog/repository.html
---

## Principle

The database is the most critical boundary in most applications. Data that gets in wrong stays wrong — corrupting reports, breaking downstream systems, and causing bugs that surface far from where the bad data entered. Every query must be parameterized, every migration must be reversible, and every connection must be managed through a pool with proper cleanup.

AI generates database code with recurring issues: raw SQL without parameterization, migrations without rollback plans, no connection pooling, and N+1 query patterns left undetected. This standard covers the data access patterns that keep databases safe, reliable, and performant.

## Rules

### Query Safety

1. **Parameterize every query. No exceptions.** This rule is repeated from the security standard because its violation is the most common and most dangerous database mistake. Never concatenate, interpolate, or format user-controlled values into any query string. Use parameterized queries or ORM query builders exclusively. (CWE-89)

2. **Use query builders for dynamic queries.** When filters, sorting, or column selection are dynamic, use the ORM's query builder or a safe SQL builder — not string concatenation. Dynamic `WHERE` clauses constructed from user input are injection vectors even when individual values are parameterized, if the column names or operators come from user input.

3. **Avoid N+1 queries.** When loading a list of records that each have related records, load the related records in a single query (JOIN, eager load, or batch fetch) — not one query per parent record. N+1 queries are the most common database performance problem and AI rarely detects or prevents them.

### Migrations

4. **Every migration must have an up and a down.** The `up` migration applies the change. The `down` migration reverses it exactly. If a migration cannot be reversed (dropping a column with data), document this explicitly and ensure the data is backed up before running. Irreversible migrations should be rare and intentional.

5. **Migrations must be safe for zero-downtime deployments.** Avoid operations that lock tables for long periods: adding a column with a default value on a large table, creating indexes without `CONCURRENTLY`, or restructuring tables in a single step. Break large migrations into multiple safe steps.

6. **Never modify data and schema in the same migration.** Schema changes (adding columns, creating indexes) and data changes (backfilling values, transforming records) belong in separate migrations. Mixing them makes rollbacks dangerous — rolling back the schema change may leave data in an inconsistent state.

### Connection Management

7. **Use connection pooling for every database access.** Never create a new database connection per request. Use a connection pool (PgBouncer, HikariCP, SQLAlchemy pool, Prisma connection pool) configured with appropriate min/max connections, idle timeout, and connection lifetime. Unmanaged connections cause connection exhaustion under load. (CWE-400)

8. **Close connections and cursors in finally blocks.** Every connection checked out from a pool and every cursor opened must be returned/closed in a `finally` block, context manager (`with`), or equivalent guaranteed cleanup mechanism. Leaked connections exhaust the pool.

9. **Set query timeouts.** Every database query should have a timeout (statement_timeout, query_timeout). A query without a timeout that hits a full table scan can hold a connection for minutes, blocking other requests and potentially causing cascading failures.

### ORM vs Raw SQL

10. **Use the ORM for standard CRUD operations.** ORMs prevent injection, handle connection management, and produce readable code for standard create/read/update/delete operations. Don't bypass the ORM for queries it handles well.

11. **Use raw SQL for complex queries where the ORM produces poor results.** Complex aggregations, CTEs, window functions, bulk operations, and performance-critical queries may be better expressed as raw SQL. When using raw SQL, it must still be parameterized, and it should live in the repository/data access layer — not in services or handlers.

12. **Do not mix ORM and raw SQL inconsistently.** Within a project, establish a clear convention: which operations use the ORM and which use raw SQL. Document the boundary. If both are used, raw SQL should be confined to specific repository methods, not scattered through the codebase.

## Patterns

### Parameterized Dynamic Queries

#### Do This

```python
# Safe dynamic query with query builder
def search_users(filters: dict) -> list[User]:
    query = select(User)

    if "name" in filters:
        query = query.where(User.name.ilike(f"%{filters['name']}%"))
    if "role" in filters:
        query = query.where(User.role == filters["role"])
    if "active" in filters:
        query = query.where(User.is_active == filters["active"])

    return session.execute(query).scalars().all()
```

#### Not This

```python
# Dynamic query built with string concatenation — injection risk (CWE-89)
def search_users(filters: dict) -> list:
    sql = "SELECT * FROM users WHERE 1=1"
    if "name" in filters:
        sql += f" AND name ILIKE '%{filters['name']}%'"
    if "role" in filters:
        sql += f" AND role = '{filters['role']}'"
    return db.execute(sql).fetchall()
```

**Why it's wrong:** Every filter value is concatenated directly into the SQL string. Setting `name` to `%' OR '1'='1` bypasses the filter. Setting `role` to `admin' --` bypasses all subsequent conditions. Even though the individual values might seem harmless, the dynamic construction makes this exploitable.

### N+1 Query Prevention

#### Do This

```python
# Eager load related records — 2 queries total
def get_orders_with_items(user_id: str) -> list[Order]:
    return (
        session.query(Order)
        .options(joinedload(Order.items))  # Load items in the same query
        .filter(Order.user_id == user_id)
        .all()
    )
```

```sql
-- Or with raw SQL: single query with JOIN
SELECT o.*, i.* FROM orders o
LEFT JOIN order_items i ON i.order_id = o.id
WHERE o.user_id = $1
ORDER BY o.created_at DESC
```

#### Not This

```python
# N+1: 1 query for orders + N queries for items
def get_orders_with_items(user_id: str) -> list[dict]:
    orders = session.query(Order).filter(Order.user_id == user_id).all()
    result = []
    for order in orders:  # If 100 orders → 101 queries
        items = session.query(OrderItem).filter(OrderItem.order_id == order.id).all()
        result.append({"order": order, "items": items})
    return result
```

**Why it's wrong:** For 100 orders, this executes 101 queries — 1 for orders, 100 for items. For 1,000 orders, 1,001 queries. Database round-trips are expensive (network latency, connection overhead, query parsing). A single JOIN or eager load achieves the same result in 1-2 queries regardless of result count.

### Migration Safety

#### Do This

```python
# Migration: add column (nullable first for zero-downtime)
def up():
    # Step 1: Add nullable column — no table lock, no downtime
    op.add_column("users", sa.Column("display_name", sa.String(200), nullable=True))

def down():
    op.drop_column("users", "display_name")

# Separate migration: backfill data
def up():
    op.execute("UPDATE users SET display_name = name WHERE display_name IS NULL")

def down():
    op.execute("UPDATE users SET display_name = NULL")

# Third migration: add NOT NULL constraint after backfill
def up():
    op.alter_column("users", "display_name", nullable=False)

def down():
    op.alter_column("users", "display_name", nullable=True)
```

#### Not This

```python
# Single migration: adds column with NOT NULL + default on a huge table
def up():
    # Locks the entire table while rewriting every row to add the default
    op.add_column("users", sa.Column(
        "display_name", sa.String(200), nullable=False, server_default="Unknown"
    ))
    # Also backfills data in the same migration
    op.execute("UPDATE users SET display_name = name")

def down():
    pass  # No rollback — irreversible
```

**Why it's wrong:** Adding a NOT NULL column with a default value on a large table locks the table while every row is rewritten. On a table with millions of rows, this can take minutes of downtime. Mixing schema changes with data backfills makes rollback dangerous. Missing `down()` means this migration is irreversible.

### Connection Management

#### Do This

```python
# Connection pool with proper configuration
from sqlalchemy import create_engine

engine = create_engine(
    DATABASE_URL,
    pool_size=20,           # Max connections in pool
    max_overflow=5,         # Additional connections under load
    pool_timeout=30,        # Wait time for available connection
    pool_recycle=1800,      # Recycle connections after 30 minutes
    pool_pre_ping=True,     # Verify connection health before use
)

# Context manager guarantees connection return
async def get_user(user_id: str) -> User:
    with engine.connect() as conn:
        row = conn.execute(
            text("SELECT * FROM users WHERE id = :id"),
            {"id": user_id}
        ).fetchone()
        return User.from_row(row) if row else None
    # Connection automatically returned to pool
```

#### Not This

```python
# New connection per request — no pooling, no cleanup
import psycopg2

async def get_user(user_id: str):
    conn = psycopg2.connect(DATABASE_URL)  # New connection every call
    cursor = conn.cursor()
    cursor.execute(f"SELECT * FROM users WHERE id = '{user_id}'")
    row = cursor.fetchone()
    # Connection never closed — leaked
    # Also: SQL injection and no parameterization
    return row
```

**Why it's wrong:** Every request creates a new database connection (expensive: TCP handshake, TLS negotiation, auth). The connection is never closed, so under load the database runs out of connections. There's also SQL injection. A connection pool reuses existing connections and guarantees cleanup.

## Exceptions

- **Read replicas** may use separate connection pools with different configurations (higher pool size, longer timeouts) than the primary.
- **Batch processing** (data imports, ETL) may use single long-lived connections or connection-per-batch rather than the request pool.
- **Schema management tools** (Django manage.py, Alembic CLI) operate outside the application pool and may use direct connections.

## Cross-References

- [Security](core-security) — Parameterized queries as a universal security principle
- [Backend Security](web-backend-security) — Injection prevention and connection security
- [Backend Structure](web-backend-structure) — Repository pattern and data access layer isolation
- [Error Handling](core-error-handling) — Database error handling and transaction rollback
