import { describe, test, expect } from 'bun:test';
import {
  validateCliTemplate,
  validatePreset,
  maskApiKey,
  VALID_CLI_PLACEHOLDERS,
  VALID_ONE_SHOT_PLACEHOLDERS,
  REQUIRED_ARGS_TEMPLATE_PLACEHOLDERS,
  REQUIRED_ONE_SHOT_PLACEHOLDERS,
  FORBIDDEN_ONE_SHOT_PLACEHOLDERS,
} from '../preset-utils.ts';
import type { CliPreset } from '../../types/presets.ts';

// ================== validateCliTemplate ==================

describe('validateCliTemplate', () => {
  test('accepts valid pipeline template with all required placeholders', () => {
    const result = validateCliTemplate(
      'exec -m {model} -o {output_file} "{prompt}"',
      'args_template',
      { required: REQUIRED_ARGS_TEMPLATE_PLACEHOLDERS },
    );
    expect(result).toBeNull();
  });

  test('rejects pipeline template missing {output_file}', () => {
    const result = validateCliTemplate(
      'exec -m {model} "{prompt}"',
      'args_template',
      { required: REQUIRED_ARGS_TEMPLATE_PLACEHOLDERS },
    );
    expect(result).toContain('missing required');
    expect(result).toContain('output_file');
  });

  test('rejects pipeline template missing multiple required placeholders', () => {
    const result = validateCliTemplate(
      'exec "{prompt}"',
      'args_template',
      { required: REQUIRED_ARGS_TEMPLATE_PLACEHOLDERS },
    );
    expect(result).toContain('missing required');
    expect(result).toContain('model');
    expect(result).toContain('output_file');
  });

  test('accepts valid one-shot template', () => {
    const result = validateCliTemplate(
      'exec -m {model} "{prompt}"',
      'one_shot_args_template',
      {
        validSet: VALID_ONE_SHOT_PLACEHOLDERS,
        required: REQUIRED_ONE_SHOT_PLACEHOLDERS,
        forbidden: FORBIDDEN_ONE_SHOT_PLACEHOLDERS,
      },
    );
    expect(result).toBeNull();
  });

  test('rejects one-shot template with forbidden {output_file}', () => {
    const result = validateCliTemplate(
      'exec -m {model} -o {output_file} "{prompt}"',
      'one_shot_args_template',
      {
        validSet: VALID_CLI_PLACEHOLDERS, // allow parsing
        required: REQUIRED_ONE_SHOT_PLACEHOLDERS,
        forbidden: FORBIDDEN_ONE_SHOT_PLACEHOLDERS,
      },
    );
    expect(result).toContain('not allowed');
    expect(result).toContain('output_file');
  });

  test('rejects one-shot template with forbidden {schema_path}', () => {
    const result = validateCliTemplate(
      'exec -m {model} --schema {schema_path} "{prompt}"',
      'one_shot_args_template',
      {
        validSet: VALID_CLI_PLACEHOLDERS,
        required: REQUIRED_ONE_SHOT_PLACEHOLDERS,
        forbidden: FORBIDDEN_ONE_SHOT_PLACEHOLDERS,
      },
    );
    expect(result).toContain('not allowed');
    expect(result).toContain('schema_path');
  });

  test('rejects one-shot template with unknown placeholder', () => {
    const result = validateCliTemplate(
      'exec -m {model} "{prompt}" --out {output_file}',
      'one_shot_args_template',
      {
        validSet: VALID_ONE_SHOT_PLACEHOLDERS,
        required: REQUIRED_ONE_SHOT_PLACEHOLDERS,
      },
    );
    expect(result).toContain('unknown placeholder');
    expect(result).toContain('output_file');
  });

  test('rejects one-shot template missing {model}', () => {
    const result = validateCliTemplate(
      'exec "{prompt}"',
      'one_shot_args_template',
      {
        validSet: VALID_ONE_SHOT_PLACEHOLDERS,
        required: REQUIRED_ONE_SHOT_PLACEHOLDERS,
        forbidden: FORBIDDEN_ONE_SHOT_PLACEHOLDERS,
      },
    );
    expect(result).toContain('missing required');
    expect(result).toContain('model');
  });

  test('detects unbalanced opening brace', () => {
    const result = validateCliTemplate('exec {model', 'args_template');
    expect(result).toContain('unbalanced');
  });

  test('detects unexpected closing brace', () => {
    const result = validateCliTemplate('exec model}', 'args_template');
    expect(result).toContain('unexpected');
  });

  test('rejects unknown placeholder in default valid set', () => {
    const result = validateCliTemplate('exec {model} {bogus}', 'args_template');
    expect(result).toContain('unknown placeholder');
    expect(result).toContain('bogus');
  });

  test('accepts template with all 5 pipeline placeholders', () => {
    const result = validateCliTemplate(
      'exec -m {model} -o {output_file} --schema {schema_path} -r {reasoning_effort} "{prompt}"',
      'args_template',
      { required: REQUIRED_ARGS_TEMPLATE_PLACEHOLDERS },
    );
    expect(result).toBeNull();
  });

  test('accepts one-shot template with optional {reasoning_effort}', () => {
    const result = validateCliTemplate(
      'exec -m {model} -r {reasoning_effort} "{prompt}"',
      'one_shot_args_template',
      {
        validSet: VALID_ONE_SHOT_PLACEHOLDERS,
        required: REQUIRED_ONE_SHOT_PLACEHOLDERS,
        forbidden: FORBIDDEN_ONE_SHOT_PLACEHOLDERS,
      },
    );
    expect(result).toBeNull();
  });
});

// ================== validatePreset: CLI one-shot constraints ==================

/** Minimal valid CLI preset for testing. */
function makeCliPreset(overrides: Partial<CliPreset> = {}): Record<string, unknown> {
  return {
    type: 'cli',
    name: 'Test CLI',
    command: 'test-cmd',
    args_template: 'exec -m {model} -o {output_file} "{prompt}"',
    models: ['test-model'],
    ...overrides,
  };
}

describe('validatePreset: CLI args_template required placeholders', () => {
  test('accepts args_template with all required placeholders', () => {
    const preset = makeCliPreset();
    expect(() => validatePreset(preset)).not.toThrow();
  });

  test('rejects args_template missing {output_file}', () => {
    const preset = makeCliPreset({ args_template: 'exec -m {model} "{prompt}"' });
    expect(() => validatePreset(preset)).toThrow('missing required');
  });

  test('rejects args_template missing {model}', () => {
    const preset = makeCliPreset({ args_template: 'exec -o {output_file} "{prompt}"' });
    expect(() => validatePreset(preset)).toThrow('missing required');
  });
});

describe('validatePreset: CLI one_shot_args_template', () => {
  test('accepts valid one_shot_args_template', () => {
    const preset = makeCliPreset({
      one_shot_args_template: 'exec -m {model} "{prompt}"',
    });
    const result = validatePreset(preset) as CliPreset;
    expect(result.one_shot_args_template).toBe('exec -m {model} "{prompt}"');
  });

  test('rejects one_shot_args_template with {output_file}', () => {
    const preset = makeCliPreset({
      one_shot_args_template: 'exec -m {model} -o {output_file} "{prompt}"',
    });
    expect(() => validatePreset(preset)).toThrow('unknown placeholder');
  });

  test('rejects one_shot_args_template with {schema_path}', () => {
    const preset = makeCliPreset({
      one_shot_args_template: 'exec -m {model} --schema {schema_path} "{prompt}"',
    });
    expect(() => validatePreset(preset)).toThrow('unknown placeholder');
  });

  test('rejects one_shot_args_template missing {model}', () => {
    const preset = makeCliPreset({
      one_shot_args_template: 'exec "{prompt}"',
    });
    expect(() => validatePreset(preset)).toThrow('missing required');
  });

  test('rejects one_shot_args_template missing {prompt}', () => {
    const preset = makeCliPreset({
      one_shot_args_template: 'exec -m {model}',
    });
    expect(() => validatePreset(preset)).toThrow('missing required');
  });

  test('rejects non-string one_shot_args_template', () => {
    const preset = makeCliPreset();
    (preset as Record<string, unknown>).one_shot_args_template = 42;
    expect(() => validatePreset(preset)).toThrow('one_shot_args_template must be a string');
  });

  test('normalizes whitespace-only one_shot_args_template to undefined', () => {
    const preset = makeCliPreset({ one_shot_args_template: '   ' } as any);
    const result = validatePreset(preset) as CliPreset;
    expect(result.one_shot_args_template).toBeUndefined();
  });

  test('normalizes empty string one_shot_args_template to undefined', () => {
    const preset = makeCliPreset({ one_shot_args_template: '' } as any);
    const result = validatePreset(preset) as CliPreset;
    expect(result.one_shot_args_template).toBeUndefined();
  });

  test('accepts preset without one_shot_args_template', () => {
    const preset = makeCliPreset();
    const result = validatePreset(preset) as CliPreset;
    expect(result.one_shot_args_template).toBeUndefined();
  });
});

describe('validatePreset: CLI resume_args_template whitespace normalization', () => {
  test('normalizes whitespace-only resume_args_template to undefined', () => {
    const preset = makeCliPreset({ resume_args_template: '   \t  ' } as any);
    const result = validatePreset(preset) as CliPreset;
    expect(result.resume_args_template).toBeUndefined();
  });

  test('normalizes empty resume_args_template to undefined', () => {
    const preset = makeCliPreset({ resume_args_template: '' } as any);
    const result = validatePreset(preset) as CliPreset;
    expect(result.resume_args_template).toBeUndefined();
  });

  test('accepts valid resume_args_template', () => {
    const preset = makeCliPreset({
      resume_args_template: 'exec resume -m {model} "{prompt}"',
    });
    const result = validatePreset(preset) as CliPreset;
    expect(result.resume_args_template).toBe('exec resume -m {model} "{prompt}"');
  });

  test('rejects non-string resume_args_template', () => {
    const preset = makeCliPreset();
    (preset as Record<string, unknown>).resume_args_template = 123;
    expect(() => validatePreset(preset)).toThrow('resume_args_template must be a string');
  });
});

// ================== validatePreset: API max_output_tokens ==================

/** Minimal valid API preset for testing. */
const FAKE_KEY = 'FAKE-TEST-KEY-NOT-REAL';

function makeApiPreset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'api',
    name: 'Test API',
    base_url: 'https://api.example.com',
    api_key: FAKE_KEY,
    models: ['test-model'],
    ...overrides,
  };
}

describe('validatePreset: API max_output_tokens', () => {
  test('accepts valid positive integer (4096)', () => {
    const preset = makeApiPreset({ max_output_tokens: 4096 });
    expect(() => validatePreset(preset)).not.toThrow();
  });

  test('rejects zero (0)', () => {
    const preset = makeApiPreset({ max_output_tokens: 0 });
    expect(() => validatePreset(preset)).toThrow('max_output_tokens must be a positive integer');
  });

  test('rejects negative value (-100)', () => {
    const preset = makeApiPreset({ max_output_tokens: -100 });
    expect(() => validatePreset(preset)).toThrow('max_output_tokens must be a positive integer');
  });

  test('rejects non-integer float (12.5)', () => {
    const preset = makeApiPreset({ max_output_tokens: 12.5 });
    expect(() => validatePreset(preset)).toThrow('max_output_tokens must be a positive integer');
  });

  test('rejects non-number string', () => {
    const preset = makeApiPreset({ max_output_tokens: 'abc' });
    expect(() => validatePreset(preset)).toThrow('max_output_tokens must be a positive integer');
  });

  test('accepts absent field (optional)', () => {
    const preset = makeApiPreset();
    expect(() => validatePreset(preset)).not.toThrow();
  });

  test('rejects value exceeding upper bound (1000001)', () => {
    const preset = makeApiPreset({ max_output_tokens: 1_000_001 });
    expect(() => validatePreset(preset)).toThrow('max_output_tokens must not exceed 1000000');
  });

  test('accepts exactly upper bound (1000000)', () => {
    const preset = makeApiPreset({ max_output_tokens: 1_000_000 });
    expect(() => validatePreset(preset)).not.toThrow();
  });
});

// ================== maskApiKey ==================

describe('maskApiKey', () => {
  test('masks key showing prefix and last 4 chars', () => {
    expect(maskApiKey('sk-or-v1-abcdefghx789')).toBe('sk-***x789');
  });

  test('masks short key (4 chars or fewer)', () => {
    expect(maskApiKey('abcd')).toBe('****');
    expect(maskApiKey('abc')).toBe('****');
    expect(maskApiKey('a')).toBe('****');
  });

  test('masks 5-char key', () => {
    expect(maskApiKey('abcde')).toBe('abc***bcde');
  });
});
