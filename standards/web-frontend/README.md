# Web Frontend Standards

Standards for client-side web development — browser-based applications, SPAs, and component-driven UIs. These build on [core standards](../core/README.md) with frontend-specific guidance.

Load these when the project contains frontend code (React, Vue, Svelte, Angular, or plain HTML/CSS/JS).

## Standards

| Standard | What It Covers |
|----------|---------------|
| [Structure](structure.md) | Component organization, state management patterns, folder conventions, component size thresholds. |
| [Security](security.md) | XSS prevention, CSRF defense (SameSite + tokens), auth token handling, CSP, CORS, URL validation, safe redirects. |
| [Performance](performance.md) | Bundle discipline, lazy loading, code splitting, rendering optimization, asset management. |

## File Naming Convention

Standard files use kebab-case: `structure.md`, `security.md`, `performance.md`.

Each file follows the format spec defined in [`standards/README.md`](../README.md).
