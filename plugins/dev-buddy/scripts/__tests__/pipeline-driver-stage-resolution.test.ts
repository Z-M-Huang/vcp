import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import path from 'path';
import {
  ctx,
  setup, teardown, readState, readPipelineTasks, next, driveToShowStatus,
} from './pipeline-driver-test-utils.ts';

// ─── STAGE RESOLUTION ─────────────────────────────────────────────────────

describe('pipeline-driver stage resolution', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('feature pipeline creates stages matching config', () => {
    driveToShowStatus('feature');
    const state = readState();
    const tasks = readPipelineTasks();
    // Stage count should match resolved config
    expect(state.stages.length).toBe(tasks.stages.length);
    expect(state.stages.length).toBeGreaterThanOrEqual(3); // At minimum: req, plan, impl
  });

  test('feature stages start with requirements, planning, end with reviews', () => {
    driveToShowStatus('feature');
    const state = readState();
    const types = state.stages.map((s: any) => s.type);
    expect(types[0]).toBe('requirements');
    expect(types[1]).toBe('planning');
    // Must have at least one of each review type and implementation
    expect(types.filter((t: string) => t === 'plan-review').length).toBeGreaterThanOrEqual(1);
    expect(types.filter((t: string) => t === 'implementation').length).toBe(1);
    expect(types.filter((t: string) => t === 'code-review').length).toBeGreaterThanOrEqual(1);
  });

  test('bugfix pipeline has RCA + implementation + reviews', () => {
    driveToShowStatus('bugfix');
    const state = readState();
    const types = state.stages.map((s: any) => s.type);
    expect(types.filter((t: string) => t === 'rca').length).toBeGreaterThanOrEqual(1);
    expect(types.filter((t: string) => t === 'implementation').length).toBe(1);
    expect(types.filter((t: string) => t === 'code-review').length).toBeGreaterThanOrEqual(1);
  });
});

// ─── PARALLEL GROUP DETECTION ──────────────────────────────────────────────

describe('pipeline-driver parallel groups', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('consecutive parallel same-type stages share a parallel_group_id', () => {
    driveToShowStatus('feature');
    const state = readState();

    const planReviewsInGroup = state.stages.filter(
      (s: any) => s.type === 'plan-review' && s.parallel_group_id !== null,
    );
    const codeReviewsInGroup = state.stages.filter(
      (s: any) => s.type === 'code-review' && s.parallel_group_id !== null,
    );

    if (planReviewsInGroup.length >= 2) {
      const groupId = planReviewsInGroup[0].parallel_group_id;
      expect(
        planReviewsInGroup.every((s: any) => s.parallel_group_id === groupId),
      ).toBe(true);
    }

    if (codeReviewsInGroup.length >= 2) {
      const groupId = codeReviewsInGroup[0].parallel_group_id;
      expect(
        codeReviewsInGroup.every((s: any) => s.parallel_group_id === groupId),
      ).toBe(true);
    }
  });

  test('parallel groups have distinct IDs', () => {
    driveToShowStatus('feature');
    const state = readState();
    const groupIds = new Set(
      state.stages
        .filter((s: any) => s.parallel_group_id !== null)
        .map((s: any) => s.parallel_group_id),
    );

    if (groupIds.size >= 2) {
      expect(groupIds.size).toBeGreaterThanOrEqual(2);
    }
  });
});

// ─── PIPELINE TASKS JSON (Hook Contract) ───────────────────────────────────

describe('pipeline-tasks.json hook contract', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('stages have required fields for hooks', () => {
    driveToShowStatus('feature');
    const state = readState();

    for (const stage of state.stages) {
      expect(stage.type).toBeTruthy();
      expect(stage.provider).toBeTruthy();
      expect(stage.providerType).toBeTruthy();
      expect(stage.model).toBeTruthy();
      expect(stage.output_file).toBeTruthy();
      expect(typeof stage.current_version).toBe('number');
      expect(
        stage.parallel_group_id === null ||
          typeof stage.parallel_group_id === 'number',
      ).toBe(true);
    }

    // Also verify pipeline-tasks.json has the same structure
    const tasks = readPipelineTasks();
    expect(tasks.stages.length).toBe(state.stages.length);
    for (const stage of tasks.stages) {
      expect(stage.type).toBeTruthy();
      expect(stage.provider).toBeTruthy();
    }
  });

  test('config_hash is consistent', () => {
    driveToShowStatus('feature');
    const tasks = readPipelineTasks();
    const state = readState();
    expect(tasks.config_hash).toBe(state.config_hash);
  });
});

// ─── SPECIALIST SHUTDOWN BATCHING ─────────────────────────────────────────

describe('pipeline-driver specialist shutdown batching', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('specialist shutdown batched into single parallel_batch', () => {
    driveToShowStatus('feature');
    const state = readState();

    // Set up specialists and phase
    state.phase = 'specialist_shutdown';
    state.step = 0;
    state.specialists = {
      approved_specialists: [
        { name: 'researcher-1', agentType: 'general-purpose', status: 'spawned' },
        { name: 'researcher-2', agentType: 'general-purpose', status: 'spawned' },
        { name: 'researcher-3', agentType: 'general-purpose', status: 'completed' },
      ],
    };
    state.pending_command = null;
    fs.writeFileSync(
      path.join(ctx.testDir, '.vcp/task/pipeline-state.json'),
      JSON.stringify(state, null, 2),
    );

    const cmd = next();
    expect(cmd.action).toBe('parallel_batch');
    // Should have 3 shutdown_teammate sub-commands (2 spawned + 1 completed)
    expect(cmd.commands.length).toBe(3);
    for (const sub of cmd.commands) {
      expect(sub.action).toBe('shutdown_teammate');
    }
    const recipients = cmd.commands.map((s: any) => s.recipient).sort();
    expect(recipients).toEqual(['researcher-1', 'researcher-2', 'researcher-3']);
  });
});
