import { describe, expect, test } from 'bun:test';
import { sanitizeForFilename, getOutputFileName, getV3OutputFileName, isValidStageEntry, VALID_STAGE_TYPES, SAFE_PATH_RE } from './stage-definitions.ts';

// ─── sanitizeForFilename ─────────────────────────────────────────────────────

describe('sanitizeForFilename', () => {
  test('lowercases input', () => {
    expect(sanitizeForFilename('O3')).toBe('o3');
    expect(sanitizeForFilename('Sonnet')).toBe('sonnet');
  });

  test('replaces spaces with hyphens', () => {
    expect(sanitizeForFilename('Codex CLI')).toBe('codex-cli');
  });

  test('replaces underscores with hyphens', () => {
    expect(sanitizeForFilename('gpt_4')).toBe('gpt-4');
  });

  test('strips unsafe characters', () => {
    expect(sanitizeForFilename('foo/bar')).toBe('foobar');
    expect(sanitizeForFilename('a@b#c')).toBe('abc');
  });

  test('collapses consecutive hyphens', () => {
    expect(sanitizeForFilename('a   b')).toBe('a-b');
    expect(sanitizeForFilename('a___b')).toBe('a-b');
    expect(sanitizeForFilename('a - b')).toBe('a-b');
  });

  test('trims leading and trailing hyphens', () => {
    expect(sanitizeForFilename(' hello ')).toBe('hello');
    expect(sanitizeForFilename('_leading_')).toBe('leading');
  });

  test('preserves dots in model names', () => {
    expect(sanitizeForFilename('gpt-5.3-codex')).toBe('gpt-5.3-codex');
    expect(sanitizeForFilename('M2.5')).toBe('m2.5');
  });

  test('preserves already-clean names', () => {
    expect(sanitizeForFilename('anthropic-subscription')).toBe('anthropic-subscription');
    expect(sanitizeForFilename('sonnet')).toBe('sonnet');
    expect(sanitizeForFilename('o3')).toBe('o3');
  });

  test('throws on empty string', () => {
    expect(() => sanitizeForFilename('')).toThrow('Cannot sanitize');
  });

  test('throws on whitespace-only string', () => {
    expect(() => sanitizeForFilename('   ')).toThrow('Cannot sanitize');
  });

  test('throws on dot', () => {
    expect(() => sanitizeForFilename('.')).toThrow('Cannot sanitize');
  });

  test('throws on double dot', () => {
    expect(() => sanitizeForFilename('..')).toThrow('Cannot sanitize');
  });

  test('throws when all chars are stripped', () => {
    expect(() => sanitizeForFilename('///???')).toThrow('Cannot sanitize');
  });
});

// ─── getOutputFileName ───────────────────────────────────────────────────────

describe('getOutputFileName', () => {
  test('returns canonical name for singleton stages', () => {
    expect(getOutputFileName('requirements', 1, 'anthropic', 'opus', 1)).toBe('user-story/manifest.json');
    expect(getOutputFileName('planning', 1, 'anthropic', 'opus', 1)).toBe('plan/manifest.json');
    expect(getOutputFileName('implementation', 1, 'anthropic', 'sonnet', 1)).toBe('impl-result.json');
  });

  test('returns unversioned name for plan-review', () => {
    expect(getOutputFileName('plan-review', 1, 'anthropic-subscription', 'sonnet', 1))
      .toBe('plan-review-anthropic-subscription-sonnet-1.json');
  });

  test('returns unversioned name for code-review', () => {
    expect(getOutputFileName('code-review', 2, 'anthropic-subscription', 'opus', 1))
      .toBe('code-review-anthropic-subscription-opus-2.json');
  });

  test('returns versioned name for rca', () => {
    expect(getOutputFileName('rca', 1, 'anthropic-subscription', 'sonnet', 1))
      .toBe('rca-anthropic-subscription-sonnet-1-v1.json');
  });

  test('increments version for rca re-analysis', () => {
    expect(getOutputFileName('rca', 1, 'anthropic-subscription', 'sonnet', 2))
      .toBe('rca-anthropic-subscription-sonnet-1-v2.json');
    expect(getOutputFileName('rca', 1, 'anthropic-subscription', 'sonnet', 3))
      .toBe('rca-anthropic-subscription-sonnet-1-v3.json');
  });

  test('review version param is no-op (pattern has no {version})', () => {
    expect(getOutputFileName('plan-review', 1, 'anthropic-subscription', 'sonnet', 1))
      .toBe(getOutputFileName('plan-review', 1, 'anthropic-subscription', 'sonnet', 5));
  });

  test('sanitizes provider name with spaces', () => {
    expect(getOutputFileName('plan-review', 1, 'Codex CLI', 'o3', 1))
      .toBe('plan-review-codex-cli-o3-1.json');
  });

  test('sanitizes model name with dots', () => {
    expect(getOutputFileName('code-review', 1, 'codex-cli', 'gpt-5.3-codex', 1))
      .toBe('code-review-codex-cli-gpt-5.3-codex-1.json');
  });

  test('different indices produce different filenames for same provider+model', () => {
    const file1 = getOutputFileName('code-review', 1, 'anthropic-subscription', 'sonnet', 1);
    const file2 = getOutputFileName('code-review', 2, 'anthropic-subscription', 'sonnet', 1);
    expect(file1).not.toBe(file2);
  });

  test('singleton ignores provider/model/version params', () => {
    const a = getOutputFileName('requirements', 1, 'foo', 'bar', 5);
    const b = getOutputFileName('requirements', 1, 'baz', 'qux', 1);
    expect(a).toBe(b);
    expect(a).toBe('user-story/manifest.json');
  });
});

// ─── getV3OutputFileName ────────────────────────────────────────────────────

describe('getV3OutputFileName', () => {
  test('includes system prompt name for plan-review', () => {
    expect(getV3OutputFileName('plan-review', 'plan-reviewer', 1, 'anthropic-subscription', 'sonnet', 1))
      .toBe('plan-review-plan-reviewer-anthropic-subscription-sonnet-1.json');
  });

  test('includes system prompt name for code-review', () => {
    expect(getV3OutputFileName('code-review', 'code-reviewer', 1, 'anthropic-subscription', 'opus', 1))
      .toBe('code-review-code-reviewer-anthropic-subscription-opus-1.json');
  });

  test('omits version for review stages', () => {
    const name = getV3OutputFileName('plan-review', 'plan-reviewer', 1, 'sub', 'sonnet', 1);
    expect(name).not.toContain('-v1');
    expect(name).toBe('plan-review-plan-reviewer-sub-sonnet-1.json');
  });

  test('keeps version for rca', () => {
    expect(getV3OutputFileName('rca', 'root-cause-analyst', 1, 'anthropic-subscription', 'sonnet', 1))
      .toBe('rca-root-cause-analyst-anthropic-subscription-sonnet-1-v1.json');
  });

  test('rca version increments', () => {
    expect(getV3OutputFileName('rca', 'root-cause-analyst', 1, 'sub', 'sonnet', 2))
      .toBe('rca-root-cause-analyst-sub-sonnet-1-v2.json');
  });

  test('falls back to v2 pattern for singletons', () => {
    expect(getV3OutputFileName('requirements', 'requirements-gatherer', 1, 'sub', 'opus', 1))
      .toBe('user-story/manifest.json');
  });

  test('sanitizes system prompt name', () => {
    expect(getV3OutputFileName('plan-review', 'Custom Reviewer', 1, 'sub', 'sonnet', 1))
      .toBe('plan-review-custom-reviewer-sub-sonnet-1.json');
  });
});

// ─── SAFE_PATH_RE compatibility ─────────────────────────────────────────────

describe('SAFE_PATH_RE', () => {
  test('validates new unversioned review filenames', () => {
    expect(SAFE_PATH_RE.test('plan-review-plan-reviewer-sub-sonnet-1.json')).toBe(true);
    expect(SAFE_PATH_RE.test('code-review-code-reviewer-sub-opus-2.json')).toBe(true);
  });

  test('validates old versioned review filenames (backward compat)', () => {
    expect(SAFE_PATH_RE.test('plan-review-sub-sonnet-1-v1.json')).toBe(true);
    expect(SAFE_PATH_RE.test('code-review-sub-opus-2-v1.json')).toBe(true);
  });

  test('validates rca versioned filenames', () => {
    expect(SAFE_PATH_RE.test('rca-root-cause-analyst-sub-sonnet-1-v1.json')).toBe(true);
  });

  test('validates singleton paths', () => {
    expect(SAFE_PATH_RE.test('user-story/manifest.json')).toBe(true);
    expect(SAFE_PATH_RE.test('plan/manifest.json')).toBe(true);
    expect(SAFE_PATH_RE.test('impl-result.json')).toBe(true);
  });

  test('rejects path traversal', () => {
    expect(SAFE_PATH_RE.test('../evil.json')).toBe(false);
    expect(SAFE_PATH_RE.test('../../etc/passwd')).toBe(false);
  });
});

// ─── VALID_STAGE_TYPES ───────────────────────────────────────────────────────

describe('VALID_STAGE_TYPES', () => {
  test('contains all 6 stage types', () => {
    expect(VALID_STAGE_TYPES.size).toBe(6);
    for (const t of ['requirements', 'planning', 'plan-review', 'implementation', 'code-review', 'rca']) {
      expect(VALID_STAGE_TYPES.has(t)).toBe(true);
    }
  });
});

// ─── isValidStageEntry ───────────────────────────────────────────────────────

describe('isValidStageEntry', () => {
  test('accepts valid plan-review entry (new format)', () => {
    expect(isValidStageEntry({ type: 'plan-review', output_file: 'plan-review-plan-reviewer-sub-sonnet-1.json' })).toBe(true);
  });

  test('accepts valid plan-review entry (old versioned format)', () => {
    expect(isValidStageEntry({ type: 'plan-review', output_file: 'plan-review-sub-sonnet-1-v1.json' })).toBe(true);
  });

  test('accepts valid code-review entry', () => {
    expect(isValidStageEntry({ type: 'code-review', output_file: 'code-review-code-reviewer-sub-opus-2.json' })).toBe(true);
  });

  test('accepts valid singleton entries', () => {
    expect(isValidStageEntry({ type: 'requirements', output_file: 'user-story/manifest.json' })).toBe(true);
    expect(isValidStageEntry({ type: 'planning', output_file: 'plan/manifest.json' })).toBe(true);
    expect(isValidStageEntry({ type: 'implementation', output_file: 'impl-result.json' })).toBe(true);
  });

  test('accepts valid rca entry', () => {
    expect(isValidStageEntry({ type: 'rca', output_file: 'rca-sub-sonnet-1-v1.json' })).toBe(true);
  });

  test('accepts extra properties (forward-compatible)', () => {
    expect(isValidStageEntry({
      type: 'code-review',
      output_file: 'code-review-code-reviewer-sub-sonnet-1.json',
      current_version: 1,
      provider: 'anthropic-subscription',
    })).toBe(true);
  });

  test('rejects null', () => {
    expect(isValidStageEntry(null)).toBe(false);
  });

  test('rejects undefined', () => {
    expect(isValidStageEntry(undefined)).toBe(false);
  });

  test('rejects non-object', () => {
    expect(isValidStageEntry('plan-review')).toBe(false);
    expect(isValidStageEntry(42)).toBe(false);
  });

  test('rejects missing type', () => {
    expect(isValidStageEntry({ output_file: 'plan-review-sub-sonnet-1.json' })).toBe(false);
  });

  test('rejects missing output_file', () => {
    expect(isValidStageEntry({ type: 'plan-review' })).toBe(false);
  });

  test('rejects unknown stage type', () => {
    expect(isValidStageEntry({ type: 'not-a-stage', output_file: 'foo.json' })).toBe(false);
  });

  test('rejects path traversal in output_file', () => {
    expect(isValidStageEntry({ type: 'plan-review', output_file: '../../package.json' })).toBe(false);
    expect(isValidStageEntry({ type: 'plan-review', output_file: '../etc/passwd' })).toBe(false);
  });

  test('rejects absolute paths in output_file', () => {
    expect(isValidStageEntry({ type: 'plan-review', output_file: '/etc/passwd' })).toBe(false);
  });

  test('accepts output_file with safe path separators', () => {
    expect(isValidStageEntry({ type: 'plan-review', output_file: 'subdir/review.json' })).toBe(true);
    expect(isValidStageEntry({ type: 'requirements', output_file: 'user-story/manifest.json' })).toBe(true);
    expect(isValidStageEntry({ type: 'planning', output_file: 'plan/manifest.json' })).toBe(true);
  });

  test('rejects non-json output_file', () => {
    expect(isValidStageEntry({ type: 'plan-review', output_file: 'review.txt' })).toBe(false);
    expect(isValidStageEntry({ type: 'plan-review', output_file: 'review' })).toBe(false);
  });

  test('rejects output_file starting with dot', () => {
    expect(isValidStageEntry({ type: 'plan-review', output_file: '.hidden.json' })).toBe(false);
  });

  test('rejects empty output_file', () => {
    expect(isValidStageEntry({ type: 'plan-review', output_file: '' })).toBe(false);
  });
});
