import { describe, expect, test } from 'bun:test';
import path from 'path';
import {
  loadStageDefinition,
  composePrompt,
  discoverSystemPrompts,
  getSystemPrompt,
} from '../system-prompts.ts';
import type { StagePrompt, SystemPrompt } from '../system-prompts.ts';

const STAGES_DIR = path.join(import.meta.dir, '..', '..', 'stages');
const BUILT_IN_DIR = path.join(import.meta.dir, '..', '..', 'system-prompts', 'built-in');

// ─── Stage Definition Loading ───────────────────────────────────────────────

describe('loadStageDefinition', () => {
  const stageTypes = ['requirements', 'planning', 'plan-review', 'implementation', 'code-review', 'rca'] as const;

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
    const stage = loadStageDefinition('plan-review', '/nonexistent/dir');
    expect(stage).toBeNull();
  });

  test('plan-review stage has correct tools', () => {
    const stage = loadStageDefinition('plan-review', STAGES_DIR);
    expect(stage!.tools).toContain('Read');
    expect(stage!.tools).toContain('Write');
    expect(stage!.tools).not.toContain('Bash');
    expect(stage!.disallowedTools).toContain('Edit');
    expect(stage!.disallowedTools).toContain('Bash');
  });

  test('implementation stage has all tools including TaskCreate', () => {
    const stage = loadStageDefinition('implementation', STAGES_DIR);
    expect(stage!.tools).toContain('TaskCreate');
    expect(stage!.tools).toContain('Bash');
    expect(stage!.tools).toContain('Edit');
  });

  test('plan-review stage starts with Output Contract', () => {
    const stage = loadStageDefinition('plan-review', STAGES_DIR);
    expect(stage!.content).toMatch(/^# Plan Review Stage\s+## Output Contract/);
  });

  test('code-review stage starts with Output Contract', () => {
    const stage = loadStageDefinition('code-review', STAGES_DIR);
    expect(stage!.content).toMatch(/Output Contract/);
  });
});

// ─── Role Prompt Loading (Stripped System Prompts) ──────────────────────────

describe('role prompts (stripped system prompts)', () => {
  test('discovers all 6 built-in role prompts', () => {
    const prompts = discoverSystemPrompts(BUILT_IN_DIR);
    const builtIn = prompts.filter(p => p.source === 'built-in');
    expect(builtIn.length).toBe(6);

    const names = builtIn.map(p => p.name).sort();
    expect(names).toEqual([
      'code-reviewer',
      'implementer',
      'plan-reviewer',
      'planner',
      'requirements-gatherer',
      'root-cause-analyst',
    ]);
  });

  test('role prompts have empty tools array', () => {
    const prompts = discoverSystemPrompts(BUILT_IN_DIR);
    for (const p of prompts.filter(p => p.source === 'built-in')) {
      expect(p.tools).toEqual([]);
    }
  });

  test('role prompts contain competencies, not output format', () => {
    const prompts = discoverSystemPrompts(BUILT_IN_DIR);
    for (const p of prompts.filter(p => p.source === 'built-in')) {
      expect(p.content).toContain('Core Competencies');
      expect(p.content).not.toContain('## Output Format');
      expect(p.content).not.toContain('## Output Contract');
      expect(p.content).not.toContain('## Completion Requirements');
    }
  });

  test('getSystemPrompt resolves by name', () => {
    const prompt = getSystemPrompt('plan-reviewer', BUILT_IN_DIR);
    expect(prompt).not.toBeNull();
    expect(prompt!.name).toBe('plan-reviewer');
    expect(prompt!.description).toBeTruthy();
  });
});

// ─── Prompt Composition ─────────────────────────────────────────────────────

describe('composePrompt', () => {
  test('composes stage + role with separator', () => {
    const stage = loadStageDefinition('plan-review', STAGES_DIR)!;
    const role = getSystemPrompt('plan-reviewer', BUILT_IN_DIR)!;
    const composed = composePrompt(stage, role);

    // Stage content comes first
    expect(composed.indexOf('Output Contract')).toBeLessThan(composed.indexOf('Core Competencies'));

    // Separator between stage and role
    expect(composed).toContain('\n\n---\n\n');

    // Both sections present
    expect(composed).toContain('Output Contract');
    expect(composed).toContain('Core Competencies');
  });

  test('composed prompt has stage rules before role expertise', () => {
    const stage = loadStageDefinition('code-review', STAGES_DIR)!;
    const role = getSystemPrompt('code-reviewer', BUILT_IN_DIR)!;
    const composed = composePrompt(stage, role);

    const contractPos = composed.indexOf('Output Contract');
    const competenciesPos = composed.indexOf('Core Competencies');
    expect(contractPos).toBeGreaterThan(-1);
    expect(competenciesPos).toBeGreaterThan(-1);
    expect(contractPos).toBeLessThan(competenciesPos);
  });
});

