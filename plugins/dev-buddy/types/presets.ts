/**
 * Preset type definitions for AI provider configuration.
 * Discriminant field: 'type'
 *
 * Zero imports from other type modules (C21).
 */

export interface ApiPreset {
  type: 'api';
  name: string;
  description?: string;
  base_url: string;
  api_key: string;
  models: string[];
}

export interface SubscriptionPreset {
  type: 'subscription';
  name: string;
  description?: string;
}

export interface CliPreset {
  type: 'cli';
  name: string;
  description?: string;
  command: string;
  args?: string[];
}

export type Preset = ApiPreset | SubscriptionPreset | CliPreset;

export interface PresetConfig {
  version: '2.0';
  presets: Record<string, Preset>;
}
