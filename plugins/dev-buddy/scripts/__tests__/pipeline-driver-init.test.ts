import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  ctx, DRIVER, EXEC_CWD,
  setup, teardown, run, report, readState, readPipelineTasks, next, driveToShowStatus,
} from './pipeline-driver-test-utils.ts';

// ─── INIT ──────────────────────────────────────────────────────────────────

describe('pipeline-driver init', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('fresh init emits create_team with correct team name', () => {
    const cmd = run(`init --pipeline feature --cwd "${ctx.testDir}"`);
    expect(cmd.action).toBe('create_team');
    expect(cmd.team_name).toMatch(/^pipeline-/);
    expect(cmd.command_id).toMatch(/^cmd-/);
    expect(cmd.state_version).toBe(0);
  });

  test('init creates pipeline-state.json with stages', () => {
    run(`init --pipeline feature --cwd "${ctx.testDir}"`);
    const state = readState();
    expect(state.pipeline).toBe('feature');
    expect(state.phase).toBe('init');
    expect(state.step).toBe(1);
    expect(state.stages.length).toBeGreaterThan(0);
  });

  test('init creates pipeline-tasks.json (hook contract)', () => {
    run(`init --pipeline feature --cwd "${ctx.testDir}"`);
    const tasks = readPipelineTasks();
    expect(tasks.pipeline_type).toBe('feature-implement');
    expect(tasks.team_name).toMatch(/^pipeline-/);
    expect(tasks.stages).toBeInstanceOf(Array);
    expect(tasks.config_hash).toBeTruthy();
  });

  test('init persists pending_command for replay semantics', () => {
    const cmd = run(`init --pipeline feature --cwd "${ctx.testDir}"`);
    const state = readState();
    expect(state.pending_command).not.toBeNull();
    expect(state.pending_command.command_id).toBe(cmd.command_id);
    expect(state.pending_command.action).toBe('create_team');
  });

  test('bugfix init creates bugfix pipeline', () => {
    const cmd = run(`init --pipeline bugfix --cwd "${ctx.testDir}"`);
    expect(cmd.action).toBe('create_team');
    const state = readState();
    expect(state.pipeline).toBe('bugfix');
  });

  test('resume detection triggers ask_user when pipeline-tasks.json exists', () => {
    // First init
    run(`init --pipeline feature --cwd "${ctx.testDir}"`);

    // Remove state file but keep pipeline-tasks.json
    const statePath = path.join(ctx.testDir, '.vcp/task/pipeline-state.json');
    fs.unlinkSync(statePath);

    // Re-init should detect existing pipeline
    const cmd = run(`init --pipeline feature --cwd "${ctx.testDir}"`);
    expect(cmd.action).toBe('ask_user');
    expect(cmd.question).toMatch(/previous pipeline/i);
    expect(cmd.options).toBeInstanceOf(Array);
    expect(cmd.options.length).toBe(3);
  });
});

// ─── NEXT — Replay Semantics ───────────────────────────────────────────────

describe('pipeline-driver next — replay', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('next replays unacknowledged pending command', () => {
    const initCmd = run(`init --pipeline feature --cwd "${ctx.testDir}"`);

    // Call next WITHOUT reporting — should replay the init command
    const replayCmd = next();
    expect(replayCmd.action).toBe(initCmd.action);
    expect(replayCmd.command_id).toBe(initCmd.command_id);
  });

  test('next increments state_version on replay', () => {
    run(`init --pipeline feature --cwd "${ctx.testDir}"`);
    const state1 = readState();
    const v1 = state1.state_version;

    next(); // replay
    const state2 = readState();
    expect(state2.state_version).toBe(v1 + 1);
  });

  test('next returns escalate if no state exists', () => {
    const cmd = next();
    expect(cmd.action).toBe('escalate');
    expect(cmd.error).toMatch(/no pipeline state/i);
  });
});

// ─── RESET ─────────────────────────────────────────────────────────────────

describe('pipeline-driver reset', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('reset clears task directory', () => {
    run(`init --pipeline feature --cwd "${ctx.testDir}"`);
    expect(
      fs.existsSync(path.join(ctx.testDir, '.vcp/task/pipeline-state.json')),
    ).toBe(true);

    const result = run(`reset --cwd "${ctx.testDir}"`);
    expect(result.ok).toBe(true);

    expect(
      fs.existsSync(path.join(ctx.testDir, '.vcp/task/pipeline-state.json')),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(ctx.testDir, '.vcp/task/pipeline-tasks.json')),
    ).toBe(false);
  });

  test('reset creates empty task directory', () => {
    run(`init --pipeline feature --cwd "${ctx.testDir}"`);
    run(`reset --cwd "${ctx.testDir}"`);
    expect(fs.existsSync(path.join(ctx.testDir, '.vcp/task'))).toBe(true);
  });
});

// ─── STATUS ────────────────────────────────────────────────────────────────

describe('pipeline-driver status', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('status with no pipeline returns idle', () => {
    fs.mkdirSync(path.join(ctx.testDir, '.vcp/task'), { recursive: true });
    const output = execSync(
      `bun "${DRIVER}" status --cwd "${ctx.testDir}"`,
      { encoding: 'utf-8', cwd: EXEC_CWD, timeout: 15000 },
    ).trim();
    const status = JSON.parse(output);
    expect(status.phase).toBe('idle');
  });

  test('status shows current phase and stages', () => {
    run(`init --pipeline feature --cwd "${ctx.testDir}"`);
    const output = execSync(
      `bun "${DRIVER}" status --cwd "${ctx.testDir}"`,
      { encoding: 'utf-8', cwd: EXEC_CWD, timeout: 15000 },
    ).trim();
    const status = JSON.parse(output);
    expect(status.phase).toBe('init');
    expect(status.pipeline).toBe('feature');
    expect(status.stages).toBeInstanceOf(Array);
    expect(status.stages.length).toBeGreaterThan(0);
  });
});

// ─── STATE VERSION MONOTONICITY ────────────────────────────────────────────

describe('pipeline-driver state version', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('state_version increments on each next call', () => {
    const initCmd = run(`init --pipeline feature --cwd "${ctx.testDir}"`);
    report(initCmd.command_id);

    const versions: number[] = [];
    for (let i = 0; i < 5; i++) {
      const cmd = next();
      versions.push(cmd.state_version);
      let extra: Record<string, any> = {};
      if (cmd.action === 'list_tasks') {
        extra = { tasks: [] };
      } else if (cmd.action === 'parallel_batch' && cmd.commands) {
        const batchResults: Record<string, { ok: boolean; taskId?: string }> = {};
        cmd.commands.forEach((sub: any, idx: number) => {
          batchResults[sub.command_id] = { ok: true, taskId: `task-${idx + 1}` };
        });
        extra = { batch_results: batchResults };
      }
      report(cmd.command_id, extra);
    }

    for (let i = 1; i < versions.length; i++) {
      expect(versions[i]).toBeGreaterThan(versions[i - 1]);
    }
  });
});

// ─── TEAM NAME DERIVATION ──────────────────────────────────────────────────

describe('pipeline-driver team name', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('team name is deterministic for same path', () => {
    const cmd1 = run(`init --pipeline feature --cwd "${ctx.testDir}"`);
    const name1 = cmd1.team_name;

    run(`reset --cwd "${ctx.testDir}"`);
    const cmd2 = run(`init --pipeline feature --cwd "${ctx.testDir}"`);
    expect(cmd2.team_name).toBe(name1);
  });

  test('team name format: pipeline-{basename}-{hash}', () => {
    const cmd = run(`init --pipeline feature --cwd "${ctx.testDir}"`);
    expect(cmd.team_name).toMatch(/^pipeline-[a-z0-9-]+-[a-f0-9]{6}$/);
  });
});

// ─── COMMAND HISTORY ───────────────────────────────────────────────────────

describe('pipeline-driver command history', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('commands are tracked in history', () => {
    const cmd = run(`init --pipeline feature --cwd "${ctx.testDir}"`);
    const state = readState();

    expect(state.command_history.length).toBeGreaterThan(0);
    const entry = state.command_history[0];
    expect(entry.command_id).toBe(cmd.command_id);
    expect(entry.action).toBe('create_team');
    expect(entry.acknowledged).toBe(false);
  });

  test('acknowledged commands marked in history', () => {
    const cmd = run(`init --pipeline feature --cwd "${ctx.testDir}"`);
    report(cmd.command_id);

    const state = readState();
    const entry = state.command_history.find(
      (h: any) => h.command_id === cmd.command_id,
    );
    expect(entry.acknowledged).toBe(true);
  });
});

// ─── OUTPUT FILE NAMING ────────────────────────────────────────────────────

describe('pipeline-driver output file naming', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('singleton stages have canonical output files', () => {
    driveToShowStatus('feature');
    const state = readState();

    const req = state.stages.find((s: any) => s.type === 'requirements');
    expect(req.output_file).toBe('user-story/manifest.json');

    const plan = state.stages.find((s: any) => s.type === 'planning');
    expect(plan.output_file).toBe('plan/manifest.json');

    const impl = state.stages.find((s: any) => s.type === 'implementation');
    expect(impl.output_file).toBe('impl-result.json');
  });

  test('multi-instance stages have indexed versioned filenames', () => {
    driveToShowStatus('feature');
    const state = readState();

    const reviews = state.stages.filter(
      (s: any) => s.type === 'plan-review',
    );
    for (const review of reviews) {
      expect(review.output_file).toMatch(/^plan-review-.*-v1\.json$/);
    }
  });

  test('version starts at 1 for all stages', () => {
    driveToShowStatus('feature');
    const state = readState();
    for (const stage of state.stages) {
      expect(stage.current_version).toBe(1);
    }
  });
});

// ─── RESUME DETECTION ──────────────────────────────────────────────────────

describe('pipeline-driver resume detection', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('second init with same config shows config match', () => {
    const cmd1 = run(`init --pipeline feature --cwd "${ctx.testDir}"`);
    report(cmd1.command_id);

    const cmd2 = run(`init --pipeline feature --cwd "${ctx.testDir}"`);
    expect(cmd2.action).toBe('ask_user');
    expect(cmd2.context).toMatch(/config matches/i);
  });

  test('resume rebuilds stages from pipeline-tasks.json', () => {
    // Drive to show_status (all tasks created + deps wired)
    const showStatus = driveToShowStatus('bugfix');
    report(showStatus.command_id);

    // Save current state for comparison
    const originalState = readState();
    const originalTeamName = originalState.team_name;
    const stageCount = originalState.stages.length;

    // Delete the pipeline-state.json to simulate legacy pipeline (only tasks file)
    const statePath = path.join(ctx.testDir, '.vcp/task/pipeline-state.json');
    fs.unlinkSync(statePath);

    // Re-init should detect existing pipeline-tasks.json
    const initCmd = run(`init --pipeline bugfix --cwd "${ctx.testDir}"`);
    expect(initCmd.action).toBe('ask_user');
    expect(initCmd.question).toMatch(/previous pipeline/i);

    // User chooses "Resume"
    report(initCmd.command_id, { answer: 'Resume' });

    // State should be rebuilt from pipeline-tasks.json
    const resumedState = readState();
    expect(resumedState.phase).toBe('main_loop');
    expect(resumedState.stages.length).toBe(stageCount);
    expect(resumedState.team_name).toBe(originalTeamName);

    // Backup should have been created
    const backupPath = path.join(ctx.testDir, '.vcp/task/pipeline-tasks.json.bak');
    expect(fs.existsSync(backupPath)).toBe(true);
  });

  test('start fresh after resume detection resets state', () => {
    // Drive to show_status
    const showStatus = driveToShowStatus('bugfix');
    report(showStatus.command_id);

    // Re-init
    const initCmd = run(`init --pipeline bugfix --cwd "${ctx.testDir}"`);
    expect(initCmd.action).toBe('ask_user');

    // User chooses "Start fresh"
    report(initCmd.command_id, { answer: 'Start fresh' });

    // State should transition to init with stages re-resolved from config
    const state = readState();
    expect(state.phase).toBe('init');
    expect(state.step).toBe(0);
    expect(state.stages.length).toBeGreaterThan(0); // Stages re-resolved from config
    expect(state.stages.every((s: { status: string }) => s.status === 'pending')).toBe(true);
  });
});
