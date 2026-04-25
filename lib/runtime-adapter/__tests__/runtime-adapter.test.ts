import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { projectDir } from '../src/index';

describe('projectDir', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.CLAUDE_PROJECT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.CLAUDE_PROJECT_DIR;
    } else {
      process.env.CLAUDE_PROJECT_DIR = savedEnv;
    }
  });

  test('returns CLAUDE_PROJECT_DIR when set', () => {
    process.env.CLAUDE_PROJECT_DIR = '/tmp/from-env';
    expect(projectDir()).toBe('/tmp/from-env');
  });

  test('env var wins over explicit fallback', () => {
    process.env.CLAUDE_PROJECT_DIR = '/tmp/from-env';
    expect(projectDir('/tmp/from-arg')).toBe('/tmp/from-env');
  });

  test('returns fallback when env var unset', () => {
    expect(projectDir('/tmp/from-arg')).toBe('/tmp/from-arg');
  });

  test('falls through to process.cwd() when neither is set', () => {
    expect(projectDir()).toBe(process.cwd());
  });

  test('empty string env var falls through to fallback (legacy || semantics)', () => {
    process.env.CLAUDE_PROJECT_DIR = '';
    expect(projectDir('/tmp/from-arg')).toBe('/tmp/from-arg');
  });

  test('empty string env + empty fallback falls through to cwd', () => {
    process.env.CLAUDE_PROJECT_DIR = '';
    expect(projectDir('')).toBe(process.cwd());
  });
});
