import { describe, test, expect } from 'bun:test';
import {
  parseArgs,
  DEFAULT_TASK_TIMEOUT_MS,
  MAX_AGENT_STEPS,
  TOOL_REGISTRY,
  TOOL_NAMES,
  resolveAllowedTools,
  buildToolSet,
  createRunner,
  UnifiedRunner,
} from '../api-task-runner.ts';
import type { AgentRunner, AgentRunOptions, AgentRunResult } from '../api-task-runner.ts';
import type { ApiPreset } from '../../types/presets.ts';
import type { streamText } from 'ai';

// ================== TEST FIXTURES ==================

/** Test-only fake preset — not a real credential. */
const FAKE_KEY = 'FAKE-TEST-KEY-NOT-REAL';

const mockPreset: ApiPreset = {
  type: 'api',
  name: 'test-api',
  base_url: 'https://api.example.com/v1',
  api_key: FAKE_KEY,
  models: ['MiniMax-M2.5', 'ModelB'],
};

const mockOpenAIPreset: ApiPreset = {
  type: 'api',
  name: 'test-openai',
  base_url: 'https://api.openai.com',
  api_key: FAKE_KEY,
  models: ['gpt-4o', 'o3'],
  protocol: 'openai',
};

const defaultRunOptions: AgentRunOptions = {
  model: 'MiniMax-M2.5',
  timeoutMs: 30_000,
  cwd: '/tmp',
  debugEnabled: false,
  presetName: 'test-api',
};

// ================== DEFAULT_TASK_TIMEOUT_MS ==================

describe('DEFAULT_TASK_TIMEOUT_MS', () => {
  test('is 300 seconds', () => {
    expect(DEFAULT_TASK_TIMEOUT_MS).toBe(300_000);
  });
});

// ================== MAX_AGENT_STEPS ==================

describe('MAX_AGENT_STEPS', () => {
  test('is 100', () => {
    expect(MAX_AGENT_STEPS).toBe(100);
  });
});

// ================== TOOL_NAMES ==================

describe('TOOL_NAMES', () => {
  test('contains 6 PascalCase tool names', () => {
    expect(TOOL_NAMES).toHaveLength(6);
    expect(TOOL_NAMES).toEqual(['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep']);
  });

  test('is derived from TOOL_REGISTRY', () => {
    expect(TOOL_NAMES).toEqual(TOOL_REGISTRY.map(t => t.name));
  });
});

// ================== TOOL_REGISTRY ==================

describe('TOOL_REGISTRY', () => {
  test('has 6 entries', () => {
    expect(TOOL_REGISTRY).toHaveLength(6);
  });

  test('each entry has name and key', () => {
    for (const entry of TOOL_REGISTRY) {
      expect(typeof entry.name).toBe('string');
      expect(typeof entry.key).toBe('string');
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.key.length).toBeGreaterThan(0);
    }
  });

  test('names are unique', () => {
    const names = TOOL_REGISTRY.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('keys are unique', () => {
    const keys = TOOL_REGISTRY.map(t => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('names are PascalCase, keys are lowercase', () => {
    for (const entry of TOOL_REGISTRY) {
      expect(entry.name[0]).toBe(entry.name[0].toUpperCase());
      expect(entry.key).toBe(entry.key.toLowerCase());
    }
  });
});

// ================== resolveAllowedTools ==================

describe('resolveAllowedTools', () => {
  test('returns all 6 keys when no filter', () => {
    const result = resolveAllowedTools();
    expect(result.size).toBe(6);
    expect(result).toContain('read');
    expect(result).toContain('write');
    expect(result).toContain('edit');
    expect(result).toContain('bash');
    expect(result).toContain('glob');
    expect(result).toContain('grep');
  });

  test('returns all 6 keys for empty array', () => {
    expect(resolveAllowedTools([]).size).toBe(6);
  });

  test('filters to matching PascalCase names', () => {
    const result = resolveAllowedTools(['Read', 'Grep']);
    expect(result.size).toBe(2);
    expect(result).toContain('read');
    expect(result).toContain('grep');
  });

  test('ignores unknown PascalCase names', () => {
    const result = resolveAllowedTools(['Read', 'Unknown', 'Grep']);
    expect(result.size).toBe(2);
    expect(result).toContain('read');
    expect(result).toContain('grep');
  });

  test('returns empty set when all names are unknown', () => {
    const result = resolveAllowedTools(['Foo', 'Bar']);
    expect(result.size).toBe(0);
  });
});

// ================== buildToolSet ==================

describe('buildToolSet', () => {
  test('returns 6 tools when no filter', () => {
    const tools = buildToolSet();
    expect(Object.keys(tools)).toHaveLength(6);
    expect(Object.keys(tools).sort()).toEqual(['bash', 'edit', 'glob', 'grep', 'read', 'write']);
  });

  test('filters to matching PascalCase names', () => {
    const tools = buildToolSet(['Read', 'Glob', 'Grep']);
    expect(Object.keys(tools)).toHaveLength(3);
    expect(Object.keys(tools).sort()).toEqual(['glob', 'grep', 'read']);
  });

  test('returns empty object when all names are unknown', () => {
    const tools = buildToolSet(['Foo']);
    expect(Object.keys(tools)).toHaveLength(0);
  });

  test('returns empty object for empty set (all filtered out)', () => {
    const tools = buildToolSet(['NonExistent']);
    expect(Object.keys(tools)).toHaveLength(0);
  });
});

// ================== parseArgs ==================

describe('parseArgs', () => {
  const base = ['bun', 'api-task-runner.ts'];

  test('parses all required arguments', () => {
    const result = parseArgs([
      ...base,
      '--preset', 'my-preset',
      '--model', 'M2.5',
      '--cwd', '/project',
      '--task', 'do something',
    ]);
    expect(result).toEqual({
      preset: 'my-preset',
      model: 'M2.5',
      task: 'do something',
      cwd: '/project',
      taskTimeoutMs: 300_000,
      taskFromStdin: false,
      stream: false,
    });
  });

  test('accepts --task-stdin flag as alternative to --task', () => {
    const result = parseArgs([
      ...base,
      '--preset', 'my-preset',
      '--model', 'M2.5',
      '--cwd', '/project',
      '--task-stdin',
    ]);
    expect(result.taskFromStdin).toBe(true);
    expect(result.task).toBeUndefined();
  });

  test('rejects when neither --task nor --task-stdin provided', () => {
    expect(() => parseArgs([
      ...base,
      '--preset', 'p',
      '--model', 'm',
      '--cwd', '/d',
    ])).toThrow('--task or --task-stdin');
  });

  test('parses --task-timeout flag', () => {
    const result = parseArgs([
      ...base,
      '--preset', 'p',
      '--model', 'm',
      '--cwd', '/d',
      '--task', 't',
      '--task-timeout', '60000',
    ]);
    expect(result.taskTimeoutMs).toBe(60000);
  });

  test('defaults taskTimeoutMs to DEFAULT_TASK_TIMEOUT_MS', () => {
    const result = parseArgs([
      ...base,
      '--preset', 'p',
      '--model', 'model',
      '--cwd', '/d',
      '--task', 't',
    ]);
    expect(result.taskTimeoutMs).toBe(DEFAULT_TASK_TIMEOUT_MS);
  });

  test('parses --stream flag', () => {
    const result = parseArgs([
      ...base,
      '--preset', 'p',
      '--model', 'm',
      '--cwd', '/d',
      '--task', 't',
      '--stream',
    ]);
    expect(result.stream).toBe(true);
  });

  test('defaults stream to false', () => {
    const result = parseArgs([
      ...base,
      '--preset', 'p',
      '--model', 'm',
      '--cwd', '/d',
      '--task', 't',
    ]);
    expect(result.stream).toBe(false);
  });

  test('rejects missing required arguments', () => {
    expect(() => parseArgs([...base, '--preset', 'p']))
      .toThrow('Missing required arguments');
  });

  test('rejects invalid model name (shell metacharacters)', () => {
    expect(() => parseArgs([
      ...base,
      '--preset', 'p',
      '--model', 'model; rm -rf /',
      '--cwd', '/d',
      '--task', 't',
    ])).toThrow('Invalid model name');
  });

  test('accepts model with dots, hyphens, underscores', () => {
    const result = parseArgs([
      ...base,
      '--preset', 'p',
      '--model', 'MiniMax-M2.5_beta',
      '--cwd', '/d',
      '--task', 't',
    ]);
    expect(result.model).toBe('MiniMax-M2.5_beta');
  });

  test('rejects zero --task-timeout', () => {
    expect(() => parseArgs([
      ...base,
      '--preset', 'p',
      '--model', 'm',
      '--cwd', '/d',
      '--task', 't',
      '--task-timeout', '0',
    ])).toThrow('--task-timeout must be a positive integer');
  });

  test('rejects negative --task-timeout', () => {
    expect(() => parseArgs([
      ...base,
      '--preset', 'p',
      '--model', 'm',
      '--cwd', '/d',
      '--task', 't',
      '--task-timeout', '-100',
    ])).toThrow('--task-timeout must be a positive integer');
  });

  test('rejects non-numeric --task-timeout', () => {
    expect(() => parseArgs([
      ...base,
      '--preset', 'p',
      '--model', 'm',
      '--cwd', '/d',
      '--task', 't',
      '--task-timeout', 'abc',
    ])).toThrow('--task-timeout must be a positive integer');
  });

  test('parses --system-prompt flag', () => {
    const result = parseArgs([
      ...base,
      '--preset', 'p',
      '--model', 'm',
      '--cwd', '/d',
      '--task', 't',
      '--system-prompt', 'discoverer',
    ]);
    expect(result.systemPrompt).toBe('discoverer');
  });

  test('omitting --system-prompt leaves it undefined', () => {
    const result = parseArgs([
      ...base,
      '--preset', 'p',
      '--model', 'm',
      '--cwd', '/d',
      '--task', 't',
    ]);
    expect(result.systemPrompt).toBeUndefined();
  });

  test('rejects --system-prompt without value', () => {
    expect(() => parseArgs([
      ...base,
      '--preset', 'p',
      '--model', 'm',
      '--cwd', '/d',
      '--task', 't',
      '--system-prompt',
    ])).toThrow('--system-prompt requires a value');
  });
});

// ================== parseArgs --allowed-tools ==================

describe('parseArgs --allowed-tools', () => {
  const base = ['bun', 'api-task-runner.ts'];

  test('parses --allowed-tools as comma-separated list', () => {
    const result = parseArgs([
      ...base,
      '--preset', 'p', '--model', 'm', '--cwd', '/d', '--task', 't',
      '--allowed-tools', 'Read,Glob,Grep',
    ]);
    expect(result.allowedTools).toEqual(['Read', 'Glob', 'Grep']);
  });

  test('trims whitespace from tool names', () => {
    const result = parseArgs([
      ...base,
      '--preset', 'p', '--model', 'm', '--cwd', '/d', '--task', 't',
      '--allowed-tools', 'Read, Glob, Grep',
    ]);
    expect(result.allowedTools).toEqual(['Read', 'Glob', 'Grep']);
  });

  test('omitting --allowed-tools leaves it undefined', () => {
    const result = parseArgs([
      ...base,
      '--preset', 'p', '--model', 'm', '--cwd', '/d', '--task', 't',
    ]);
    expect(result.allowedTools).toBeUndefined();
  });

  test('rejects --allowed-tools without value', () => {
    expect(() => parseArgs([
      ...base,
      '--preset', 'p', '--model', 'm', '--cwd', '/d', '--task', 't',
      '--allowed-tools',
    ])).toThrow('--allowed-tools requires a value');
  });

  test('rejects unknown flags', () => {
    expect(() => parseArgs([
      ...base,
      '--preset', 'p', '--model', 'm', '--cwd', '/d', '--task', 't',
      '--bogus',
    ])).toThrow('Unknown flag: --bogus');
  });
});

// ================== createRunner ==================

describe('createRunner', () => {
  test('returns UnifiedRunner for default protocol', () => {
    const runner = createRunner(mockPreset);
    expect(runner).toBeInstanceOf(UnifiedRunner);
  });

  test('returns UnifiedRunner for openai protocol', () => {
    const runner = createRunner(mockOpenAIPreset);
    expect(runner).toBeInstanceOf(UnifiedRunner);
  });

  test('returns UnifiedRunner for explicit anthropic protocol', () => {
    const runner = createRunner({ ...mockPreset, protocol: 'anthropic' });
    expect(runner).toBeInstanceOf(UnifiedRunner);
  });

  test('implements AgentRunner interface', () => {
    const runner = createRunner(mockPreset);
    expect(typeof runner.run).toBe('function');
  });
});

// ================== UnifiedRunner ==================

describe('UnifiedRunner', () => {
  test('returns result text on success', async () => {
    const mockStream = ((opts: any) => ({
      text: 'Task done successfully',
      steps: [],
      finishReason: 'stop',
      usage: { promptTokens: 0, completionTokens: 0 },
      warnings: [],
      response: { id: 'test', timestamp: new Date(), modelId: 'test', headers: {} },
      toolCalls: [],
      toolResults: [],
      providerMetadata: {},
      experimental_providerMetadata: {},
      logprobs: undefined,
      responseMessages: [],
      roundtrips: [],
      sources: [],
      reasoning: undefined,
      reasoningDetails: [],
      files: [],
      request: {},
    })) as unknown as typeof streamText;

    const runner = new UnifiedRunner(mockPreset, mockStream);
    const result = await runner.run('test task', defaultRunOptions);

    expect(result.result).toBe('Task done successfully');
    expect(result.error).toBeNull();
    expect(result.timedOut).toBe(false);
  });

  test('returns fallback text when result.text is empty', async () => {
    const mockStream = (() => ({
      text: '',
      steps: [],
      finishReason: 'stop',
      usage: { promptTokens: 0, completionTokens: 0 },
      warnings: [],
      response: { id: 'test', timestamp: new Date(), modelId: 'test', headers: {} },
      toolCalls: [],
      toolResults: [],
      providerMetadata: {},
      experimental_providerMetadata: {},
      logprobs: undefined,
      responseMessages: [],
      roundtrips: [],
      sources: [],
      reasoning: undefined,
      reasoningDetails: [],
      files: [],
      request: {},
    })) as unknown as typeof streamText;

    const runner = new UnifiedRunner(mockPreset, mockStream);
    const result = await runner.run('test task', defaultRunOptions);

    expect(result.result).toBe('Task completed (no text response)');
  });

  test('extracts text from intermediate steps when final step text is empty', async () => {
    const mockStream = (() => ({
      text: '',
      steps: [
        { text: 'Analyzing the code.', toolCalls: [], toolResults: [] },
        { text: 'Found the issue in auth module.', toolCalls: [{}], toolResults: [{}] },
        { text: '', toolCalls: [{}], toolResults: [{}] },
      ],
      finishReason: 'stop',
      usage: { promptTokens: 100, completionTokens: 200 },
      warnings: [],
      response: { id: 'test', timestamp: new Date(), modelId: 'test', headers: {} },
      toolCalls: [{}],
      toolResults: [{}],
      providerMetadata: {},
      experimental_providerMetadata: {},
      logprobs: undefined,
      responseMessages: [],
      roundtrips: [],
      sources: [],
      reasoning: undefined,
      reasoningDetails: [],
      files: [],
      request: {},
    })) as unknown as typeof streamText;

    const runner = new UnifiedRunner(mockPreset, mockStream);
    const result = await runner.run('test task', defaultRunOptions);

    expect(result.result).toBe('Analyzing the code.\n\nFound the issue in auth module.');
    expect(result.error).toBeNull();
  });

  test('forwards system prompt', async () => {
    let capturedOpts: any = null;
    const mockStream = ((opts: any) => {
      capturedOpts = opts;
      return {
        text: 'done',
        steps: [],
        finishReason: 'stop',
        usage: { promptTokens: 0, completionTokens: 0 },
        warnings: [],
        response: { id: 'test', timestamp: new Date(), modelId: 'test', headers: {} },
        toolCalls: [],
        toolResults: [],
        providerMetadata: {},
        experimental_providerMetadata: {},
        logprobs: undefined,
        responseMessages: [],
        roundtrips: [],
        sources: [],
        reasoning: undefined,
        reasoningDetails: [],
        files: [],
        request: {},
      };
    }) as unknown as typeof streamText;

    const runner = new UnifiedRunner(mockPreset, mockStream);
    await runner.run('test task', {
      ...defaultRunOptions,
      systemPromptContent: 'You are a code reviewer.',
    });

    expect(capturedOpts.system).toBe('You are a code reviewer.');
  });

  test('omits system prompt when not provided', async () => {
    let capturedOpts: any = null;
    const mockStream = ((opts: any) => {
      capturedOpts = opts;
      return {
        text: 'done',
        steps: [],
        finishReason: 'stop',
        usage: { promptTokens: 0, completionTokens: 0 },
        warnings: [],
        response: { id: 'test', timestamp: new Date(), modelId: 'test', headers: {} },
        toolCalls: [],
        toolResults: [],
        providerMetadata: {},
        experimental_providerMetadata: {},
        logprobs: undefined,
        responseMessages: [],
        roundtrips: [],
        sources: [],
        reasoning: undefined,
        reasoningDetails: [],
        files: [],
        request: {},
      };
    }) as unknown as typeof streamText;

    const runner = new UnifiedRunner(mockPreset, mockStream);
    await runner.run('test task', defaultRunOptions);

    expect(capturedOpts.system).toBeUndefined();
  });

  test('handles API error', async () => {
    const mockStream = (() => {
      throw new Error('API key is invalid');
    }) as unknown as typeof streamText;

    const runner = new UnifiedRunner(mockPreset, mockStream);
    const result = await runner.run('test task', defaultRunOptions);

    expect(result.result).toBeNull();
    expect(result.error).toBe('API key is invalid');
    expect(result.timedOut).toBe(false);
  });

  test('handles timeout via AbortError', async () => {
    const mockStream = (() => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    }) as unknown as typeof streamText;

    const runner = new UnifiedRunner(mockPreset, mockStream);
    const result = await runner.run('test task', defaultRunOptions);

    expect(result.result).toBeNull();
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain('timed out');
  });

  test('forwards reasoning_effort in providerOptions', async () => {
    let capturedOpts: any = null;
    const mockStream = ((opts: any) => {
      capturedOpts = opts;
      return {
        text: 'done',
        steps: [],
        finishReason: 'stop',
        usage: { promptTokens: 0, completionTokens: 0 },
        warnings: [],
        response: { id: 'test', timestamp: new Date(), modelId: 'test', headers: {} },
        toolCalls: [],
        toolResults: [],
        providerMetadata: {},
        experimental_providerMetadata: {},
        logprobs: undefined,
        responseMessages: [],
        roundtrips: [],
        sources: [],
        reasoning: undefined,
        reasoningDetails: [],
        files: [],
        request: {},
      };
    }) as unknown as typeof streamText;

    const presetWithReasoning: ApiPreset = {
      ...mockOpenAIPreset,
      reasoning_effort: 'high',
    };
    const runner = new UnifiedRunner(presetWithReasoning, mockStream);
    await runner.run('test task', { ...defaultRunOptions, model: 'gpt-4o', presetName: 'test-openai' });

    expect(capturedOpts.providerOptions).toEqual({ openai: { reasoningEffort: 'high' } });
  });

  test('does not set providerOptions when no reasoning_effort', async () => {
    let capturedOpts: any = null;
    const mockStream = ((opts: any) => {
      capturedOpts = opts;
      return {
        text: 'done',
        steps: [],
        finishReason: 'stop',
        usage: { promptTokens: 0, completionTokens: 0 },
        warnings: [],
        response: { id: 'test', timestamp: new Date(), modelId: 'test', headers: {} },
        toolCalls: [],
        toolResults: [],
        providerMetadata: {},
        experimental_providerMetadata: {},
        logprobs: undefined,
        responseMessages: [],
        roundtrips: [],
        sources: [],
        reasoning: undefined,
        reasoningDetails: [],
        files: [],
        request: {},
      };
    }) as unknown as typeof streamText;

    const runner = new UnifiedRunner(mockPreset, mockStream);
    await runner.run('test task', defaultRunOptions);

    expect(capturedOpts.providerOptions).toBeUndefined();
  });

  test('forwards max_output_tokens as maxOutputTokens', async () => {
    let capturedOpts: any = null;
    const mockStream = ((opts: any) => {
      capturedOpts = opts;
      return {
        text: 'done',
        steps: [],
        finishReason: 'stop',
        usage: { promptTokens: 0, completionTokens: 0 },
        warnings: [],
        response: { id: 'test', timestamp: new Date(), modelId: 'test', headers: {} },
        toolCalls: [],
        toolResults: [],
        providerMetadata: {},
        experimental_providerMetadata: {},
        logprobs: undefined,
        responseMessages: [],
        roundtrips: [],
        sources: [],
        reasoning: undefined,
        reasoningDetails: [],
        files: [],
        request: {},
      };
    }) as unknown as typeof streamText;

    const presetWithTokens: ApiPreset = {
      ...mockPreset,
      max_output_tokens: 8192,
    };
    const runner = new UnifiedRunner(presetWithTokens, mockStream);
    await runner.run('test task', defaultRunOptions);

    expect(capturedOpts.maxOutputTokens).toBe(8192);
  });

  test('defaults maxOutputTokens to 16384 for openai protocol', async () => {
    let capturedOpts: any = null;
    const mockStream = ((opts: any) => {
      capturedOpts = opts;
      return {
        text: 'done',
        steps: [],
        finishReason: 'stop',
        usage: { promptTokens: 0, completionTokens: 0 },
        warnings: [],
        response: { id: 'test', timestamp: new Date(), modelId: 'test', headers: {} },
        toolCalls: [],
        toolResults: [],
        providerMetadata: {},
        experimental_providerMetadata: {},
        logprobs: undefined,
        responseMessages: [],
        roundtrips: [],
        sources: [],
        reasoning: undefined,
        reasoningDetails: [],
        files: [],
        request: {},
      };
    }) as unknown as typeof streamText;

    const runner = new UnifiedRunner(mockOpenAIPreset, mockStream);
    await runner.run('test task', { ...defaultRunOptions, model: 'gpt-4o', presetName: 'test-openai' });

    expect(capturedOpts.maxOutputTokens).toBe(16384);
  });

  test('defaults maxOutputTokens to undefined for anthropic protocol', async () => {
    let capturedOpts: any = null;
    const mockStream = ((opts: any) => {
      capturedOpts = opts;
      return {
        text: 'done',
        steps: [],
        finishReason: 'stop',
        usage: { promptTokens: 0, completionTokens: 0 },
        warnings: [],
        response: { id: 'test', timestamp: new Date(), modelId: 'test', headers: {} },
        toolCalls: [],
        toolResults: [],
        providerMetadata: {},
        experimental_providerMetadata: {},
        logprobs: undefined,
        responseMessages: [],
        roundtrips: [],
        sources: [],
        reasoning: undefined,
        reasoningDetails: [],
        files: [],
        request: {},
      };
    }) as unknown as typeof streamText;

    const runner = new UnifiedRunner(mockPreset, mockStream);
    await runner.run('test task', defaultRunOptions);

    expect(capturedOpts.maxOutputTokens).toBeUndefined();
  });

  test('passes tools from buildToolSet', async () => {
    let capturedOpts: any = null;
    const mockStream = ((opts: any) => {
      capturedOpts = opts;
      return {
        text: 'done',
        steps: [],
        finishReason: 'stop',
        usage: { promptTokens: 0, completionTokens: 0 },
        warnings: [],
        response: { id: 'test', timestamp: new Date(), modelId: 'test', headers: {} },
        toolCalls: [],
        toolResults: [],
        providerMetadata: {},
        experimental_providerMetadata: {},
        logprobs: undefined,
        responseMessages: [],
        roundtrips: [],
        sources: [],
        reasoning: undefined,
        reasoningDetails: [],
        files: [],
        request: {},
      };
    }) as unknown as typeof streamText;

    const runner = new UnifiedRunner(mockPreset, mockStream);
    await runner.run('test task', {
      ...defaultRunOptions,
      allowedTools: ['Read', 'Grep'],
    });

    const toolKeys = Object.keys(capturedOpts.tools);
    expect(toolKeys.sort()).toEqual(['grep', 'read']);
  });
});
