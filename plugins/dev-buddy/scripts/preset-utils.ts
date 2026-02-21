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
        description: 'Default Claude subscription via Task tool',
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
      return p as unknown as ApiPreset;
    }
    case 'subscription': {
      return p as unknown as SubscriptionPreset;
    }
    case 'cli': {
      if (typeof p.command !== 'string' || p.command.trim() === '') {
        throw new Error('CLI preset must have a command string');
      }
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
