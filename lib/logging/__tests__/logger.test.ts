import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  capLogPayload,
  vcpLog,
  createLogger,
  LOG_PAYLOAD_MAX_BYTES,
  type LogEntry,
} from '../src/index.ts';

const tmpDirs: string[] = [];
afterAll(() => { tmpDirs.forEach(d => rmSync(d, { recursive: true, force: true })); });

function makeTmpDir(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'vcp-logger-test-'));
  tmpDirs.push(d);
  return d;
}

describe('capLogPayload', () => {
  test('passes through when under the limit', () => {
    expect(capLogPayload('hello')).toBe('hello');
  });

  test('truncates oversize strings and appends the marker', () => {
    const input = 'x'.repeat(LOG_PAYLOAD_MAX_BYTES * 2);
    const out = capLogPayload(input);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(LOG_PAYLOAD_MAX_BYTES);
    expect(out.endsWith('\n...truncated')).toBe(true);
  });

  test('respects a custom cap', () => {
    const input = 'x'.repeat(100);
    const out = capLogPayload(input, 20);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(20);
    expect(out.endsWith('\n...truncated')).toBe(true);
  });

  test('counts UTF-8 bytes (not characters) when deciding to truncate', () => {
    const input = '€'.repeat(20);
    const out = capLogPayload(input, 40);
    expect(Buffer.byteLength(input, 'utf8')).toBe(60);
    expect(out.endsWith('\n...truncated')).toBe(true);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(42);
  });
});

describe('vcpLog default binding', () => {
  test('writes to .vcp/vcp.log', async () => {
    const dir = makeTmpDir();
    await vcpLog(dir, { source: 'test', event: 'Hi', decision: 'info', details: 'hello' }, true);
    const content = readFileSync(path.join(dir, '.vcp', 'vcp.log'), 'utf-8');
    expect(content).toContain('Hi');
  });

  test('appends entries', async () => {
    const dir = makeTmpDir();
    await vcpLog(dir, { source: 'test', event: 'A', decision: 'info', details: 'first' }, true);
    await vcpLog(dir, { source: 'test', event: 'B', decision: 'warn', details: 'second' }, true);
    const content = readFileSync(path.join(dir, '.vcp', 'vcp.log'), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('first');
    expect(lines[1]).toContain('second');
  });

  test('entry format matches pattern', async () => {
    const dir = makeTmpDir();
    await vcpLog(dir, { source: 'security-gate', event: 'PreToolUse', decision: 'block', details: 'CWE-798' }, true);
    const content = readFileSync(path.join(dir, '.vcp', 'vcp.log'), 'utf-8');
    expect(content).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[PreToolUse\] security-gate: block — CWE-798\n$/,
    );
  });

  test('does not throw on write failure', async () => {
    await vcpLog('/nonexistent/path/that/does/not/exist', {
      source: 'test', event: 'X', decision: 'info',
    }, true);
  });

  test('no-ops when projectRoot is empty', async () => {
    await vcpLog('', { source: 'test', event: 'X', decision: 'info' }, true);
  });

  test('no-ops when projectRoot is relative', async () => {
    await vcpLog('relative/path', { source: 'test', event: 'X', decision: 'info' }, true);
  });

  test('omits details when not provided', async () => {
    const dir = makeTmpDir();
    await vcpLog(dir, { source: 'test', event: 'X', decision: 'allow' }, true);
    const content = readFileSync(path.join(dir, '.vcp', 'vcp.log'), 'utf-8');
    expect(content).not.toContain(' — ');
    expect(content).toMatch(/allow\n$/);
  });

  test('no-ops when debug is false', async () => {
    const dir = makeTmpDir();
    await vcpLog(dir, { source: 'test', event: 'X', decision: 'info' }, false);
    expect(existsSync(path.join(dir, '.vcp', 'vcp.log'))).toBe(false);
  });

  test('no-ops when debug omitted', async () => {
    const dir = makeTmpDir();
    await vcpLog(dir, { source: 'test', event: 'X', decision: 'info' });
    expect(existsSync(path.join(dir, '.vcp', 'vcp.log'))).toBe(false);
  });
});

describe('createLogger with custom filename', () => {
  test('writes to the configured filename', async () => {
    const dir = makeTmpDir();
    const log = createLogger('dev-buddy.log');
    await log(dir, { source: 'db', event: 'X', decision: 'info', details: 'custom' }, true);
    const content = readFileSync(path.join(dir, '.vcp', 'dev-buddy.log'), 'utf-8');
    expect(content).toContain('custom');
    expect(existsSync(path.join(dir, '.vcp', 'vcp.log'))).toBe(false);
  });

  test('writes with fsync when entry.fsync is set', async () => {
    const dir = makeTmpDir();
    const log = createLogger('dev-buddy.log');
    await log(dir, {
      source: 'test', event: 'durable.event', decision: 'info',
      details: 'important payload', fsync: true,
    }, true);
    const content = readFileSync(path.join(dir, '.vcp', 'dev-buddy.log'), 'utf-8');
    expect(content).toContain('durable.event');
    expect(content).toContain('important payload');
  });

  test('writes without fsync when flag omitted', async () => {
    const dir = makeTmpDir();
    const log = createLogger('dev-buddy.log');
    await log(dir, { source: 'test', event: 'normal.event', decision: 'info' }, true);
    expect(existsSync(path.join(dir, '.vcp', 'dev-buddy.log'))).toBe(true);
  });

  test('no-ops when debug is false', async () => {
    const dir = makeTmpDir();
    const log = createLogger('dev-buddy.log');
    await log(dir, { source: 'test', event: 'skipped', decision: 'info', fsync: true }, false);
    expect(existsSync(path.join(dir, '.vcp', 'dev-buddy.log'))).toBe(false);
  });
});

describe('log rotation', () => {
  test('rotates when file exceeds 5MB', async () => {
    const dir = makeTmpDir();
    const logDir = path.join(dir, '.vcp');
    mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, 'vcp.log');

    writeFileSync(logFile, 'x'.repeat(5 * 1024 * 1024 + 1));

    await vcpLog(dir, {
      source: 'test', event: 'AfterRotation', decision: 'info', details: 'new entry',
    }, true);

    expect(existsSync(logFile + '.1')).toBe(true);
    const rotated = readFileSync(logFile + '.1', 'utf-8');
    expect(rotated.length).toBeGreaterThan(5 * 1024 * 1024);

    const current = readFileSync(logFile, 'utf-8');
    expect(current).toContain('AfterRotation');
    expect(current.length).toBeLessThan(200);
  });

  test('keeps at most 3 versions', async () => {
    const dir = makeTmpDir();
    const logDir = path.join(dir, '.vcp');
    mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, 'vcp.log');

    writeFileSync(logFile + '.1', 'version-1-content\n');
    writeFileSync(logFile + '.2', 'version-2-content\n');
    writeFileSync(logFile, 'y'.repeat(5 * 1024 * 1024 + 1));

    await vcpLog(dir, { source: 'test', event: 'Rotate3', decision: 'info' }, true);

    const v2 = readFileSync(logFile + '.2', 'utf-8');
    expect(v2).toContain('version-1-content');

    const v1 = readFileSync(logFile + '.1', 'utf-8');
    expect(v1.length).toBeGreaterThan(5 * 1024 * 1024);

    const current = readFileSync(logFile, 'utf-8');
    expect(current).toContain('Rotate3');

    expect(existsSync(logFile + '.3')).toBe(false);
  });

  test('does not rotate when under 5MB', async () => {
    const dir = makeTmpDir();
    const logDir = path.join(dir, '.vcp');
    mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, 'vcp.log');

    writeFileSync(logFile, 'small content\n');

    await vcpLog(dir, { source: 'test', event: 'NoRotation', decision: 'info' }, true);

    expect(existsSync(logFile + '.1')).toBe(false);
    const content = readFileSync(logFile, 'utf-8');
    expect(content).toContain('small content');
    expect(content).toContain('NoRotation');
  });
});
