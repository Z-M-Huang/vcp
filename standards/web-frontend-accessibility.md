---
id: web-frontend-accessibility
title: Web Accessibility
scope: web-frontend
severity: high
tags: [accessibility, wcag, aria, a11y, keyboard, screen-reader, contrast]
references:
  - title: "WCAG 2.2"
    url: https://www.w3.org/TR/WCAG22/
  - title: "WAI-ARIA 1.2"
    url: https://www.w3.org/TR/wai-aria-1.2/
  - title: "WCAG 2.1 — Understanding SC 1.3.1 Info and Relationships"
    url: https://www.w3.org/WAI/WCAG21/Understanding/info-and-relationships.html
---

## Principle

The web is for everyone. Accessibility is not an afterthought or a compliance checkbox — it is a core quality attribute that determines whether people can use what you build. One billion people worldwide live with disabilities. Inaccessible software excludes them.

AI-generated frontend code routinely produces `div` soup with click handlers instead of semantic HTML, missing alt text, broken keyboard navigation, and no focus management. These failures lock out screen reader users, keyboard-only users, and people with motor or visual impairments. This standard enforces the practices that make web applications usable by everyone.

## Rules

### Semantic Structure

1. **Use semantic HTML elements.** Use `button`, `nav`, `main`, `header`, `footer`, `article`, `section`, `aside`, `form`, `label` instead of generic `div` and `span`. Semantic elements convey meaning to assistive technology without extra ARIA. A `div` with a click handler is not a button — it has no role, no keyboard support, and no accessible name. (WCAG 1.3.1)

2. **Provide text alternatives for all non-text content.** Every `img` needs a meaningful `alt` attribute. Decorative images use `alt=""`. Icons conveying meaning need `aria-label` or visually hidden text. `svg` elements need `role="img"` and `aria-label` or `title`. (WCAG 1.1.1)

### Keyboard and Focus

3. **Ensure all interactive elements are keyboard accessible.** Every clickable element must be focusable and activatable via keyboard. Use native interactive elements (`button`, `a`, `input`) — they get keyboard support for free. If a `div` or `span` must be interactive: add `role`, `tabindex="0"`, and keyboard event handlers for Enter and Space. Never use `tabindex` > 0. (WCAG 2.1.1)

4. **Implement visible focus indicators.** Never set `outline: none` or `outline: 0` without providing an alternative focus style. Focus indicators must have a minimum 3:1 contrast ratio against adjacent colors. Use `:focus-visible` for keyboard-only focus styling. (WCAG 2.4.7)

### Color and Contrast

5. **Maintain sufficient color contrast.** Normal text: minimum 4.5:1 contrast ratio. Large text (18pt+ or 14pt+ bold): minimum 3:1. UI components and graphical objects: minimum 3:1. Never convey information by color alone — add text, icons, or patterns. (WCAG 1.4.3, 1.4.11)

### Forms

6. **Associate form controls with labels.** Every input, select, and textarea must have a programmatically associated `label` (via `for`/`id` or nesting). Group related fields with `fieldset`/`legend`. Provide clear error messages that identify the field and describe the problem. Use `aria-describedby` for additional help text. (WCAG 1.3.1, 3.3.1, 3.3.2)

### Dynamic Content and Focus Management

7. **Manage focus on route changes and dynamic content.** When the page content changes (SPA route change, modal open, toast notification), move focus to the new content or announce it. Use `aria-live` regions for dynamic updates. Focus modals on open, return focus to trigger on close. Implement focus traps in modals and dialogs. (WCAG 2.4.3)

### Motion and Animation

8. **Respect user motion preferences.** Check `prefers-reduced-motion` and disable or reduce animations. Never auto-play video or audio. Provide controls to pause, stop, or hide any moving content. No content should flash more than 3 times per second. (WCAG 2.3.1, 2.3.3)

### Language

9. **Set the document language.** Always set `lang` attribute on the `html` element. Use `lang` attribute on elements that contain content in a different language. This enables screen readers to use the correct pronunciation. (WCAG 3.1.1, 3.1.2)

### Touch Targets

10. **Ensure adequate touch target size.** Interactive targets must be at least 24x24 CSS pixels (WCAG 2.5.8 minimum). Aim for 44x44 pixels for primary actions. Provide adequate spacing between targets to prevent accidental activation. (WCAG 2.5.8)

## Patterns

### Semantic HTML vs Div Soup

#### Do This

```jsx
// Semantic elements convey meaning to assistive technology
function PageLayout({ children }) {
  return (
    <>
      <header>
        <nav aria-label="Main navigation">
          <ul>
            <li><a href="/home">Home</a></li>
            <li><a href="/about">About</a></li>
          </ul>
        </nav>
      </header>
      <main>{children}</main>
      <footer>
        <p>&copy; 2025 Example Corp</p>
      </footer>
    </>
  );
}
```

#### Not This

```jsx
// Div soup — no semantic meaning, invisible to assistive technology
function PageLayout({ children }) {
  return (
    <div>
      <div className="header">
        <div className="nav">
          <div className="nav-item" onClick={() => navigate("/home")}>Home</div>
          <div className="nav-item" onClick={() => navigate("/about")}>About</div>
        </div>
      </div>
      <div className="main">{children}</div>
      <div className="footer">
        <div>&copy; 2025 Example Corp</div>
      </div>
    </div>
  );
}
```

**Why it's wrong:** Screen readers announce `nav`, `main`, `header`, and `footer` as landmarks — users can jump directly to them. A `div` with `className="nav"` is invisible to assistive technology. The clickable `div` elements have no role, no keyboard support, and no accessible name. A keyboard user cannot tab to them or activate them with Enter/Space.

### Image Alt Text

#### Do This

```jsx
// Meaningful alt text describes the image's purpose
<img src="/chart-q4.png" alt="Q4 revenue chart showing 23% growth over Q3" />

// Decorative images use empty alt to be skipped by screen readers
<img src="/decorative-border.png" alt="" />

// SVG with accessible name
<svg role="img" aria-label="Warning icon">
  <path d="..." />
</svg>

// Icon button with accessible label
<button aria-label="Close dialog">
  <svg aria-hidden="true" focusable="false">
    <path d="..." />
  </svg>
</button>
```

#### Not This

```jsx
// Missing alt — screen reader announces the filename
<img src="/chart-q4.png" />

// Redundant alt that adds no information
<img src="/logo.png" alt="image" />

// Decorative image without empty alt — screen reader reads the filename
<img src="/decorative-border.png" />

// SVG with no accessible name
<svg>
  <path d="..." />
</svg>

// Icon button with no accessible label
<button>
  <svg><path d="..." /></svg>
</button>
```

**Why it's wrong:** Without `alt`, a screen reader announces the image filename (e.g., "chart dash q four dot png"), which is meaningless. `alt="image"` adds no information. Decorative images without `alt=""` force screen reader users to listen to irrelevant filenames. SVGs without roles or labels are invisible. Icon-only buttons without `aria-label` have no accessible name — a screen reader user hears "button" with no indication of what it does.

### Keyboard Accessibility

#### Do This

```jsx
// Native button — keyboard accessible by default
<button onClick={handleDelete}>Delete item</button>

// Native link — keyboard accessible by default
<a href="/settings">Settings</a>

// When a non-native element MUST be interactive (rare — prefer native elements)
<div
  role="button"
  tabIndex={0}
  onClick={handleAction}
  onKeyDown={(e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleAction();
    }
  }}
>
  Custom action
</div>
```

#### Not This

```jsx
// Clickable div — not focusable, not keyboard accessible, no role
<div onClick={handleDelete}>Delete item</div>

// Span as link — not focusable, no role, no keyboard support
<span onClick={() => navigate("/settings")} className="link">Settings</span>

// Positive tabindex breaks natural tab order
<button tabIndex={5} onClick={handleAction}>Action</button>
```

**Why it's wrong:** A `div` with only `onClick` cannot be reached by keyboard (no tabindex), has no role (screen reader does not announce it as interactive), and does not respond to Enter or Space. A `tabindex` greater than 0 forces the element to the front of the tab order, breaking the natural reading sequence for keyboard users. Native `button` and `a` elements provide all of this for free.

### Form Labels

#### Do This

```jsx
// Explicit label association via htmlFor/id
<label htmlFor="email-input">Email address</label>
<input id="email-input" type="email" aria-describedby="email-help email-error" />
<span id="email-help">We will never share your email.</span>
{error && <span id="email-error" role="alert">{error}</span>}

// Grouped fields with fieldset/legend
<fieldset>
  <legend>Shipping address</legend>
  <label htmlFor="street">Street</label>
  <input id="street" type="text" />
  <label htmlFor="city">City</label>
  <input id="city" type="text" />
</fieldset>
```

#### Not This

```jsx
// Placeholder is not a label — disappears on input, low contrast, not announced reliably
<input type="email" placeholder="Email address" />

// Label not associated — screen reader does not connect them
<label>Email address</label>
<input type="email" />

// No grouping — screen reader users cannot tell these fields are related
<p>Shipping address</p>
<input type="text" placeholder="Street" />
<input type="text" placeholder="City" />
```

**Why it's wrong:** An input without a programmatically associated label has no accessible name — a screen reader user hears "edit text" with no indication of what to type. Placeholders disappear when the user starts typing and are not reliably announced by all screen readers. Without `htmlFor`/`id` or nesting, the `label` element is visually near the input but not programmatically connected to it. Without `fieldset`/`legend`, related fields have no group context.

### Focus Management in Modals

#### Do This

```jsx
function Modal({ isOpen, onClose, title, children }) {
  const modalRef = useRef(null);
  const triggerRef = useRef(null);

  useEffect(() => {
    if (isOpen) {
      // Store the element that opened the modal
      triggerRef.current = document.activeElement;
      // Move focus into the modal
      modalRef.current?.focus();
    }
    return () => {
      // Return focus to trigger when modal closes
      if (triggerRef.current) {
        triggerRef.current.focus();
      }
    };
  }, [isOpen]);

  // Trap focus inside the modal
  function handleKeyDown(e) {
    if (e.key === "Escape") {
      onClose();
      return;
    }
    if (e.key === "Tab") {
      const focusable = modalRef.current.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="modal-title">{title}</h2>
        {children}
        <button onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
```

#### Not This

```jsx
// No focus management, no keyboard support, no ARIA
function Modal({ isOpen, onClose, children }) {
  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <div className="modal-content">
        {children}
        <span className="close-btn" onClick={onClose}>X</span>
      </div>
    </div>
  );
}
```

**Why it's wrong:** When this modal opens, focus stays wherever it was on the page. A screen reader user does not know the modal appeared. A keyboard user can tab behind the modal into page content they cannot see. There is no Escape key support. The close button is a `span` — not focusable, not keyboard accessible. No `role="dialog"`, no `aria-modal`, no `aria-labelledby` — assistive technology cannot identify this as a modal or find its title.

### Motion Preferences

#### Do This

```css
/* Reduce or remove animations for users who prefer reduced motion */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

```jsx
// Check motion preference in JavaScript for programmatic animations
function useReducedMotion() {
  const [prefersReduced, setPrefersReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = (e) => setPrefersReduced(e.matches);
    mediaQuery.addEventListener("change", handler);
    return () => mediaQuery.removeEventListener("change", handler);
  }, []);

  return prefersReduced;
}

// Usage: skip animation if user prefers reduced motion
function FadeIn({ children }) {
  const prefersReduced = useReducedMotion();

  return (
    <div
      style={{
        opacity: 1,
        transition: prefersReduced ? "none" : "opacity 300ms ease-in",
      }}
    >
      {children}
    </div>
  );
}
```

#### Not This

```jsx
// Ignores motion preferences — forced animation on all users
function FadeIn({ children }) {
  return (
    <div className="animate-fade-in" style={{ animationDuration: "500ms" }}>
      {children}
    </div>
  );
}
```

```css
/* No prefers-reduced-motion check — animations always run */
.animate-fade-in {
  animation: fadeIn 500ms ease-in forwards;
}
```

**Why it's wrong:** People with vestibular disorders (affecting up to 35% of adults over 40) experience dizziness, nausea, and disorientation from screen animations. `prefers-reduced-motion` is a system-level signal that the user has explicitly requested reduced motion. Ignoring it causes physical discomfort and makes the application unusable for these users.

## Exceptions

- **Decorative images may use empty `alt`.** Images that are purely decorative (borders, spacers, background textures) should use `alt=""` so screen readers skip them. This is not an omission — it is the correct treatment for decorative content.
- **Third-party embeds may not be fully controllable.** Embedded iframes (maps, video players, social widgets) from third parties may not meet all accessibility requirements. Provide accessible alternatives where possible (e.g., a text address alongside an embedded map) and document known limitations.
- **Complex visualizations may provide alternative descriptions.** Charts, graphs, data maps, and interactive visualizations may not be fully accessible via ARIA alone. Provide a text summary or data table alternative that conveys the same information. The visualization itself should still have a role, accessible name, and basic keyboard navigation where feasible.

## Cross-References

- [Frontend Structure](web-frontend-structure) — Component organization patterns
- [Frontend Security](web-frontend-security) — CSP considerations for accessibility overlays
