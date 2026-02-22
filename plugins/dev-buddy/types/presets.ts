/**
 * Preset type definitions for AI provider configuration.
 * Discriminant field: 'type'
 *
 * Zero imports from other type modules (C21).
 */

export interface ApiPreset {
  type: 'api';
  name: string;
  base_url: string;
  api_key: string;
  models: string[];
}

export interface SubscriptionPreset {
  type: 'subscription';
  name: string;
}

/**
 * CLI preset with command template placeholders.
 *
 * Available placeholders in args_template / resume_args_template:
 *   {model}            — model name from stage config (validated against models[])
 *   {output_file}      — derived output file path
 *   {schema_path}      — path to JSON schema for structured output validation
 *   {prompt}           — AI-generated review/task prompt
 *   {reasoning_effort} — reasoning effort level (only when supports_reasoning_effort is true)
 */
export interface CliPreset {
  type: 'cli';
  name: string;
  /** The CLI command to invoke (e.g., 'codex'). */
  command: string;
  /** Command template string with placeholders (e.g., 'exec --full-auto --model {model} {prompt}'). */
  args_template: string;
  /** Optional resume template string. Used when resuming a session. */
  resume_args_template?: string;
  /** Whether this CLI tool supports session resume. */
  supports_resume?: boolean;
  /** Whether this CLI tool supports reasoning effort configuration. */
  supports_reasoning_effort?: boolean;
  /** Default reasoning effort level. Only used when supports_reasoning_effort is true. */
  reasoning_effort?: 'low' | 'medium' | 'high' | 'xhigh';
  /** Custom timeout in milliseconds. Default: 1200000 (20 minutes). */
  timeout_ms?: number;
  /** List of model names supported by this CLI tool. Required. Validated against /^[a-zA-Z0-9._-]+$/. */
  models: string[];
}

export type Preset = ApiPreset | SubscriptionPreset | CliPreset;

export interface PresetConfig {
  version: '2.0';
  presets: Record<string, Preset>;
}
