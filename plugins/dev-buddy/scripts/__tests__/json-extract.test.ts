import { describe, test, expect } from 'bun:test';
import { extractJsonFromResult } from '../json-extract.ts';

describe('extractJsonFromResult', () => {
  // Strategy 0: non-string input
  test('returns object input as-is', () => {
    const obj = { key: 'value' };
    expect(extractJsonFromResult(obj)).toEqual(obj);
  });

  test('returns array input as-is', () => {
    const arr = [1, 2, 3];
    expect(extractJsonFromResult(arr)).toEqual(arr);
  });

  test('returns null for null input', () => {
    expect(extractJsonFromResult(null)).toBeNull();
  });

  test('returns null for undefined input', () => {
    expect(extractJsonFromResult(undefined)).toBeNull();
  });

  test('returns null for number input', () => {
    expect(extractJsonFromResult(42)).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(extractJsonFromResult('')).toBeNull();
  });

  test('returns null for whitespace-only string', () => {
    expect(extractJsonFromResult('   \n  ')).toBeNull();
  });

  // Strategy 1: direct JSON parse
  test('parses raw JSON object string', () => {
    const json = '{"key": "value", "num": 42}';
    expect(extractJsonFromResult(json)).toEqual({ key: 'value', num: 42 });
  });

  test('parses raw JSON array string', () => {
    const json = '[1, 2, 3]';
    expect(extractJsonFromResult(json)).toEqual([1, 2, 3]);
  });

  // Strategy 2: code fences
  test('extracts JSON from ```json code block', () => {
    const md = 'Some analysis text\n\n```json\n{"key": "value"}\n```\n\nMore text';
    expect(extractJsonFromResult(md)).toEqual({ key: 'value' });
  });

  test('extracts JSON from ``` code block (no lang tag)', () => {
    const md = 'Text\n\n```\n{"key": "value"}\n```\n';
    expect(extractJsonFromResult(md)).toEqual({ key: 'value' });
  });

  test('extracts last JSON block when multiple present', () => {
    const md = '```json\n{"first": true}\n```\n\nMore text\n\n```json\n{"last": true}\n```';
    expect(extractJsonFromResult(md)).toEqual({ last: true });
  });

  test('falls back to earlier block when last block is malformed', () => {
    const md = '```json\n{"good": true}\n```\n\n```json\n{bad json\n```';
    expect(extractJsonFromResult(md)).toEqual({ good: true });
  });

  test('returns null for plain text with no JSON', () => {
    expect(extractJsonFromResult('This is just plain text with no JSON')).toBeNull();
  });

  test('returns null when code blocks contain non-JSON', () => {
    const md = '```\nfunction hello() { return 1; }\n```';
    expect(extractJsonFromResult(md)).toBeNull();
  });

  test('returns null when all code blocks contain malformed JSON', () => {
    const md = '```json\n{bad\n```\n\n```json\n{also bad}\n```';
    expect(extractJsonFromResult(md)).toBeNull();
  });

  // Real-world example from analysis files
  test('extracts JSON from real analysis file result', () => {
    const result = 'Based on my analysis of the codebase:\n\n```json\n{"acceptance_criteria": [{"id": "AC1", "description": "Test"}], "scope": {"in_scope": ["feature A"]}}\n```';
    const parsed = extractJsonFromResult(result) as Record<string, unknown>;
    expect(parsed).not.toBeNull();
    expect(Array.isArray(parsed.acceptance_criteria)).toBe(true);
    expect((parsed.acceptance_criteria as unknown[]).length).toBe(1);
  });
});
