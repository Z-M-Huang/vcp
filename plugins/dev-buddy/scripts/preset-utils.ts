/**
 * Preset utilities for AI provider configuration management.
 *
 * Config storage: ~/.vcp/ai-presets.json (cross-platform via os.homedir())
 * Provides: path resolution, CRUD operations, maskApiKey(), default preset creation.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Preset, PresetConfig, ApiPreset, SubscriptionPreset, CliPreset } from '../types/presets.ts';
import { MODEL_NAME_REGEX } from '../types/stage-definitions.ts';

/** Valid placeholders for CLI args_template and resume_args_template. */
export const VALID_CLI_PLACEHOLDERS = new Set([
  'model', 'output_file', 'schema_path', 'prompt', 'reasoning_effort',
]);

// Cross-platform config directory: ~/.vcp/
export const CONFIG_DIR = path.join(os.homedir(), '.vcp');
export const PRESETS_PATH = path.join(CONFIG_DIR, 'ai-presets.json');

/**
 * Mask an API key showing only the last 4 characters.
 * Examples:
 *   maskApiKey('sk-or-v1-abcdefghx789') -> 'sk-***x789'
 *   maskApiKey('abcd') -> '****'
 *   maskApiKey('abc') -> '****'
 */
export function maskApiKey(key: string): string {
  if (key.length <= 4) return '****';
  return key.slice(0, 3) + '***' + key.slice(-4);
}

/**
 * Create the default preset configuration with a single Anthropic subscription preset.
 * Also creates the ~/.vcp/ directory if it does not exist.
 */
export function createDefaultPresets(): PresetConfig {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const defaultConfig: PresetConfig = {
    version: '2.0',
    presets: {
      'anthropic-subscription': {
        type: 'subscription',
        name: 'Anthropic Subscription',
      },
    },
  };
  fs.writeFileSync(PRESETS_PATH, JSON.stringify(defaultConfig, null, 2), 'utf-8');
  return defaultConfig;
}

/**
 * Read the presets config from disk.
 * If the file does not exist, creates the default config first.
 */
export function readPresets(): PresetConfig {
  if (!fs.existsSync(PRESETS_PATH)) {
    return createDefaultPresets();
  }
  const raw = fs.readFileSync(PRESETS_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as PresetConfig;
  return parsed;
}

/**
 * Write the presets config to disk.
 * Validates version field before writing.
 */
export function writePresets(config: PresetConfig): void {
  if (config.version !== '2.0') {
    throw new Error(`Invalid preset config version: ${config.version}. Expected '2.0'.`);
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(PRESETS_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Validate model names in an array. Throws on invalid entries.
 */
function validateModelNames(models: unknown[], label: string): void {
  for (const model of models) {
    if (typeof model !== 'string' || !MODEL_NAME_REGEX.test(model)) {
      throw new Error(`${label} model '${model}' is invalid. Must match /^[a-z0-9.-]+$/`);
    }
  }
}

/**
 * Validate a CLI template string for balanced braces and known placeholders.
 * Returns an error message string, or null if valid.
 */
export function validateCliTemplate(template: string, fieldName: string): string | null {
  const validList = [...VALID_CLI_PLACEHOLDERS].join(', ');
  let i = 0;
  while (i < template.length) {
    if (template[i] === '{') {
      const closeIdx = template.indexOf('}', i + 1);
      if (closeIdx === -1) {
        return `${fieldName}: unbalanced '{' at position ${i}. Missing closing '}'.`;
      }
      const name = template.slice(i + 1, closeIdx);
      if (!VALID_CLI_PLACEHOLDERS.has(name)) {
        return `${fieldName}: unknown placeholder '{${name}}'. Valid placeholders: ${validList}`;
      }
      i = closeIdx + 1;
    } else if (template[i] === '}') {
      return `${fieldName}: unexpected '}' at position ${i} without matching '{'.`;
    } else {
      i++;
    }
  }
  return null;
}

/**
 * Validate a single preset object at runtime.
 * Returns the typed Preset if valid, throws on invalid input.
 */
export function validatePreset(preset: unknown): Preset {
  if (!preset || typeof preset !== 'object') {
    throw new Error('Preset must be an object');
  }
  const p = preset as Record<string, unknown>;

  if (typeof p.name !== 'string' || p.name.trim() === '') {
    throw new Error('Preset must have a non-empty name string');
  }
  if (typeof p.type !== 'string') {
    throw new Error('Preset must have a type field');
  }

  switch (p.type) {
    case 'api': {
      if (typeof p.base_url !== 'string' || p.base_url.trim() === '') {
        throw new Error('API preset must have a base_url string');
      }
      if (typeof p.api_key !== 'string' || p.api_key.trim() === '') {
        throw new Error('API preset must have an api_key string');
      }
      if (!Array.isArray(p.models) || p.models.length === 0) {
        throw new Error('API preset must have a non-empty models array');
      }
      validateModelNames(p.models as unknown[], 'API preset');
      return p as unknown as ApiPreset;
    }
    case 'subscription': {
      return p as unknown as SubscriptionPreset;
    }
    case 'cli': {
      if (typeof p.command !== 'string' || p.command.trim() === '') {
        throw new Error('CLI preset must have a command string');
      }
      // args_template is required
      if (typeof p.args_template !== 'string' || p.args_template.trim() === '') {
        throw new Error('CLI preset must have a non-empty args_template string');
      }
      {
        const templateErr = validateCliTemplate(p.args_template as string, 'args_template');
        if (templateErr) throw new Error(templateErr);
      }
      // resume_args_template is optional but must be string if present
      if (p.resume_args_template !== undefined && typeof p.resume_args_template !== 'string') {
        throw new Error('CLI preset resume_args_template must be a string');
      }
      if (typeof p.resume_args_template === 'string' && p.resume_args_template.trim() !== '') {
        const templateErr = validateCliTemplate(p.resume_args_template as string, 'resume_args_template');
        if (templateErr) throw new Error(templateErr);
      }
      // supports_resume is optional but must be boolean if present
      if (p.supports_resume !== undefined && typeof p.supports_resume !== 'boolean') {
        throw new Error('CLI preset supports_resume must be a boolean');
      }
      // supports_reasoning_effort is optional but must be boolean if present
      if (p.supports_reasoning_effort !== undefined && typeof p.supports_reasoning_effort !== 'boolean') {
        throw new Error('CLI preset supports_reasoning_effort must be a boolean');
      }
      // reasoning_effort is optional but must be one of low/medium/high if present
      if (p.reasoning_effort !== undefined) {
        const validEfforts = ['low', 'medium', 'high', 'xhigh'];
        if (typeof p.reasoning_effort !== 'string' || !validEfforts.includes(p.reasoning_effort)) {
          throw new Error(`CLI preset reasoning_effort must be one of: ${validEfforts.join(', ')}`);
        }
      }
      // timeout_ms is optional but must be positive integer if present
      if (p.timeout_ms !== undefined) {
        if (!Number.isInteger(p.timeout_ms) || (p.timeout_ms as number) <= 0) {
          throw new Error('CLI preset timeout_ms must be a positive integer');
        }
      }
      // models is required for CLI presets
      if (!Array.isArray(p.models) || p.models.length === 0) {
        throw new Error('CLI preset must have a non-empty models array');
      }
      validateModelNames(p.models as unknown[], 'CLI preset');
      return p as unknown as CliPreset;
    }
    default:
      throw new Error(`Unknown preset type: ${p.type}. Must be 'api', 'subscription', or 'cli'.`);
  }
}

/**
 * Mask API keys in a preset for safe display.
 * Returns a copy with api_key masked; non-API presets are returned as-is.
 */
export function maskPresetKeys(preset: Preset): Preset {
  if (preset.type === 'api') {
    return { ...preset, api_key: maskApiKey(preset.api_key) };
  }
  return preset;
}
