/**
 * Pipeline configuration management.
 *
 * Loads and validates ~/.vcp/dev-buddy.json, spawns session managers for
 * API providers, and manages their lifecycle.
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
import type { PipelineConfig, PipelineStages, ResolvedStage, SessionPortMapping } from '../types/pipeline.ts';

// Config path: ~/.vcp/dev-buddy.json (C11)
export const CONFIG_PATH = path.join(os.homedir(), '.vcp', 'dev-buddy.json');

// Session ports file (stored in .task/ relative to cwd)
const SESSION_PORTS_FILENAME = 'session-ports.json';

/**
 * Default pipeline config — all stages use 'anthropic-subscription'.
 * Backward compatible: behaves like pre-v2 single-provider pipeline (AC40).
 */
export const DEFAULT_CONFIG: PipelineConfig = {
  version: '2.0',
  pipeline: {
    stages: {
      requirements: { provider: 'anthropic-subscription' },
      planning: { provider: 'anthropic-subscription' },
      plan_review_sonnet: { provider: 'anthropic-subscription' },
      plan_review_opus: { provider: 'anthropic-subscription' },
      plan_review_codex: { provider: 'anthropic-subscription' },
      implementation: { provider: 'anthropic-subscription' },
      code_review_sonnet: { provider: 'anthropic-subscription' },
      code_review_opus: { provider: 'anthropic-subscription' },
      code_review_codex: { provider: 'anthropic-subscription' },
    },
    max_iterations: 10,
    team_name_pattern: 'pipeline-{BASENAME}-{HASH}',
  },
};

/**
 * Load pipeline config from disk, merged with defaults (C22 — simple object spread).
 * Returns defaults if file does not exist.
 */
export function loadPipelineConfig(): PipelineConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    return DEFAULT_CONFIG;
  }
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  const userConfig = JSON.parse(raw) as Partial<PipelineConfig>;

  // Simple object spread for defaults (C22)
  return {
    ...DEFAULT_CONFIG,
    ...userConfig,
    pipeline: {
      ...DEFAULT_CONFIG.pipeline,
      ...(userConfig.pipeline || {}),
      stages: {
        ...DEFAULT_CONFIG.pipeline.stages,
        ...(userConfig.pipeline?.stages || {}),
      },
    },
  };
}

/**
 * Validate all provider references in the pipeline config.
 * Checks: (1) preset exists, (2) API presets have base_url and api_key.
 * Fails fast with human-readable errors listing ALL invalid providers.
 */
export function validateProviderReferences(config: PipelineConfig): void {
  const presets = readPresets();
  const stages = config.pipeline.stages;

  // Collect all unique provider names from stages
  const providerNames = new Set<string>(
    Object.values(stages).map(stage => stage.provider)
  );

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
 * Resolve a pipeline stage to its provider name and type.
 */
export function resolveStage(stageName: keyof PipelineStages, config: PipelineConfig): ResolvedStage {
  const stage = config.pipeline.stages[stageName];
  if (!stage) {
    throw new Error(`Unknown pipeline stage: ${stageName}`);
  }
  const providerType = getProviderType(stage.provider);
  return {
    provider_name: stage.provider,
    provider_type: providerType,
  };
}

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

/**
 * Spawn session managers for unique API providers in the pipeline config.
 * Returns an array of port/token/pid mappings.
 * Writes mappings to .task/session-ports.json.
 */
export async function spawnSessionManagers(
  config: PipelineConfig,
  cwd: string
): Promise<SessionPortMapping[]> {
  const presets = readPresets();
  const stages = config.pipeline.stages;

  // Find unique API provider names
  const apiProviders = new Set<string>();
  for (const stage of Object.values(stages)) {
    const preset = presets.presets[stage.provider];
    if (preset?.type === 'api') {
      apiProviders.add(stage.provider);
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
    const proc = Bun.spawn(['bun', scriptPath, '--preset', presetName, '--cwd', cwd], {
      cwd,
      stdout: 'pipe',
      stderr: 'inherit',
    });

    // Read startup output (port + token)
    const reader = proc.stdout.getReader();
    let startupLine = '';
    const decoder = new TextDecoder();

    // Read until we get the JSON startup line
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
      startupLine = await startupPromise;
      if (startupTimeout) clearTimeout(startupTimeout);
      startupJson = JSON.parse(startupLine);
    } catch (err) {
      throw new Error(`Failed to start session manager for '${presetName}': ${err instanceof Error ? err.message : String(err)}`);
    }

    if (startupJson.status !== 'ready') {
      throw new Error(`Session manager for '${presetName}' reported status: ${startupJson.status}`);
    }

    const mapping: SessionPortMapping = {
      preset_name: presetName,
      port: startupJson.port,
      token: startupJson.token,
      pid: proc.pid,
    };

    mappings.push(mapping);
    console.error(`[Pipeline] Session manager for '${presetName}' ready on port ${startupJson.port}`);
  }

  // Write mappings to .task/session-ports.json
  const taskDir = path.join(cwd, '.task');
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
        10_000 // 10s timeout for shutdown (must wait for in-progress task drain)
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

/**
 * Send SIGTERM to a session manager process.
 */
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
 * Read session port mappings from .task/session-ports.json.
 */
export function readSessionMappings(cwd: string): SessionPortMapping[] {
  const portsPath = path.join(cwd, '.task', SESSION_PORTS_FILENAME);
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
        break;
      }

      case 'shutdown': {
        const mappings = readSessionMappings(cwd);
        if (mappings.length === 0) {
          console.log('[Pipeline] No session managers to shutdown');
        } else {
          await shutdownSessionManagers(mappings);
          // Clean up port file
          const portsPath = path.join(cwd, '.task', SESSION_PORTS_FILENAME);
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
