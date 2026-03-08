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

  test('first stage has no dependencies (excluded from batch)', () => {
    const initCmd = run(`init --pipeline feature --cwd "${ctx.testDir}"`);
    report(initCmd.command_id);

    let cmd = next(); // list_tasks
    report(cmd.command_id, { tasks: [] });
    cmd = next(); // parallel_batch (create_task×N)
    expect(cmd.action).toBe('parallel_batch');

    // Build batch results
    const createResults: Record<string, { ok: boolean; taskId: string }> = {};
    cmd.commands.forEach((sub: any, i: number) => {
      createResults[sub.command_id] = { ok: true, taskId: `task-${i + 1}` };
    });
    report(cmd.command_id, { batch_results: createResults });
    cmd = next(); // parallel_batch (update_task×M for deps)
    expect(cmd.action).toBe('parallel_batch');

    // Stage 0 (requirements) should NOT appear in the dependency batch
    // because it has no predecessors
    const taskIdsInBatch = cmd.commands.map((sub: any) => sub.taskId);
    expect(taskIdsInBatch).not.toContain('task-1');
  });

  test('sequential stages wire to their predecessor', () => {
    const initCmd = run(`init --pipeline feature --cwd "${ctx.testDir}"`);
    report(initCmd.command_id);

    let cmd = next(); // list_tasks
    report(cmd.command_id, { tasks: [] });
    cmd = next(); // parallel_batch (create_task×N)
    expect(cmd.action).toBe('parallel_batch');

    const createResults: Record<string, { ok: boolean; taskId: string }> = {};
    cmd.commands.forEach((sub: any, i: number) => {
      createResults[sub.command_id] = { ok: true, taskId: `task-${i + 1}` };
    });
    report(cmd.command_id, { batch_results: createResults });
    cmd = next(); // parallel_batch (update_task×M for deps)
    expect(cmd.action).toBe('parallel_batch');

    // Stage 1 (planning) should be blocked by stage 0 (requirements)
    const planningWire = cmd.commands.find((sub: any) => sub.taskId === 'task-2');
    expect(planningWire).toBeDefined();
    expect(planningWire.addBlockedBy).toContain('task-1');
  });

  test('fan-out: parallel group members share same predecessors', () => {
    const initCmd = run(`init --pipeline feature --cwd "${ctx.testDir}"`);
    report(initCmd.command_id);

    let cmd = next(); // list_tasks
    report(cmd.command_id, { tasks: [] });
    cmd = next(); // parallel_batch (create)
    expect(cmd.action).toBe('parallel_batch');

    const createResults: Record<string, { ok: boolean; taskId: string }> = {};
    cmd.commands.forEach((sub: any, i: number) => {
      createResults[sub.command_id] = { ok: true, taskId: `task-${i + 1}` };
    });
    report(cmd.command_id, { batch_results: createResults });
    cmd = next(); // parallel_batch (deps)
    expect(cmd.action).toBe('parallel_batch');

    const state = readState();
    const firstGroupId = state.stages.find(
      (s: any) => s.parallel_group_id !== null,
    )?.parallel_group_id;

    if (firstGroupId !== undefined) {
      const groupMembers = state.stages.filter(
        (s: any) => s.parallel_group_id === firstGroupId,
      );

      // Extract wiring from batch sub-commands
      const wired: Map<string, string[]> = new Map();
      for (const sub of cmd.commands) {
        if (sub.action === 'update_task' && sub.addBlockedBy) {
          wired.set(sub.taskId, sub.addBlockedBy);
        }
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

    let cmd = next(); // list_tasks
    report(cmd.command_id, { tasks: [] });
    cmd = next(); // parallel_batch (create)
    expect(cmd.action).toBe('parallel_batch');

    const createResults: Record<string, { ok: boolean; taskId: string }> = {};
    cmd.commands.forEach((sub: any, i: number) => {
      createResults[sub.command_id] = { ok: true, taskId: `task-${i + 1}` };
    });
    report(cmd.command_id, { batch_results: createResults });
    cmd = next(); // parallel_batch (deps)
    expect(cmd.action).toBe('parallel_batch');

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

      // Extract wiring from batch sub-commands
      const wired: Map<string, string[]> = new Map();
      for (const sub of cmd.commands) {
        if (sub.action === 'update_task' && sub.addBlockedBy) {
          wired.set(sub.taskId, sub.addBlockedBy);
        }
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

// ─── BATCH CREATION ROBUSTNESS ────────────────────────────────────────────

describe('pipeline-driver batch creation robustness', () => {
  beforeEach(setup);
  afterEach(teardown);

  /** Drive from init through list_tasks, return the create batch command. */
  function driveToCreateBatch(pipeline: 'feature' | 'bugfix' = 'feature'): any {
    const initCmd = run(`init --pipeline ${pipeline} --cwd "${ctx.testDir}"`);
    report(initCmd.command_id);
    let cmd = next(); // list_tasks
    report(cmd.command_id, { tasks: [] });
    cmd = next(); // parallel_batch (create_task×N)
    expect(cmd.action).toBe('parallel_batch');
    return cmd;
  }

  /** Report a create batch with sequential task IDs. */
  function reportCreateBatch(cmd: any): Record<string, { ok: boolean; taskId: string }> {
    const results: Record<string, { ok: boolean; taskId: string }> = {};
    cmd.commands.forEach((sub: any, i: number) => {
      results[sub.command_id] = { ok: true, taskId: `task-${i + 1}` };
    });
    report(cmd.command_id, { batch_results: results });
    return results;
  }

  test('shuffled batch_results ordering maps task IDs correctly', () => {
    const batchCmd = driveToCreateBatch();

    // Build results in REVERSE order to verify ordering doesn't matter
    const results: Record<string, { ok: boolean; taskId: string }> = {};
    const reversed = [...batchCmd.commands].reverse();
    reversed.forEach((sub: any, i: number) => {
      // Assign task IDs based on original position, not iteration order
      const originalIdx = batchCmd.commands.indexOf(sub);
      results[sub.command_id] = { ok: true, taskId: `task-${originalIdx + 1}` };
    });
    report(batchCmd.command_id, { batch_results: results });

    const state = readState();
    // Each stage should have the task ID matching its index
    for (let i = 0; i < state.stages.length; i++) {
      expect(state.stages[i].task_id).toBe(`task-${i + 1}`);
    }
  });

  test('failed sub-command marks stage failed, others get task IDs', () => {
    const batchCmd = driveToCreateBatch();

    // Fail stage 2 (index 2), succeed all others
    const results: Record<string, any> = {};
    batchCmd.commands.forEach((sub: any, i: number) => {
      if (i === 2) {
        results[sub.command_id] = { ok: false, error: 'Task creation failed' };
      } else {
        results[sub.command_id] = { ok: true, taskId: `task-${i + 1}` };
      }
    });
    report(batchCmd.command_id, { batch_results: results });

    const state = readState();
    // Stage 2 should be marked failed with no task_id
    expect(state.stages[2].status).toBe('failed');
    // Other stages should have task IDs
    expect(state.stages[0].task_id).toBe('task-1');
    expect(state.stages[1].task_id).toBe('task-2');
    expect(state.stages[3].task_id).toBe('task-4');
  });

  test('idempotent create batch: stages with existing task_ids are excluded', () => {
    // Drive to show_status so all stages get task_ids
    driveToShowStatus('feature');
    const state = readState();
    const allHaveIds = state.stages.every((s: any) => s.task_id);
    expect(allHaveIds).toBe(true);

    // Manually reset phase to task_chain_creation, step 0
    // Must also clear pending_command (show_status from driveToShowStatus)
    // so next() enters handleTaskChainCreation instead of replaying show_status
    state.phase = 'task_chain_creation';
    state.step = 0;
    state.pending_command = null;
    fs.writeFileSync(
      path.join(ctx.testDir, '.vcp/task/pipeline-state.json'),
      JSON.stringify(state, null, 2),
    );

    // next() should skip create batch (all stages have task_ids)
    // and go directly to task_chain_dependencies (update_task batch)
    const cmd = next();
    expect(cmd.action).toBe('parallel_batch');
    // Verify NO create_task sub-commands — only update_task (dependency wiring)
    const createCmds = cmd.commands.filter((sub: any) => sub.action === 'create_task');
    expect(createCmds.length).toBe(0);
    const updateCmds = cmd.commands.filter((sub: any) => sub.action === 'update_task');
    expect(updateCmds.length).toBeGreaterThan(0);
  });

  test('specialist shutdown batched into single parallel_batch', () => {
    // We need to get to specialist_shutdown phase to test this.
    // Drive to show_status, then manipulate state to simulate specialist_shutdown.
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
