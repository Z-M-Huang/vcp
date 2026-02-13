---
id: web-frontend-performance
title: Frontend Performance
scope: web-frontend
severity: medium
tags: [performance, bundle-size, lazy-loading, code-splitting, rendering, assets]
references:
  - title: "web.dev — Performance"
    url: https://web.dev/performance/
  - title: "MDN — Lazy Loading"
    url: https://developer.mozilla.org/en-US/docs/Web/Performance/Lazy_loading
---

## Principle

Frontend performance is death by a thousand cuts. No single dependency, image, or re-render is the problem — it's the accumulation of many small decisions, each seemingly harmless, that compounds into a slow application. Every dependency added, every image unoptimized, and every unnecessary render is a tax on the user's device and network.

AI adds dependencies without checking bundle impact, loads everything upfront, and rarely applies rendering optimizations proactively. The result is applications that start fast with a prototype but slow down as features accumulate.

## Rules

### Bundle Discipline

1. **Check bundle impact before adding a dependency.** Before `npm install`, check the package size on bundlephobia.com or equivalent. If a 200KB library is being added for something 20 lines of code can do, write the code. If the dependency is justified, check for tree-shakeable alternatives or lighter packages with the same functionality.

2. **Code-split at route boundaries.** Each route (page) should be a separate chunk loaded on demand. Users visiting the homepage should not download the code for the settings page, the admin dashboard, or any page they haven't navigated to. Use dynamic `import()` for route-level splitting.

3. **Do not import the entire library when you need one function.** Use named imports from subpaths when available: `import debounce from "lodash/debounce"` instead of `import { debounce } from "lodash"`. The latter may pull in the entire library if tree-shaking is not configured correctly.

### Lazy Loading

4. **Lazy-load below-the-fold content.** Components, images, and data that are not visible on initial page load should not block initial rendering. Use `React.lazy()`, dynamic `import()`, `loading="lazy"` on images, or intersection observers to defer loading until the content enters (or is near) the viewport.

5. **Lazy-load heavy third-party components.** Rich text editors, charting libraries, maps, and syntax highlighters are often large. Load them only when the user interacts with the feature that needs them — not on page load.

### Rendering Optimization

6. **Do not memoize prematurely.** `React.memo`, `useMemo`, and `useCallback` have a cost — they add memory overhead and code complexity. Use them only when profiling shows a measurable performance problem. Most components re-render fast enough without memoization. Profile first, optimize second.

7. **Prevent unnecessary re-renders from unstable references.** Objects, arrays, and functions created inline in render are new references on every render, which causes child components to re-render. When profiling confirms this is a problem, stabilize these references with `useMemo` or `useCallback`. Do not stabilize everything by default — only what profiling identifies.

8. **Virtualize long lists.** Lists over ~100 items should use windowed/virtualized rendering (react-window, TanStack Virtual, or equivalent). Rendering 10,000 DOM nodes when only 20 are visible wastes memory and CPU. Virtualization renders only the visible items plus a small buffer.

### Asset Optimization

9. **Serve images in modern formats at appropriate sizes.** Use WebP or AVIF instead of PNG/JPEG where browser support allows. Serve responsive images (`srcset`) so mobile devices don't download desktop-sized images. Compress all images — an unoptimized 5MB hero image on a 3G connection is a 15-second wait.

10. **Subset and optimize fonts.** Custom fonts should include only the character sets needed (latin, latin-ext) and be served in WOFF2 format. Use `font-display: swap` to prevent invisible text during font loading. Limit to 2-3 font weights — each additional weight is another file download.

### Critical Path

11. **Minimize blocking resources in the critical rendering path.** CSS that's needed for above-the-fold content should be inlined or loaded with high priority. CSS for below-the-fold content should be deferred. JavaScript that's not needed for initial render should be `defer` or `async`. Every blocking resource delays first paint.

12. **Prefer CSS for visual effects over JavaScript.** CSS transitions and animations run on the compositor thread and don't block the main thread. JavaScript animations run on the main thread and can cause jank. Use CSS for transforms, opacity changes, and simple transitions. Reserve JavaScript animation for complex, interactive, or physics-based motion.

## Patterns

### Bundle Impact Check

#### Do This

```typescript
// Need date formatting — check built-in first
const formatted = new Intl.DateTimeFormat("en-US", {
  year: "numeric", month: "short", day: "numeric"
}).format(date);
// 0 KB added — uses built-in Intl API
```

#### Not This

```typescript
// Adding moment.js (300KB+ gzipped) for simple date formatting
import moment from "moment";
const formatted = moment(date).format("MMM D, YYYY");
```

**Why it's wrong:** `moment.js` adds ~300KB to the bundle (it's also deprecated in favor of lighter alternatives). The built-in `Intl.DateTimeFormat` API handles the same formatting with zero bundle cost. Even when a library is needed, `date-fns` (tree-shakeable, ~3KB per function) or `dayjs` (~2KB) are far lighter alternatives.

### Route-Level Code Splitting

#### Do This

```tsx
import { lazy, Suspense } from "react";

// Each route is a separate chunk — loaded only when navigated to
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Settings = lazy(() => import("./pages/Settings"));
const AdminPanel = lazy(() => import("./pages/AdminPanel"));

function App() {
  return (
    <Suspense fallback={<Spinner />}>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/admin" element={<AdminPanel />} />
      </Routes>
    </Suspense>
  );
}
```

#### Not This

```tsx
// All pages imported statically — entire app downloaded on first visit
import Dashboard from "./pages/Dashboard";
import Settings from "./pages/Settings";
import AdminPanel from "./pages/AdminPanel"; // 200KB admin code loaded for all users
```

**Why it's wrong:** Every page's code is in a single bundle downloaded on the first visit. A regular user who never visits the admin panel still downloads its 200KB of code. As pages are added, the initial bundle grows without bound. Code splitting at route boundaries ensures users only download the code for pages they actually visit.

### Lazy Loading Heavy Components

#### Do This

```tsx
import { lazy, Suspense, useState } from "react";

// Chart library loaded only when user opens the analytics tab
const Chart = lazy(() => import("./Chart"));

function AnalyticsDashboard() {
  const [showChart, setShowChart] = useState(false);

  return (
    <div>
      <button onClick={() => setShowChart(true)}>Show Analytics</button>
      {showChart && (
        <Suspense fallback={<Spinner />}>
          <Chart data={analyticsData} />
        </Suspense>
      )}
    </div>
  );
}
```

#### Not This

```tsx
// 500KB charting library loaded on page mount, even if user never opens analytics
import { BarChart, LineChart, PieChart } from "recharts";
```

**Why it's wrong:** The charting library is loaded on page mount regardless of whether the user ever views the analytics section. For users who never click "Show Analytics," this is wasted bandwidth and increased time-to-interactive for no benefit.

### Image Optimization

#### Do This

```html
<!-- Responsive images with modern format, lazy-loaded -->
<img
  srcset="hero-400.webp 400w, hero-800.webp 800w, hero-1200.webp 1200w"
  sizes="(max-width: 600px) 400px, (max-width: 1000px) 800px, 1200px"
  src="hero-800.webp"
  alt="Hero image"
  loading="lazy"
  decoding="async"
  width="1200"
  height="600"
/>
```

#### Not This

```html
<!-- 5MB unoptimized PNG, no responsive sizes, blocks layout -->
<img src="hero.png" alt="Hero image" />
```

**Why it's wrong:** A 5MB PNG on a mobile connection takes 15+ seconds to load. No responsive sizes means mobile downloads the desktop version. No `loading="lazy"` means below-the-fold images block page load. No `width`/`height` means layout shift when the image loads. WebP is typically 30-50% smaller than PNG at equivalent quality.

## Exceptions

- **Admin/internal tools** where user count is small and development speed is more valuable than page load optimization may relax bundle discipline. Performance standards still apply to user-facing applications.
- **Memoization in performance-sensitive contexts** like animation frames, real-time data displays, or canvas rendering may be appropriate proactively, before profiling — the cost of jank in these contexts is obvious.
- **Above-the-fold critical content** (hero images, main navigation) should NOT be lazy-loaded — it should load immediately for the best LCP (Largest Contentful Paint) score.

## Cross-References

- [Dependency Management](core-dependency-management) — Bundle impact assessment before adding dependencies
- [Frontend Structure](web-frontend-structure) — Feature-based splitting enables route-level code splitting
- [Code Quality](core-code-quality) — Eliminating dead code reduces bundle size
