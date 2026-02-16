---
id: web-backend-realtime
title: Realtime Communication Security
scope: web-backend
severity: high
tags: [websocket, sse, realtime, streaming, connection-management, cwe]
references:
  - title: "CWE-1385 — Missing Origin Validation in WebSockets"
    url: https://cwe.mitre.org/data/definitions/1385.html
  - title: "OWASP — WebSocket Security"
    url: https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html#websockets
  - title: "RFC 6455 — The WebSocket Protocol"
    url: https://www.rfc-editor.org/rfc/rfc6455
---

## Principle

Realtime connections are long-lived, stateful, and bidirectional — they amplify every security mistake. A single unauthenticated WebSocket can consume server resources for hours. A single unvalidated message can corrupt shared state across all connected clients. Apply the same rigor to WebSocket and SSE connections that you apply to HTTP endpoints: authenticate before connecting, authorize every action, validate every message, and plan for abuse at scale.

## Rules

### WebSocket Security

1. **Authenticate on the WebSocket upgrade request.** Validate authentication tokens (JWT, session cookie) during the HTTP upgrade handshake, before the WebSocket connection is established. Do not defer auth to the first WebSocket message — unauthenticated connections consume server resources and can be abused.

2. **Re-validate authorization per message.** A user's permissions can change during a long-lived connection. Check authorization for each message that accesses or modifies resources. Do not cache auth decisions for the lifetime of the connection.

3. **Validate the Origin header on upgrade requests.** Check that the `Origin` header matches your allowed origins. Without this, any website the user visits can open a WebSocket to your server using the user's cookies — this is Cross-Site WebSocket Hijacking (CSWSH). (CWE-1385)

4. **Validate and schema-check every incoming message.** Define a strict schema for each message type (JSON Schema, Zod, protobuf). Reject messages that don't conform. Enforce maximum message size and maximum JSON nesting depth. Malformed messages must not crash the handler.

5. **Rate-limit messages per connection and per user.** Set a maximum messages-per-second rate for each connection. Disconnect clients that exceed the limit. Without rate limiting, a single malicious client can flood the server with messages.

6. **Set connection limits and enforce heartbeats.** Limit the maximum number of concurrent connections per user and globally. Implement ping/pong heartbeats to detect dead connections. Close idle connections after a timeout. Set maximum message size at the WebSocket server level.

7. **Handle backpressure.** If the server sends messages faster than the client can consume them, the buffer grows unbounded and the server runs out of memory. Monitor send buffer size. Drop non-critical messages or disconnect slow clients. Never assume the client is keeping up.

### Client-Side WebSocket

8. **Implement reconnection with exponential backoff and jitter.** When a WebSocket disconnects, reconnect with exponential backoff (e.g., 1s, 2s, 4s, 8s... capped at 30s) plus random jitter. Without jitter, all clients reconnect simultaneously after an outage, creating a thundering herd that crashes the server again. Always use `wss://` (TLS). Clean up event listeners and close connections on component unmount.

### Server-Sent Events (SSE)

9. **Use event IDs for resumption and set retry intervals.** Include `id:` fields in SSE events so clients can resume from the last received event via `Last-Event-ID`. Set the `retry:` field to control reconnection timing. Be aware of the browser's 6-connection-per-domain limit with HTTP/1.1 — use HTTP/2 or a dedicated SSE subdomain.

10. **Authenticate SSE connections and sanitize event data.** SSE uses standard HTTP, so authenticate via cookies or bearer tokens. Apply CSRF protection since SSE is initiated by the browser. Never include unsanitized user content in SSE `data:` fields — it can lead to XSS if the client injects data into the DOM without escaping.

## Patterns

### WebSocket Auth on Upgrade

#### Do This

```javascript
// Authenticate during the HTTP upgrade handshake (Node.js + ws)
const WebSocket = require("ws");
const jwt = require("jsonwebtoken");

const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  // Extract token from query string or cookie
  const url = new URL(request.url, "http://localhost");
  const token = url.searchParams.get("token");

  if (!token) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  const jwtSecret = process.env.JWT_SECRET;
  try {
    const user = jwt.verify(token, jwtSecret);
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.user = user;
      wss.emit("connection", ws, request);
    });
  } catch (err) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
  }
});
```

#### Not This

```javascript
// No auth on upgrade — any client can connect (VULNERABLE)
const wss = new WebSocket.Server({ port: 8080 });

wss.on("connection", (ws) => {
  // Auth deferred to first message — connection already open
  ws.on("message", (data) => {
    const msg = JSON.parse(data);
    if (msg.type === "auth") {
      // Too late — unauthenticated connection already consuming resources
      ws.user = validateToken(msg.token);
    }
  });
});
```

**Why it's wrong:** The WebSocket connection is fully established before any authentication occurs. An attacker can open thousands of unauthenticated connections to exhaust server resources. The server has no way to distinguish legitimate clients from attackers until they send a message — which they may never do.

### Origin Validation

#### Do This

```javascript
// Validate Origin header during upgrade (CWE-1385)
const ALLOWED_ORIGINS = new Set([
  "https://app.example.com",
  "https://staging.example.com",
]);

server.on("upgrade", (request, socket, head) => {
  const origin = request.headers.origin;

  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }

  // Proceed with authentication and upgrade...
});
```

#### Not This

```javascript
// No Origin check — any website can connect using the user's cookies (CWE-1385)
server.on("upgrade", (request, socket, head) => {
  // Origin header ignored — Cross-Site WebSocket Hijacking possible
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});
```

**Why it's wrong:** Without Origin validation, a malicious page at `https://evil.com` can open a WebSocket to your server. If the user is logged in and auth uses cookies, the browser automatically attaches them. The attacker's page now has a fully authenticated WebSocket connection to your server — Cross-Site WebSocket Hijacking.

### Message Schema Validation

#### Do This

```javascript
// Strict message validation with Zod
const { z } = require("zod");

const ChatMessage = z.object({
  type: z.literal("chat"),
  channel: z.string().max(64).regex(/^[a-zA-Z0-9_-]+$/),
  content: z.string().min(1).max(2000),
});

const TypingMessage = z.object({
  type: z.literal("typing"),
  channel: z.string().max(64).regex(/^[a-zA-Z0-9_-]+$/),
});

const IncomingMessage = z.discriminatedUnion("type", [
  ChatMessage,
  TypingMessage,
]);

const MAX_MESSAGE_SIZE = 8192; // 8 KB

ws.on("message", (raw) => {
  // Enforce size limit before parsing
  if (raw.length > MAX_MESSAGE_SIZE) {
    ws.send(JSON.stringify({ error: "Message too large" }));
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    ws.send(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  const result = IncomingMessage.safeParse(parsed);
  if (!result.success) {
    ws.send(JSON.stringify({ error: "Invalid message format" }));
    return;
  }

  // result.data is typed and validated
  handleMessage(ws, result.data);
});
```

#### Not This

```javascript
// No validation — trusts client-sent data directly (VULNERABLE)
ws.on("message", (raw) => {
  const msg = JSON.parse(raw); // Crashes on invalid JSON
  if (msg.type === "chat") {
    // No size limit, no format check, no field validation
    broadcast(msg.channel, msg.content);
  }
});
```

**Why it's wrong:** The handler crashes on malformed JSON (denial of service). There is no size limit, so a client can send a 100MB message. There is no schema validation, so `msg.channel` could be `"../../admin"` and `msg.content` could be a 10GB string. The data propagates through the system untrusted.

### Reconnection with Exponential Backoff and Jitter

#### Do This

```javascript
// Client-side: reconnect with exponential backoff + jitter
function createReliableWebSocket(url) {
  let ws = null;
  let attempt = 0;
  const BASE_DELAY_MS = 1000;
  const MAX_DELAY_MS = 30000;
  let disposed = false;

  function connect() {
    if (disposed) return;

    ws = new WebSocket(url);

    ws.addEventListener("open", () => {
      attempt = 0; // Reset on successful connection
    });

    ws.addEventListener("close", (event) => {
      if (disposed) return;
      if (event.code === 1000) return; // Normal closure, do not reconnect

      scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // Error is always followed by close — reconnect handled there
    });
  }

  function scheduleReconnect() {
    const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
    const jitter = delay * (0.5 + Math.random() * 0.5);
    attempt++;

    setTimeout(connect, jitter);
  }

  function dispose() {
    disposed = true;
    if (ws) {
      ws.close(1000, "Client closing");
      ws = null;
    }
  }

  connect();

  return { getSocket: () => ws, dispose };
}

// Clean up on component unmount
const connection = createReliableWebSocket("wss://api.example.com/ws");
// On unmount:
connection.dispose();
```

#### Not This

```javascript
// Immediate reconnect with no backoff — thundering herd (VULNERABLE)
function connect() {
  const ws = new WebSocket("wss://api.example.com/ws");

  ws.addEventListener("close", () => {
    // Reconnect immediately — all clients hit the server at once
    connect();
  });
}
```

**Why it's wrong:** When the server goes down, every client reconnects immediately and simultaneously. This creates a thundering herd — thousands of connections arriving at the same instant, which can crash the server again before it finishes starting up. Exponential backoff spreads reconnections over time. Jitter prevents clients that disconnected at the same time from reconnecting at the same time.

### SSE Event IDs for Resumption

#### Do This

```javascript
// Server: include event IDs for client resumption (Node.js)
const express = require("express");
const app = express();

app.get("/events", authenticate, (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Check if client is resuming from a previous connection
  const lastEventId = req.headers["last-event-id"];
  if (lastEventId) {
    // Send any events the client missed since lastEventId
    const missed = getEventsSince(lastEventId);
    for (const event of missed) {
      res.write(`id: ${event.id}\n`);
      res.write(`data: ${JSON.stringify(event.data)}\n\n`);
    }
  }

  // Set retry interval (milliseconds)
  res.write("retry: 5000\n\n");

  // Send new events as they occur
  const unsubscribe = eventBus.subscribe((event) => {
    res.write(`id: ${event.id}\n`);
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event.data)}\n\n`);
  });

  req.on("close", () => {
    unsubscribe();
  });
});
```

#### Not This

```javascript
// No event IDs — client loses all events on reconnect (BROKEN)
app.get("/events", (req, res) => {
  // No authentication — anyone can read the event stream
  res.writeHead(200, { "Content-Type": "text/event-stream" });

  eventBus.subscribe((event) => {
    // No event ID — client cannot resume on reconnect
    // No retry field — browser uses default (often too aggressive)
    res.write(`data: ${event.data}\n\n`);
  });

  // No cleanup on disconnect — memory leak
});
```

**Why it's wrong:** Without event IDs, clients that reconnect after a network blip lose every event that occurred during the disconnection. There is no way to resume — the client must either miss data or request the full state again. Without cleanup on disconnect, the event listener leaks, and the server accumulates dead subscriptions until it runs out of memory. Without authentication, the event stream is public.

## Exceptions

- **Internal microservice WebSockets on a private network with mTLS** may skip Origin validation since the connection is machine-to-machine and not subject to browser-based CSWSH attacks.
- **Browser-to-browser WebRTC data channels** have their own security model (DTLS, ICE) and are not covered by these WebSocket rules.
- **SSE connections for public event streams** (stock tickers, sports scores, public dashboards) may use lighter authentication. Rate limiting and connection limits still apply.

## Cross-References

- [Backend Security](web-backend-security) — Authentication (R4-6), rate limiting (R13-14)
- [Frontend Security](web-frontend-security) — XSS prevention for rendering SSE data
- [Backend API Design](web-backend-api-design) — Correlation IDs in WebSocket messages
