---
id: core-code-quality
title: Code Quality
scope: core
severity: high
tags: [quality, duplication, dead-code, consistency, naming, churn]
references:
  - title: "GitClear 2024 — AI Coding Assistants Code Quality"
    url: https://www.gitclear.com/
  - title: "CMU — AI-Assisted Coding Complexity Study"
    url: https://www.cmu.edu/
  - title: "CodeRabbit 2025 — State of AI vs Human Code"
    url: https://www.coderabbit.ai/blog/state-of-ai-vs-human-code-generation-report
---

## Principle

Code is read far more than it is written. Every line added to a codebase becomes a maintenance obligation. The goal is not to produce more code faster — it is to produce the minimum correct code that solves the problem clearly and consistently with what already exists.

AI treats each prompt as independent — no memory of what it generated before. This produces an 8x increase in code duplication (GitClear 2024), code churn up from 5.5% to 7.9%, and AI-generated functions that "perform similar tasks differently" within the same codebase. This standard exists to prevent that degradation.

## Rules

### Reuse Before Recreate

1. **Search the existing codebase before writing new code.** Before creating a utility, helper, formatter, validator, or any reusable logic, search for existing implementations. Check: utility directories, shared modules, the file where similar logic already lives. If something close exists, extend it rather than creating a parallel implementation.

2. **Match existing patterns.** When the codebase has an established way of doing something — error handling, API calls, data transformations, formatting — follow it. Do not introduce a new pattern for the same concern. One pattern per concern across the entire project.

### Duplication

3. **Eliminate structural duplication.** When three or more code blocks share the same structure and serve the same purpose, extract the shared logic into a single function or module. Two similar blocks may be coincidence; three is a pattern that must be consolidated.

4. **Do not extract prematurely.** Two code blocks that look similar but serve different business purposes and change for different reasons are not duplication — they are coincidence. Only extract when the shared structure is stable and the blocks genuinely have the same reason to change.

### Dead Code

5. **Remove code that is not executed.** Unused imports, unreachable branches, commented-out blocks, functions with zero callers, and variables that are assigned but never read are dead code. Remove them. Dead code misleads readers, increases cognitive load, and creates false dependencies.

6. **Never comment out code as a "backup."** Version control is the backup. Commented-out code is noise that future readers must evaluate and decide to ignore. If code is not needed now, delete it — `git log` preserves the history.

### Consistency

7. **Follow the project's established naming conventions.** Use the same casing, prefixes, suffixes, and vocabulary as the existing code. If the project uses `getUserById`, do not introduce `fetch_user` or `findUserWithId`. Consistency within the project always overrides personal style preferences.

8. **One way to do each thing.** The project should have one pattern for HTTP clients, one pattern for date formatting, one pattern for config access, one pattern for logging. When you need to do something the codebase already does, use the same approach — not a novel alternative.

### Code Churn

9. **Get it right the first time.** Before writing code, understand the requirements fully. Read the relevant existing code. Plan the approach. Code written hastily and revised within days is churn — it wastes review time and introduces instability. Spend more time thinking and less time typing.

10. **Make changes minimal and focused.** Each change should do one thing. Don't mix refactoring with feature work. Don't fix formatting in a file you're changing for a bug fix. Smaller, focused changes are easier to review, test, and revert.

## Patterns

### Search Before Creating

#### Do This

```typescript
// Need to format a date? Search the codebase first.
// Found: src/utils/formatting.ts already has formatDate()
import { formatDate } from "@/utils/formatting";

const displayDate = formatDate(order.createdAt);
```

#### Not This

```typescript
// Creating a new date formatter without checking if one exists
function formatOrderDate(date: Date): string {
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
}

const displayDate = formatOrderDate(order.createdAt);
```

**Why it's wrong:** Now two date formatting functions exist. They produce different formats (the existing one might use ISO 8601, this one uses M/D/YYYY). When the format needs to change, only one gets updated. Users see inconsistent dates.

### Duplication Extraction

#### Do This

```python
# Three endpoints all validate and normalize email the same way — extract it
def normalize_email(email: str) -> str:
    if not email or not isinstance(email, str):
        raise ValidationError("Email is required")
    email = email.strip().lower()
    if not EMAIL_REGEX.match(email):
        raise ValidationError("Invalid email format")
    return email

# Used in all three places
email = normalize_email(request.data["email"])
```

#### Not This

```python
# Same validation copy-pasted into three endpoints with slight variations
# Endpoint 1:
email = request.data["email"].strip().lower()
if not re.match(r"[^@]+@[^@]+\.[^@]+", email): ...

# Endpoint 2:
email = request.data.get("email", "").strip()
if "@" not in email: ...

# Endpoint 3:
email = request.data["email"].lower().strip()
if not EMAIL_PATTERN.match(email): ...
```

**Why it's wrong:** Three implementations of email validation with three different behaviors. One checks with regex, one checks for "@", one uses a pattern constant. When the validation rule needs to change, all three must be found and updated — and they will diverge further over time.

### Dead Code Removal

#### Do This

```javascript
// Only the code that's actually used
export function calculateTotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}
```

#### Not This

```javascript
// Commented-out "backup" code and unused functions
// function calculateTotalV1(items) {
//   let total = 0;
//   for (const item of items) {
//     total += item.price * item.quantity;
//   }
//   return total;
// }

// TODO: might need this later
// function calculateTotalWithTax(items, taxRate) {
//   return calculateTotal(items) * (1 + taxRate);
// }

export function calculateTotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}
```

**Why it's wrong:** Future readers must evaluate all the commented-out code to understand what's active. "Might need this later" never comes, and if it does, the old implementation is usually wrong for the new requirements anyway. Version control preserves history — deleting code is safe.

### Naming Consistency

#### Do This

```python
# Project consistently uses get_X_by_Y pattern
def get_user_by_id(user_id: int) -> User: ...
def get_order_by_id(order_id: int) -> Order: ...
def get_product_by_sku(sku: str) -> Product: ...  # Follows established pattern
```

#### Not This

```python
# Existing codebase uses get_X_by_Y, but new code introduces different patterns
def get_user_by_id(user_id: int) -> User: ...      # Existing
def get_order_by_id(order_id: int) -> Order: ...    # Existing
def fetch_product(sku: str) -> Product: ...          # New — different verb, no "by_Y"
def find_invoice_with_number(num: str) -> Invoice: ...  # New — yet another pattern
```

**Why it's wrong:** Three naming patterns for the same concept. Developers searching for "how to look up an entity" will find inconsistent patterns and not know which to follow. Each new contributor copies a different style, accelerating divergence.

## Exceptions

- **Generated code** (ORM migrations, protobuf outputs, API client stubs) follows its generator's conventions, not the project's hand-written patterns. Do not modify generated files to match project style.
- **Test files** may contain intentional duplication when each test must be independently readable and setup logic shouldn't be abstracted into hard-to-trace helpers.
- **Performance-critical code** may justify seemingly redundant implementations when abstraction introduces measurable overhead. Document the benchmark that justifies it.

## Cross-References

- [Architecture](core-architecture) — SRP and separation of concerns prevent structural duplication
- [Root Cause Analysis](core-root-cause-analysis) — Duplication often causes the "fix one, miss the other" bug pattern
- [Testing](core-testing) — Test consistency and when duplication in tests is acceptable
