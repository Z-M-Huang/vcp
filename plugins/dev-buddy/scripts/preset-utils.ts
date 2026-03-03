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

/** Placeholders required in args_template for pipeline cli-executor to function. */
export const REQUIRED_ARGS_TEMPLATE_PLACEHOLDERS = ['model', 'prompt', 'output_file'] as const;

/** Valid placeholders for one_shot_args_template (no pipeline context). */
export const VALID_ONE_SHOT_PLACEHOLDERS = new Set([
  'model', 'prompt', 'reasoning_effort',
]);

/** Placeholders required in one_shot_args_template. */
export const REQUIRED_ONE_SHOT_PLACEHOLDERS = ['model', 'prompt'] as const;

/** Placeholders forbidden in one_shot_args_template (pipeline-only). */
export const FORBIDDEN_ONE_SHOT_PLACEHOLDERS = new Set(['output_file', 'schema_path']);

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
  // Set restrictive permissions on config directory (contains credentials)
  // chmod is a no-op on Windows — that's acceptable
  try {
    fs.chmodSync(CONFIG_DIR, 0o700);
  } catch (err) {
    console.warn(`[preset-utils] chmod(0o700) on config dir failed: ${(err as Error).message}`);
  }
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
  // Set restrictive permissions on presets file (contains API keys)
  try {
    fs.chmodSync(PRESETS_PATH, 0o600);
  } catch (err) {
    console.warn(`[preset-utils] chmod(0o600) on presets file failed: ${(err as Error).message}`);
  }
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
  // Set restrictive permissions on config directory (contains credentials)
  // chmod is a no-op on Windows — that's acceptable
  try {
    fs.chmodSync(CONFIG_DIR, 0o700);
  } catch (err) {
    console.warn(`[preset-utils] chmod(0o700) on config dir failed: ${(err as Error).message}`);
  }
  fs.writeFileSync(PRESETS_PATH, JSON.stringify(config, null, 2), 'utf-8');
  // Set restrictive permissions on presets file (contains API keys)
  try {
    fs.chmodSync(PRESETS_PATH, 0o600);
  } catch (err) {
    console.warn(`[preset-utils] chmod(0o600) on presets file failed: ${(err as Error).message}`);
  }
}

/**
 * Validate model names in an array. Throws on invalid entries.
 */
function validateModelNames(models: unknown[], label: string): void {
  for (const model of models) {
    if (typeof model !== 'string' || !MODEL_NAME_REGEX.test(model)) {
      throw new Error(`${label} model '${model}' is invalid. Must match /^[a-zA-Z0-9._-]+$/`);
    }
  }
}

/**
 * Validate a CLI template string for balanced braces and known placeholders.
 * Optionally checks required placeholders are present and forbidden ones are absent.
 * Returns an error message string, or null if valid.
 */
export function validateCliTemplate(
  template: string,
  fieldName: string,
  options?: {
    validSet?: Set<string>;
    required?: readonly string[];
    forbidden?: Set<string>;
  },
): string | null {
  const validSet = options?.validSet ?? VALID_CLI_PLACEHOLDERS;
  const validList = [...validSet].join(', ');
  let i = 0;
  while (i < template.length) {
    if (template[i] === '{') {
      const closeIdx = template.indexOf('}', i + 1);
      if (closeIdx === -1) {
        return `${fieldName}: unbalanced '{' at position ${i}. Missing closing '}'.`;
      }
      const name = template.slice(i + 1, closeIdx);
      if (!validSet.has(name)) {
        return `${fieldName}: unknown placeholder '{${name}}'. Valid placeholders: ${validList}`;
      }
      if (options?.forbidden?.has(name)) {
        return `${fieldName}: placeholder '{${name}}' is not allowed in this template.`;
      }
      i = closeIdx + 1;
    } else if (template[i] === '}') {
      return `${fieldName}: unexpected '}' at position ${i} without matching '{'.`;
    } else {
      i++;
    }
  }

  // Check required placeholders are present
  if (options?.required) {
    const missing = options.required.filter(p => !template.includes(`{${p}}`));
    if (missing.length > 0) {
      return `${fieldName}: missing required placeholder(s): {${missing.join('}, {')}}`;
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
      // timeout_ms is optional but must be positive integer if present
      if (p.timeout_ms !== undefined) {
        if (!Number.isInteger(p.timeout_ms) || (p.timeout_ms as number) <= 0) {
          throw new Error('API preset timeout_ms must be a positive integer');
        }
      }
      // protocol is optional but must be a valid value if present
      if (p.protocol !== undefined) {
        const validProtocols = ['anthropic', 'openai'];
        if (typeof p.protocol !== 'string' || !validProtocols.includes(p.protocol)) {
          throw new Error(`API preset protocol must be one of: ${validProtocols.join(', ')}`);
        }
      }
      // reasoning_effort is optional but must be a valid value if present
      if (p.reasoning_effort !== undefined) {
        const validEfforts = ['', 'minimal', 'low', 'medium', 'high', 'xhigh'];
        if (typeof p.reasoning_effort !== 'string' || !validEfforts.includes(p.reasoning_effort)) {
          throw new Error(`API preset reasoning_effort must be one of: (empty), minimal, low, medium, high, xhigh`);
        }
      }
      // max_output_tokens is optional but must be a positive integer <= 1,000,000 if present
      if (p.max_output_tokens !== undefined) {
        if (typeof p.max_output_tokens !== 'number' || !Number.isInteger(p.max_output_tokens) || (p.max_output_tokens as number) <= 0) {
          throw new Error('API preset max_output_tokens must be a positive integer');
        }
        if ((p.max_output_tokens as number) > 1_000_000) {
          throw new Error('API preset max_output_tokens must not exceed 1000000');
        }
      }
      return p as unknown as ApiPreset;
    }
    case 'subscription': {
      return p as unknown as SubscriptionPreset;
    }
    case 'cli': {
      if (typeof p.command !== 'string' || p.command.trim() === '') {
        throw new Error('CLI preset must have a command string');
      }
      // args_template is required — must contain {model}, {prompt}, {output_file}
      if (typeof p.args_template !== 'string' || p.args_template.trim() === '') {
        throw new Error('CLI preset must have a non-empty args_template string');
      }
      {
        const templateErr = validateCliTemplate(p.args_template as string, 'args_template', {
          required: REQUIRED_ARGS_TEMPLATE_PLACEHOLDERS,
        });
        if (templateErr) throw new Error(templateErr);
      }
      // resume_args_template is optional but must be string if present.
      // Normalize whitespace-only to undefined to prevent silent runtime breakage.
      if (p.resume_args_template !== undefined && typeof p.resume_args_template !== 'string') {
        throw new Error('CLI preset resume_args_template must be a string');
      }
      if (typeof p.resume_args_template === 'string') {
        if (p.resume_args_template.trim() === '') {
          p.resume_args_template = undefined;
        } else {
          const templateErr = validateCliTemplate(p.resume_args_template, 'resume_args_template');
          if (templateErr) throw new Error(templateErr);
        }
      }
      // one_shot_args_template is optional — must contain {model}, {prompt}, must NOT contain {output_file}/{schema_path}.
      // Normalize whitespace-only to undefined to prevent silent runtime breakage.
      if (p.one_shot_args_template !== undefined && typeof p.one_shot_args_template !== 'string') {
        throw new Error('CLI preset one_shot_args_template must be a string');
      }
      if (typeof p.one_shot_args_template === 'string') {
        if (p.one_shot_args_template.trim() === '') {
          p.one_shot_args_template = undefined;
        } else {
          const templateErr = validateCliTemplate(p.one_shot_args_template, 'one_shot_args_template', {
            validSet: VALID_ONE_SHOT_PLACEHOLDERS,
            required: REQUIRED_ONE_SHOT_PLACEHOLDERS,
            forbidden: FORBIDDEN_ONE_SHOT_PLACEHOLDERS,
          });
          if (templateErr) throw new Error(templateErr);
        }
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
