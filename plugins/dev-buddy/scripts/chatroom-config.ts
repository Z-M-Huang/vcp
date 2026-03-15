/**
 * Chatroom configuration management.
 *
 * Loads and validates ~/.vcp/dev-buddy-chatroom.json.
 *
 * Config format: participants array + max_rounds.
 * Participants reference presets from ~/.vcp/ai-presets.json.
 */

import fs from 'fs';
import path from 'path';
import { CONFIG_DIR, readPresets } from './preset-utils.ts';
import type { ChatroomConfig, ChatroomParticipant } from '../types/chatroom.ts';
import type { PresetConfig, CliPreset } from '../types/presets.ts';
import { MODEL_NAME_REGEX } from '../types/stage-definitions.ts';
import { atomicWriteFile } from './pipeline-config.ts';
import { discoverSystemPrompts } from './system-prompts.ts';

// Config path: ~/.vcp/dev-buddy-chatroom.json
export const CHATROOM_CONFIG_PATH = path.join(CONFIG_DIR, 'dev-buddy-chatroom.json');

// ─── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_CHATROOM_CONFIG: ChatroomConfig = {
  participants: [],
  max_rounds: 3,
};

// ─── Field Allowlists (CWE-915) ─────────────────────────────────────────────

export const ALLOWED_CHATROOM_FIELDS = new Set(['participants', 'max_rounds']);
export const ALLOWED_PARTICIPANT_FIELDS = new Set(['preset', 'model', 'system_prompt']);

// ─── Config Loading ──────────────────────────────────────────────────────────

/**
 * Load and validate the chatroom config from disk.
 *
 * Behavior:
 * - No file: returns DEFAULT_CHATROOM_CONFIG
 * - Valid JSON: validates structure, merges with defaults, returns
 * - Invalid JSON or invalid structure: throws (fail fast, no fallbacks)
 */
export function loadChatroomConfig(configPath = CHATROOM_CONFIG_PATH): ChatroomConfig {
  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_CHATROOM_CONFIG, participants: [] };
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`Chatroom config at ${configPath} is not valid JSON`);
  }

  // Structural validation (fail fast)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Chatroom config at ${configPath} must be a JSON object`);
  }

  // Reject unknown top-level fields
  const unknownFields = Object.keys(parsed).filter(k => !ALLOWED_CHATROOM_FIELDS.has(k));
  if (unknownFields.length > 0) {
    throw new Error(`Chatroom config has unknown fields: ${unknownFields.join(', ')}`);
  }

  // Validate participants array structure
  if ('participants' in parsed) {
    if (!Array.isArray(parsed.participants)) {
      throw new Error('Chatroom config: participants must be an array');
    }
    const participants = parsed.participants as unknown[];
    if (participants.length > 10) {
      throw new Error('Chatroom config: maximum 10 participants allowed');
    }
    for (let i = 0; i < participants.length; i++) {
      const p = participants[i];
      if (!p || typeof p !== 'object' || Array.isArray(p)) {
        throw new Error(`Chatroom config: participants[${i}] must be an object`);
      }
      const pObj = p as Record<string, unknown>;
      const unknownPFields = Object.keys(pObj).filter(k => !ALLOWED_PARTICIPANT_FIELDS.has(k));
      if (unknownPFields.length > 0) {
        throw new Error(`Chatroom config: participants[${i}] has unknown fields: ${unknownPFields.join(', ')}`);
      }
      if (typeof pObj.preset !== 'string' || pObj.preset.trim() === '') {
        throw new Error(`Chatroom config: participants[${i}].preset must be a non-empty string`);
      }
      if (typeof pObj.model !== 'string' || pObj.model.trim() === '') {
        throw new Error(`Chatroom config: participants[${i}].model must be a non-empty string`);
      }
      if (typeof pObj.model === 'string' && !MODEL_NAME_REGEX.test(pObj.model)) {
        throw new Error(`Chatroom config: participants[${i}].model contains invalid characters`);
      }
    }
  }

  // Validate max_rounds
  if ('max_rounds' in parsed) {
    const mr = parsed.max_rounds;
    if (!Number.isInteger(mr) || (mr as number) < 1 || (mr as number) > 10) {
      throw new Error('Chatroom config: max_rounds must be an integer between 1 and 10');
    }
  }

  // Merge with defaults
  return {
    participants: Array.isArray(parsed.participants)
      ? (parsed.participants as ChatroomParticipant[])
      : [...DEFAULT_CHATROOM_CONFIG.participants],
    max_rounds: typeof parsed.max_rounds === 'number'
      ? (parsed.max_rounds as number)
      : DEFAULT_CHATROOM_CONFIG.max_rounds,
  };
}

// ─── Config Saving ───────────────────────────────────────────────────────────

/**
 * Save chatroom config atomically to disk.
 */
export function saveChatroomConfig(config: ChatroomConfig, configPath = CHATROOM_CONFIG_PATH): void {
  atomicWriteFile(configPath, config);
}

// ─── Validation for API Endpoint ─────────────────────────────────────────────

/**
 * Validate a chatroom config body from the API.
 * Returns an error message string on failure, null on success.
 *
 * Validation rules:
 * - Reject unknown fields (CWE-915)
 * - participants: array, length 0–10
 * - Each participant: preset must exist, model must be valid for that preset
 * - CLI presets must have one_shot_args_template configured
 * - max_rounds: integer 1–10
 */
export function validateChatroomConfig(body: unknown, presets: PresetConfig): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Config must be a JSON object';
  }
  const obj = body as Record<string, unknown>;

  // Reject unknown top-level fields
  const unknownFields = Object.keys(obj).filter(k => !ALLOWED_CHATROOM_FIELDS.has(k));
  if (unknownFields.length > 0) {
    return `Unknown fields rejected: ${unknownFields.join(', ')}`;
  }

  // Validate participants
  if (!Array.isArray(obj.participants)) {
    return "'participants' must be an array";
  }
  const participants = obj.participants as unknown[];
  if (participants.length > 10) {
    return 'Maximum 10 participants allowed';
  }

  for (let i = 0; i < participants.length; i++) {
    const p = participants[i];
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      return `participants[${i}]: must be an object`;
    }
    const pObj = p as Record<string, unknown>;

    // Reject unknown participant fields
    const unknownPFields = Object.keys(pObj).filter(k => !ALLOWED_PARTICIPANT_FIELDS.has(k));
    if (unknownPFields.length > 0) {
      return `participants[${i}]: unknown fields rejected: ${unknownPFields.join(', ')}`;
    }

    if (typeof pObj.preset !== 'string' || pObj.preset.trim() === '') {
      return `participants[${i}]: preset must be a non-empty string`;
    }
    if (typeof pObj.model !== 'string' || pObj.model.trim() === '') {
      return `participants[${i}]: model must be a non-empty string`;
    }

    // Validate model name format
    if (!MODEL_NAME_REGEX.test(pObj.model as string)) {
      return `participants[${i}]: model '${pObj.model}' contains invalid characters`;
    }

    // Validate preset exists
    const preset = presets.presets[pObj.preset as string];
    if (!preset) {
      return `participants[${i}]: preset '${pObj.preset}' not found`;
    }

    // Validate model exists in preset
    const model = pObj.model as string;
    if (preset.type === 'subscription') {
      if (!['haiku', 'sonnet', 'opus'].includes(model)) {
        return `participants[${i}]: model '${model}' is not valid for subscription preset (use haiku, sonnet, or opus)`;
      }
    } else if (preset.type === 'api' || preset.type === 'cli') {
      if (!preset.models.includes(model)) {
        return `participants[${i}]: model '${model}' not found in preset '${pObj.preset}'. Available: ${preset.models.join(', ')}`;
      }
    }

    // CLI presets must have one_shot_args_template
    if (preset.type === 'cli') {
      if (!(preset as CliPreset).one_shot_args_template) {
        return `participants[${i}]: CLI preset '${pObj.preset}' has no one_shot_args_template configured`;
      }
    }

    // Validate optional system_prompt name against discovered prompts
    if ('system_prompt' in pObj && pObj.system_prompt !== '' && pObj.system_prompt !== undefined) {
      if (typeof pObj.system_prompt !== 'string') {
        return `participants[${i}]: system_prompt must be a string`;
      }
      const builtInDir = path.join(import.meta.dir, '..', 'system-prompts', 'built-in');
      try {
        const prompts = discoverSystemPrompts(builtInDir);
        const names = new Set(prompts.map(p => p.name));
        if (!names.has(pObj.system_prompt)) {
          return `participants[${i}]: system_prompt '${pObj.system_prompt}' not found. Available: ${[...names].join(', ')}`;
        }
      } catch { /* discovery failure is non-fatal for validation */ }
    }
  }

  // Validate max_rounds
  if (!('max_rounds' in obj)) {
    return "'max_rounds' is required";
  }
  const mr = obj.max_rounds;
  if (!Number.isInteger(mr) || (mr as number) < 1 || (mr as number) > 10) {
    return "'max_rounds' must be an integer between 1 and 10";
  }

  return null;
}
