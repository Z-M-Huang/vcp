import { describe, expect, test } from 'bun:test';
import {
  VALID_STAGE_TYPES,
  VALID_LEGACY_STAGE_TYPES,
  STAGE_DEFINITIONS,
  LEGACY_STAGE_MAPPING,
  LEGACY_AGENT_TYPES,
  MODEL_NAME_REGEX,
} from './stage-definitions.ts';
import type { StageType, LegacyStageType } from './stage-definitions.ts';

// ─── VALID_STAGE_TYPES ───────────────────────────────────────────────────────

describe('VALID_STAGE_TYPES', () => {
  test('contains all 7 stage types (6 pipeline + 1 optional)', () => {
    expect(VALID_STAGE_TYPES.size).toBe(7);
    for (const t of ['discovery', 'ralph-requirements', 'decomposition', 'ralph-build', 'ralph-code-review', 'ralph-uat', 'unit-review']) {
      expect(VALID_STAGE_TYPES.has(t)).toBe(true);
    }
  });

  test('does not contain legacy stage types', () => {
    for (const t of ['requirements', 'planning', 'plan-review', 'implementation', 'code-review', 'rca']) {
      expect(VALID_STAGE_TYPES.has(t)).toBe(false);
    }
  });
});

// ─── STAGE_DEFINITIONS ──────────────────────────────────────────────────────

describe('STAGE_DEFINITIONS', () => {
  test('every stage has agent_type', () => {
    for (const [, def] of Object.entries(STAGE_DEFINITIONS)) {
      expect(typeof def.agent_type).toBe('string');
      expect(def.agent_type.length).toBeGreaterThan(0);
    }
  });

  test('ralph-build is singleton with max 1 executor', () => {
    expect(STAGE_DEFINITIONS['ralph-build'].singleton).toBe(true);
    expect(STAGE_DEFINITIONS['ralph-build'].max_executors).toBe(1);
  });

  test('ralph-uat is singleton with max 1 executor', () => {
    expect(STAGE_DEFINITIONS['ralph-uat'].singleton).toBe(true);
    expect(STAGE_DEFINITIONS['ralph-uat'].max_executors).toBe(1);
  });

  test('multi-executor stages have no max_executors', () => {
    expect(STAGE_DEFINITIONS['discovery'].max_executors).toBeUndefined();
    expect(STAGE_DEFINITIONS['ralph-requirements'].max_executors).toBeUndefined();
    expect(STAGE_DEFINITIONS['decomposition'].max_executors).toBeUndefined();
    expect(STAGE_DEFINITIONS['ralph-code-review'].max_executors).toBeUndefined();
  });
});

// ─── Legacy Mappings ─────────────────────────────────────────────────────────

describe('LEGACY_STAGE_MAPPING', () => {
  test('maps all 6 legacy types to valid Ralph types', () => {
    const legacyTypes: LegacyStageType[] = ['requirements', 'planning', 'plan-review', 'implementation', 'code-review', 'rca'];
    for (const lt of legacyTypes) {
      const mapped = LEGACY_STAGE_MAPPING[lt];
      expect(VALID_STAGE_TYPES.has(mapped)).toBe(true);
    }
  });

  test('plan-review and rca both map to discovery', () => {
    expect(LEGACY_STAGE_MAPPING['plan-review']).toBe('discovery');
    expect(LEGACY_STAGE_MAPPING['rca']).toBe('discovery');
  });
});

describe('LEGACY_AGENT_TYPES', () => {
  test('has agent types for all 6 legacy stages', () => {
    expect(Object.keys(LEGACY_AGENT_TYPES).length).toBe(6);
  });
});

// ─── VALID_LEGACY_STAGE_TYPES ────────────────────────────────────────────────

describe('VALID_LEGACY_STAGE_TYPES', () => {
  test('contains all 6 legacy types', () => {
    expect(VALID_LEGACY_STAGE_TYPES.size).toBe(6);
    for (const t of ['requirements', 'planning', 'plan-review', 'implementation', 'code-review', 'rca']) {
      expect(VALID_LEGACY_STAGE_TYPES.has(t)).toBe(true);
    }
  });
});

// ─── MODEL_NAME_REGEX ────────────────────────────────────────────────────────

describe('MODEL_NAME_REGEX', () => {
  test('accepts valid model names', () => {
    expect(MODEL_NAME_REGEX.test('sonnet')).toBe(true);
    expect(MODEL_NAME_REGEX.test('gpt-5.4')).toBe(true);
    expect(MODEL_NAME_REGEX.test('MiniMax-M2.5')).toBe(true);
  });

  test('rejects names with special chars', () => {
    expect(MODEL_NAME_REGEX.test('model name')).toBe(false);
    expect(MODEL_NAME_REGEX.test('model;drop')).toBe(false);
    expect(MODEL_NAME_REGEX.test('')).toBe(false);
  });
});
