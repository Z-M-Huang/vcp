/**
 * Pipeline configuration management (v3 inline executor format).
 *
 * Loads and validates ~/.vcp/dev-buddy.json.
 * Auto-migrates from v2 (StageEntry arrays) and v3-named (top-level executors map) on first load.
 *
 * Usage (CLI mode):
 *   bun pipeline-config.ts validate-v3 --cwd <dir>
 *   bun pipeline-config.ts migrate --cwd <dir>
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { readPresets } from './preset-utils.ts';
import type { PipelineConfig, StageEntry, DevBuddyConfig, StageExecutor, StageConfig } from '../types/pipeline.ts';
import { STAGE_DEFINITIONS, MODEL_NAME_REGEX, VALID_STAGE_TYPES, getV3OutputFileName } from '../types/stage-definitions.ts';
import type { StageType } from '../types/stage-definitions.ts';
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

// ─── Default v3 Config (inline executors) ────────────────────────────────────

export const DEFAULT_V3_CONFIG: DevBuddyConfig = {
  version: '3.0',
  stages: {
    'requirements': { executors: [{ system_prompt: 'requirements-gatherer', preset: 'anthropic-subscription', model: 'opus' }] },
    'planning': { executors: [{ system_prompt: 'planner', preset: 'anthropic-subscription', model: 'opus' }] },
    'plan-review': { executors: [{ system_prompt: 'plan-reviewer', preset: 'anthropic-subscription', model: 'sonnet' }] },
    'implementation': { executors: [{ system_prompt: 'implementer', preset: 'anthropic-subscription', model: 'sonnet' }] },
    'code-review': { executors: [{ system_prompt: 'code-reviewer', preset: 'anthropic-subscription', model: 'sonnet' }] },
    'rca': { executors: [
      { system_prompt: 'root-cause-analyst', preset: 'anthropic-subscription', model: 'sonnet', parallel: true },
      { system_prompt: 'root-cause-analyst', preset: 'anthropic-subscription', model: 'opus' },
    ] },
  },
  feature_pipeline: ['requirements', 'planning', 'plan-review', 'implementation', 'code-review'],
  bugfix_pipeline: ['rca', 'requirements', 'planning', 'plan-review', 'implementation', 'code-review'],
  max_iterations: 10,
  max_tdd_iterations: 5,
};

// ─── v2 → v3-inline Migration ───────────────────────────────────────────────

/**
 * Migrate a v2 PipelineConfig (StageEntry arrays) to v3 inline format.
 */
export function migrateV2ToV3(v2: PipelineConfig): DevBuddyConfig {
  const stages: Record<string, StageConfig> = {};

  for (const pipeline of [v2.feature_pipeline, v2.bugfix_pipeline]) {
    for (const entry of pipeline) {
      const agentType = STAGE_DEFINITIONS[entry.type as StageType]?.agent_type;
      if (!agentType) continue;

      const stageType = entry.type as StageType;
      if (!stages[stageType]) {
        stages[stageType] = { executors: [] };
      }

      const exec: StageExecutor = {
        system_prompt: agentType,
        preset: entry.provider,
        model: entry.model,
      };
      if (entry.parallel) exec.parallel = true;

      // Avoid duplicate executors in same stage
      const isDup = stages[stageType].executors.some(e =>
        e.system_prompt === exec.system_prompt && e.preset === exec.preset && e.model === exec.model
      );
      if (!isDup) {
        stages[stageType].executors.push(exec);
      }
    }
  }

  // Ensure all 6 stage types exist
  for (const stageType of VALID_STAGE_TYPES) {
    if (!stages[stageType]) {
      const defaultStage = DEFAULT_V3_CONFIG.stages[stageType as StageType];
      stages[stageType] = defaultStage ? { executors: [...defaultStage.executors] } : { executors: [] };
    }
  }

  const featureStages = [...new Set(v2.feature_pipeline.map(e => e.type as StageType))];
  const bugfixStages = [...new Set(v2.bugfix_pipeline.map(e => e.type as StageType))];

  return {
    version: '3.0',
    stages: stages as Record<StageType, StageConfig>,
    feature_pipeline: featureStages,
    bugfix_pipeline: bugfixStages,
    max_iterations: v2.max_iterations ?? 10,
    max_tdd_iterations: 5,
  };
}

// ─── v3-named → v3-inline Migration ─────────────────────────────────────────

/**
 * Migrate a v3 config with top-level named executors to v3 inline format.
 * Detects old format by presence of top-level 'executors' key.
 */
function migrateV3NamedToInline(config: Record<string, unknown>): DevBuddyConfig {
  const namedExecutors = config.executors as Record<string, { system_prompt: string; preset: string; model: string }>;
  const oldStages = config.stages as Record<string, { executors: Array<{ name: string; parallel?: boolean }> }>;
  const newStages: Record<string, StageConfig> = {};

  for (const [stageType, stageConfig] of Object.entries(oldStages)) {
    newStages[stageType] = {
      executors: stageConfig.executors.map(ref => {
        const exec = namedExecutors[ref.name];
        if (!exec) {
          throw new Error(`Migration failed: stage '${stageType}' references unknown executor '${ref.name}'`);
        }
        const inline: StageExecutor = {
          system_prompt: exec.system_prompt,
          preset: exec.preset,
          model: exec.model,
        };
        if (ref.parallel) inline.parallel = true;
        return inline;
      }),
    };
  }

  // Ensure all 6 stage types exist
  for (const stageType of VALID_STAGE_TYPES) {
    if (!newStages[stageType]) {
      const defaultStage = DEFAULT_V3_CONFIG.stages[stageType as StageType];
      newStages[stageType] = defaultStage ? { executors: [...defaultStage.executors] } : { executors: [] };
    }
  }

  return {
    version: '3.0',
    stages: newStages as Record<StageType, StageConfig>,
    feature_pipeline: (config.feature_pipeline || DEFAULT_V3_CONFIG.feature_pipeline) as StageType[],
    bugfix_pipeline: (config.bugfix_pipeline || DEFAULT_V3_CONFIG.bugfix_pipeline) as StageType[],
    max_iterations: (config.max_iterations as number) ?? 10,
    max_tdd_iterations: (config.max_tdd_iterations as number) ?? 5,
  };
}

// ─── v3 Validation ──────────────────────────────────────────────────────────

/**
 * Validate a v3 DevBuddyConfig (inline executor format).
 */
export function validateDevBuddyConfig(config: DevBuddyConfig): void {
  if (config.version !== '3.0') {
    throw new Error(`Invalid config version: '${config.version}'. Expected '3.0'.`);
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

  // Validate stages: all 6 stage types must exist
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

    // Synthesizer rule: last executor must be non-parallel when multiple executors
    if (stage.executors.length > 1) {
      const lastExec = stage.executors[stage.executors.length - 1];
      if (lastExec.parallel === true) {
        throw new Error(
          `Stage '${stageType}': last executor must be non-parallel (it acts as the synthesizer)`
        );
      }
    }
  }

  // Stages in active pipelines must have at least 1 executor
  for (const stageType of VALID_STAGE_TYPES) {
    const stage = config.stages[stageType as StageType];
    const inFeature = config.feature_pipeline.includes(stageType as StageType);
    const inBugfix = config.bugfix_pipeline.includes(stageType as StageType);
    if ((inFeature || inBugfix) && stage.executors.length === 0) {
      throw new Error(`Stage '${stageType}': must have at least 1 executor (used in active pipeline)`);
    }
  }

  // Validate pipelines
  for (const [key, pipeline] of [['feature_pipeline', config.feature_pipeline], ['bugfix_pipeline', config.bugfix_pipeline]] as const) {
    if (!Array.isArray(pipeline)) {
      throw new Error(`${key} must be an array`);
    }
    for (let i = 0; i < pipeline.length; i++) {
      if (!VALID_STAGE_TYPES.has(pipeline[i])) {
        throw new Error(`${key}[${i}]: invalid stage type '${pipeline[i]}'`);
      }
      if (pipeline[i] === 'rca' && key === 'feature_pipeline') {
        throw new Error(`${key}[${i}]: 'rca' is only allowed in bugfix_pipeline`);
      }
    }
  }

  // Validate numeric fields
  if (!Number.isInteger(config.max_iterations) || config.max_iterations <= 0) {
    throw new Error(`max_iterations must be a positive integer`);
  }
  if (!Number.isInteger(config.max_tdd_iterations) || config.max_tdd_iterations <= 0) {
    throw new Error(`max_tdd_iterations must be a positive integer`);
  }

  // Validate optional theme field
  if (config.theme !== undefined && config.theme !== 'light' && config.theme !== 'dark') {
    throw new Error(`theme must be 'light' or 'dark'`);
  }
}

// ─── Config Format Detection ────────────────────────────────────────────────

function isV3Inline(parsed: Record<string, unknown>): boolean {
  if (parsed.version !== '3.0') return false;
  // v3-inline: no top-level 'executors' key, stages have inline executor defs
  return !parsed.executors;
}

function isV3Named(parsed: Record<string, unknown>): boolean {
  if (parsed.version !== '3.0') return false;
  // v3-named: has top-level 'executors' key
  return !!parsed.executors;
}

// ─── Config Loading ─────────────────────────────────────────────────────────

/**
 * Load the dev-buddy config as v3-inline.
 * Auto-migrates from v2 or v3-named format and persists with backup.
 */
export function loadDevBuddyConfig(): DevBuddyConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    return DEFAULT_V3_CONFIG;
  }

  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`Config at ${CONFIG_PATH} is not valid JSON`);
  }

  // Already v3-inline — auto-fix synthesizer rule, then validate and return
  if (isV3Inline(parsed)) {
    const config = parsed as unknown as DevBuddyConfig;
    // Auto-fix: last executor in multi-executor stage must be non-parallel (synthesizer)
    let synthMigrated = false;
    for (const stage of Object.values(config.stages)) {
      if (stage.executors.length > 1 && stage.executors[stage.executors.length - 1].parallel === true) {
        stage.executors[stage.executors.length - 1].parallel = false;
        synthMigrated = true;
      }
    }
    if (synthMigrated) {
      const backupPath = `${CONFIG_PATH}.backup-synth-${Date.now()}`;
      fs.copyFileSync(CONFIG_PATH, backupPath);
      atomicWriteFile(CONFIG_PATH, config);
      console.error(`[Pipeline] Auto-migrated synthesizer rule (last executor non-parallel). Backup at ${backupPath}`);
    }
    validateDevBuddyConfig(config);
    return config;
  }

  // v3-named — migrate to v3-inline
  if (isV3Named(parsed)) {
    const v3 = migrateV3NamedToInline(parsed);
    validateDevBuddyConfig(v3);
    const backupPath = `${CONFIG_PATH}.v3-named.backup`;
    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(CONFIG_PATH, backupPath);
    }
    atomicWriteFile(CONFIG_PATH, v3);
    console.error(`[Pipeline] Auto-migrated config from v3-named to v3-inline. Backup at ${backupPath}`);
    return v3;
  }

  // v2 format — migrate to v3-inline
  const v2 = parsed as unknown as PipelineConfig;
  const v3 = migrateV2ToV3(v2);
  validateDevBuddyConfig(v3);
  const backupPath = `${CONFIG_PATH}.v2.backup`;
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(CONFIG_PATH, backupPath);
  }
  atomicWriteFile(CONFIG_PATH, v3);
  console.error(`[Pipeline] Auto-migrated config from v2 to v3-inline. Backup at ${backupPath}`);
  return v3;
}

// ─── Executor Resolution ────────────────────────────────────────────────────

/**
 * Resolve a stage executor's provider type.
 * Simple helper since inline executors already have all fields.
 */
export function resolveExecutor(executor: StageExecutor): StageExecutor & { providerType: 'subscription' | 'api' | 'cli' } {
  return {
    ...executor,
    providerType: getProviderType(executor.preset),
  };
}

// ─── Pipeline Expansion ─────────────────────────────────────────────────────

/** A single expanded task entry for pipeline-tasks.json. */
export interface ExpandedStageEntry {
  type: StageType;
  system_prompt: string;
  provider: string;
  model: string;
  providerType: 'subscription' | 'api' | 'cli';
  output_file: string;
  parallel_group_id: string | null;
  current_version: number;
}

/**
 * Expand a v3 pipeline config into task entries.
 * Each inline executor becomes one entry.
 */
export function expandPipelineToEntries(
  config: DevBuddyConfig,
  pipelineKey: 'feature_pipeline' | 'bugfix_pipeline',
): ExpandedStageEntry[] {
  const pipeline = config[pipelineKey];
  const entries: ExpandedStageEntry[] = [];
  const typeCounters: Record<string, number> = {};
  let parallelGroupCounter = 0;

  for (const stageType of pipeline) {
    const stageConfig = config.stages[stageType];
    if (!stageConfig) continue;

    let inParallelGroup = false;
    let currentGroupId: string | null = null;

    for (const exec of stageConfig.executors) {
      const providerType = getProviderType(exec.preset);
      typeCounters[stageType] = (typeCounters[stageType] || 0) + 1;
      const index = typeCounters[stageType];

      if (exec.parallel) {
        if (!inParallelGroup) {
          parallelGroupCounter++;
          currentGroupId = `pg_${parallelGroupCounter}`;
          inParallelGroup = true;
        }
      } else {
        inParallelGroup = false;
        currentGroupId = null;
      }

      const outputFile = getV3OutputFileName(stageType, exec.system_prompt, index, exec.preset, exec.model, 1);

      entries.push({
        type: stageType,
        system_prompt: exec.system_prompt,
        provider: exec.preset,
        model: exec.model,
        providerType,
        output_file: outputFile,
        parallel_group_id: currentGroupId,
        current_version: 1,
      });
    }
  }

  return entries;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const command = process.argv[2];

  try {
    switch (command) {
      case 'validate-v3': {
        const config = loadDevBuddyConfig();
        const stageCount = Object.values(config.stages).reduce((n, s) => n + s.executors.length, 0);
        console.log(`[Pipeline] v3 config valid. ${stageCount} total executors, ${config.feature_pipeline.length} feature stages, ${config.bugfix_pipeline.length} bugfix stages`);
        break;
      }

      case 'migrate': {
        const v3 = loadDevBuddyConfig();
        atomicWriteFile(CONFIG_PATH, v3);
        const stageCount = Object.values(v3.stages).reduce((n, s) => n + s.executors.length, 0);
        console.log(`[Pipeline] Config migrated to v3-inline. ${stageCount} total executors.`);
        break;
      }

      default:
        console.error(`Unknown command: ${command}. Use: validate-v3, migrate`);
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
