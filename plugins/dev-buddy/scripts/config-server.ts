#!/usr/bin/env bun
/**
 * Dev Buddy Web Configuration Portal Server
 *
 * REST API for managing AI presets, pipeline config, and session managers.
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
import { readPresets, writePresets, validatePreset, maskApiKey, maskPresetKeys, CONFIG_DIR } from './preset-utils.ts';
import { loadPipelineConfig, readSessionMappings, fetchWithTimeout, atomicWriteFile, validateConfig, DEFAULT_CONFIG } from './pipeline-config.ts';
import type { Preset } from '../types/presets.ts';
import { STAGE_DEFINITIONS } from '../types/stage-definitions.ts';
import type { PipelineConfig, StageEntry } from '../types/pipeline.ts';

// Allowed fields per preset type for field allowlisting (CWE-915)
const ALLOWED_PRESET_FIELDS: Record<string, Set<string>> = {
  api: new Set(['type', 'name', 'base_url', 'api_key', 'models', 'timeout_ms']),
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

  const server = Bun.serve({
    port: 0, // OS-assigned port

    fetch(req: Request): Response | Promise<Response> {
      const url = new URL(req.url);
      const pathname = url.pathname;

      // CORS: exact localhost origin only (no wildcard, no reflection) — CWE-346
      const origin = req.headers.get('Origin');
      const serverOrigin = `http://localhost:${server.port}`;
      const corsHeaders: Record<string, string> = origin === serverOrigin
        ? {
            'Access-Control-Allow-Origin': serverOrigin,
            'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
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
        return handleApiRequest(req, url, pathname, cwd, corsHeaders);
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
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    // --- Preset routes ---
    if (pathname === '/api/presets') {
      if (req.method === 'GET') {
        return handleGetPresets(corsHeaders);
      }
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

    // --- Pipeline config routes ---
    // NOTE: /api/pipeline-config/defaults must be matched before /api/pipeline-config
    // to avoid the less-specific route consuming requests for the sub-path.
    if (pathname === '/api/pipeline-config/defaults') {
      if (req.method === 'GET') {
        return handleGetPipelineConfigDefaults(corsHeaders);
      }
    }

    if (pathname === '/api/pipeline-config') {
      if (req.method === 'GET') {
        return handleGetPipelineConfig(corsHeaders);
      }
      if (req.method === 'PUT') {
        return await handlePutPipelineConfig(req, corsHeaders);
      }
    }

    // --- Preset models ---
    if (pathname.startsWith('/api/preset-models/')) {
      const presetName = decodeURIComponent(pathname.slice('/api/preset-models/'.length));
      if (req.method === 'GET') {
        return handleGetPresetModels(presetName, corsHeaders);
      }
    }

    // --- Session status ---
    if (pathname === '/api/sessions') {
      if (req.method === 'GET') {
        return await handleGetSessions(cwd, corsHeaders);
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

// --- Pipeline config handlers ---

function handleGetPipelineConfig(corsHeaders: Record<string, string>): Response {
  const config = loadPipelineConfig();
  return jsonResponse({ config }, 200, corsHeaders);
}

/**
 * Return the factory default config (DEFAULT_CONFIG) directly.
 * Used by the web portal's "Reset to Default" button — always returns the
 * hard-coded factory template, never the user-saved config from disk.
 */
function handleGetPipelineConfigDefaults(corsHeaders: Record<string, string>): Response {
  return jsonResponse({ config: DEFAULT_CONFIG }, 200, corsHeaders);
}

// Allowed top-level pipeline config fields (CWE-915)
const ALLOWED_TOP_LEVEL_FIELDS = new Set([
  'feature_pipeline', 'bugfix_pipeline', 'max_iterations', 'team_name_pattern',
]);

// Allowed stage entry fields
const ALLOWED_STAGE_ENTRY_FIELDS = new Set(['type', 'provider', 'model']);

/**
 * Validate a stage entry object for field allowlisting and structural correctness.
 * Returns an error message string, or null if valid.
 */
function validateStageEntry(entry: unknown, label: string): string | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return `${label}: must be an object`;
  }
  const obj = entry as Record<string, unknown>;
  const unknownFields = Object.keys(obj).filter(k => !ALLOWED_STAGE_ENTRY_FIELDS.has(k));
  if (unknownFields.length > 0) {
    return `${label}: unknown fields rejected: ${unknownFields.join(', ')}`;
  }
  if (typeof obj.type !== 'string' || obj.type.trim() === '') {
    return `${label}: type must be a non-empty string`;
  }
  if (typeof obj.provider !== 'string' || obj.provider.trim() === '') {
    return `${label}: provider must be a non-empty string`;
  }
  if (typeof obj.model !== 'string' || obj.model.trim() === '') {
    return `${label}: model must be a non-empty string`;
  }
  return null;
}

async function handlePutPipelineConfig(req: Request, corsHeaders: Record<string, string>): Promise<Response> {
  const body = await parseJsonBody(req);

  let config: PipelineConfig;

  {
    // Field allowlisting (CWE-915)
    const unknownTopLevel = Object.keys(body).filter(k => !ALLOWED_TOP_LEVEL_FIELDS.has(k));
    if (unknownTopLevel.length > 0) {
      return jsonResponse(
        { error: { code: 'INVALID_CONFIG', message: `Unknown top-level fields rejected: ${unknownTopLevel.join(', ')}` } },
        400,
        corsHeaders
      );
    }

    // Validate both pipeline arrays are present
    if (!Array.isArray(body.feature_pipeline)) {
      return jsonResponse(
        { error: { code: 'INVALID_CONFIG', message: "Config must include 'feature_pipeline' as an array" } },
        400,
        corsHeaders
      );
    }
    if (!Array.isArray(body.bugfix_pipeline)) {
      return jsonResponse(
        { error: { code: 'INVALID_CONFIG', message: "Config must include 'bugfix_pipeline' as an array" } },
        400,
        corsHeaders
      );
    }

    // Validate stage entry fields on both arrays
    const featurePipeline = body.feature_pipeline as unknown[];
    for (let i = 0; i < featurePipeline.length; i++) {
      const err = validateStageEntry(featurePipeline[i], `feature_pipeline[${i}]`);
      if (err) {
        return jsonResponse({ error: { code: 'INVALID_CONFIG', message: err } }, 400, corsHeaders);
      }
    }
    const bugfixPipeline = body.bugfix_pipeline as unknown[];
    for (let i = 0; i < bugfixPipeline.length; i++) {
      const err = validateStageEntry(bugfixPipeline[i], `bugfix_pipeline[${i}]`);
      if (err) {
        return jsonResponse({ error: { code: 'INVALID_CONFIG', message: err } }, 400, corsHeaders);
      }
    }

    // Validate optional settings fields
    if ('max_iterations' in body) {
      const mi = body.max_iterations;
      if (!Number.isInteger(mi) || (mi as number) <= 0) {
        return jsonResponse(
          { error: { code: 'INVALID_CONFIG', message: "'max_iterations' must be a positive integer" } },
          400,
          corsHeaders
        );
      }
    }
    if ('team_name_pattern' in body) {
      const tnp = body.team_name_pattern;
      if (typeof tnp !== 'string' || tnp.trim() === '') {
        return jsonResponse(
          { error: { code: 'INVALID_CONFIG', message: "'team_name_pattern' must be a non-empty string" } },
          400,
          corsHeaders
        );
      }
    }

    config = body as unknown as PipelineConfig;
  }

  // Run semantic validation (stage type constraints, singleton, pipeline restrictions, model regex)
  try {
    validateConfig(config);
  } catch (err) {
    return jsonResponse(
      { error: { code: 'INVALID_CONFIG', message: err instanceof Error ? err.message : 'Config validation failed' } },
      400,
      corsHeaders
    );
  }

  // Write atomically to ~/.vcp/dev-buddy.json
  const pipelineConfigPath = path.join(os.homedir(), '.vcp', 'dev-buddy.json');
  atomicWriteFile(pipelineConfigPath, config);

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

// --- Session handlers ---

async function handleGetSessions(cwd: string, corsHeaders: Record<string, string>): Promise<Response> {
  const mappings = readSessionMappings(cwd);

  // Query all session managers in parallel (Promise.allSettled — one slow/dead doesn't block others)
  const results = await Promise.allSettled(
    mappings.map(async mapping => {
      const url = `http://localhost:${mapping.port}/status`;
      try {
        const resp = await fetchWithTimeout(
          url,
          { headers: { Authorization: `Bearer ${mapping.token}` } },
          5_000 // 5s timeout (GET /status should be fast)
        );
        if (!resp.ok) {
          return { preset_name: mapping.preset_name, port: mapping.port, health: 'unknown', error: `HTTP ${resp.status}` };
        }
        const data = await resp.json() as Record<string, unknown>;
        return { preset_name: mapping.preset_name, port: mapping.port, ...data };
      } catch (err) {
        if (err instanceof Error) {
          if (err.name === 'AbortError') {
            return { preset_name: mapping.preset_name, port: mapping.port, health: 'unknown', error: 'Status check timed out' };
          }
          if (err.message.includes('ECONNREFUSED') || err.message.includes('connection refused') || err.message.includes('fetch failed')) {
            return { preset_name: mapping.preset_name, port: mapping.port, health: 'dead', error: 'Session manager not reachable' };
          }
        }
        const errorId = crypto.randomUUID();
        console.error(`[Config Server] Session status error (error_id: ${errorId}):`, err);
        return { preset_name: mapping.preset_name, port: mapping.port, health: 'unknown', error: 'Status check failed' };
      }
    })
  );

  const sessions = results.map(r => r.status === 'fulfilled' ? r.value : { health: 'unknown', error: 'Unknown error' });

  return jsonResponse({ sessions }, 200, corsHeaders);
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
