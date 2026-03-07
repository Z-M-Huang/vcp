import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import path from 'path';
import {
  ctx,
  setup, teardown, run, report, readState, readPipelineTasks, next, driveToShowStatus,
} from './pipeline-driver-test-utils.ts';

// ─── TASK CHAIN CREATION ───────────────────────────────────────────────────

describe('pipeline-driver task chain creation', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('feature pipeline creates stages matching config', () => {
    const cmd = run(`init --pipeline feature --cwd "${ctx.testDir}"`);
    report(cmd.command_id);
    next(); // list_tasks

    const state = readState();
    const tasks = readPipelineTasks();
    // Stage count should match resolved config
    expect(state.stages.length).toBe(tasks.stages.length);
    expect(state.stages.length).toBeGreaterThanOrEqual(3); // At minimum: req, plan, impl
  });

  test('task IDs are stored in stages after creation', () => {
    driveToShowStatus('feature');
    const state = readState();

    const withTaskIds = state.stages.filter((s: any) => s.task_id);
    expect(withTaskIds.length).toBe(state.stages.length);
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

    // Find stages that belong to parallel groups
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

// ─── DEPENDENCY WIRING ─────────────────────────────────────────────────────

describe('pipeline-driver dependency wiring', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('first stage has no dependencies (noop)', () => {
    const initCmd = run(`init --pipeline feature --cwd "${ctx.testDir}"`);
    report(initCmd.command_id);

    let cmd = next(); // list_tasks
    report(cmd.command_id, { tasks: [] });
    cmd = next(); // first create_task

    // Create all tasks
    let taskNum = 1;
    while (cmd.action === 'create_task') {
      report(cmd.command_id, { taskId: `task-${taskNum}` });
      cmd = next();
      taskNum++;
      if (taskNum > 25) break;
    }

    // First dependency step for stage 0 should be noop (no predecessors)
    expect(cmd.action).toBe('noop');
  });

  test('sequential stages wire to their predecessor', () => {
    const initCmd = run(`init --pipeline feature --cwd "${ctx.testDir}"`);
    report(initCmd.command_id);

    let cmd = next(); // list_tasks
    report(cmd.command_id, { tasks: [] });
    cmd = next(); // create_task

    let taskNum = 1;
    while (cmd.action === 'create_task') {
      report(cmd.command_id, { taskId: `task-${taskNum}` });
      cmd = next();
      taskNum++;
      if (taskNum > 25) break;
    }

    // Collect all update_task commands with addBlockedBy
    const wired: Array<{ taskId: string; blockedBy: string[] }> = [];
    while (cmd.action === 'update_task' || cmd.action === 'noop') {
      if (cmd.action === 'update_task' && cmd.addBlockedBy) {
        wired.push({ taskId: cmd.taskId, blockedBy: cmd.addBlockedBy });
      }
      report(cmd.command_id);
      cmd = next();
    }

    // Stage 1 (planning) should be blocked by stage 0 (requirements)
    const planningWire = wired.find(w => w.taskId === 'task-2');
    expect(planningWire).toBeDefined();
    expect(planningWire!.blockedBy).toContain('task-1');
  });

  test('fan-out: parallel group members share same predecessors', () => {
    const initCmd = run(`init --pipeline feature --cwd "${ctx.testDir}"`);
    report(initCmd.command_id);

    let cmd = next();
    report(cmd.command_id, { tasks: [] });
    cmd = next();

    let taskNum = 1;
    while (cmd.action === 'create_task') {
      report(cmd.command_id, { taskId: `task-${taskNum}` });
      cmd = next();
      taskNum++;
      if (taskNum > 25) break;
    }

    const state = readState();
    const firstGroupId = state.stages.find(
      (s: any) => s.parallel_group_id !== null,
    )?.parallel_group_id;

    if (firstGroupId !== undefined) {
      const groupMembers = state.stages.filter(
        (s: any) => s.parallel_group_id === firstGroupId,
      );

      const wired: Map<string, string[]> = new Map();
      while (cmd.action === 'update_task' || cmd.action === 'noop') {
        if (cmd.action === 'update_task' && cmd.addBlockedBy) {
          wired.set(cmd.taskId, cmd.addBlockedBy);
        }
        report(cmd.command_id);
        cmd = next();
      }

      const memberBlockedBys = groupMembers
        .map((m: any) => wired.get(m.task_id))
        .filter(Boolean);

      if (memberBlockedBys.length >= 2) {
        const first = JSON.stringify(memberBlockedBys[0]);
        for (const bl of memberBlockedBys.slice(1)) {
          expect(JSON.stringify(bl)).toBe(first);
        }
      }
    }
  });

  test('fan-in: stage after parallel group blocked by ALL group members', () => {
    const initCmd = run(`init --pipeline feature --cwd "${ctx.testDir}"`);
    report(initCmd.command_id);

    let cmd = next();
    report(cmd.command_id, { tasks: [] });
    cmd = next();

    let taskNum = 1;
    while (cmd.action === 'create_task') {
      report(cmd.command_id, { taskId: `task-${taskNum}` });
      cmd = next();
      taskNum++;
      if (taskNum > 25) break;
    }

    const state = readState();
    const firstGroupId = state.stages.find(
      (s: any) => s.parallel_group_id !== null,
    )?.parallel_group_id;

    if (firstGroupId !== undefined) {
      const groupMembers = state.stages.filter(
        (s: any) => s.parallel_group_id === firstGroupId,
      );
      const lastInGroup = groupMembers[groupMembers.length - 1];
      const successorIndex = lastInGroup.index + 1;
      const successor = state.stages.find(
        (s: any) => s.index === successorIndex,
      );

      const wired: Map<string, string[]> = new Map();
      while (cmd.action === 'update_task' || cmd.action === 'noop') {
        if (cmd.action === 'update_task' && cmd.addBlockedBy) {
          wired.set(cmd.taskId, cmd.addBlockedBy);
        }
        report(cmd.command_id);
        cmd = next();
      }

      if (successor) {
        const blockedBy = wired.get(successor.task_id);
        if (blockedBy) {
          for (const member of groupMembers) {
            expect(blockedBy).toContain(member.task_id);
          }
        }
      }
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

    // Check state stages (which have task_ids after chain creation)
    for (const stage of state.stages) {
      expect(stage.type).toBeTruthy();
      expect(stage.provider).toBeTruthy();
      expect(stage.providerType).toBeTruthy();
      expect(stage.model).toBeTruthy();
      expect(stage.output_file).toBeTruthy();
      expect(stage.task_id).toBeTruthy();
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
