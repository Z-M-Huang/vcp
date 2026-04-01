/**
 * Pipeline configuration management (v5 Ralph loop format).
 *
 * Loads and validates ~/.vcp/dev-buddy.json.
 * Auto-migrates from v2, v3, and v4 formats directly to v5 on first load.
 *
 * Usage (CLI mode):
 *   bun pipeline-config.ts validate --cwd <dir>
 *   bun pipeline-config.ts migrate --cwd <dir>
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { readPresets } from './preset-utils.ts';
import type { PipelineConfig, DevBuddyConfig, DevBuddyConfigV3, StageExecutor, StageConfig } from '../types/pipeline.ts';
import { STAGE_DEFINITIONS, MODEL_NAME_REGEX, VALID_STAGE_TYPES, LEGACY_STAGE_MAPPING, LEGACY_AGENT_TYPES, VALID_LEGACY_STAGE_TYPES } from '../types/stage-definitions.ts';
import type { StageType, LegacyStageType } from '../types/stage-definitions.ts';
import { discoverSystemPrompts } from './system-prompts.ts';

// Config path: ~/.vcp/dev-buddy.json
export const CONFIG_PATH = path.join(os.homedir(), '.vcp', 'dev-buddy.json');

// ─── Atomic Writes ───────────────────────────────────────────────────────────

/**
 * Write data to filePath atomically using a temp file + rename pattern.
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
    try { fs.unlinkSync(tempPath); } catch { /* ignore cleanup failure */ }
    throw err;
  }
}

// ─── Provider Resolution ─────────────────────────────────────────────────────

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
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── Default Config (v5 Ralph loop) ──────────────────────────────────────────

/** The Ralph pipeline stage order. */
const RALPH_PIPELINE: StageType[] = [
  'discovery', 'ralph-requirements', 'decomposition',
  'ralph-build', 'ralph-code-review', 'ralph-uat',
];

export const DEFAULT_CONFIG: DevBuddyConfig = {
  version: '5.0',
  stages: {
    'discovery': { executors: [{ system_prompt: 'discoverer', preset: 'anthropic-subscription', model: 'sonnet' }] },
    'ralph-requirements': { executors: [{ system_prompt: 'ralph-requirements-analyst', preset: 'anthropic-subscription', model: 'opus' }] },
    'decomposition': { executors: [{ system_prompt: 'decomposer', preset: 'anthropic-subscription', model: 'opus' }] },
    'ralph-build': { executors: [{ system_prompt: 'unit-builder', preset: 'anthropic-subscription', model: 'sonnet' }] },
    'ralph-code-review': { executors: [{ system_prompt: 'ralph-code-reviewer', preset: 'anthropic-subscription', model: 'sonnet' }] },
    'ralph-uat': { executors: [{ system_prompt: 'uat-evaluator', preset: 'anthropic-subscription', model: 'sonnet' }] },
  },
  pipelines: {
    'ralph': RALPH_PIPELINE,
  },
  max_iterations: 10,
  max_build_attempts: 3,
  max_outer_iterations: 3,
  max_discovery_iterations: 3,
  max_requirements_iterations: 3,
  max_decomposition_iterations: 2,
};

// ─── Pipeline Name Validation ────────────────────────────────────────────────

/** Valid pipeline name: lowercase alphanumeric + hyphens, starts with alphanumeric, max 50 chars. */
const PIPELINE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Names that would cause prototype pollution if used as object keys. */
const FORBIDDEN_PIPELINE_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Validate a pipeline name.
 * @throws Error if invalid.
 */
function validatePipelineName(name: string): void {
  if (!name || name.length > 50) {
    throw new Error(`Pipeline name must be 1-50 characters, got ${name.length}`);
  }
  if (FORBIDDEN_PIPELINE_NAMES.has(name)) {
    throw new Error(`Pipeline name '${name}' is forbidden (prototype pollution risk)`);
  }
  if (!PIPELINE_NAME_RE.test(name)) {
    throw new Error(`Pipeline name '${name}' is invalid. Must match /^[a-z0-9][a-z0-9-]*$/`);
  }
}

// ─── v5 Validation ──────────────────────────────────────────────────────────

/**
 * Validate a v5 DevBuddyConfig (Ralph loop format).
 */
export function validateDevBuddyConfig(config: DevBuddyConfig): void {
  if (config.version !== '5.0') {
    throw new Error(`Invalid config version: '${config.version}'. Expected '5.0'.`);
  }

  // Discover available system prompts for name validation
  const builtInDir = path.join(import.meta.dir, '..', 'system-prompts', 'built-in');
  let availablePrompts: Set<string>;
  try {
    const prompts = discoverSystemPrompts(builtInDir);
    availablePrompts = new Set(prompts.map(p => p.name));
  } catch {
    availablePrompts = new Set();
  }

  // Validate stages: all 6 Ralph stage types must exist
  for (const stageType of VALID_STAGE_TYPES) {
    const stage = config.stages[stageType as StageType];
    if (!stage) {
      throw new Error(`Missing stage config for '${stageType}'`);
    }
    if (!Array.isArray(stage.executors)) {
      throw new Error(`Stage '${stageType}': executors must be an array`);
    }
    for (let i = 0; i < stage.executors.length; i++) {
      const exec = stage.executors[i];
      if (!exec.system_prompt || typeof exec.system_prompt !== 'string') {
        throw new Error(`Stage '${stageType}' executor[${i}]: system_prompt is required`);
      }
      if (availablePrompts.size > 0 && !availablePrompts.has(exec.system_prompt)) {
        throw new Error(`Stage '${stageType}' executor[${i}]: system_prompt '${exec.system_prompt}' not found. Available: ${[...availablePrompts].join(', ')}`);
      }
      if (!exec.preset || typeof exec.preset !== 'string') {
        throw new Error(`Stage '${stageType}' executor[${i}]: preset is required`);
      }
      // Validate preset exists
      try {
        getProviderType(exec.preset);
      } catch {
        throw new Error(`Stage '${stageType}' executor[${i}]: preset '${exec.preset}' not found in ai-presets.json`);
      }
      if (!exec.model || typeof exec.model !== 'string') {
        throw new Error(`Stage '${stageType}' executor[${i}]: model is required`);
      }
      if (!MODEL_NAME_REGEX.test(exec.model)) {
        throw new Error(`Stage '${stageType}' executor[${i}]: invalid model name '${exec.model}'`);
      }
      if (exec.parallel !== undefined && typeof exec.parallel !== 'boolean') {
        throw new Error(`Stage '${stageType}' executor[${i}]: parallel must be a boolean`);
      }
    }

    // Enforce max_executors constraint
    const def = STAGE_DEFINITIONS[stageType as StageType];
    if (def.max_executors !== undefined && stage.executors.length > def.max_executors) {
      throw new Error(
        `Stage '${stageType}': maximum ${def.max_executors} executor(s) allowed, got ${stage.executors.length}`
      );
    }
  }

  // Validate pipelines object
  if (!config.pipelines || typeof config.pipelines !== 'object' || Array.isArray(config.pipelines)) {
    throw new Error('pipelines must be an object');
  }
  const pipelineNames = Object.keys(config.pipelines);
  if (pipelineNames.length === 0) {
    throw new Error('At least 1 pipeline is required');
  }

  // Collect all stages used in any pipeline for executor-count check
  const stagesInAnyPipeline = new Set<string>();

  for (const [name, pipeline] of Object.entries(config.pipelines)) {
    validatePipelineName(name);
    if (!Array.isArray(pipeline)) {
      throw new Error(`Pipeline '${name}' must be an array`);
    }
    for (let i = 0; i < pipeline.length; i++) {
      if (!VALID_STAGE_TYPES.has(pipeline[i])) {
        throw new Error(`Pipeline '${name}'[${i}]: invalid stage type '${pipeline[i]}'`);
      }
      stagesInAnyPipeline.add(pipeline[i]);
    }
  }

  // Stages in active pipelines must have at least 1 executor
  for (const stageType of stagesInAnyPipeline) {
    const stage = config.stages[stageType as StageType];
    if (stage.executors.length === 0) {
      throw new Error(`Stage '${stageType}': must have at least 1 executor (used in active pipeline)`);
    }
  }

  // Enforce synthesizer rule: last executor in multi-executor stages must be non-parallel
  for (const [, stage] of Object.entries(config.stages)) {
    if (stage.executors.length > 1 && stage.executors[stage.executors.length - 1].parallel) {
      stage.executors[stage.executors.length - 1].parallel = false;
    }
  }

  // Validate numeric fields
  if (!Number.isInteger(config.max_iterations) || config.max_iterations <= 0) {
    throw new Error(`max_iterations must be a positive integer`);
  }
  if (!Number.isInteger(config.max_build_attempts) || config.max_build_attempts <= 0) {
    throw new Error(`max_build_attempts must be a positive integer`);
  }
  if (!Number.isInteger(config.max_outer_iterations) || config.max_outer_iterations <= 0) {
    throw new Error(`max_outer_iterations must be a positive integer`);
  }
  if (!Number.isInteger(config.max_discovery_iterations) || config.max_discovery_iterations <= 0) {
    throw new Error(`max_discovery_iterations must be a positive integer`);
  }
  if (!Number.isInteger(config.max_requirements_iterations) || config.max_requirements_iterations <= 0) {
    throw new Error(`max_requirements_iterations must be a positive integer`);
  }
  if (!Number.isInteger(config.max_decomposition_iterations) || config.max_decomposition_iterations <= 0) {
    throw new Error(`max_decomposition_iterations must be a positive integer`);
  }

  // Validate optional theme field
  if (config.theme !== undefined && config.theme !== 'light' && config.theme !== 'dark') {
    throw new Error(`theme must be 'light' or 'dark'`);
  }
}

// ─── Config Format Detection ────────────────────────────────────────────────

function isV5(parsed: Record<string, unknown>): boolean {
  return parsed.version === '5.0';
}

function isV4(parsed: Record<string, unknown>): boolean {
  return parsed.version === '4.0' && !!parsed.pipelines;
}

function isV3Inline(parsed: Record<string, unknown>): boolean {
  if (parsed.version !== '3.0') return false;
  return !parsed.executors;
}

function isV3Named(parsed: Record<string, unknown>): boolean {
  if (parsed.version !== '3.0') return false;
  return !!parsed.executors;
}

// ─── Legacy Migration Helpers ────────────────────────────────────────────────

/**
 * Replace system_prompt with the Ralph default for the target stage.
 * Old built-in prompt files are deleted; new stages use new prompts.
 */
function migratePromptName(_oldName: string, targetStage: StageType): string {
  return STAGE_DEFINITIONS[targetStage].agent_type;
}

/**
 * Convert legacy executor configs for a given legacy stage to v5 stage executors.
 * Preserves preset/model/parallel, rewrites system_prompt to Ralph equivalent.
 */
function migrateLegacyExecutors(
  legacyType: string,
  executors: StageExecutor[],
): { targetStage: StageType; executors: StageExecutor[] } | null {
  if (!VALID_LEGACY_STAGE_TYPES.has(legacyType)) return null;

  const targetStage = LEGACY_STAGE_MAPPING[legacyType as LegacyStageType];
  const migratedExecutors = executors.map(exec => ({
    ...exec,
    system_prompt: migratePromptName(exec.system_prompt, targetStage),
  }));

  // ralph-build is singleton — take only first executor
  if (targetStage === 'ralph-build' || targetStage === 'ralph-uat') {
    return { targetStage, executors: migratedExecutors.slice(0, 1) };
  }

  return { targetStage, executors: migratedExecutors };
}

/**
 * Build v5 stages from migrated legacy stage data.
 * Handles deduplication when multiple legacy stages map to the same Ralph stage
 * (e.g., both plan-review and rca map to discovery).
 */
function buildV5Stages(
  migratedStages: Map<StageType, StageExecutor[]>,
): Record<StageType, StageConfig> {
  const result = {} as Record<StageType, StageConfig>;

  for (const stageType of VALID_STAGE_TYPES) {
    const st = stageType as StageType;
    const migrated = migratedStages.get(st);
    if (migrated && migrated.length > 0) {
      // Deduplicate executors (same system_prompt + preset + model)
      const seen = new Set<string>();
      const deduped: StageExecutor[] = [];
      for (const exec of migrated) {
        const key = `${exec.system_prompt}|${exec.preset}|${exec.model}`;
        if (!seen.has(key)) {
          seen.add(key);
          deduped.push(exec);
        }
      }
      result[st] = { executors: deduped };
    } else {
      // Fall back to default
      result[st] = { executors: [...DEFAULT_CONFIG.stages[st].executors] };
    }
  }

  return result;
}

// ─── Direct-to-v5 Migration Functions ────────────────────────────────────────

/**
 * Migrate a v4 config directly to v5.
 */
function migrateV4ToV5(v4: Record<string, unknown>): DevBuddyConfig {
  const oldStages = v4.stages as Record<string, StageConfig>;
  const migratedStages = new Map<StageType, StageExecutor[]>();

  for (const [legacyType, stageConfig] of Object.entries(oldStages)) {
    const result = migrateLegacyExecutors(legacyType, stageConfig.executors);
    if (result) {
      const existing = migratedStages.get(result.targetStage) ?? [];
      migratedStages.set(result.targetStage, [...existing, ...result.executors]);
    }
  }

  return {
    version: '5.0',
    stages: buildV5Stages(migratedStages),
    pipelines: { ralph: RALPH_PIPELINE },
    max_iterations: (v4.max_iterations as number) ?? 10,
    max_build_attempts: (v4.max_tdd_iterations as number) ?? 3,
    max_outer_iterations: 3,
    max_discovery_iterations: 3,
    max_requirements_iterations: 3,
    max_decomposition_iterations: 2,
    ...((v4.theme as string) ? { theme: v4.theme as 'light' | 'dark' } : {}),
  };
}

/**
 * Migrate a v3-inline config directly to v5.
 */
function migrateV3InlineToV5(v3: DevBuddyConfigV3): DevBuddyConfig {
  const migratedStages = new Map<StageType, StageExecutor[]>();

  for (const [legacyType, stageConfig] of Object.entries(v3.stages)) {
    const result = migrateLegacyExecutors(legacyType, stageConfig.executors);
    if (result) {
      const existing = migratedStages.get(result.targetStage) ?? [];
      migratedStages.set(result.targetStage, [...existing, ...result.executors]);
    }
  }

  return {
    version: '5.0',
    stages: buildV5Stages(migratedStages),
    pipelines: { ralph: RALPH_PIPELINE },
    max_iterations: v3.max_iterations ?? 10,
    max_build_attempts: v3.max_tdd_iterations ?? 3,
    max_outer_iterations: 3,
    max_discovery_iterations: 3,
    max_requirements_iterations: 3,
    max_decomposition_iterations: 2,
    ...(v3.theme ? { theme: v3.theme } : {}),
  };
}

/**
 * Migrate a v3-named config directly to v5.
 * v3-named has top-level 'executors' map referenced by name in stages.
 */
function migrateV3NamedToV5(config: Record<string, unknown>): DevBuddyConfig {
  const namedExecutors = config.executors as Record<string, { system_prompt: string; preset: string; model: string }>;
  const oldStages = config.stages as Record<string, { executors: Array<{ name: string; parallel?: boolean }> }>;
  const migratedStages = new Map<StageType, StageExecutor[]>();

  for (const [legacyType, stageConfig] of Object.entries(oldStages)) {
    const inlineExecutors: StageExecutor[] = stageConfig.executors
      .map(ref => {
        const exec = namedExecutors[ref.name];
        if (!exec) return null;
        const inline: StageExecutor = {
          system_prompt: exec.system_prompt,
          preset: exec.preset,
          model: exec.model,
        };
        if (ref.parallel) inline.parallel = true;
        return inline;
      })
      .filter((e): e is StageExecutor => e !== null);

    const result = migrateLegacyExecutors(legacyType, inlineExecutors);
    if (result) {
      const existing = migratedStages.get(result.targetStage) ?? [];
      migratedStages.set(result.targetStage, [...existing, ...result.executors]);
    }
  }

  return {
    version: '5.0',
    stages: buildV5Stages(migratedStages),
    pipelines: { ralph: RALPH_PIPELINE },
    max_iterations: (config.max_iterations as number) ?? 10,
    max_build_attempts: (config.max_tdd_iterations as number) ?? 3,
    max_outer_iterations: 3,
    max_discovery_iterations: 3,
    max_requirements_iterations: 3,
    max_decomposition_iterations: 2,
    ...((config.theme as string) ? { theme: config.theme as 'light' | 'dark' } : {}),
  };
}

/**
 * Migrate a v2 PipelineConfig (StageEntry arrays) directly to v5.
 */
function migrateV2ToV5(v2: PipelineConfig): DevBuddyConfig {
  const migratedStages = new Map<StageType, StageExecutor[]>();

  for (const pipeline of [v2.feature_pipeline, v2.bugfix_pipeline]) {
    if (!pipeline) continue;
    for (const entry of pipeline) {
      const legacyAgentType = LEGACY_AGENT_TYPES[entry.type as LegacyStageType];
      if (!legacyAgentType) continue;

      const exec: StageExecutor = {
        system_prompt: legacyAgentType,
        preset: entry.provider,
        model: entry.model,
      };
      if (entry.parallel) exec.parallel = true;

      const result = migrateLegacyExecutors(entry.type, [exec]);
      if (result) {
        const existing = migratedStages.get(result.targetStage) ?? [];
        migratedStages.set(result.targetStage, [...existing, ...result.executors]);
      }
    }
  }

  return {
    version: '5.0',
    stages: buildV5Stages(migratedStages),
    pipelines: { ralph: RALPH_PIPELINE },
    max_iterations: v2.max_iterations ?? 10,
    max_build_attempts: 3,
    max_outer_iterations: 3,
    max_discovery_iterations: 3,
    max_requirements_iterations: 3,
    max_decomposition_iterations: 2,
  };
}

// ─── Config Loading ─────────────────────────────────────────────────────────

/**
 * Load the dev-buddy config as v5.
 * Auto-migrates from v2, v3-named, v3-inline, and v4 formats directly to v5.
 */
export function loadDevBuddyConfig(): DevBuddyConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    return DEFAULT_CONFIG;
  }

  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`Config at ${CONFIG_PATH} is not valid JSON`);
  }

  // Already v5 — fill additive defaults BEFORE validation, then validate and return
  if (isV5(parsed)) {
    const config = parsed as unknown as DevBuddyConfig;
    config.max_discovery_iterations ??= DEFAULT_CONFIG.max_discovery_iterations;
    config.max_requirements_iterations ??= DEFAULT_CONFIG.max_requirements_iterations;
    config.max_decomposition_iterations ??= DEFAULT_CONFIG.max_decomposition_iterations;
    validateDevBuddyConfig(config);
    return config;
  }

  // v4 — migrate directly to v5
  if (isV4(parsed)) {
    const v5 = migrateV4ToV5(parsed);
    validateDevBuddyConfig(v5);
    const backupPath = `${CONFIG_PATH}.v4.backup`;
    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(CONFIG_PATH, backupPath);
    }
    atomicWriteFile(CONFIG_PATH, v5);
    console.error(`[Pipeline] Auto-migrated config from v4 to v5. Backup at ${backupPath}`);
    return v5;
  }

  // v3-inline — migrate directly to v5
  if (isV3Inline(parsed)) {
    const v3 = parsed as unknown as DevBuddyConfigV3;
    const v5 = migrateV3InlineToV5(v3);
    validateDevBuddyConfig(v5);
    const backupPath = `${CONFIG_PATH}.v3-inline.backup`;
    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(CONFIG_PATH, backupPath);
    }
    atomicWriteFile(CONFIG_PATH, v5);
    console.error(`[Pipeline] Auto-migrated config from v3-inline to v5. Backup at ${backupPath}`);
    return v5;
  }

  // v3-named — migrate directly to v5
  if (isV3Named(parsed)) {
    const v5 = migrateV3NamedToV5(parsed);
    validateDevBuddyConfig(v5);
    const backupPath = `${CONFIG_PATH}.v3-named.backup`;
    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(CONFIG_PATH, backupPath);
    }
    atomicWriteFile(CONFIG_PATH, v5);
    console.error(`[Pipeline] Auto-migrated config from v3-named to v5. Backup at ${backupPath}`);
    return v5;
  }

  // v2 format — migrate directly to v5
  const v2 = parsed as unknown as PipelineConfig;
  const v5 = migrateV2ToV5(v2);
  validateDevBuddyConfig(v5);
  const backupPath = `${CONFIG_PATH}.v2.backup`;
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(CONFIG_PATH, backupPath);
  }
  atomicWriteFile(CONFIG_PATH, v5);
  console.error(`[Pipeline] Auto-migrated config from v2 to v5. Backup at ${backupPath}`);
  return v5;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const command = process.argv[2];

  try {
    switch (command) {
      case 'validate':
      case 'validate-v3': {
        const config = loadDevBuddyConfig();
        const stageCount = Object.values(config.stages).reduce((n, s) => n + s.executors.length, 0);
        const pipelineCount = Object.keys(config.pipelines).length;
        console.log(`[Pipeline] v5 config valid. ${stageCount} total executors, ${pipelineCount} pipeline(s): ${Object.keys(config.pipelines).join(', ')}`);
        break;
      }

      case 'migrate': {
        const config = loadDevBuddyConfig();
        atomicWriteFile(CONFIG_PATH, config);
        const stageCount = Object.values(config.stages).reduce((n, s) => n + s.executors.length, 0);
        console.log(`[Pipeline] Config migrated to v5. ${stageCount} total executors, ${Object.keys(config.pipelines).length} pipeline(s).`);
        break;
      }

      default:
        console.error(`Unknown command: ${command}. Use: validate, migrate`);
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
