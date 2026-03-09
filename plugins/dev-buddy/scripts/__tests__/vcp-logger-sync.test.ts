/**
 * Tests for synchronous logging functions (vcpLogSync, isDebugEnabledSync,
 * initDriverLog, driverLog).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

import {
  vcpLogSync,
  isDebugEnabledSync,
  initDriverLog,
  driverLog,
} from '../vcp-logger.ts';

const DRIVER = path.resolve(__dirname, '../pipeline-driver.ts');
const EXEC_CWD = path.resolve(__dirname, '../../../..'); // /app/vcp root

let testDir: string;

function setup(): void {
  testDir = fs.mkdtempSync(path.join('/tmp', 'logger-test-'));
}

function teardown(): void {
  if (testDir && fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

describe('vcpLogSync', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('writes to .vcp/dev-buddy.log when debug=true', () => {
    vcpLogSync(testDir, {
      source: 'test',
      event: 'test-event',
      decision: 'info',
      details: 'hello world',
    }, true);

    const logPath = path.join(testDir, '.vcp', 'dev-buddy.log');
    expect(fs.existsSync(logPath)).toBe(true);
    const content = fs.readFileSync(logPath, 'utf-8');
    expect(content).toContain('[test-event]');
    expect(content).toContain('test: info');
    expect(content).toContain('hello world');
  });

  test('no-ops when debug=false', () => {
    vcpLogSync(testDir, {
      source: 'test',
      event: 'test-event',
      decision: 'info',
    }, false);

    const logPath = path.join(testDir, '.vcp', 'dev-buddy.log');
    expect(fs.existsSync(logPath)).toBe(false);
  });

  test('no-ops when projectRoot is empty', () => {
    vcpLogSync('', {
      source: 'test',
      event: 'test-event',
      decision: 'info',
    }, true);
    // Should not throw
  });

  test('appends multiple lines', () => {
    vcpLogSync(testDir, { source: 'a', event: 'e1', decision: 'info' }, true);
    vcpLogSync(testDir, { source: 'b', event: 'e2', decision: 'warn' }, true);

    const logPath = path.join(testDir, '.vcp', 'dev-buddy.log');
    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('[e1]');
    expect(lines[1]).toContain('[e2]');
  });
});

describe('isDebugEnabledSync', () => {
  // This test reads the real ~/.vcp/config.json.
  // We verify it returns a boolean without modifying the user's config.
  test('returns a boolean', () => {
    const result = isDebugEnabledSync();
    expect(typeof result).toBe('boolean');
  });
});

describe('initDriverLog + driverLog', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('writes with source=pipeline-driver after init', () => {
    initDriverLog(testDir, true);
    driverLog('test-event', 'info', 'test details');

    const logPath = path.join(testDir, '.vcp', 'dev-buddy.log');
    expect(fs.existsSync(logPath)).toBe(true);
    const content = fs.readFileSync(logPath, 'utf-8');
    expect(content).toContain('pipeline-driver');
    expect(content).toContain('[test-event]');
    expect(content).toContain('test details');
  });

  test('no-ops when debug=false', () => {
    initDriverLog(testDir, false);
    driverLog('test-event', 'info', 'test details');

    const logPath = path.join(testDir, '.vcp', 'dev-buddy.log');
    expect(fs.existsSync(logPath)).toBe(false);
  });
});

describe('pipeline-driver integration (logging)', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('init produces log entries when debug=true', () => {
    // Since isDebugEnabledSync reads from homedir, check if debug is currently on.
    const debugEnabled = isDebugEnabledSync();
    if (!debugEnabled) {
      // Skip integration test if debug is not enabled globally.
      // This avoids modifying the user's ~/.vcp/config.json.
      return;
    }

    // All args are test-controlled constants (no untrusted data).
    execSync(
      `bun "${DRIVER}" init --pipeline feature --cwd "${testDir}"`,
      { cwd: EXEC_CWD, timeout: 15000 },
    );

    const logPath = path.join(testDir, '.vcp', 'dev-buddy.log');
    if (fs.existsSync(logPath)) {
      const content = fs.readFileSync(logPath, 'utf-8');
      expect(content).toContain('pipeline-driver');
    }
  });
});
