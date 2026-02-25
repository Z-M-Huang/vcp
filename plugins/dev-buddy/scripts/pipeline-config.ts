/**
 * Pipeline configuration management.
 *
 * Loads and validates ~/.vcp/dev-buddy.json and manages session manager lifecycle.
 *
 * Config format: ordered arrays of {type, provider, model} stage entries.
 * Both provider and model are required on every stage — no defaults.
 *
 * Usage (CLI mode):
 *   bun pipeline-config.ts validate --cwd <dir>
 *   bun pipeline-config.ts spawn --cwd <dir>
 *   bun pipeline-config.ts shutdown --cwd <dir>
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { readPresets, maskApiKey } from './preset-utils.ts';
import type { SessionPortMapping, PipelineConfig, StageEntry } from '../types/pipeline.ts';
import { STAGE_DEFINITIONS, MODEL_NAME_REGEX } from '../types/stage-definitions.ts';
import type { StageType } from '../types/stage-definitions.ts';

// Config path: ~/.vcp/dev-buddy.json (C11)
export const CONFIG_PATH = path.join(os.homedir(), '.vcp', 'dev-buddy.json');

// Session ports file (stored in .vcp/task/ relative to cwd)
const SESSION_PORTS_FILENAME = 'session-ports.json';

// ─── Default Config ──────────────────────────────────────────────────────────

/**
 * Default pipeline config — all stages use 'anthropic-subscription'.
 * Every stage has an explicit model — no defaults.
 *
 * Feature pipeline: 9 stages (requirements, planning, 3x plan-review, implementation, 3x code-review)
 * Bug-fix pipeline: 7 stages (2x rca, 1x plan-review, implementation, 3x code-review)
 */
export const DEFAULT_CONFIG: PipelineConfig = {
  feature_pipeline: [
    { type: 'requirements', provider: 'anthropic-subscription', model: 'opus' },
    { type: 'planning', provider: 'anthropic-subscription', model: 'opus' },
    { type: 'plan-review', provider: 'anthropic-subscription', model: 'sonnet' },
    { type: 'plan-review', provider: 'anthropic-subscription', model: 'opus' },
    { type: 'plan-review', provider: 'anthropic-subscription', model: 'sonnet' },
    { type: 'implementation', provider: 'anthropic-subscription', model: 'sonnet' },
    { type: 'code-review', provider: 'anthropic-subscription', model: 'sonnet' },
    { type: 'code-review', provider: 'anthropic-subscription', model: 'opus' },
    { type: 'code-review', provider: 'anthropic-subscription', model: 'sonnet' },
  ],
  bugfix_pipeline: [
    { type: 'rca', provider: 'anthropic-subscription', model: 'sonnet' },
    { type: 'rca', provider: 'anthropic-subscription', model: 'opus' },
    { type: 'plan-review', provider: 'anthropic-subscription', model: 'sonnet' },
    { type: 'implementation', provider: 'anthropic-subscription', model: 'sonnet' },
    { type: 'code-review', provider: 'anthropic-subscription', model: 'sonnet' },
    { type: 'code-review', provider: 'anthropic-subscription', model: 'opus' },
    { type: 'code-review', provider: 'anthropic-subscription', model: 'sonnet' },
  ],
  max_iterations: 10,
  team_name_pattern: 'pipeline-{BASENAME}-{HASH}',
};

// ─── Atomic Writes ───────────────────────────────────────────────────────────

/**
 * Write data to filePath atomically using a temp file + rename pattern.
 * Prevents partial writes if the process crashes mid-write.
 * Exported for reuse in config-server.ts.
 */
export function atomicWriteFile(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try { fs.unlinkSync(tempPath); } catch { /* ignore cleanup failure */ }
    throw err;
  }
}

// ─── Config Validation ───────────────────────────────────────────────────────

/**
 * Validate a pipeline config.
 * Throws descriptive errors on constraint violations.
 * Both provider and model are required on every stage.
 *
 * @param config - The config to validate.
 * @param pipelineType - If provided, only validate the specified pipeline array.
 */
export function validateConfig(config: PipelineConfig, pipelineType?: 'feature' | 'bugfix'): void {
  const pipelinesToCheck: Array<{ name: string; stages: StageEntry[]; type: 'feature' | 'bugfix' }> = [];

  if (!pipelineType || pipelineType === 'feature') {
    if (!Array.isArray(config.feature_pipeline)) {
      throw new Error('Config must have feature_pipeline as an array');
    }
    pipelinesToCheck.push({ name: 'feature_pipeline', stages: config.feature_pipeline, type: 'feature' });
  }
  if (!pipelineType || pipelineType === 'bugfix') {
    if (!Array.isArray(config.bugfix_pipeline)) {
      throw new Error('Config must have bugfix_pipeline as an array');
    }
    pipelinesToCheck.push({ name: 'bugfix_pipeline', stages: config.bugfix_pipeline, type: 'bugfix' });
  }

  for (const { name, stages, type } of pipelinesToCheck) {
    const validTypes = new Set<string>(Object.keys(STAGE_DEFINITIONS));
    const singletonCounts: Record<string, number> = {};
    let implementationCount = 0;

    for (let i = 0; i < stages.length; i++) {
      const entry = stages[i];

      // Validate stage type
      if (!entry || typeof entry.type !== 'string' || !validTypes.has(entry.type)) {
        throw new Error(
          `${name}[${i}]: invalid stage type '${entry?.type}'. Must be one of: ${[...validTypes].join(', ')}`
        );
      }

      const stageDef = STAGE_DEFINITIONS[entry.type as StageType];

      // Pipeline type restriction (requirements/planning only in feature)
      if (!stageDef.allowed_pipelines.includes(type)) {
        throw new Error(
          `${name}[${i}]: stage type '${entry.type}' is not allowed in ${type} pipeline. ` +
          `Allowed in: ${stageDef.allowed_pipelines.join(', ')}`
        );
      }

      // Singleton constraint
      if (stageDef.singleton) {
        singletonCounts[entry.type] = (singletonCounts[entry.type] || 0) + 1;
        if (singletonCounts[entry.type] > 1) {
          throw new Error(
            `${name}: '${entry.type}' is a singleton stage and may appear at most once per pipeline`
          );
        }
      }

      // Count implementation stages
      if (entry.type === 'implementation') {
        implementationCount++;
      }

      // Validate parallel flag type and applicability
      if ('parallel' in entry && typeof entry.parallel !== 'boolean') {
        throw new Error(
          `${name}[${i}]: 'parallel' must be a boolean, got ${typeof entry.parallel}`
        );
      }
      if (entry.parallel === true) {
        if (entry.type !== 'plan-review' && entry.type !== 'code-review') {
          throw new Error(
            `${name}[${i}]: 'parallel' is only allowed on plan-review and code-review stages, not '${entry.type}'`
          );
        }
      }

      // Validate provider (non-empty string)
      if (typeof entry.provider !== 'string' || entry.provider.trim() === '') {
        throw new Error(`${name}[${i}]: provider must be a non-empty string`);
      }

      // Validate model (required, non-empty string matching regex)
      if (typeof entry.model !== 'string' || entry.model.trim() === '') {
        throw new Error(`${name}[${i}]: model is required and must be a non-empty string`);
      }
      if (!MODEL_NAME_REGEX.test(entry.model)) {
        throw new Error(
          `${name}[${i}]: invalid model name '${entry.model}'. Must match /^[a-zA-Z0-9._-]+$/`
        );
      }
    }

    // Minimum constraint: every pipeline must have at least one implementation stage
    if (implementationCount === 0) {
      throw new Error(
        `${name}: every pipeline must have at least one implementation stage`
      );
    }
  }
}

// ─── Config Loading ───────────────────────────────────────────────────────────

/**
 * Load and validate the pipeline config from disk.
 *
 * Behavior:
 * - No file: returns DEFAULT_CONFIG
 * - Valid JSON: validates and returns
 * - Invalid: throws (fail fast, no fallbacks)
 */
export function loadPipelineConfig(): PipelineConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    return DEFAULT_CONFIG;
  }

  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`Pipeline config at ${CONFIG_PATH} is not valid JSON`);
  }

  const config = parsed as unknown as PipelineConfig;
  validateConfig(config);
  return config;
}

// ─── Provider Validation ──────────────────────────────────────────────────────

/**
 * Validate all provider references in the pipeline config.
 * Checks: (1) preset exists, (2) API presets have base_url and api_key.
 */
export function validateProviderReferences(config: PipelineConfig): void {
  const presets = readPresets();

  // Collect all unique provider names from both pipelines
  const providerNames = new Set<string>();
  for (const entry of [...config.feature_pipeline, ...config.bugfix_pipeline]) {
    providerNames.add(entry.provider);
  }

  const errors: string[] = [];

  for (const name of providerNames) {
    const preset = presets.presets[name];
    if (!preset) {
      errors.push(`  - Preset '${name}' not found in ~/.vcp/ai-presets.json`);
      continue;
    }
    if (preset.type === 'api') {
      if (!preset.base_url) {
        errors.push(`  - API preset '${name}' is missing base_url`);
      }
      if (!preset.api_key) {
        errors.push(`  - API preset '${name}' is missing api_key`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Pipeline config validation failed. The following providers are invalid:\n${errors.join('\n')}\n` +
      `\nRun '/dev-buddy:manage-presets' to add or fix presets before starting the pipeline.`
    );
  }
}

/**
 * Get the type of a provider preset by name.
 */
export function getProviderType(presetName: string): 'subscription' | 'api' | 'cli' {
  const presets = readPresets();
  const preset = presets.presets[presetName];
  if (!preset) {
    throw new Error(`Preset '${presetName}' not found`);
  }
  return preset.type;
}

/**
 * Resolve a stage entry to its provider type.
 */
export function resolveStageEntry(entry: StageEntry): { provider_name: string; provider_type: 'subscription' | 'api' | 'cli' } {
  const providerType = getProviderType(entry.provider);
  return {
    provider_name: entry.provider,
    provider_type: providerType,
  };
}

// ─── HTTP Helpers ─────────────────────────────────────────────────────────────

/**
 * HTTP fetch with explicit timeout using AbortController.
 * Exported for reuse in config-server.ts.
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── Session Managers ─────────────────────────────────────────────────────────

/**
 * Spawn session managers for unique API providers in the pipeline config.
 * Iterates both feature_pipeline and bugfix_pipeline for unique API providers.
 */
export async function spawnSessionManagers(
  config: PipelineConfig,
  cwd: string
): Promise<SessionPortMapping[]> {
  const presets = readPresets();

  // Find unique API provider names across both pipelines
  const apiProviders = new Set<string>();
  for (const entry of [...config.feature_pipeline, ...config.bugfix_pipeline]) {
    const preset = presets.presets[entry.provider];
    if (preset?.type === 'api') {
      apiProviders.add(entry.provider);
    }
  }

  if (apiProviders.size === 0) {
    return [];
  }

  const mappings: SessionPortMapping[] = [];
  const scriptPath = path.join(import.meta.dir, 'session-manager.ts');

  for (const presetName of apiProviders) {
    const preset = presets.presets[presetName];
    if (preset?.type === 'api') {
      console.error(`[Pipeline] Spawning session manager for preset: ${presetName} (key: ${maskApiKey(preset.api_key)})`);
    }

    // Spawn session manager — list form, no shell (C8, CWE-78)
    const spawnArgs = ['bun', scriptPath, '--preset', presetName, '--cwd', cwd];
    if (preset?.type === 'api' && preset.timeout_ms) {
      spawnArgs.push('--task-timeout', String(preset.timeout_ms));
    }
    const proc = Bun.spawn(spawnArgs, {
      cwd,
      stdout: 'pipe',
      stderr: 'inherit',
    });

    // Read startup output (port + token)
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();

    let startupTimeout: ReturnType<typeof setTimeout> | null = null;
    const startupPromise = new Promise<string>((resolve, reject) => {
      startupTimeout = setTimeout(() => reject(new Error(`Session manager for '${presetName}' did not start within 30s`)), 30_000);

      async function read() {
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            reject(new Error(`Session manager for '${presetName}' exited before sending startup output`));
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          const lineEnd = buffer.indexOf('\n');
          if (lineEnd >= 0) {
            resolve(buffer.slice(0, lineEnd).trim());
            return;
          }
        }
      }
      read().catch(reject);
    });

    let startupJson: { status: string; port: number; token: string };
    try {
      const startupLine = await startupPromise;
      if (startupTimeout) clearTimeout(startupTimeout);
      startupJson = JSON.parse(startupLine);
    } catch (err) {
      throw new Error(`Failed to start session manager for '${presetName}': ${err instanceof Error ? err.message : String(err)}`);
    }

    if (startupJson.status !== 'ready') {
      throw new Error(`Session manager for '${presetName}' reported status: ${startupJson.status}`);
    }

    // Detach child process so this parent (pipeline-config.ts) can exit
    // while the session manager keeps running as an independent process.
    // Also release the stdout reader — we only needed the startup JSON line.
    reader.releaseLock();
    proc.unref();

    const mapping: SessionPortMapping = {
      preset_name: presetName,
      port: startupJson.port,
      token: startupJson.token,
      pid: proc.pid,
    };

    mappings.push(mapping);
    console.error(`[Pipeline] Session manager for '${presetName}' ready on port ${startupJson.port}`);
  }

  // Write mappings to .vcp/task/session-ports.json
  const taskDir = path.join(cwd, '.vcp', 'task');
  fs.mkdirSync(taskDir, { recursive: true });
  const portsPath = path.join(taskDir, SESSION_PORTS_FILENAME);
  fs.writeFileSync(portsPath, JSON.stringify(mappings, null, 2), 'utf-8');

  return mappings;
}

/**
 * Shutdown all session managers by sending POST /shutdown.
 * Falls back to SIGTERM on timeout or connection failure.
 */
export async function shutdownSessionManagers(mappings: SessionPortMapping[]): Promise<void> {
  for (const mapping of mappings) {
    const url = `http://localhost:${mapping.port}/shutdown`;
    try {
      const response = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${mapping.token}`,
            'Content-Type': 'application/json',
          },
        },
        10_000
      );
      if (response.ok) {
        console.error(`[Pipeline] Session manager at port ${mapping.port} shutting down`);
      } else {
        console.error(`[Pipeline] Session manager at port ${mapping.port} returned ${response.status} on shutdown — sending SIGTERM`);
        sendSigterm(mapping);
      }
    } catch (err) {
      if (err instanceof Error) {
        if (err.name === 'AbortError') {
          console.error(`[Pipeline] Session manager at port ${mapping.port} did not respond to shutdown within 10s — sending SIGTERM`);
        } else if (err.message.includes('ECONNREFUSED') || err.message.includes('connection refused')) {
          console.error(`[Pipeline] Session manager at port ${mapping.port} already stopped`);
          continue;
        } else {
          console.error(`[Pipeline] Shutdown error for port ${mapping.port}: ${err.message} — sending SIGTERM`);
        }
      }
      sendSigterm(mapping);
    }
  }
}

function sendSigterm(mapping: SessionPortMapping): void {
  try {
    process.kill(mapping.pid, 'SIGTERM');
    console.error(`[Pipeline] Sent SIGTERM to session manager pid ${mapping.pid}`);
  } catch (err) {
    if (err instanceof Error && (err.message.includes('ESRCH') || err.message.includes('No such process'))) {
      console.error(`[Pipeline] Session manager pid ${mapping.pid} already exited`);
    } else {
      console.error(`[Pipeline] Failed to send SIGTERM to pid ${mapping.pid}:`, err);
    }
  }
}

/**
 * Read session port mappings from .vcp/task/session-ports.json.
 */
export function readSessionMappings(cwd: string): SessionPortMapping[] {
  const portsPath = path.join(cwd, '.vcp', 'task', SESSION_PORTS_FILENAME);
  if (!fs.existsSync(portsPath)) return [];
  const raw = fs.readFileSync(portsPath, 'utf-8');
  return JSON.parse(raw) as SessionPortMapping[];
}

// ============================================================
// CLI entry point
// ============================================================

if (import.meta.main) {
  const command = process.argv[2];
  const cwdIndex = process.argv.indexOf('--cwd');
  const cwd = cwdIndex >= 0 ? process.argv[cwdIndex + 1] : process.cwd();

  try {
    const config = loadPipelineConfig();

    switch (command) {
      case 'validate':
        validateProviderReferences(config);
        console.log('[Pipeline] Config validation passed');
        break;

      case 'spawn': {
        validateProviderReferences(config);
        const mappings = await spawnSessionManagers(config, cwd);
        console.log(`[Pipeline] Spawned ${mappings.length} session manager(s)`);
        // Explicit exit — inherited stderr pipes from child processes can keep
        // the event loop alive even after unref(). Force clean exit.
        process.exit(0);
        break; // unreachable, but satisfies lint
      }

      case 'shutdown': {
        const mappings = readSessionMappings(cwd);
        if (mappings.length === 0) {
          console.log('[Pipeline] No session managers to shutdown');
        } else {
          await shutdownSessionManagers(mappings);
          // Clean up port file
          const portsPath = path.join(cwd, '.vcp', 'task', SESSION_PORTS_FILENAME);
          if (fs.existsSync(portsPath)) fs.unlinkSync(portsPath);
          console.log(`[Pipeline] Shut down ${mappings.length} session manager(s)`);
        }
        break;
      }

      default:
        console.error(`Unknown command: ${command}. Use: validate | spawn | shutdown`);
        process.exit(1);
    }
  } catch (err) {
    if (err instanceof Error) {
      console.error(`[Pipeline Config] Error: ${err.message}`);
    } else {
      console.error('[Pipeline Config] Unknown error:', err);
    }
    process.exit(1);
  }
}
