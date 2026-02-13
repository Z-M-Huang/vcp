---
id: web-frontend-structure
title: Frontend Structure
scope: web-frontend
severity: high
tags: [frontend, components, state-management, folder-structure, react, vue, svelte]
references:
  - title: "React Documentation — Thinking in React"
    url: https://react.dev/learn/thinking-in-react
  - title: "Bulletproof React — Project Structure"
    url: https://github.com/alan2207/bulletproof-react
---

## Principle

A component should render one piece of UI. A hook or composable should encapsulate one piece of logic. A file should contain one concept. When components grow past a few hundred lines, they're doing too many jobs — fetching data, managing state, handling events, formatting output, and rendering UI all in one place.

AI creates monolithic 500+ line components that work on day one but become unmaintainable as the application grows. It mixes data fetching, state management, business logic, and presentation in a single file because that's the fastest path to "working code." This standard enforces the structure that keeps frontend codebases navigable.

## Rules

### Component Boundaries

1. **One component, one visual responsibility.** A component renders one piece of UI — a form, a card, a navigation bar. If a component renders a page header AND a data table AND a pagination control, it has three visual responsibilities and should be three components.

2. **Separate data/logic from presentation.** Components that fetch data, transform it, and render it are doing three jobs. Split into: a container (or hook) that manages data and logic, and a presentational component that receives props and renders UI. The presentational component should be testable with just props — no API calls, no global state access.

3. **Keep components under 200 lines. Components over 300 lines must be split or justified.** Size thresholds:
   - **Under 200 lines:** No action needed.
   - **200-300 lines:** Review for extraction opportunities. A component this size is acceptable only if it has a single clearly-defined responsibility (e.g., a complex form with many fields but no data fetching or business logic).
   - **Over 300 lines:** Must be split into smaller components, or the developer must document a specific reason it cannot be split (e.g., "splitting would require lifting 8 state variables to a parent, increasing complexity"). A note saying "reviewed" or "acceptable" without a specific reason is not a valid justification.

### State Management

4. **Colocate state with the component that uses it.** State should live in the lowest common ancestor of the components that need it — not higher. If only one component uses a piece of state, that state belongs in that component. Lifting state to a global store "just in case" creates unnecessary coupling.

5. **Use global state only for truly global data.** Authentication status, user preferences, theme, and feature flags are global. A form's input values, a modal's open/closed state, and a list's filter criteria are not. Global state should be the exception, not the default.

6. **Derive values instead of storing computed state.** If a value can be calculated from existing state, calculate it — don't store it separately. Storing derived values creates synchronization bugs where the source and the derived copy get out of sync.

### Folder Structure

7. **Prefer feature-based organization; use layer-based only when justified.** Both approaches have tradeoffs:
   - **Feature-based** (`features/orders/`, `features/users/`): related files are colocated, features are self-contained, easy to add/remove features, scales well with team size. Downside: shared code boundaries require discipline.
   - **Layer-based** (`components/`, `hooks/`, `api/`): simple for small apps, familiar to new developers. Downside: related files are scattered across directories, adding a feature touches many folders, scales poorly past ~20 components.
   - **Choose feature-based** when the app has 3+ distinct features, multiple contributors, or is expected to grow. Choose layer-based only for very small applications (under ~10 components) where the overhead of feature folders adds no value.

8. **Keep shared code explicitly separate from feature code.** Shared components (buttons, inputs, modals), shared hooks (useDebounce, useMediaQuery), and shared utilities live in a clearly named shared directory (`shared/`, `common/`, or `lib/`). Feature code that's only used by one feature stays in that feature's directory.

### File Naming

9. **One exported component per file.** Each component file exports one component whose name matches the filename. `UserProfile.tsx` exports `UserProfile`. Do not export multiple components from a single file — it makes imports ambiguous and files harder to find.

10. **Use consistent file naming across the project.** Pick one convention and use it everywhere: `PascalCase.tsx` for components, `camelCase.ts` for utilities, `kebab-case.ts` for modules — whatever the project established. Do not mix conventions.

## Patterns

### Component Separation

#### Do This

```tsx
// useOrders.ts — data fetching and logic
function useOrders(userId: string) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    fetchOrders(userId)
      .then(setOrders)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [userId]);

  return { orders, loading, error };
}

// OrderList.tsx — presentation only
function OrderList({ orders }: { orders: Order[] }) {
  return (
    <ul>
      {orders.map((order) => (
        <OrderCard key={order.id} order={order} />
      ))}
    </ul>
  );
}

// OrdersPage.tsx — composition
function OrdersPage({ userId }: { userId: string }) {
  const { orders, loading, error } = useOrders(userId);
  if (loading) return <Spinner />;
  if (error) return <ErrorMessage error={error} />;
  return <OrderList orders={orders} />;
}
```

#### Not This

```tsx
// OrdersPage.tsx — 400+ line god component
function OrdersPage({ userId }: { userId: string }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sortBy, setSortBy] = useState("date");
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(1);
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  useEffect(() => { /* fetch logic */ }, [userId]);
  useEffect(() => { /* sort logic */ }, [sortBy]);
  useEffect(() => { /* filter logic */ }, [filter]);

  const handleSort = () => { /* ... */ };
  const handleFilter = () => { /* ... */ };
  const handlePageChange = () => { /* ... */ };
  const handleOrderClick = () => { /* ... */ };
  const handleModalClose = () => { /* ... */ };
  const formatDate = (d) => { /* ... */ };
  const formatCurrency = (n) => { /* ... */ };

  return (
    <div>
      {/* 200 lines of JSX mixing header, filters, table, pagination, modal */}
    </div>
  );
}
```

**Why it's wrong:** This component manages data fetching, sorting, filtering, pagination, modal state, date formatting, and currency formatting — at least seven different concerns. It can't be tested without rendering the entire page. The sort logic can't be reused by another page. The format utilities can't be shared. Every future change touches this one massive file.

### State Colocation

#### Do This

```tsx
// Search filter state stays in the component that uses it
function UserSearch() {
  const [query, setQuery] = useState(""); // Local — only this component needs it

  return (
    <input value={query} onChange={(e) => setQuery(e.target.value)} />
  );
}

// Auth state is truly global — lives in context/store
function AuthProvider({ children }) {
  const [user, setUser] = useState<User | null>(null);
  // ... auth logic
  return <AuthContext.Provider value={{ user }}>{children}</AuthContext.Provider>;
}
```

#### Not This

```tsx
// Everything in global store — even local UI state
const useStore = create((set) => ({
  searchQuery: "",            // Only used by one component
  isDropdownOpen: false,      // Only used by one component
  selectedTab: "overview",    // Only used by one component
  user: null,                 // Actually global
  theme: "light",             // Actually global
  setSearchQuery: (q) => set({ searchQuery: q }),
  setDropdownOpen: (v) => set({ isDropdownOpen: v }),
  // ... 30 more actions for local UI state
}));
```

**Why it's wrong:** A global store containing local UI state creates coupling between unrelated components. Changing the search component means modifying the global store that every other component depends on. When `searchQuery` updates, components subscribed to the store may re-render unnecessarily. Global state should be reserved for data that multiple unrelated components need simultaneously.

### Feature-Based Folders

#### Do This

```
src/
├── features/
│   ├── orders/
│   │   ├── OrderList.tsx
│   │   ├── OrderCard.tsx
│   │   ├── useOrders.ts
│   │   ├── ordersApi.ts
│   │   └── types.ts
│   └── users/
│       ├── UserProfile.tsx
│       ├── useUser.ts
│       ├── usersApi.ts
│       └── types.ts
├── shared/
│   ├── components/
│   │   ├── Button.tsx
│   │   └── Spinner.tsx
│   └── hooks/
│       └── useDebounce.ts
└── app/
    ├── routes.tsx
    └── layout.tsx
```

#### Not This

```
src/
├── components/
│   ├── OrderList.tsx
│   ├── OrderCard.tsx
│   ├── UserProfile.tsx
│   ├── Button.tsx
│   └── Spinner.tsx
├── hooks/
│   ├── useOrders.ts
│   ├── useUser.ts
│   └── useDebounce.ts
├── api/
│   ├── ordersApi.ts
│   └── usersApi.ts
└── types/
    ├── orders.ts
    └── users.ts
```

**Why it's wrong:** To understand the "orders" feature, you must look in four different directories. To add a new feature, you must modify four directories. To delete a feature, you must find and remove files scattered across the tree. Feature-based organization keeps related code together — everything about "orders" is in one place.

## Exceptions

- **Very small applications** (under ~10 components) don't need feature folders. A flat `components/` directory is fine until the application grows.
- **Framework conventions** override this standard when the framework enforces a specific structure (e.g., Next.js `app/` directory, Nuxt `pages/`). Work within the framework's conventions.
- **Shared component libraries** (design systems) organize by component type, not by feature — that's their correct organization since they serve all features.

## Cross-References

- [Architecture](core-architecture) — SRP and separation of concerns at the system level
- [Code Quality](core-code-quality) — Reuse patterns and consistency within the project
- [Frontend Security](web-frontend-security) — Where security checks belong in the component tree
- [Frontend Performance](web-frontend-performance) — Code splitting at feature boundaries
