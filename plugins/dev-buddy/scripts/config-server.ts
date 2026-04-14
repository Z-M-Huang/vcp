#!/usr/bin/env bun
/**
 * Dev Buddy Web Configuration Portal Server
 *
 * REST API for managing AI presets and pipeline config.
 * Serves the Alpine.js SPA from plugins/dev-buddy/web/.
 *
 * Security:
 * - CORS restricted to exact localhost origin (no wildcard, no reflection)
 * - API keys masked by default; reveal endpoint with rate limiting + audit log
 * - Field allowlisting on PUT endpoints (CWE-915)
 * - Sanitized error responses (CWE-209)
 * - List-form browser launch (CWE-78)
 *
 * Usage:
 *   bun config-server.ts [--cwd <dir>] [--idle-timeout <minutes>]
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import net from 'net';
import { readPresets, writePresets, validatePreset, maskApiKey, maskPresetKeys, CONFIG_DIR } from './preset-utils.ts';
import { loadDevBuddyConfig, validateDevBuddyConfig, fetchWithTimeout, atomicWriteFile, CONFIG_PATH as PIPELINE_CONFIG_PATH } from './pipeline-config.ts';
import { discoverSystemPrompts, getSystemPrompt, writeCustomPrompt, deleteCustomPrompt } from './system-prompts.ts';
import { loadChatroomConfig, saveChatroomConfig, validateChatroomConfig, DEFAULT_CHATROOM_CONFIG } from './chatroom-config.ts';
import type { ChatroomConfig } from '../types/chatroom.ts';
import type { Preset } from '../types/presets.ts';
import { STAGE_DEFINITIONS, OPTIONAL_STAGE_TYPES } from '../types/stage-definitions.ts';
import type { StageType } from '../types/stage-definitions.ts';
import type { DevBuddyConfig, StageExecutor } from '../types/pipeline.ts';
import { VALID_STAGE_TYPES, MODEL_NAME_REGEX } from '../types/stage-definitions.ts';

// Allowed fields per preset type for field allowlisting (CWE-915)
const ALLOWED_PRESET_FIELDS: Record<string, Set<string>> = {
  api: new Set(['type', 'name', 'base_url', 'api_key', 'models', 'timeout_ms', 'protocol', 'reasoning_effort', 'max_output_tokens', 'max_context_tokens']),
  subscription: new Set(['type', 'name']),
  cli: new Set(['type', 'name', 'command', 'args_template', 'resume_args_template', 'one_shot_args_template', 'supports_resume', 'supports_reasoning_effort', 'reasoning_effort', 'timeout_ms', 'models']),
};

// Reveal rate limiting: Map<presetName, Array<timestamp>>
const revealTimestamps = new Map<string, number[]>();
const REVEAL_MAX_PER_MINUTE = 10;

/**
 * Check if reveal is rate-limited for a given preset name.
 */
function isRevealRateLimited(presetName: string): boolean {
  const now = Date.now();
  const windowMs = 60_000; // 1 minute
  const timestamps = revealTimestamps.get(presetName) || [];
  const recent = timestamps.filter(t => now - t < windowMs);
  revealTimestamps.set(presetName, recent);
  return recent.length >= REVEAL_MAX_PER_MINUTE;
}

/**
 * Record a reveal event for rate limiting.
 */
function recordReveal(presetName: string): void {
  const timestamps = revealTimestamps.get(presetName) || [];
  timestamps.push(Date.now());
  revealTimestamps.set(presetName, timestamps);
}

/**
 * Log a reveal audit event to stderr.
 */
function logRevealAudit(presetName: string, req: Request): void {
  const userAgent = req.headers.get('User-Agent') || 'unknown';
  console.error(`[AUDIT] API key revealed for preset "${presetName}" at ${new Date().toISOString()} from ${userAgent}`);
}

// Test rate limiting: Map<presetName, Array<timestamp>>
const testTimestamps = new Map<string, number[]>();
const TEST_MAX_PER_MINUTE = 5;

function isTestRateLimited(presetName: string): { limited: boolean; retryAfterSeconds?: number } {
  const now = Date.now();
  const windowMs = 60_000;
  const timestamps = testTimestamps.get(presetName) || [];
  const recent = timestamps.filter(t => now - t < windowMs);
  testTimestamps.set(presetName, recent);
  if (recent.length >= TEST_MAX_PER_MINUTE) {
    const oldestInWindow = Math.min(...recent);
    const retryAfterSeconds = Math.ceil((oldestInWindow + windowMs - now) / 1000);
    return { limited: true, retryAfterSeconds };
  }
  return { limited: false };
}

function recordTest(presetName: string): void {
  const timestamps = testTimestamps.get(presetName) || [];
  timestamps.push(Date.now());
  testTimestamps.set(presetName, timestamps);
}

function logTestAudit(presetName: string, presetType: string, summary: string): void {
  console.error(`[AUDIT] TEST ${presetName} (${presetType}): ${summary} at ${new Date().toISOString()}`);
}

type ErrorCategory = 'auth_failed' | 'not_found' | 'rate_limited' | 'server_error' | 'connection_failed' | 'timeout' | 'tls_error' | 'invalid_response' | 'invalid_request';

interface ModelTestResult {
  model: string;
  success: boolean;
  latency_ms: number;
  attempts: number;
  error_category?: ErrorCategory;
  /** Actionable hint for the user, e.g. when a token-limit error is detected. */
  hint?: string;
}

function classifyError(err: unknown, statusCode?: number): { category: ErrorCategory; retryable: boolean } {
  if (statusCode) {
    if (statusCode === 401 || statusCode === 403) return { category: 'auth_failed', retryable: false };
    if (statusCode === 404) return { category: 'not_found', retryable: false };
    if (statusCode === 422) return { category: 'invalid_request', retryable: false };
    if (statusCode === 429) return { category: 'rate_limited', retryable: true };
    if (statusCode >= 500) return { category: 'server_error', retryable: true };
  }
  if (err instanceof Error) {
    if (err.name === 'AbortError') return { category: 'timeout', retryable: true };
    const msg = err.message.toLowerCase();
    if (msg.includes('econnrefused') || msg.includes('connection refused') || msg.includes('fetch failed') || msg.includes('dns')) {
      return { category: 'connection_failed', retryable: true };
    }
    if (msg.includes('certificate') || msg.includes('ssl') || msg.includes('tls')) {
      return { category: 'tls_error', retryable: false };
    }
  }
  return { category: 'invalid_response', retryable: false };
}

async function testApiModel(baseUrl: string, apiKey: string, model: string): Promise<ModelTestResult> {
  const MAX_ATTEMPTS = 3;
  const BACKOFF_DELAYS = [0, 1000, 2000]; // first attempt immediate, then 1s, 2s
  const TIMEOUT_MS = 15_000;
  const startTime = Date.now();
  let lastCategory: ErrorCategory = 'invalid_response';

  let nextDelay: number | null = null; // allows Retry-After to override default backoff

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Apply delay: use Retry-After override if set, otherwise default backoff
    if (attempt > 0) {
      const delay = nextDelay !== null ? nextDelay : BACKOFF_DELAYS[attempt];
      nextDelay = null; // reset override
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    try {
      const resp = await fetchWithTimeout(
        `${baseUrl}/v1/messages`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'Hi' }],
          }),
        },
        TIMEOUT_MS
      );

      if (resp.ok) {
        return { model, success: true, latency_ms: Date.now() - startTime, attempts: attempt + 1 };
      }

      const { category, retryable } = classifyError(null, resp.status);
      lastCategory = category;

      if (!retryable || attempt >= MAX_ATTEMPTS - 1) {
        return { model, success: false, latency_ms: Date.now() - startTime, attempts: attempt + 1, error_category: category };
      }

      // On 429, check Retry-After header to override next iteration's backoff delay
      if (resp.status === 429) {
        const retryAfter = resp.headers.get('Retry-After');
        if (retryAfter) {
          const delaySec = parseInt(retryAfter, 10);
          if (!isNaN(delaySec) && delaySec > 0 && delaySec <= 30) {
            nextDelay = delaySec * 1000;
          }
        }
      }
      // continue to next attempt (delay applied at top of loop)
    } catch (err) {
      const { category, retryable } = classifyError(err);
      lastCategory = category;
      if (!retryable || attempt >= MAX_ATTEMPTS - 1) {
        return { model, success: false, latency_ms: Date.now() - startTime, attempts: attempt + 1, error_category: category };
      }
    }
  }

  return { model, success: false, latency_ms: Date.now() - startTime, attempts: MAX_ATTEMPTS, error_category: lastCategory };
}

/**
 * Test an OpenAI-compatible API endpoint by sending a minimal request to /v1/chat/completions.
 * Uses a 30s timeout (increased from 15s to accommodate reasoning models that may be slow).
 */
async function testOpenAIModel(baseUrl: string, apiKey: string, model: string, maxOutputTokens?: number): Promise<ModelTestResult> {
  const TIMEOUT_MS = 30_000;
  const startTime = Date.now();
  const effectiveMaxTokens = maxOutputTokens ?? 16384;

  try {
    const resp = await fetchWithTimeout(
      `${baseUrl}/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: effectiveMaxTokens,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      },
      TIMEOUT_MS
    );

    if (resp.ok) {
      return { model, success: true, latency_ms: Date.now() - startTime, attempts: 1 };
    }

    // Detect token-limit 400 errors and produce actionable hint
    if (resp.status === 400) {
      const body = await resp.text().catch(() => '');
      const lower = body.toLowerCase();
      if (lower.includes('max_tokens') || lower.includes('token limit') || lower.includes('maximum')) {
        const { category } = classifyError(null, resp.status);
        return {
          model, success: false, latency_ms: Date.now() - startTime, attempts: 1,
          error_category: category,
          hint: 'Try lowering Max Output Tokens in preset settings',
        };
      }
    }

    const { category } = classifyError(null, resp.status);
    return { model, success: false, latency_ms: Date.now() - startTime, attempts: 1, error_category: category };
  } catch (err) {
    const { category } = classifyError(err);
    return { model, success: false, latency_ms: Date.now() - startTime, attempts: 1, error_category: category };
  }
}

async function handleTestPreset(
  presetName: string,
  corsHeaders: Record<string, string>
): Promise<Response> {
  // Rate limit check
  const rateCheck = isTestRateLimited(presetName);
  if (rateCheck.limited) {
    logTestAudit(presetName, 'unknown', 'rate limited');
    return jsonResponse(
      { error: { code: 'RATE_LIMITED', message: `Test rate limit exceeded. Try again in ${rateCheck.retryAfterSeconds} seconds.` } },
      429,
      { ...corsHeaders, 'Retry-After': String(rateCheck.retryAfterSeconds) }
    );
  }

  // Read preset from disk
  const config = readPresets();
  const preset = config.presets[presetName];
  if (!preset) {
    logTestAudit(presetName, 'unknown', 'preset not found');
    return jsonResponse(
      { error: { code: 'NOT_FOUND', message: 'Preset not found' } },
      404,
      corsHeaders
    );
  }

  // Record the test attempt for rate limiting
  recordTest(presetName);

  if (preset.type === 'api') {
    const models = Array.isArray(preset.models) ? preset.models : [];
    const protocol = preset.protocol ?? 'anthropic';
    const testFn = protocol === 'openai'
      ? (model: string) => testOpenAIModel(preset.base_url, preset.api_key, model, preset.max_output_tokens)
      : (model: string) => testApiModel(preset.base_url, preset.api_key, model);
    const results = await Promise.allSettled(models.map(testFn));
    const modelResults: ModelTestResult[] = results.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : { model: models[i], success: false, latency_ms: 0, attempts: 1, error_category: 'invalid_response' as ErrorCategory }
    );
    const passed = modelResults.filter(r => r.success).length;
    logTestAudit(presetName, 'api', `${passed}/${modelResults.length} models passed (${protocol})`);
    return jsonResponse({ type: 'api', results: modelResults }, 200, corsHeaders);
  }

  if (preset.type === 'cli') {
    let commandPath: string | null = null;
    let found = false;
    try {
      commandPath = Bun.which(preset.command);
      found = commandPath !== null;
    } catch {
      // Bun.which() threw (e.g., runtime incompatibility) -- treat as not found
      found = false;
    }
    const results = found
      ? [{ command: preset.command, found: true, path: commandPath }]
      : [{ command: preset.command, found: false }];
    logTestAudit(presetName, 'cli', found ? `command found at ${commandPath}` : 'command not found');
    return jsonResponse({ type: 'cli', results }, 200, corsHeaders);
  }

  if (preset.type === 'subscription') {
    logTestAudit(presetName, 'subscription', 'informational response');
    return jsonResponse(
      { type: 'subscription', status: 'ok', message: 'Subscription presets use your Claude plan directly. No connectivity test needed.' },
      200,
      corsHeaders
    );
  }

  return jsonResponse(
    { error: { code: 'BAD_REQUEST', message: 'Unknown preset type' } },
    400,
    corsHeaders
  );
}

/**
 * Handle inline preset test — accepts credentials in request body (not from disk).
 * Reuses testApiModel() and Bun.which() directly.
 */
async function handleTestPresetInline(
  req: Request,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const body = await parseJsonBody(req);
  const { type } = body;

  if (!type || !['api', 'cli', 'subscription'].includes(type as string)) {
    return jsonResponse(
      { error: { code: 'INVALID_REQUEST', message: 'type must be api, cli, or subscription' } },
      400, corsHeaders
    );
  }

  // Rate limit: per-type buckets
  const rateLimitKey = `__inline_${type}_test__`;
  const rateCheck = isTestRateLimited(rateLimitKey);
  if (rateCheck.limited) {
    logTestAudit('inline-test', type as string, 'rate limited');
    return jsonResponse(
      { error: { code: 'RATE_LIMITED', message: `Test rate limit exceeded. Try again in ${rateCheck.retryAfterSeconds} seconds.` } },
      429, { ...corsHeaders, 'Retry-After': String(rateCheck.retryAfterSeconds) }
    );
  }
  recordTest(rateLimitKey);

  if (type === 'subscription') {
    logTestAudit('inline-test', 'subscription', 'informational');
    return jsonResponse(
      { type: 'subscription', status: 'ok', message: 'Subscription presets use your Claude plan directly. No connectivity test needed.' },
      200, corsHeaders
    );
  }

  if (type === 'cli') {
    const command = body.command;
    if (typeof command !== 'string' || !command.trim()) {
      return jsonResponse(
        { error: { code: 'INVALID_REQUEST', message: 'command is required for CLI presets' } },
        400, corsHeaders
      );
    }
    try {
      const commandPath = Bun.which(command.trim());
      const found = commandPath !== null;
      const results = found
        ? [{ command: command.trim(), found: true, path: commandPath }]
        : [{ command: command.trim(), found: false }];
      logTestAudit('inline-test', 'cli', found ? 'command found' : 'command not found');
      return jsonResponse({ type: 'cli', results }, 200, corsHeaders);
    } catch {
      logTestAudit('inline-test', 'cli', 'command check failed');
      return jsonResponse(
        { type: 'cli', results: [{ command: command.trim(), found: false }] },
        200, corsHeaders
      );
    }
  }

  if (type === 'api') {
    const base_url = body.base_url;
    const api_key = body.api_key;
    const models = body.models;
    const protocol = typeof body.protocol === 'string' ? body.protocol : 'anthropic';
    if (typeof base_url !== 'string' || !base_url.trim()) {
      return jsonResponse(
        { error: { code: 'INVALID_REQUEST', message: 'base_url is required' } },
        400, corsHeaders
      );
    }
    if (typeof api_key !== 'string' || !api_key.trim()) {
      return jsonResponse(
        { error: { code: 'INVALID_REQUEST', message: 'api_key is required' } },
        400, corsHeaders
      );
    }
    if (!Array.isArray(models) || models.length === 0 || !models.every(m => typeof m === 'string' && m.trim())) {
      return jsonResponse(
        { error: { code: 'INVALID_REQUEST', message: 'models must be a non-empty array of strings' } },
        400, corsHeaders
      );
    }

    const maxOutputTokens = typeof body.max_output_tokens === 'number' ? body.max_output_tokens : undefined;
    const testFn = protocol === 'openai'
      ? (model: string) => testOpenAIModel(base_url.trim(), api_key, model.trim(), maxOutputTokens)
      : (model: string) => testApiModel(base_url.trim(), api_key, model.trim());
    const results = await Promise.allSettled((models as string[]).map(testFn));
    const modelResults: ModelTestResult[] = results.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : { model: (models as string[])[i], success: false, latency_ms: 0, attempts: 1, error_category: 'invalid_response' as ErrorCategory }
    );
    logTestAudit('inline-test', 'api', `${modelResults.filter(r => r.success).length}/${modelResults.length} passed (${protocol})`);
    return jsonResponse({ type: 'api', results: modelResults }, 200, corsHeaders);
  }

  return jsonResponse(
    { error: { code: 'INVALID_REQUEST', message: 'Unsupported type' } },
    400, corsHeaders
  );
}

/**
 * Validate preset fields against the allowlist (CWE-915).
 */
function allowlistPresetFields(body: Record<string, unknown>, presetType: string): Record<string, unknown> {
  const allowed = ALLOWED_PRESET_FIELDS[presetType];
  if (!allowed) {
    throw new Error(`Unknown preset type: ${presetType}`);
  }
  const unknown = Object.keys(body).filter(k => !allowed.has(k));
  if (unknown.length > 0) {
    throw new Error(`Unknown fields rejected: ${unknown.join(', ')}`);
  }
  return body;
}

/**
 * Create a JSON response helper.
 */
function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

/**
 * Check if a port is available on 127.0.0.1.
 * Returns availability status and the system error code on failure.
 */
function checkPortAvailable(port: number): Promise<{ available: boolean; errorCode?: string }> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (err: NodeJS.ErrnoException) => {
      resolve({ available: false, errorCode: err.code });
    });
    srv.once('listening', () => { srv.close(() => resolve({ available: true })); });
    srv.listen(port, '127.0.0.1');
  });
}

/**
 * Parse request body with 10MB size limit.
 */
async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  const contentLength = req.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > 10 * 1024 * 1024) {
    throw Object.assign(new Error('Request body exceeds 10MB limit'), { status: 413 });
  }
  const text = await req.text();
  if (text.length > 10 * 1024 * 1024) {
    throw Object.assign(new Error('Request body exceeds 10MB limit'), { status: 413 });
  }
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * Reset the idle timer.
 */
function resetIdleTimer(
  current: ReturnType<typeof setTimeout> | null,
  callback: () => void,
  timeoutMs: number
): ReturnType<typeof setTimeout> {
  if (current !== null) clearTimeout(current);
  return setTimeout(callback, timeoutMs);
}

/**
 * Start the config server.
 */
async function startConfigServer(cwd: string, idleTimeoutMinutes: number): Promise<void> {
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let shutdownRequested = false;

  const idleTimeoutMs = idleTimeoutMinutes * 60 * 1000;

  // Serve static files from the web/ directory
  const webDir = path.join(import.meta.dir, '..', 'web');

  // Read config_port for fixed port binding
  const devBuddyConfig = loadDevBuddyConfig();
  const serverPort = devBuddyConfig.config_port ?? 0;

  const server = Bun.serve({
    hostname: '127.0.0.1', // localhost-only (Bun defaults to 0.0.0.0)
    port: serverPort,      // config_port or OS-assigned

    fetch(req: Request): Response | Promise<Response> {
      const url = new URL(req.url);
      const pathname = url.pathname;

      // CORS: exact localhost origin only (no wildcard, no reflection) — CWE-346
      const origin = req.headers.get('Origin');
      const serverOrigin = `http://localhost:${server.port}`;
      const corsHeaders: Record<string, string> = origin === serverOrigin
        ? {
            'Access-Control-Allow-Origin': serverOrigin,
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          }
        : {};

      // Handle OPTIONS preflight
      if (req.method === 'OPTIONS') {
        if (origin !== serverOrigin) {
          return new Response(null, { status: 403 });
        }
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      // CORS enforcement for ALL non-preflight requests — CWE-346.
      // Reject any request whose Origin header is present but not the exact server
      // origin. This covers /api/* and any future routes. Requests
      // without an Origin header (e.g. direct curl, browser address-bar navigation)
      // are not cross-origin browser requests and are allowed through.
      if (origin && origin !== serverOrigin) {
        return new Response(
          JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Cross-origin request rejected' } }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Reset idle timer on every request
      idleTimer = resetIdleTimer(idleTimer, () => {
        console.error('[Config Server] Idle timeout expired — shutting down');
        shutdown();
      }, idleTimeoutMs);

      // Route API requests
      if (pathname.startsWith('/api/')) {
        return handleApiRequest(req, url, pathname, cwd, corsHeaders, server.port);
      }

      // Serve static files
      return serveStaticFile(pathname, webDir, corsHeaders);
    },
  });

  function shutdown(): void {
    if (shutdownRequested) return;
    shutdownRequested = true;
    if (idleTimer) clearTimeout(idleTimer);
    server.stop();
    process.exit(0);
  }

  // Graceful shutdown
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Start idle timer
  idleTimer = resetIdleTimer(idleTimer, () => {
    console.error('[Config Server] Idle timeout expired — shutting down');
    shutdown();
  }, idleTimeoutMs);

  // Emit startup output
  const startupUrl = `http://localhost:${server.port}`;
  console.log(JSON.stringify({ port: server.port, url: startupUrl }));

  // Open browser — list-form subprocess (CWE-78)
  const validatedUrl = `http://localhost:${server.port}/`;
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      Bun.spawn(['open', validatedUrl]);
    } else if (platform === 'win32') {
      Bun.spawn(['cmd', '/c', 'start', validatedUrl]);
    } else {
      Bun.spawn(['xdg-open', validatedUrl]);
    }
  } catch {
    // Browser launch failure is non-fatal
    console.error('[Config Server] Browser launch failed — navigate to:', validatedUrl);
  }
}

/**
 * Handle API requests.
 */
async function handleApiRequest(
  req: Request,
  url: URL,
  pathname: string,
  cwd: string,
  corsHeaders: Record<string, string>,
  serverPort: number
): Promise<Response> {
  try {
    // --- Preset routes ---
    if (pathname === '/api/presets') {
      if (req.method === 'GET') {
        return handleGetPresets(corsHeaders);
      }
    }

    // --- Inline preset test (form data, not saved to disk) ---
    if (pathname === '/api/test-preset' && req.method === 'POST') {
      return await handleTestPresetInline(req, corsHeaders);
    }

    // --- Preset test route (must match BEFORE generic /api/presets/:name) ---
    const testMatch = pathname.match(/^\/api\/presets\/([^/]+)\/test$/);
    if (testMatch && req.method === 'POST') {
      const presetName = decodeURIComponent(testMatch[1]);
      return handleTestPreset(presetName, corsHeaders);
    }

    if (pathname.startsWith('/api/presets/')) {
      const presetName = decodeURIComponent(pathname.slice('/api/presets/'.length));

      if (req.method === 'GET') {
        const revealParam = url.searchParams.get('reveal');
        return handleGetPreset(req, presetName, revealParam, corsHeaders);
      }
      if (req.method === 'PUT') {
        return await handlePutPreset(req, presetName, corsHeaders);
      }
      if (req.method === 'DELETE') {
        return handleDeletePreset(presetName, corsHeaders);
      }
    }

    // --- Stage definitions ---
    if (pathname === '/api/stage-definitions') {
      if (req.method === 'GET') {
        return handleGetStageDefinitions(corsHeaders);
      }
    }

    // --- Chatroom config routes ---
    // NOTE: /api/chatroom-config/defaults must be matched before /api/chatroom-config
    if (pathname === '/api/chatroom-config/defaults') {
      if (req.method === 'GET') {
        return handleGetChatroomConfigDefaults(corsHeaders);
      }
    }

    if (pathname === '/api/chatroom-config') {
      if (req.method === 'GET') {
        return handleGetChatroomConfig(corsHeaders);
      }
      if (req.method === 'PUT') {
        return await handlePutChatroomConfig(req, corsHeaders);
      }
    }

    // --- Preset models ---
    if (pathname.startsWith('/api/preset-models/')) {
      const presetName = decodeURIComponent(pathname.slice('/api/preset-models/'.length));
      if (req.method === 'GET') {
        return handleGetPresetModels(presetName, corsHeaders);
      }
    }

    // --- v3 System Prompts routes ---
    if (pathname === '/api/system-prompts') {
      if (req.method === 'GET') {
        try {
          const agentsDir = path.join(import.meta.dir, '..', 'system-prompts', 'built-in');
          const prompts = discoverSystemPrompts(agentsDir);
          return jsonResponse({
            prompts: prompts.map(p => ({
              name: p.name, description: p.description, tools: p.tools,
              disallowedTools: p.disallowedTools, source: p.source,
            })),
          }, 200, corsHeaders);
        } catch (err) {
          return jsonResponse({ error: { code: 'DISCOVERY_ERROR', message: err instanceof Error ? err.message : 'Unknown error' } }, 500, corsHeaders);
        }
      }
    }

    if (pathname.startsWith('/api/system-prompts/')) {
      const promptName = decodeURIComponent(pathname.slice('/api/system-prompts/'.length));
      const agentsDir = path.join(import.meta.dir, '..', 'system-prompts', 'built-in');

      if (req.method === 'GET') {
        const prompt = getSystemPrompt(promptName, agentsDir);
        if (!prompt) return jsonResponse({ error: { code: 'NOT_FOUND', message: `System prompt '${promptName}' not found` } }, 404, corsHeaders);
        return jsonResponse({ prompt }, 200, corsHeaders);
      }
      if (req.method === 'PUT') {
        const body = await req.text();
        try {
          writeCustomPrompt(promptName, body, agentsDir);
          return jsonResponse({ success: true }, 200, corsHeaders);
        } catch (err) {
          return jsonResponse({ error: { code: 'VALIDATION_ERROR', message: err instanceof Error ? err.message : 'Unknown error' } }, 400, corsHeaders);
        }
      }
      if (req.method === 'DELETE') {
        try {
          deleteCustomPrompt(promptName);
          return jsonResponse({ success: true }, 200, corsHeaders);
        } catch (err) {
          return jsonResponse({ error: { code: 'DELETE_ERROR', message: err instanceof Error ? err.message : 'Unknown error' } }, 400, corsHeaders);
        }
      }
    }

    // --- v3 Stages routes ---
    if (pathname === '/api/stages') {
      if (req.method === 'GET') {
        const config = loadDevBuddyConfig();
        // Ensure optional stages always appear in the response (empty executors = disabled)
        const stages = { ...config.stages };
        for (const optStage of OPTIONAL_STAGE_TYPES) {
          if (!stages[optStage as StageType]) {
            stages[optStage as StageType] = { executors: [] };
          }
        }
        return jsonResponse({ stages }, 200, corsHeaders);
      }
    }

    if (pathname.startsWith('/api/stages/')) {
      const stageName = decodeURIComponent(pathname.slice('/api/stages/'.length));
      if (req.method === 'PUT') {
        // Validate stage name
        if (!VALID_STAGE_TYPES.has(stageName)) {
          return jsonResponse({ error: { code: 'INVALID_STAGE', message: `Unknown stage type '${stageName}'` } }, 400, corsHeaders);
        }
        const body = await req.json() as Record<string, unknown>;
        const config = loadDevBuddyConfig();
        if (!body.executors || !Array.isArray(body.executors)) {
          return jsonResponse({ error: { code: 'VALIDATION_ERROR', message: 'executors array is required' } }, 400, corsHeaders);
        }
        // Field allowlist for inline executors (CWE-915)
        const allowedExecFields = new Set(['system_prompt', 'preset', 'model', 'parallel']);
        for (let i = 0; i < (body.executors as unknown[]).length; i++) {
          const exec = (body.executors as unknown[])[i];
          if (!exec || typeof exec !== 'object' || Array.isArray(exec)) {
            return jsonResponse({ error: { code: 'VALIDATION_ERROR', message: `executors[${i}]: must be an object` } }, 400, corsHeaders);
          }
          for (const key of Object.keys(exec as Record<string, unknown>)) {
            if (!allowedExecFields.has(key)) {
              return jsonResponse({ error: { code: 'INVALID_FIELD', message: `executors[${i}]: unknown field '${key}'` } }, 400, corsHeaders);
            }
          }
          if (!exec.system_prompt || !exec.preset || !exec.model) {
            return jsonResponse({ error: { code: 'VALIDATION_ERROR', message: `executors[${i}]: system_prompt, preset, and model are required` } }, 400, corsHeaders);
          }
          if (typeof exec.model === 'string' && !MODEL_NAME_REGEX.test(exec.model)) {
            return jsonResponse({ error: { code: 'VALIDATION_ERROR', message: `executors[${i}]: invalid model name` } }, 400, corsHeaders);
          }
        }
        config.stages[stageName as keyof typeof config.stages] = { executors: body.executors as StageExecutor[] };
        validateDevBuddyConfig(config);
        atomicWriteFile(PIPELINE_CONFIG_PATH, config);
        return jsonResponse({ success: true }, 200, corsHeaders);
      }
    }

    // --- v3 Settings routes ---
    if (pathname === '/api/settings') {
      if (req.method === 'GET') {
        const config = loadDevBuddyConfig();
        return jsonResponse({ config_port: config.config_port ?? null, max_iterations: config.max_iterations, max_build_attempts: config.max_build_attempts, max_outer_iterations: config.max_outer_iterations, max_discovery_iterations: config.max_discovery_iterations, max_requirements_iterations: config.max_requirements_iterations, max_decomposition_iterations: config.max_decomposition_iterations, theme: config.theme }, 200, corsHeaders);
      }
      if (req.method === 'PUT') {
        const body = await req.json() as Record<string, unknown>;
        const config = loadDevBuddyConfig();
        // config_port: only touch when explicitly present (partial PUTs like theme toggle omit it)
        if ('config_port' in body) {
          if (body.config_port === null) {
            delete config.config_port;
          } else if (typeof body.config_port === 'number' && Number.isInteger(body.config_port) && body.config_port >= 1 && body.config_port <= 65535) {
            if (body.config_port !== serverPort) {
              const result = await checkPortAvailable(body.config_port);
              if (!result.available) {
                const msg = result.errorCode === 'EACCES'
                  ? `Port ${body.config_port} requires elevated privileges`
                  : `Port ${body.config_port} is already in use`;
                return jsonResponse({ error: { code: 'PORT_UNAVAILABLE', message: msg } }, 409, corsHeaders);
              }
            }
            config.config_port = body.config_port;
          } else {
            return jsonResponse({ error: { code: 'INVALID_PORT', message: 'config_port must be an integer between 1 and 65535, or null to clear' } }, 400, corsHeaders);
          }
        }
        if (typeof body.max_iterations === 'number') config.max_iterations = body.max_iterations;
        if (typeof body.max_build_attempts === 'number') config.max_build_attempts = body.max_build_attempts;
        if (typeof body.max_outer_iterations === 'number') config.max_outer_iterations = body.max_outer_iterations;
        if (typeof body.max_discovery_iterations === 'number') config.max_discovery_iterations = body.max_discovery_iterations;
        if (typeof body.max_requirements_iterations === 'number') config.max_requirements_iterations = body.max_requirements_iterations;
        if (typeof body.max_decomposition_iterations === 'number') config.max_decomposition_iterations = body.max_decomposition_iterations;
        if (typeof body.theme === 'string' && (body.theme === 'light' || body.theme === 'dark')) config.theme = body.theme as 'light' | 'dark';
        validateDevBuddyConfig(config);
        atomicWriteFile(PIPELINE_CONFIG_PATH, config);
        return jsonResponse({ success: true }, 200, corsHeaders);
      }
    }

    return jsonResponse({ error: { code: 'NOT_FOUND', message: 'Endpoint not found' } }, 404, corsHeaders);
  } catch (err) {
    // Sanitized error responses (CWE-209)
    const errorId = crypto.randomUUID();
    console.error(`[ERROR] API error (error_id: ${errorId}):`, err);

    if (err instanceof Error && 'status' in err) {
      const status = (err as Error & { status: number }).status;
      return jsonResponse({ error: { code: 'REQUEST_ERROR', message: err.message } }, status, corsHeaders);
    }
    return jsonResponse(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal error', details: errorId } },
      500,
      corsHeaders
    );
  }
}

// --- Preset handlers ---

function handleGetPresets(corsHeaders: Record<string, string>): Response {
  const config = readPresets();
  const masked: Record<string, Preset> = {};
  for (const [name, preset] of Object.entries(config.presets)) {
    masked[name] = maskPresetKeys(preset);
  }
  return jsonResponse({ presets: masked }, 200, corsHeaders);
}

function handleGetPreset(
  req: Request,
  presetName: string,
  revealParam: string | null,
  corsHeaders: Record<string, string>
): Response {
  const config = readPresets();
  const preset = config.presets[presetName];
  if (!preset) {
    return jsonResponse({ error: { code: 'NOT_FOUND', message: 'Preset not found' } }, 404, corsHeaders);
  }

  if (revealParam === 'true') {
    // Reveal endpoint — full API key
    if (preset.type !== 'api') {
      return jsonResponse(
        { error: { code: 'BAD_REQUEST', message: 'Only API presets have keys to reveal' } },
        400,
        corsHeaders
      );
    }
    if (isRevealRateLimited(presetName)) {
      return jsonResponse(
        { error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded. Please wait before revealing again.' } },
        429,
        { ...corsHeaders, 'Retry-After': '60' }
      );
    }
    recordReveal(presetName);
    logRevealAudit(presetName, req);
    return jsonResponse({ preset }, 200, corsHeaders);
  }

  // Default: masked
  return jsonResponse({ preset: maskPresetKeys(preset) }, 200, corsHeaders);
}

async function handlePutPreset(
  req: Request,
  presetName: string,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const body = await parseJsonBody(req);

  // Get preset type for allowlisting
  const presetType = body.type as string;
  if (!presetType || !ALLOWED_PRESET_FIELDS[presetType]) {
    return jsonResponse(
      { error: { code: 'BAD_REQUEST', message: 'Preset must have a valid type: api, subscription, or cli' } },
      400,
      corsHeaders
    );
  }

  // Field allowlisting (CWE-915)
  let allowedBody: Record<string, unknown>;
  try {
    allowedBody = allowlistPresetFields(body, presetType);
  } catch (err) {
    return jsonResponse(
      { error: { code: 'BAD_REQUEST', message: err instanceof Error ? err.message : 'Field validation failed' } },
      400,
      corsHeaders
    );
  }

  // Normalize base_url: strip trailing /v1 or /v1/ to prevent double-pathing
  // e.g., https://api.example.com/v1 -> https://api.example.com
  if (typeof allowedBody.base_url === 'string') {
    allowedBody.base_url = allowedBody.base_url.replace(/\/v1\/?$/, '');
  }

  // Validate preset
  let validPreset: Preset;
  try {
    validPreset = validatePreset({ name: presetName, ...allowedBody });
  } catch (err) {
    return jsonResponse(
      { error: { code: 'INVALID_PRESET', message: err instanceof Error ? err.message : 'Invalid preset' } },
      400,
      corsHeaders
    );
  }

  const config = readPresets();
  config.presets[presetName] = validPreset;
  writePresets(config);

  return jsonResponse({ preset: maskPresetKeys(validPreset) }, 200, corsHeaders);
}

function handleDeletePreset(presetName: string, corsHeaders: Record<string, string>): Response {
  const config = readPresets();
  if (!config.presets[presetName]) {
    return jsonResponse({ error: { code: 'NOT_FOUND', message: 'Preset not found' } }, 404, corsHeaders);
  }
  delete config.presets[presetName];
  writePresets(config);
  return jsonResponse({ deleted: true }, 200, corsHeaders);
}

// --- Stage definitions handler ---

function handleGetStageDefinitions(corsHeaders: Record<string, string>): Response {
  return jsonResponse({ stage_definitions: STAGE_DEFINITIONS }, 200, corsHeaders);
}

// --- Chatroom config handlers ---

function handleGetChatroomConfig(corsHeaders: Record<string, string>): Response {
  const config = loadChatroomConfig();
  return jsonResponse({ config }, 200, corsHeaders);
}

function handleGetChatroomConfigDefaults(corsHeaders: Record<string, string>): Response {
  return jsonResponse({ config: DEFAULT_CHATROOM_CONFIG }, 200, corsHeaders);
}

async function handlePutChatroomConfig(req: Request, corsHeaders: Record<string, string>): Promise<Response> {
  const body = await parseJsonBody(req);
  const presets = readPresets();
  const error = validateChatroomConfig(body, presets);
  if (error) {
    return jsonResponse({ error: { code: 'INVALID_CONFIG', message: error } }, 400, corsHeaders);
  }
  saveChatroomConfig(body as unknown as ChatroomConfig);
  return jsonResponse({ saved: true }, 200, corsHeaders);
}

// --- Preset models handler ---

function handleGetPresetModels(presetName: string, corsHeaders: Record<string, string>): Response {
  const config = readPresets();
  const preset = config.presets[presetName];
  if (!preset) {
    return jsonResponse({ error: { code: 'NOT_FOUND', message: 'Preset not found' } }, 404, corsHeaders);
  }

  let models: string[];
  if (preset.type === 'subscription') {
    // Subscription presets expose the standard Claude model short-names
    models = ['sonnet', 'opus', 'haiku'];
  } else if (preset.type === 'api') {
    models = Array.isArray(preset.models) ? preset.models : [];
  } else {
    // cli
    models = Array.isArray(preset.models) ? preset.models : [];
  }

  return jsonResponse({ models }, 200, corsHeaders);
}

// --- Static file serving ---

async function serveStaticFile(
  pathname: string,
  webDir: string,
  corsHeaders: Record<string, string>
): Promise<Response> {
  // Serve index.html for root
  const filePath = pathname === '/' || pathname === ''
    ? path.join(webDir, 'index.html')
    : path.join(webDir, pathname);

  // Security: ensure path stays within webDir (path traversal prevention — CWE-22).
  // Use path.relative to avoid prefix-match bypass (e.g. /tmp/web-evil when
  // webDir is /tmp/web — startsWith would incorrectly allow sibling dirs).
  const resolved = path.resolve(filePath);
  const relative = path.relative(path.resolve(webDir), resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return new Response('Forbidden', { status: 403 });
  }

  try {
    const file = Bun.file(resolved);
    const exists = await file.exists();
    if (!exists) {
      // Fall back to index.html for SPA routing
      const indexFile = Bun.file(path.join(webDir, 'index.html'));
      return new Response(indexFile, { headers: { 'Content-Type': 'text/html', ...corsHeaders } });
    }

    const ext = path.extname(resolved);
    const contentType = ext === '.js' ? 'application/javascript'
      : ext === '.css' ? 'text/css'
      : ext === '.html' ? 'text/html'
      : ext === '.json' ? 'application/json'
      : 'application/octet-stream';

    return new Response(file, { headers: { 'Content-Type': contentType, ...corsHeaders } });
  } catch {
    return new Response('Not Found', { status: 404 });
  }
}

// ============================================================
// CLI entry point
// ============================================================

if (import.meta.main) {
  const cwdIndex = process.argv.indexOf('--cwd');
  const cwd = cwdIndex >= 0 ? process.argv[cwdIndex + 1] : process.cwd();

  const idleTimeoutIndex = process.argv.indexOf('--idle-timeout');
  const idleTimeoutMinutes = idleTimeoutIndex >= 0 ? parseInt(process.argv[idleTimeoutIndex + 1], 10) : 60;
  if (isNaN(idleTimeoutMinutes) || idleTimeoutMinutes <= 0) {
    console.error('--idle-timeout must be a positive integer');
    process.exit(1);
  }

  await startConfigServer(cwd, idleTimeoutMinutes);
}
