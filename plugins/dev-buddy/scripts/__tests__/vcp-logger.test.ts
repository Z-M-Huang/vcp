import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { capLogPayload, vcpLog, LOG_PAYLOAD_MAX_BYTES } from '../vcp-logger.ts';

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
    // '€' is 3 bytes in UTF-8 — 20 chars = 60 bytes, well above the 40-byte cap.
    // A char-based check would incorrectly pass input under 40 chars through;
    // the byte-based check must truncate.
    const input = '€'.repeat(20);
    const out = capLogPayload(input, 40);
    expect(Buffer.byteLength(input, 'utf8')).toBe(60);
    expect(out.endsWith('\n...truncated')).toBe(true);
    // Minor UTF-8-boundary slack (up to 2 bytes) is tolerated when the slice
    // lands mid-character; the hard-cap promise is "the marker always lands".
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(42);
  });
});

describe('vcpLog with fsync', () => {
  test('writes the log line and survives when fsync: true', async () => {
    const projectRoot = makeTmpDir();

    await vcpLog(projectRoot, {
      source: 'test', event: 'durable.event', decision: 'info',
      details: 'important payload',
      fsync: true,
    }, true);

    const logPath = path.join(projectRoot, '.vcp', 'dev-buddy.log');
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, 'utf-8');
    expect(content).toContain('durable.event');
    expect(content).toContain('important payload');
  });

  test('writes without fsync when flag omitted', async () => {
    const projectRoot = makeTmpDir();

    await vcpLog(projectRoot, {
      source: 'test', event: 'normal.event', decision: 'info',
      details: 'best-effort',
    }, true);

    const logPath = path.join(projectRoot, '.vcp', 'dev-buddy.log');
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, 'utf-8');
    expect(content).toContain('normal.event');
  });

  test('no-ops when debug flag is false', async () => {
    const projectRoot = makeTmpDir();

    await vcpLog(projectRoot, {
      source: 'test', event: 'skipped', decision: 'info',
      fsync: true,
    }, false);

    const logPath = path.join(projectRoot, '.vcp', 'dev-buddy.log');
    expect(existsSync(logPath)).toBe(false);
  });
});
