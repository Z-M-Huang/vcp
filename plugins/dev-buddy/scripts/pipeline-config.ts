/**
 * Pipeline configuration management.
 *
 * Loads and validates ~/.vcp/dev-buddy.json.
 *
 * Config format: ordered arrays of {type, provider, model} stage entries.
 * Both provider and model are required on every stage — no defaults.
 *
 * Usage (CLI mode):
 *   bun pipeline-config.ts validate --cwd <dir>
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { readPresets } from './preset-utils.ts';
import type { PipelineConfig, StageEntry } from '../types/pipeline.ts';
import { STAGE_DEFINITIONS, MODEL_NAME_REGEX } from '../types/stage-definitions.ts';
import type { StageType } from '../types/stage-definitions.ts';

// Config path: ~/.vcp/dev-buddy.json (C11)
export const CONFIG_PATH = path.join(os.homedir(), '.vcp', 'dev-buddy.json');

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

      default:
        console.error(`Unknown command: ${command}. Use: validate`);
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
