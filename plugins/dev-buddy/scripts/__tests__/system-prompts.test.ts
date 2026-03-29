import { describe, expect, test } from 'bun:test';
import path from 'path';
import {
  loadStageDefinition,
  composePrompt,
  discoverSystemPrompts,
  getSystemPrompt,
} from '../system-prompts.ts';

const STAGES_DIR = path.join(import.meta.dir, '..', '..', 'stages');
const BUILT_IN_DIR = path.join(import.meta.dir, '..', '..', 'system-prompts', 'built-in');

// ─── Stage Definition Loading ───────────────────────────────────────────────

describe('loadStageDefinition', () => {
  const stageTypes = ['discovery', 'ralph-requirements', 'decomposition', 'ralph-build', 'ralph-code-review', 'ralph-uat'] as const;

  for (const stageType of stageTypes) {
    test(`loads ${stageType} stage definition`, () => {
      const stage = loadStageDefinition(stageType, STAGES_DIR);
      expect(stage).not.toBeNull();
      expect(stage!.stage).toBe(stageType);
      expect(stage!.description).toBeTruthy();
      expect(stage!.tools).toBeInstanceOf(Array);
      expect(stage!.tools.length).toBeGreaterThan(0);
      expect(stage!.content).toBeTruthy();
      expect(stage!.filePath).toContain(`${stageType}.md`);
    });
  }

  test('returns null for unknown stage type', () => {
    const stage = loadStageDefinition('nonexistent', STAGES_DIR);
    expect(stage).toBeNull();
  });

  test('returns null for nonexistent directory', () => {
    const stage = loadStageDefinition('discovery', '/nonexistent/dir');
    expect(stage).toBeNull();
  });

  test('discovery stage has read-only tools (no Bash)', () => {
    const stage = loadStageDefinition('discovery', STAGES_DIR);
    expect(stage!.tools).toContain('Read');
    expect(stage!.tools).toContain('Glob');
    expect(stage!.tools).toContain('Grep');
    expect(stage!.tools).not.toContain('Bash');
  });

  test('ralph-build stage has all implementation tools', () => {
    const stage = loadStageDefinition('ralph-build', STAGES_DIR);
    expect(stage!.tools).toContain('Write');
    expect(stage!.tools).toContain('Edit');
    expect(stage!.tools).toContain('Bash');
  });

  test('ralph-code-review stage disallows Edit', () => {
    const stage = loadStageDefinition('ralph-code-review', STAGES_DIR);
    expect(stage!.disallowedTools).toContain('Edit');
  });

  test('ralph-uat stage disallows Edit and Write', () => {
    const stage = loadStageDefinition('ralph-uat', STAGES_DIR);
    expect(stage!.disallowedTools).toContain('Edit');
    expect(stage!.disallowedTools).toContain('Write');
  });
});

// ─── Role Prompt Loading ────────────────────────────────────────────────────

describe('role prompts', () => {
  test('discovers all 6 built-in Ralph role prompts (plus custom)', () => {
    const prompts = discoverSystemPrompts(BUILT_IN_DIR);
    const builtIn = prompts.filter(p => p.source === 'built-in');
    // At least 6 Ralph built-in prompts (may have more custom ones discovered)
    expect(builtIn.length).toBeGreaterThanOrEqual(6);

    const names = builtIn.map(p => p.name);
    expect(names).toContain('discoverer');
    expect(names).toContain('ralph-requirements-analyst');
    expect(names).toContain('decomposer');
    expect(names).toContain('unit-builder');
    expect(names).toContain('ralph-code-reviewer');
    expect(names).toContain('uat-evaluator');
  });

  test('role prompts have empty tools array (tools defined on stage, not role)', () => {
    const prompts = discoverSystemPrompts(BUILT_IN_DIR);
    const ralph = ['discoverer', 'ralph-requirements-analyst', 'decomposer', 'unit-builder', 'ralph-code-reviewer', 'uat-evaluator'];
    for (const p of prompts.filter(p => ralph.includes(p.name))) {
      expect(p.tools).toEqual([]);
    }
  });

  test('role prompts contain Core Competencies section', () => {
    const prompts = discoverSystemPrompts(BUILT_IN_DIR);
    const ralph = ['discoverer', 'ralph-requirements-analyst', 'decomposer', 'unit-builder', 'ralph-code-reviewer', 'uat-evaluator'];
    for (const p of prompts.filter(p => ralph.includes(p.name))) {
      expect(p.content).toContain('Core Competencies');
    }
  });

  test('getSystemPrompt resolves by name', () => {
    const prompt = getSystemPrompt('discoverer', BUILT_IN_DIR);
    expect(prompt).not.toBeNull();
    expect(prompt!.name).toBe('discoverer');
    expect(prompt!.description).toBeTruthy();
  });

  test('old prompt names no longer resolve', () => {
    const prompt = getSystemPrompt('plan-reviewer', BUILT_IN_DIR);
    expect(prompt).toBeNull();
  });
});

// ─── Prompt Composition ─────────────────────────────────────────────────────

describe('composePrompt', () => {
  test('composes stage + role with separator', () => {
    const stage = loadStageDefinition('ralph-code-review', STAGES_DIR)!;
    const role = getSystemPrompt('ralph-code-reviewer', BUILT_IN_DIR)!;
    const composed = composePrompt(stage, role);

    // Separator between stage and role
    expect(composed).toContain('\n\n---\n\n');

    // Both sections present
    expect(composed).toContain('Code Review Stage');
    expect(composed).toContain('Core Competencies');
  });

  test('stage content comes before role content', () => {
    const stage = loadStageDefinition('discovery', STAGES_DIR)!;
    const role = getSystemPrompt('discoverer', BUILT_IN_DIR)!;
    const composed = composePrompt(stage, role);

    const stagePos = composed.indexOf('Discovery Stage');
    const rolePos = composed.indexOf('Core Competencies');
    expect(stagePos).toBeGreaterThan(-1);
    expect(rolePos).toBeGreaterThan(-1);
    expect(stagePos).toBeLessThan(rolePos);
  });
});
