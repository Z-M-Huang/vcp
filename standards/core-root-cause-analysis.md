---
id: core-root-cause-analysis
title: Root Cause Analysis
scope: core
severity: high
tags: [root-cause, debugging, death-spiral, bug-fixing, tracing]
references:
  - title: "CodeRabbit 2025 — AI vs Human Code Quality"
    url: https://www.coderabbit.ai/blog/state-of-ai-vs-human-code-generation-report
  - title: "Stack Overflow — Bugs and Incidents with AI Coding Agents"
    url: https://stackoverflow.blog/2026/01/28/are-bugs-and-incidents-inevitable-with-ai-coding-agents/
---

## Principle

Fix bugs where they originate, not where they manifest. A symptom and its cause are rarely in the same place. Patching the symptom leaves the cause active — it will produce new symptoms elsewhere, each patch compounding the damage until the codebase is unmaintainable.

This is the "death spiral" of AI-assisted development: AI sees an error, patches where it appears, the patch violates assumptions elsewhere, new bugs emerge, and each fix makes the system worse. Breaking this cycle requires disciplined root cause thinking before writing any fix.

## Rules

### Before Fixing

1. **Reproduce the bug reliably before attempting a fix.** If you can't reproduce it, you don't understand it. A fix for a bug you can't reproduce is untestable — you have no way to confirm it works.

2. **Trace the data flow from symptom to source.** Follow the data backwards: where does the incorrect value come from? What function produced it? What input caused that function to produce it? Keep tracing until you reach the point where correct input first becomes incorrect output. That is the root cause.

3. **Ask "why" five times.** When you find a proximate cause, ask why that happened. Repeat until you reach a cause that, if fixed, would prevent the entire chain. Stopping too early means fixing a symptom — the real cause remains active.

### The Fix Location Decision

4. **Apply the fix at the earliest point where the defect can be corrected.** The correct fix location is where correct data first becomes incorrect — not where incorrect data eventually causes a visible error. Fixing downstream means every other consumer of the bad data is still affected.

5. **Use the decision framework to choose fix location.** Before writing code, answer these questions:

   - **Where does the symptom appear?** (the error, crash, or wrong output)
   - **Where does the incorrect data originate?** (trace backwards)
   - **Are these the same location?** If yes → fix here. If no → fix at the origin.
   - **Does this data flow through other paths?** If yes → fixing only the symptom path leaves other paths broken.
   - **Would this fix survive a refactor?** If the fix depends on execution order, specific call sites, or implementation details of other modules, it's a patch — not a root cause fix.

6. **Validate that the fix addresses the cause, not just the trigger.** After identifying a fix, check: if the same bad data arrived from a different code path, would it still be caught? If not, you've fixed one trigger but not the underlying cause.

### When Local Patching IS Correct

7. **Patch locally when the local code is genuinely at fault.** Not every bug is a root cause problem. If a function receives valid input and produces wrong output due to its own logic error, the fix belongs in that function. The decision framework applies — if tracing leads back to the same function, fix it there.

8. **Patch locally for defense-in-depth.** When adding a validation check at a consumption point as an additional safety layer (not as the primary fix), document it as defense-in-depth and reference where the primary fix lives. Both the upstream fix and the downstream guard have value.

### Breaking the Death Spiral

9. **Stop and analyze before applying a second patch to the same area.** If the same module, function, or feature has required two bug fixes in quick succession, the second fix is likely patching symptoms of a deeper issue. Step back and trace the root cause before adding more patches.

10. **Never apply a fix you don't understand.** If you cannot explain WHY a fix works — not just that it makes the test pass — do not apply it. Cargo-cult fixes create the worst death spirals because they introduce behavior that no one can reason about.

## Patterns

### Tracing to Root Cause

#### Do This

```python
# Bug: Order total shows as $0 on the confirmation page

# Step 1: Where does the symptom appear?
# → confirmation_page.render() shows total = 0

# Step 2: Where does it get the total?
# → order = order_service.get_order(order_id)
# → order.total is 0 in the returned object

# Step 3: Where is order.total set?
# → order_service.create_order() calls calculate_total()
# → calculate_total() returns 0 when items have no "price" key

# Step 4: Why do items have no "price" key?
# → The cart API returns "unit_price", not "price"
# → The cart-to-order mapping doesn't translate the field name

# ROOT CAUSE: Field mapping between cart and order is wrong
# FIX LOCATION: cart-to-order mapping function

def map_cart_to_order_items(cart_items):
    return [
        OrderItem(
            product_id=item["product_id"],
            quantity=item["quantity"],
            price=item["unit_price"],  # Fix: map "unit_price" to "price"
        )
        for item in cart_items
    ]
```

#### Not This

```python
# Symptom fix: force total to recalculate at display time
def render_confirmation(order):
    # "Fix" — recalculate total from items if it's zero
    total = order.total
    if total == 0 and order.items:
        total = sum(item.quantity * item.price for item in order.items)
    return template.render(total=total)
```

**Why it's wrong:** The order still has total=0 in the database. Every other place that reads the total — invoices, reports, refund calculations, the admin dashboard — still sees $0. The display "fix" masks the problem in one location while leaving it active everywhere else.

### The Decision Framework in Action

#### Do This

```python
# Bug: Users get "Permission denied" when accessing their own documents

# Trace:
# 1. Symptom: 403 error in GET /documents/{id}
# 2. Auth middleware checks request.user.org_id == document.org_id
# 3. request.user.org_id is None for users who signed up via SSO
# 4. SSO callback doesn't set org_id on the user record
# Root cause: SSO user creation is missing org_id assignment

# Fix at the origin — SSO callback
def handle_sso_callback(sso_data):
    user = User.create(
        email=sso_data["email"],
        org_id=sso_data["org_id"],  # Fix: include org_id from SSO data
    )
    return user
```

#### Not This

```python
# Symptom patch: skip org check for SSO users
def check_document_access(user, document):
    if user.auth_method == "sso":
        return True  # "Fix" — SSO users can access everything
    return user.org_id == document.org_id
```

**Why it's wrong:** This "fix" gives SSO users access to ALL documents across ALL organizations — a security vulnerability. The real problem is that SSO users don't have org_id set. Patching the authorization check to work around missing data introduces a worse bug than the original.

### When Local IS Correct

```python
# Bug: calculate_discount() returns negative values for 100% discounts

# Trace:
# 1. Symptom: negative line items on invoices
# 2. calculate_discount(price=50, percent=100) returns -50
# 3. The function logic: price - (price * percent / 100) ... wait
# 4. Actually: price * (1 - percent / 100) = 50 * (1 - 1) = 0. That's correct.
# 5. Re-check: the function has `return price - price * percent` (missing /100)
# Root cause: arithmetic bug IN this function. Fix belongs here.

def calculate_discount(price: float, percent: float) -> float:
    """Apply percentage discount. Returns discounted price, minimum 0."""
    if not 0 <= percent <= 100:
        raise ValueError(f"Discount percent must be 0-100, got {percent}")
    return max(0, price * (1 - percent / 100))
```

**Why this is correct:** The trace leads back to the same function. The function receives valid input (price=50, percent=100) and produces wrong output due to its own math error. Local fix is the right fix.

### Breaking the Death Spiral

#### Do This

```
# Second bug in the same payment module this week.
# STOP. Do not patch.

# Previous fix: Added retry logic when payment API returns 500
# Current bug: Duplicate charges appearing for some customers

# These are related. Step back and analyze:
# - Payment API sometimes returns 500 after processing successfully
# - Our retry logic resends the payment
# - Result: double charge

# Root cause: No idempotency key on payment requests
# Fix: Add idempotency key, REMOVE the naive retry logic
```

#### Not This

```
# Second bug this week? Just add another patch:
# "Fix" — check for duplicate charges after retrying and refund if found
# Now we have: retry logic + duplicate detection + auto-refund logic
# Three patches masking one missing idempotency key
```

**Why it's wrong:** Each patch adds complexity and new failure modes. The auto-refund might fail. The duplicate detection has a race condition. Three interacting patches are harder to reason about than one correct solution. This is the death spiral in action.

## Exceptions

- **Hotfixes under production pressure** may justify a symptom-level patch to stop the bleeding, but the root cause fix must be scheduled immediately and the symptom patch removed when the real fix lands. Document both the temporary patch and the root cause ticket.
- **Third-party bugs** where you cannot fix the source may require a workaround at your boundary. Document it as a workaround, reference the upstream issue, and remove it when the upstream fix is available.
- **Defense-in-depth additions** that add safety checks at consumption points are valuable even when the root cause is fixed elsewhere. These are not "symptom patches" — they're intentional safety layers.

## Cross-References

- [Architecture](core-architecture) — Why architectural violations cause root cause confusion across layers
- [Error Handling](core-error-handling) — How to surface errors at the right level for diagnosis
- [Testing](core-testing) — How to write regression tests that verify root cause fixes
