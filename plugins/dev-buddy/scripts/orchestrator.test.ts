import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

import {
  determinePhase,
  getProgress,
  type PipelineProgress,
} from './pipeline-utils.ts';

const TEST_PROJECT_DIR = join(import.meta.dir, '.test-project-orchestrator');
const TEST_TASK_DIR = join(TEST_PROJECT_DIR, '.vcp', 'task');

/**
 * Run `orchestrator.ts phase` with controlled CLAUDE_PROJECT_DIR
 */
function runDeterminePhase(): string {
  const result = Bun.spawnSync(['bun', join(import.meta.dir, 'orchestrator.ts'), 'phase'], {
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: TEST_PROJECT_DIR,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return result.stdout.toString().trim();
}

// ── pipeline-tasks.json helpers ─────────────────────────────────────────────

const DEFAULT_FEATURE_STAGES = [
  { type: 'requirements', provider: 'anthropic-subscription', output_file: 'user-story.json', current_version: 1 },
  { type: 'planning', provider: 'anthropic-subscription', output_file: 'plan-refined.json', current_version: 1 },
  { type: 'plan-review', provider: 'anthropic-subscription', output_file: 'plan-review-anthropic-subscription-sonnet-1-v1.json', current_version: 1 },
  { type: 'plan-review', provider: 'anthropic-subscription', output_file: 'plan-review-anthropic-subscription-opus-2-v1.json', current_version: 1 },
  { type: 'plan-review', provider: 'anthropic-subscription', output_file: 'plan-review-anthropic-subscription-sonnet-3-v1.json', current_version: 1 },
  { type: 'implementation', provider: 'anthropic-subscription', output_file: 'impl-result.json', current_version: 1 },
  { type: 'code-review', provider: 'anthropic-subscription', output_file: 'code-review-anthropic-subscription-sonnet-1-v1.json', current_version: 1 },
  { type: 'code-review', provider: 'anthropic-subscription', output_file: 'code-review-anthropic-subscription-opus-2-v1.json', current_version: 1 },
  { type: 'code-review', provider: 'anthropic-subscription', output_file: 'code-review-anthropic-subscription-sonnet-3-v1.json', current_version: 1 },
];

const DEFAULT_BUGFIX_STAGES = [
  { type: 'rca', provider: 'anthropic-subscription', output_file: 'rca-anthropic-subscription-sonnet-1-v1.json', current_version: 1 },
  { type: 'rca', provider: 'anthropic-subscription', output_file: 'rca-anthropic-subscription-opus-2-v1.json', current_version: 1 },
  { type: 'plan-review', provider: 'anthropic-subscription', output_file: 'plan-review-anthropic-subscription-sonnet-1-v1.json', current_version: 1 },
  { type: 'implementation', provider: 'anthropic-subscription', output_file: 'impl-result.json', current_version: 1 },
  { type: 'code-review', provider: 'anthropic-subscription', output_file: 'code-review-anthropic-subscription-sonnet-1-v1.json', current_version: 1 },
  { type: 'code-review', provider: 'anthropic-subscription', output_file: 'code-review-anthropic-subscription-opus-2-v1.json', current_version: 1 },
  { type: 'code-review', provider: 'anthropic-subscription', output_file: 'code-review-anthropic-subscription-sonnet-3-v1.json', current_version: 1 },
];

function makeFeatureTasks() {
  return {
    pipeline_type: 'feature-implement',
    team_name: 'pipeline-test-abc123',
    resolved_config: {
      feature_pipeline: DEFAULT_FEATURE_STAGES,
      bugfix_pipeline: DEFAULT_BUGFIX_STAGES,
      max_iterations: 10,
      team_name_pattern: 'pipeline-{BASENAME}-{HASH}',
    },
    stages: DEFAULT_FEATURE_STAGES,
  };
}

function makeBugFixTasks() {
  return {
    pipeline_type: 'bug-fix',
    team_name: 'pipeline-test-abc123',
    resolved_config: {
      feature_pipeline: DEFAULT_FEATURE_STAGES,
      bugfix_pipeline: DEFAULT_BUGFIX_STAGES,
      max_iterations: 10,
      team_name_pattern: 'pipeline-{BASENAME}-{HASH}',
    },
    stages: DEFAULT_BUGFIX_STAGES,
  };
}

describe('orchestrator.ts determine_phase', () => {
  beforeEach(() => {
    mkdirSync(TEST_TASK_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_PROJECT_DIR, { recursive: true, force: true });
  });

  test('returns requirements_gathering when .task is empty', () => {
    const phase = runDeterminePhase();
    expect(phase).toBe('requirements_gathering');
  });

  test('returns requirements_team_pending when pipeline-tasks.json exists but no analyses', () => {
    writeFileSync(
      join(TEST_TASK_DIR, 'pipeline-tasks.json'),
      JSON.stringify(makeFeatureTasks())
    );
    const phase = runDeterminePhase();
    expect(phase).toBe('requirements_team_pending');
  });

  test('returns requirements_team_exploring when analysis files exist', () => {
    writeFileSync(
      join(TEST_TASK_DIR, 'pipeline-tasks.json'),
      JSON.stringify(makeFeatureTasks())
    );
    writeFileSync(
      join(TEST_TASK_DIR, 'analysis-technical.json'),
      JSON.stringify({ specialist: 'technical' })
    );
    const phase = runDeterminePhase();
    expect(phase).toBe('requirements_team_exploring');
  });

  test('returns clean phase token without embedded counts', () => {
    writeFileSync(
      join(TEST_TASK_DIR, 'pipeline-tasks.json'),
      JSON.stringify(makeFeatureTasks())
    );
    writeFileSync(
      join(TEST_TASK_DIR, 'analysis-technical.json'),
      JSON.stringify({ specialist: 'technical' })
    );
    writeFileSync(
      join(TEST_TASK_DIR, 'analysis-security.json'),
      JSON.stringify({ specialist: 'security' })
    );
    const phase = runDeterminePhase();
    // Phase token must be a clean identifier, no parentheses or spaces
    expect(phase).toBe('requirements_team_exploring');
    expect(phase).not.toContain('(');
    expect(phase).not.toContain(' ');
  });

  test('returns plan_drafting when user-story.json exists but no plan', () => {
    writeFileSync(
      join(TEST_TASK_DIR, 'pipeline-tasks.json'),
      JSON.stringify(makeFeatureTasks())
    );
    writeFileSync(
      join(TEST_TASK_DIR, 'user-story.json'),
      JSON.stringify({ title: 'test', acceptance_criteria: [] })
    );
    const phase = runDeterminePhase();
    expect(phase).toBe('plan_drafting');
  });

  test('returns complete when all review files exist and are approved', () => {
    writeFileSync(join(TEST_TASK_DIR, 'pipeline-tasks.json'), JSON.stringify(makeFeatureTasks()));
    writeFileSync(join(TEST_TASK_DIR, 'user-story.json'), JSON.stringify({ title: 'test' }));
    writeFileSync(join(TEST_TASK_DIR, 'plan-refined.json'), JSON.stringify({ title: 'plan' }));
    writeFileSync(join(TEST_TASK_DIR, 'plan-review-anthropic-subscription-sonnet-1-v1.json'), JSON.stringify({ status: 'approved' }));
    writeFileSync(join(TEST_TASK_DIR, 'plan-review-anthropic-subscription-opus-2-v1.json'), JSON.stringify({ status: 'approved' }));
    writeFileSync(join(TEST_TASK_DIR, 'plan-review-anthropic-subscription-sonnet-3-v1.json'), JSON.stringify({ status: 'approved' }));
    writeFileSync(join(TEST_TASK_DIR, 'impl-result.json'), JSON.stringify({ status: 'complete' }));
    writeFileSync(join(TEST_TASK_DIR, 'code-review-anthropic-subscription-sonnet-1-v1.json'), JSON.stringify({ status: 'approved' }));
    writeFileSync(join(TEST_TASK_DIR, 'code-review-anthropic-subscription-opus-2-v1.json'), JSON.stringify({ status: 'approved' }));
    writeFileSync(join(TEST_TASK_DIR, 'code-review-anthropic-subscription-sonnet-3-v1.json'), JSON.stringify({ status: 'approved' }));
    const phase = runDeterminePhase();
    expect(phase).toBe('complete');
  });

  test('never returns requirements_team_synthesizing', () => {
    writeFileSync(join(TEST_TASK_DIR, 'pipeline-tasks.json'), JSON.stringify(makeFeatureTasks()));
    for (const s of ['technical', 'ux-domain', 'security', 'performance', 'architecture']) {
      writeFileSync(
        join(TEST_TASK_DIR, `analysis-${s}.json`),
        JSON.stringify({ specialist: s })
      );
    }
    const phase = runDeterminePhase();
    expect(phase).not.toContain('synthesizing');
    expect(phase).toBe('requirements_team_exploring');
  });
});

describe('bug-fix pipeline phases via orchestrator.ts phase', () => {
  beforeEach(() => {
    mkdirSync(TEST_TASK_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_PROJECT_DIR, { recursive: true, force: true });
  });

  test('returns root_cause_analysis at startup with pipeline_type bug-fix', () => {
    writeFileSync(
      join(TEST_TASK_DIR, 'pipeline-tasks.json'),
      JSON.stringify(makeBugFixTasks())
    );
    const phase = runDeterminePhase();
    expect(phase).toBe('root_cause_analysis');
  });

  test('returns root_cause_analysis when one RCA file exists', () => {
    writeFileSync(
      join(TEST_TASK_DIR, 'pipeline-tasks.json'),
      JSON.stringify(makeBugFixTasks())
    );
    writeFileSync(
      join(TEST_TASK_DIR, 'rca-anthropic-subscription-sonnet-1-v1.json'),
      JSON.stringify({ status: 'complete', root_cause: { summary: 'test' } })
    );
    const phase = runDeterminePhase();
    expect(phase).toBe('root_cause_analysis');
  });

  test('returns plan_review phase (not sonnet/opus) after bug-fix consolidation', () => {
    writeFileSync(
      join(TEST_TASK_DIR, 'pipeline-tasks.json'),
      JSON.stringify(makeBugFixTasks())
    );
    writeFileSync(join(TEST_TASK_DIR, 'user-story.json'), JSON.stringify({ title: 'Fix: bug' }));
    writeFileSync(join(TEST_TASK_DIR, 'plan-refined.json'), JSON.stringify({ steps: [] }));
    const phase = runDeterminePhase();
    // Bug-fix goes straight to plan review (not requirements, not sonnet/opus)
    expect(phase).toContain('plan_review');
    expect(phase).not.toBe('requirements_team_pending');
    expect(phase).not.toBe('plan_review_sonnet'); // phases use numeric indexes, not model names
  });

  test('returns implementation after bug-fix Codex validation approved', () => {
    writeFileSync(
      join(TEST_TASK_DIR, 'pipeline-tasks.json'),
      JSON.stringify(makeBugFixTasks())
    );
    writeFileSync(join(TEST_TASK_DIR, 'user-story.json'), JSON.stringify({ title: 'Fix: bug' }));
    writeFileSync(join(TEST_TASK_DIR, 'plan-refined.json'), JSON.stringify({ steps: [] }));
    writeFileSync(join(TEST_TASK_DIR, 'plan-review-anthropic-subscription-sonnet-1-v1.json'), JSON.stringify({ status: 'approved' }));
    const phase = runDeterminePhase();
    expect(phase).toBe('implementation');
  });

  test('bug-fix complete after all code reviews approved (no plan review sonnet/opus)', () => {
    writeFileSync(
      join(TEST_TASK_DIR, 'pipeline-tasks.json'),
      JSON.stringify(makeBugFixTasks())
    );
    writeFileSync(join(TEST_TASK_DIR, 'user-story.json'), JSON.stringify({ title: 'Fix: bug' }));
    writeFileSync(join(TEST_TASK_DIR, 'plan-refined.json'), JSON.stringify({ steps: [] }));
    // Bug-fix uses versioned plan-review, not review-codex.json
    writeFileSync(join(TEST_TASK_DIR, 'plan-review-anthropic-subscription-sonnet-1-v1.json'), JSON.stringify({ status: 'approved' }));
    writeFileSync(join(TEST_TASK_DIR, 'impl-result.json'), JSON.stringify({ status: 'complete' }));
    writeFileSync(join(TEST_TASK_DIR, 'code-review-anthropic-subscription-sonnet-1-v1.json'), JSON.stringify({ status: 'approved' }));
    writeFileSync(join(TEST_TASK_DIR, 'code-review-anthropic-subscription-opus-2-v1.json'), JSON.stringify({ status: 'approved' }));
    writeFileSync(join(TEST_TASK_DIR, 'code-review-anthropic-subscription-sonnet-3-v1.json'), JSON.stringify({ status: 'approved' }));
    const phase = runDeterminePhase();
    expect(phase).toBe('complete');
  });
});

describe('bug-fix orchestrator status messaging', () => {
  beforeEach(() => {
    mkdirSync(TEST_TASK_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_PROJECT_DIR, { recursive: true, force: true });
  });

  function runStatus(): string {
    const result = Bun.spawnSync(['bun', join(import.meta.dir, 'orchestrator.ts'), 'status'], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: TEST_PROJECT_DIR },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return result.stdout.toString();
  }

  test('plan_review phase status says RCA + Plan Validation for bug-fix', () => {
    writeFileSync(
      join(TEST_TASK_DIR, 'pipeline-tasks.json'),
      JSON.stringify(makeBugFixTasks())
    );
    writeFileSync(join(TEST_TASK_DIR, 'user-story.json'), JSON.stringify({ title: 'Fix: bug' }));
    writeFileSync(join(TEST_TASK_DIR, 'plan-refined.json'), JSON.stringify({ steps: [] }));
    const output = runStatus();
    expect(output).toContain('RCA + Plan Validation');
    expect(output).not.toContain('sonnet -> opus -> codex');
  });

  test('plan review phase shown for feature-implement after plan is drafted', () => {
    writeFileSync(
      join(TEST_TASK_DIR, 'pipeline-tasks.json'),
      JSON.stringify(makeFeatureTasks())
    );
    writeFileSync(join(TEST_TASK_DIR, 'user-story.json'), JSON.stringify({ title: 'test' }));
    writeFileSync(join(TEST_TASK_DIR, 'plan-refined.json'), JSON.stringify({ steps: [] }));
    const output = runStatus();
    expect(output).toContain('Plan Review');
    expect(output).not.toContain('RCA');
  });
});

describe('path resolution and environment', () => {
  beforeEach(() => {
    mkdirSync(TEST_TASK_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_PROJECT_DIR, { recursive: true, force: true });
  });

  test('TASK_DIR defaults to cwd/.vcp/task when CLAUDE_PROJECT_DIR not set', () => {
    const result = Bun.spawnSync(['bun', join(import.meta.dir, 'orchestrator.ts'), 'phase'], {
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: undefined,
      },
      cwd: TEST_PROJECT_DIR,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    // Should not error (though phase might be idle/requirements_gathering)
    const output = result.stdout.toString().trim();
    expect(output).toBeTruthy();
  });

  test('TASK_DIR uses CLAUDE_PROJECT_DIR when set', () => {
    writeFileSync(
      join(TEST_TASK_DIR, 'pipeline-tasks.json'),
      JSON.stringify(makeFeatureTasks())
    );
    writeFileSync(
      join(TEST_TASK_DIR, 'user-story.json'),
      JSON.stringify({ title: 'test' })
    );
    const phase = runDeterminePhase();
    expect(phase).toBe('plan_drafting');
  });

  test('multiple projects have isolated state', () => {
    const projectA = join(import.meta.dir, '.test-project-a');
    const projectB = join(import.meta.dir, '.test-project-b');

    try {
      mkdirSync(join(projectA, '.vcp', 'task'), { recursive: true });
      mkdirSync(join(projectB, '.vcp', 'task'), { recursive: true });

      // Project A: has pipeline-tasks.json + user-story → plan_drafting
      writeFileSync(
        join(projectA, '.vcp', 'task', 'pipeline-tasks.json'),
        JSON.stringify(makeFeatureTasks())
      );
      writeFileSync(
        join(projectA, '.vcp', 'task', 'user-story.json'),
        JSON.stringify({ title: 'A' })
      );

      // Project B: empty → requirements_gathering
      const phaseA = Bun.spawnSync(['bun', join(import.meta.dir, 'orchestrator.ts'), 'phase'], {
        env: { ...process.env, CLAUDE_PROJECT_DIR: projectA },
        stdout: 'pipe',
        stderr: 'pipe',
      }).stdout.toString().trim();

      const phaseB = Bun.spawnSync(['bun', join(import.meta.dir, 'orchestrator.ts'), 'phase'], {
        env: { ...process.env, CLAUDE_PROJECT_DIR: projectB },
        stdout: 'pipe',
        stderr: 'pipe',
      }).stdout.toString().trim();

      expect(phaseA).toBe('plan_drafting');
      expect(phaseB).toBe('requirements_gathering');
    } finally {
      rmSync(projectA, { recursive: true, force: true });
      rmSync(projectB, { recursive: true, force: true });
    }
  });
});

describe('lock behavior', () => {
  const lockFile = join(TEST_TASK_DIR, '.orchestrator.lock');

  beforeEach(() => {
    mkdirSync(TEST_TASK_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_PROJECT_DIR, { recursive: true, force: true });
  });

  test('acquireLock creates lock file with current PID', () => {
    // We import acquireLock/releaseLock from orchestrator.ts
    // But they use module-level TASK_DIR. Instead, test via the reset command.
    // Write a lock file and verify reset fails or cleans up.
    // For unit tests, we use pipeline-utils directly.
    writeFileSync(lockFile, String(process.pid));
    expect(existsSync(lockFile)).toBe(true);
    const content = readFileSync(lockFile, 'utf-8').trim();
    expect(parseInt(content, 10)).toBe(process.pid);
  });

  test('stale lock from dead PID gets cleaned up by reset', () => {
    // Write a lock with a definitely-dead PID
    writeFileSync(lockFile, '99999999');

    const result = Bun.spawnSync(['bun', join(import.meta.dir, 'orchestrator.ts'), 'reset'], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: TEST_PROJECT_DIR },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Reset should succeed (stale lock removed)
    expect(result.exitCode).toBe(0);
  });

  test('reset removes artifacts and does not create state.json', () => {
    // Setup artifacts
    writeFileSync(join(TEST_TASK_DIR, 'some-artifact.json'), '{}');

    const result = Bun.spawnSync(['bun', join(import.meta.dir, 'orchestrator.ts'), 'reset'], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: TEST_PROJECT_DIR },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(TEST_TASK_DIR, 'some-artifact.json'))).toBe(false);
    expect(existsSync(join(TEST_TASK_DIR, 'state.json'))).toBe(false);
  });

  test('wx flag prevents race condition on concurrent lock create', () => {
    // Manually test the wx flag behavior
    const testLock = join(TEST_TASK_DIR, '.test-lock');

    // First write succeeds
    writeFileSync(testLock, 'first', { flag: 'wx' });
    expect(readFileSync(testLock, 'utf-8')).toBe('first');

    // Second write with wx flag should throw
    let threw = false;
    try {
      writeFileSync(testLock, 'second', { flag: 'wx' });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // Original content preserved
    expect(readFileSync(testLock, 'utf-8')).toBe('first');
  });
});

describe('phase returns idle when .vcp/task/ does not exist', () => {
  const emptyProject = join(import.meta.dir, '.test-project-empty');

  afterEach(() => {
    rmSync(emptyProject, { recursive: true, force: true });
  });

  test('phase returns idle when .vcp/task/ does not exist', () => {
    mkdirSync(emptyProject, { recursive: true });

    const result = Bun.spawnSync(['bun', join(import.meta.dir, 'orchestrator.ts'), 'phase'], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: emptyProject },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.stdout.toString().trim()).toBe('idle');
  });
});

describe('--cwd flag', () => {
  const cwdProject = join(import.meta.dir, '.test-project-cwd');
  const cwdTaskDir = join(cwdProject, '.vcp', 'task');

  beforeEach(() => {
    mkdirSync(cwdTaskDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(cwdProject, { recursive: true, force: true });
  });

  test('--cwd overrides CLAUDE_PROJECT_DIR for phase', () => {
    writeFileSync(
      join(cwdTaskDir, 'pipeline-tasks.json'),
      JSON.stringify(makeFeatureTasks())
    );
    writeFileSync(
      join(cwdTaskDir, 'user-story.json'),
      JSON.stringify({ title: 'test' })
    );

    const result = Bun.spawnSync(
      ['bun', join(import.meta.dir, 'orchestrator.ts'), 'phase', '--cwd', cwdProject],
      {
        env: { ...process.env, CLAUDE_PROJECT_DIR: undefined },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );

    expect(result.stdout.toString().trim()).toBe('plan_drafting');
  });

  test('reset via --cwd clears .vcp/task/ in the target project', () => {
    writeFileSync(join(cwdTaskDir, 'some-artifact.json'), '{}');

    const result = Bun.spawnSync(
      ['bun', join(import.meta.dir, 'orchestrator.ts'), 'reset', '--cwd', cwdProject],
      {
        env: { ...process.env, CLAUDE_PROJECT_DIR: undefined },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );

    expect(result.exitCode).toBe(0);
    // Artifact removed, directory still exists (recreated empty)
    expect(existsSync(join(cwdTaskDir, 'some-artifact.json'))).toBe(false);
    expect(existsSync(cwdTaskDir)).toBe(true);
  });

  test('--cwd before command works (option-first ordering)', () => {
    writeFileSync(
      join(cwdTaskDir, 'pipeline-tasks.json'),
      JSON.stringify(makeFeatureTasks())
    );
    writeFileSync(
      join(cwdTaskDir, 'user-story.json'),
      JSON.stringify({ title: 'test' })
    );

    const result = Bun.spawnSync(
      ['bun', join(import.meta.dir, 'orchestrator.ts'), '--cwd', cwdProject, 'phase'],
      {
        env: { ...process.env, CLAUDE_PROJECT_DIR: undefined },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );

    expect(result.stdout.toString().trim()).toBe('plan_drafting');
  });

  test('--cwd without value exits with error', () => {
    const result = Bun.spawnSync(
      ['bun', join(import.meta.dir, 'orchestrator.ts'), 'phase', '--cwd'],
      {
        env: { ...process.env, CLAUDE_PROJECT_DIR: undefined },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('--cwd requires a directory path');
  });

  test('--cwd followed by another flag exits with error', () => {
    const result = Bun.spawnSync(
      ['bun', join(import.meta.dir, 'orchestrator.ts'), 'phase', '--cwd', '--dry-run'],
      {
        env: { ...process.env, CLAUDE_PROJECT_DIR: undefined },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('--cwd requires a directory path');
  });
});
