#!/usr/bin/env bun
/**
 * Session Manager HTTP Server
 *
 * Wraps the V2 Agent SDK in a long-running HTTP server exposing A2A-lite endpoints.
 * Supports 5 endpoints, bearer token auth, FIFO request queue, auto-recovery,
 * idle timeout, and graceful shutdown.
 *
 * Usage:
 *   bun session-manager.ts --preset <name> [--cwd <dir>] [--idle-timeout <min>]
 *                          [--allowed-tools <tools>] [--task-timeout <ms>]
 */

import os from 'os';
import path from 'path';
import type { Task, TaskStatus, Message, TaskError, TaskSendRequest } from '../types/a2a-lite.ts';
import type { SessionState, SessionConfig, SessionHealth, SessionStartupOutput } from '../types/session.ts';
import { maskApiKey, readPresets } from './preset-utils.ts';
import { unstable_v2_createSession } from '@anthropic-ai/claude-agent-sdk';
import type { ApiPreset } from '../types/presets.ts';
import { vcpLog, isDebugEnabled } from './vcp-logger.ts';

// ============================================================
// --- V2 Session Env ---
// ============================================================

/** Default per-task timeout: 5 minutes (300s). */
export const DEFAULT_TASK_TIMEOUT_MS = 300_000;

/** Env vars safe to inherit into the Agent SDK subprocess. */
export const ENV_ALLOWLIST = [
  // Cross-platform essentials
  'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL',
  'TMPDIR', 'TEMP', 'TMP',
  // Windows
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'HOMEDRIVE', 'HOMEPATH',
  // Network/proxy (enterprise environments)
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  // TLS/certs
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
];

/**
 * Build the env object for a V2 Agent SDK session from an API preset.
 * Inherits allowlisted host vars + sets provider credentials and model aliases.
 * The env option replaces the entire subprocess env (clean isolation).
 */
export function buildSessionEnv(preset: ApiPreset): Record<string, string> {
  const model = preset.models[0]; // Case-sensitive — passed unmodified
  const env: Record<string, string> = {};

  for (const key of ENV_ALLOWLIST) {
    if (process.env[key]) {
      env[key] = process.env[key]!;
    }
  }

  // Provider credentials + model aliases (override any inherited values)
  env.ANTHROPIC_BASE_URL = preset.base_url;
  env.ANTHROPIC_API_KEY = preset.api_key;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
  env.CLAUDE_CODE_SUBAGENT_MODEL = model;

  return env;
}

/**
 * Mutable reference to the V2 Agent SDK session.
 * Shared between startServer, executeAgentTask, attemptRespawn, and shutdown.
 */
export interface SessionRef {
  session: any;
}

/**
 * Collect the result from a V2 session stream with wall-clock timeout.
 *
 * Uses Promise.race so timeout fires even if stream() yields nothing.
 * On timeout, session.close() kills the orphaned stream consumer.
 */
export async function collectSessionResult(
  session: any,
  timeoutMs: number = DEFAULT_TASK_TIMEOUT_MS,
): Promise<{ result: string | null; error: string | null; timedOut?: boolean }> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  type CollectResult = { result: string | null; error: string | null; timedOut?: boolean };

  async function inner(): Promise<CollectResult> {
    for await (const msg of session.stream()) {
      if (msg.type === 'result') {
        if (msg.subtype === 'success') {
          return { result: msg.result, error: null };
        } else {
          return { result: null, error: `${msg.subtype}: ${(msg as any).errors?.join(', ') || 'unknown'}` };
        }
      }
    }
    return { result: null, error: 'stream ended without result message' };
  }

  const timeout = new Promise<CollectResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({ result: null, error: `task timed out after ${timeoutMs / 1000}s`, timedOut: true });
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([inner(), timeout]);
    if (result.timedOut) {
      try { session.close(); } catch { /* already closed or errored */ }
    }
    return result;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

// ============================================================
// --- Auth ---
// ============================================================

/**
 * Generate a cryptographically random 32-byte bearer token (base64url encoded).
 * Result is a 43-character base64url string.
 */
export function generateToken(): string {
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  return Buffer.from(tokenBytes).toString('base64url');
}

/**
 * Validate the Authorization: Bearer <token> header using constant-time comparison.
 * Returns true if the provided token matches the expected token.
 */
export function validateToken(req: Request, expectedToken: string): boolean {
  const auth = req.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return false;
  const providedStr = auth.slice(7);
  // Constant-time comparison to prevent timing attacks
  const provided = Buffer.from(providedStr);
  const expected = Buffer.from(expectedToken);
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

/**
 * Create a 401 Unauthorized JSON response.
 */
export function createAuthError(): Response {
  const body: { error: TaskError } = {
    error: { code: 'UNAUTHORIZED', message: 'Invalid or missing bearer token' },
  };
  return new Response(JSON.stringify(body), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ============================================================
// --- Task Queue ---
// ============================================================

/**
 * FIFO async mutex that serializes concurrent requests.
 * Ensures V2 Agent SDK sessions process one task at a time.
 */
export class TaskQueue {
  readonly queue: Array<{ resolve: () => void }> = [];
  running = false;

  async acquire(): Promise<void> {
    if (!this.running) {
      this.running = true;
      return;
    }
    return new Promise<void>(resolve => this.queue.push({ resolve }));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next.resolve();
    } else {
      this.running = false;
    }
  }
}

/**
 * Acquire the queue with a timeout.
 * Returns false if the timeout expires before acquisition.
 *
 * On timeout, the waiter is removed from the queue so it cannot
 * stall future callers — prevents deadlock under load.
 */
export async function acquireWithTimeout(queue: TaskQueue, timeoutMs: number): Promise<boolean> {
  // Fast path: lock is free
  if (!queue.running) {
    queue.running = true;
    return true;
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;

    const entry = {
      resolve: () => {
        if (!settled) {
          settled = true;
          resolve(true);
        }
      },
    };

    queue.queue.push(entry);

    setTimeout(() => {
      if (!settled) {
        settled = true;
        // Remove from queue so it does not stall future releases
        const idx = queue.queue.indexOf(entry);
        if (idx !== -1) queue.queue.splice(idx, 1);
        resolve(false);
      }
    }, timeoutMs);
  });
}

// ============================================================
// --- Route Handlers ---
// ============================================================

// In-memory task store
const tasks = new Map<string, Task>();

/**
 * Mutable reference used to track the currently active task execution promise.
 * shutdown() uses this to drain in-flight work before exiting (AC25, AC29).
 */
export interface DrainRef {
  promise: Promise<void> | null;
}

/**
 * POST /tasks/send — Create and execute a new task.
 */
export async function handleTaskSend(
  req: Request,
  state: SessionState,
  queue: TaskQueue,
  config: SessionConfig,
  drainRef?: DrainRef,
  sessionRef?: SessionRef,
  debugEnabled: boolean = false,
): Promise<Response> {
  // Health gate: reject when session is not ready
  if (state.health !== 'ready') {
    return jsonResponse(
      { error: { code: 'SERVICE_UNAVAILABLE', message: `Session is ${state.health}` } },
      503
    );
  }

  // Validate request body size (10MB max)
  const contentLength = req.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > 10 * 1024 * 1024) {
    return jsonResponse({ error: { code: 'REQUEST_TOO_LARGE', message: 'Request body exceeds 10MB limit' } }, 413);
  }

  let body: TaskSendRequest;
  try {
    const text = await req.text();
    if (text.length > 10 * 1024 * 1024) {
      return jsonResponse({ error: { code: 'REQUEST_TOO_LARGE', message: 'Request body exceeds 10MB limit' } }, 413);
    }
    body = JSON.parse(text) as TaskSendRequest;
  } catch {
    return jsonResponse({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } }, 400);
  }

  // Validate message structure
  if (!body.message || typeof body.message !== 'object') {
    return jsonResponse({ error: { code: 'INVALID_REQUEST', message: 'Request must include a message object' } }, 400);
  }
  if (!body.message.role || !Array.isArray(body.message.parts)) {
    return jsonResponse({ error: { code: 'INVALID_REQUEST', message: 'Message must have role and parts array' } }, 400);
  }
  if (body.message.role !== 'user' && body.message.role !== 'agent') {
    return jsonResponse({ error: { code: 'INVALID_REQUEST', message: 'Message role must be "user" or "agent"' } }, 400);
  }

  // Validate each message part per A2A-lite schema (AC21)
  for (const part of body.message.parts) {
    // Cast through unknown so TypeScript allows runtime property inspection of untrusted JSON
    const p = part as unknown as Record<string, unknown>;
    if (!p || typeof p.type !== 'string') {
      return jsonResponse({ error: { code: 'INVALID_REQUEST', message: 'Each part must have a type field' } }, 400);
    }
    switch (p.type) {
      case 'text':
        if (typeof p.text !== 'string') {
          return jsonResponse({ error: { code: 'INVALID_REQUEST', message: 'TextPart requires text string' } }, 400);
        }
        break;
      case 'data':
        if (typeof p.mimeType !== 'string' || typeof p.data !== 'string') {
          return jsonResponse({ error: { code: 'INVALID_REQUEST', message: 'DataPart requires mimeType and data strings' } }, 400);
        }
        break;
      case 'file':
        if (typeof p.name !== 'string' || typeof p.bytes !== 'string') {
          return jsonResponse({ error: { code: 'INVALID_REQUEST', message: 'FilePart requires name and bytes strings' } }, 400);
        }
        break;
      default:
        return jsonResponse({ error: { code: 'INVALID_REQUEST', message: `Unknown part type: ${p.type}` } }, 400);
    }
  }

  const taskId = crypto.randomUUID();
  const now = new Date().toISOString();
  const task: Task = {
    id: taskId,
    status: 'submitted',
    messages: [body.message],
    created_at: now,
    updated_at: now,
  };
  tasks.set(taskId, task);

  // Acquire FIFO queue — wait up to 5 minutes
  const acquired = await acquireWithTimeout(queue, 5 * 60 * 1000);
  if (!acquired) {
    task.status = 'failed';
    task.error = { code: 'QUEUE_TIMEOUT', message: 'Request timed out waiting for queue' };
    task.updated_at = new Date().toISOString();
    return jsonResponse({ task }, 408);
  }

  // Re-check health after queue acquisition — session may have died while we waited
  if (state.health !== 'ready') {
    queue.release();
    task.status = 'failed';
    task.error = { code: 'SERVICE_UNAVAILABLE', message: `Session became ${state.health} while queued` };
    task.updated_at = new Date().toISOString();
    return jsonResponse({ task }, 503);
  }

  // Track the execution promise in drainRef so shutdown() can wait for it (AC25, AC29)
  const executionPromise = (async () => {
    try {
      task.status = 'working';
      task.updated_at = new Date().toISOString();
      state.task_count += 1;

      // Execute via V2 Agent SDK session
      const result = await executeAgentTask(body.message, config, sessionRef!, debugEnabled);

      // AC23: Only update status if task wasn't canceled while executing.
      // Canceled is a terminal state — don't overwrite it.
      // Cast needed: TS narrows to 'working' but cancel handler mutates concurrently.
      const currentStatus = task.status as string;
      if (currentStatus !== 'canceled') {
        task.status = 'completed';
        task.result = result;
        task.updated_at = new Date().toISOString();
      }
    } catch (err) {
      const errorId = crypto.randomUUID();
      const errorMessage = err instanceof Error ? err.message : 'unknown error';
      console.error(`[ERROR] Task ${taskId} failed (error_id: ${errorId}):`, err);
      await vcpLog(config.cwd || process.cwd(), {
        source: 'session-manager', event: 'task_failed', decision: 'error',
        details: `task=${taskId} error_id=${errorId} error=${errorMessage}`,
      }, debugEnabled);
      // AC23: Don't overwrite canceled status on error either
      const errStatus = task.status as string;
      if (errStatus !== 'canceled') {
        task.status = 'failed';
        task.error = { code: 'EXECUTION_ERROR', message: 'Internal error', error_id: errorId };
        task.updated_at = new Date().toISOString();
      }
      // AC27: Transition health to dead and schedule async respawn (non-blocking)
      const failReason = err instanceof Error ? err.message : 'task execution failed';
      transitionHealth(state, 'dead', failReason);
      if (sessionRef) {
        setTimeout(() => {
          attemptRespawn(state, config, sessionRef, debugEnabled).then(newHealth => {
            transitionHealth(state, newHealth, 'respawn result');
          }).catch(respawnErr => {
            console.error('[Session] Unexpected error during respawn attempt:', respawnErr);
            transitionHealth(state, 'failed', 'respawn threw unexpectedly');
          });
        }, 1000);
      }
    } finally {
      queue.release();
      if (drainRef) drainRef.promise = null;
    }
  })();

  if (drainRef) drainRef.promise = executionPromise;
  await executionPromise;

  state.last_activity_at = new Date().toISOString();
  return jsonResponse({ task });
}

/**
 * Execute a task via the persistent V2 Agent SDK session.
 * Dispatches prompt via session.send(), collects result with timeout.
 */
async function executeAgentTask(
  message: Message,
  config: SessionConfig,
  sessionRef: SessionRef,
  debugEnabled: boolean,
): Promise<Message> {
  const textParts = message.parts.filter(p => p.type === 'text') as Array<{ type: 'text'; text: string }>;
  const prompt = textParts.map(p => p.text).join('\n');
  const logRoot = config.cwd || process.cwd();

  const truncatedPrompt = prompt.length > 4096 ? prompt.slice(0, 4096) + '…[truncated]' : prompt;
  await vcpLog(logRoot, {
    source: 'session-manager', event: 'task_dispatch', decision: 'info',
    details: `prompt_length=${prompt.length}\n--- REQUEST ---\n${truncatedPrompt}\n--- END REQUEST ---`,
  }, debugEnabled);

  await sessionRef.session.send(prompt);
  const result = await collectSessionResult(
    sessionRef.session,
    config.task_timeout_ms ?? DEFAULT_TASK_TIMEOUT_MS,
  );

  if (result.error) {
    throw new Error(`V2 session error: ${result.error}`);
  }

  const resultText = result.result ?? '';
  const truncatedResult = resultText.length > 4096 ? resultText.slice(0, 4096) + '…[truncated]' : resultText;
  await vcpLog(logRoot, {
    source: 'session-manager', event: 'task_completed', decision: 'info',
    details: `result_length=${resultText.length}\n--- RESPONSE ---\n${truncatedResult}\n--- END RESPONSE ---`,
  }, debugEnabled);

  return { role: 'agent', parts: [{ type: 'text', text: result.result ?? '' }] };
}

/**
 * GET /tasks/:id — Retrieve task status.
 */
export function handleTaskStatus(taskId: string): Response {
  const task = tasks.get(taskId);
  if (!task) {
    return jsonResponse({ error: { code: 'TASK_NOT_FOUND', message: `Task not found: ${taskId}` } }, 404);
  }
  return jsonResponse({ task });
}

/**
 * POST /tasks/:id/cancel — Cancel a running task.
 */
export function handleTaskCancel(taskId: string): Response {
  const task = tasks.get(taskId);
  if (!task) {
    return jsonResponse({ error: { code: 'TASK_NOT_FOUND', message: `Task not found: ${taskId}` } }, 404);
  }

  const terminalStates: TaskStatus[] = ['completed', 'failed', 'canceled', 'rejected'];
  if (terminalStates.includes(task.status)) {
    return jsonResponse(
      { error: { code: 'TASK_ALREADY_TERMINAL', message: `Task is already in terminal state: ${task.status}` } },
      409
    );
  }

  task.status = 'canceled';
  task.updated_at = new Date().toISOString();
  return jsonResponse({ task });
}

/**
 * GET /status — Return session health.
 */
export function handleStatus(state: SessionState): Response {
  const now = Date.now();
  const startedAt = new Date(state.started_at).getTime();
  state.uptime_ms = now - startedAt;

  return jsonResponse({
    health: state.health,
    uptime_ms: state.uptime_ms,
    task_count: state.task_count,
    started_at: state.started_at,
    last_activity_at: state.last_activity_at,
  });
}

/**
 * POST /shutdown — Stop the server.
 */
export function handleShutdown(triggerShutdown: () => void): Response {
  // Schedule shutdown after response is sent
  setTimeout(triggerShutdown, 100);
  return jsonResponse({ status: 'shutting_down', message: 'Server is shutting down' });
}

/**
 * Helper to create JSON responses.
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ============================================================
// --- Session Lifecycle ---
// ============================================================

/**
 * Check if a respawn is allowed given the sliding window rate limit.
 * Allows up to maxCount respawns within windowMs milliseconds.
 */
export function canRespawn(timestamps: number[], windowMs: number, maxCount: number): boolean {
  const now = Date.now();
  const recent = timestamps.filter(t => now - t < windowMs);
  return recent.length < maxCount;
}

const RESPAWN_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const RESPAWN_MAX_COUNT = 3;

/**
 * Attempt to respawn the V2 session after a 'dead' state.
 * Closes the dead session, re-reads the preset, creates a new session, warms it up.
 * Returns the new health state.
 */
export async function attemptRespawn(
  state: SessionState,
  config: SessionConfig,
  sessionRef?: SessionRef,
  debugEnabled: boolean = false,
): Promise<SessionHealth> {
  if (!canRespawn(state.respawn_timestamps, RESPAWN_WINDOW_MS, RESPAWN_MAX_COUNT)) {
    console.error('[Session] Respawn rate limit exceeded — transitioning to failed');
    return 'failed';
  }

  state.respawn_timestamps.push(Date.now());
  console.error('[Session] Attempting respawn...');

  try {
    // Close the dead session (if any)
    if (sessionRef?.session) {
      try { sessionRef.session.close(); } catch { /* already closed */ }
      sessionRef.session = null;
    }

    // Re-read preset (may have been updated)
    const presets = readPresets();
    const preset = presets.presets[config.preset_name];
    if (!preset) {
      console.error(`[Session] Preset not found: ${config.preset_name} — transitioning to failed (no respawn)`);
      return 'failed';
    }

    if (preset.type === 'api' && sessionRef) {
      console.error(`[Session] Recreating V2 session with key: ${maskApiKey(preset.api_key)}`);
      const env = buildSessionEnv(preset);
      sessionRef.session = unstable_v2_createSession({
        model: preset.models[0],
        env,
        permissionMode: 'default',
        allowedTools: config.allowed_tools?.split(',')
          ?? ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash'],
      });
      // Warmup the new session
      await sessionRef.session.send('Respond with OK');
      const warmupResult = await collectSessionResult(
        sessionRef.session, config.task_timeout_ms ?? DEFAULT_TASK_TIMEOUT_MS,
      );
      if (warmupResult.error) {
        console.error(`[Session] Respawn warmup failed: ${warmupResult.error}`);
        await vcpLog(config.cwd || process.cwd(), {
          source: 'session-manager', event: 'respawn_warmup_failed', decision: 'error',
          details: warmupResult.error,
        }, debugEnabled);
        return 'failed';
      }
      await vcpLog(config.cwd || process.cwd(), {
        source: 'session-manager', event: 'respawn_success', decision: 'info',
        details: `model=${preset.models[0]}`,
      }, debugEnabled);
    } else if (preset.type === 'api') {
      console.error(`[Session] Using API preset with key: ${maskApiKey(preset.api_key)}`);
    }

    return 'ready';
  } catch (err) {
    console.error('[Session] Respawn failed with config/auth error — transitioning to failed:', err);
    return 'failed';
  }
}

/**
 * Transition session health and log the change.
 */
export function transitionHealth(state: SessionState, newHealth: SessionHealth, reason?: string): void {
  const prev = state.health;
  state.health = newHealth;
  state.last_activity_at = new Date().toISOString();
  console.error(`[Session] Health transition: ${prev} -> ${newHealth}${reason ? ` (${reason})` : ''}`);
}

/**
 * Reset the idle timer, clearing the previous one.
 */
export function resetIdleTimer(
  currentTimer: ReturnType<typeof setTimeout> | null,
  callback: () => void,
  timeoutMs: number
): ReturnType<typeof setTimeout> {
  if (currentTimer !== null) {
    clearTimeout(currentTimer);
  }
  return setTimeout(callback, timeoutMs);
}

// ============================================================
// --- CLI Argument Parsing ---
// ============================================================

/**
 * Parse CLI arguments from process.argv.
 */
export function parseCLIArgs(argv: string[]): SessionConfig {
  const args = argv.slice(2); // Remove 'bun' and script path
  const result: Partial<SessionConfig> = {
    idle_timeout_minutes: 60,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--preset':
        if (!next) throw new Error('--preset requires a value');
        result.preset_name = next;
        i++;
        break;
      case '--cwd':
        if (!next) throw new Error('--cwd requires a value');
        result.cwd = next;
        i++;
        break;
      case '--idle-timeout':
        if (!next) throw new Error('--idle-timeout requires a value');
        result.idle_timeout_minutes = parseInt(next, 10);
        if (isNaN(result.idle_timeout_minutes) || result.idle_timeout_minutes <= 0) {
          throw new Error('--idle-timeout must be a positive integer');
        }
        i++;
        break;
      case '--allowed-tools':
        if (!next) throw new Error('--allowed-tools requires a value');
        result.allowed_tools = next;
        i++;
        break;
      case '--task-timeout':
        if (!next) throw new Error('--task-timeout requires a value');
        result.task_timeout_ms = parseInt(next, 10);
        if (isNaN(result.task_timeout_ms) || result.task_timeout_ms <= 0) {
          throw new Error('--task-timeout must be a positive integer (milliseconds)');
        }
        i++;
        break;
    }
  }

  if (!result.preset_name) {
    throw new Error('--preset is required. Usage: bun session-manager.ts --preset <name>');
  }

  return result as SessionConfig;
}

// ============================================================
// --- Main ---
// ============================================================

/**
 * Start the session manager HTTP server.
 */
export async function startServer(config: SessionConfig): Promise<void> {
  const TOKEN = generateToken();
  const queue = new TaskQueue();

  const state: SessionState = {
    health: 'starting',
    uptime_ms: 0,
    started_at: new Date().toISOString(),
    last_activity_at: new Date().toISOString(),
    task_count: 0,
    respawn_timestamps: [],
  };

  // Load preset
  let resolvedPreset: import('../types/presets.ts').Preset | undefined;
  try {
    const presets = readPresets();
    resolvedPreset = presets.presets[config.preset_name];
    if (!resolvedPreset) {
      console.error(`[Session] Preset not found: ${config.preset_name}`);
      process.exit(1);
    }
    if (resolvedPreset.type === 'api') {
      console.error(`[Session] Using API preset, masked key: ${maskApiKey(resolvedPreset.api_key)}`);
    }
  } catch (err) {
    console.error('[Session] Failed to load preset config:', err);
    process.exit(1);
  }

  const debugEnabled = await isDebugEnabled();
  const sessionRef: SessionRef = { session: null };

  const idleTimeoutMs = config.idle_timeout_minutes * 60 * 1000;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  // Drain reference: tracks the currently executing agent task promise.
  // shutdown() waits up to 30s for in-flight work before exiting (AC25, AC29).
  const drainRef: DrainRef = { promise: null };

  let shutdownRequested = false;

  function shutdown(): void {
    if (shutdownRequested) return;
    shutdownRequested = true;
    console.error('[Session] Shutting down gracefully...');
    if (idleTimer) clearTimeout(idleTimer);
    // Close V2 session
    if (sessionRef.session) {
      try { sessionRef.session.close(); } catch { /* already closed */ }
      sessionRef.session = null;
    }
    server.stop();
    // Drain in-flight task (wait up to 30s) before exiting
    const drain = drainRef.promise
      ? Promise.race([drainRef.promise, new Promise<void>(r => setTimeout(r, 30_000))])
      : Promise.resolve();
    drain.then(() => process.exit(0)).catch(() => process.exit(0));
  }

  function resetIdle(): void {
    idleTimer = resetIdleTimer(idleTimer, () => {
      console.error('[Session] Idle timeout expired — shutting down');
      shutdown();
    }, idleTimeoutMs);
  }

  // Graceful shutdown on signals
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  const server = Bun.serve({
    port: 0, // OS-assigned port (C7)
    async fetch(req: Request): Promise<Response> {
      // Authenticate all requests
      if (!validateToken(req, TOKEN)) {
        return createAuthError();
      }

      resetIdle();
      state.last_activity_at = new Date().toISOString();

      const url = new URL(req.url);
      const pathname = url.pathname;

      try {
        // Route matching
        if (req.method === 'POST' && pathname === '/tasks/send') {
          return await handleTaskSend(req, state, queue, config, drainRef, sessionRef, debugEnabled);
        }

        if (req.method === 'GET' && pathname.startsWith('/tasks/')) {
          const taskId = pathname.slice('/tasks/'.length);
          if (taskId && !taskId.includes('/')) {
            return handleTaskStatus(taskId);
          }
        }

        if (req.method === 'POST' && pathname.startsWith('/tasks/') && pathname.endsWith('/cancel')) {
          const taskId = pathname.slice('/tasks/'.length, -'/cancel'.length);
          if (taskId) {
            return handleTaskCancel(taskId);
          }
        }

        if (req.method === 'GET' && pathname === '/status') {
          return handleStatus(state);
        }

        if (req.method === 'POST' && pathname === '/shutdown') {
          return handleShutdown(shutdown);
        }

        return jsonResponse({ error: { code: 'NOT_FOUND', message: 'Endpoint not found' } }, 404);
      } catch (err) {
        // Global error handler — sanitized response (CWE-209)
        const errorId = crypto.randomUUID();
        console.error(`[ERROR] Unhandled error (error_id: ${errorId}):`, err);
        return jsonResponse(
          { error: { code: 'INTERNAL_ERROR', message: 'Internal error', error_id: errorId } },
          500
        );
      }
    },
  });

  // Create + warmup V2 session for API presets BEFORE emitting startup output
  if (resolvedPreset!.type === 'api') {
    const env = buildSessionEnv(resolvedPreset as ApiPreset);
    sessionRef.session = unstable_v2_createSession({
      model: (resolvedPreset as ApiPreset).models[0],
      env,
      permissionMode: 'default',
      allowedTools: config.allowed_tools?.split(',')
        ?? ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash'],
    });
    // Warmup — blocks until session is live
    await sessionRef.session.send('Respond with OK');
    const warmupResult = await collectSessionResult(
      sessionRef.session, config.task_timeout_ms ?? DEFAULT_TASK_TIMEOUT_MS,
    );
    if (warmupResult.error) {
      console.error(`[Session] Warmup failed: ${warmupResult.error}`);
      await vcpLog(config.cwd || process.cwd(), {
        source: 'session-manager', event: 'warmup_failed', decision: 'error',
        details: warmupResult.error,
      }, debugEnabled);
      process.exit(1);
    }
    transitionHealth(state, 'ready', 'V2 session warmed up');
    await vcpLog(config.cwd || process.cwd(), {
      source: 'session-manager', event: 'session_ready', decision: 'info',
      details: `model=${(resolvedPreset as ApiPreset).models[0]} base_url=${(resolvedPreset as ApiPreset).base_url}`,
    }, debugEnabled);
  } else {
    transitionHealth(state, 'ready', 'server started');
  }

  // Start idle timer
  resetIdle();

  // ONLY NOW emit startup output — caller knows session is ready
  const startupOutput: SessionStartupOutput = {
    status: 'ready',
    port: server.port as number,
    token: TOKEN,
  };
  console.log(JSON.stringify(startupOutput));
}

// Entry point
if (import.meta.main) {
  try {
    const config = parseCLIArgs(process.argv);
    await startServer(config);
  } catch (err) {
    if (err instanceof Error) {
      console.error(`[Session Manager] Error: ${err.message}`);
    } else {
      console.error('[Session Manager] Unknown error:', err);
    }
    process.exit(1);
  }
}
