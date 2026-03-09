/**
 * Schema compliance tests for OpenAI structured output requirements.
 *
 * OpenAI's response_format strict mode requires:
 * 1. No `default` keyword on any property
 * 2. Every object with `properties` has ALL property names listed in `required`
 * 3. Every object has `additionalProperties: false`
 */
import { describe, test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';

const SCHEMAS_DIR = path.resolve(__dirname, '../../docs/schemas');

/**
 * Recursively validate a JSON Schema node for OpenAI structured output compliance.
 * Returns an array of violation descriptions.
 */
function validateNode(node: unknown, jsonPath: string): string[] {
  const violations: string[] = [];
  if (!node || typeof node !== 'object' || Array.isArray(node)) return violations;

  const obj = node as Record<string, unknown>;

  // Check for `default` keyword
  if ('default' in obj) {
    violations.push(`${jsonPath}: has "default" keyword (not allowed in OpenAI structured output)`);
  }

  // If this is an object type with properties, check required + additionalProperties
  if (obj.type === 'object' && obj.properties && typeof obj.properties === 'object') {
    const props = obj.properties as Record<string, unknown>;
    const propNames = Object.keys(props);

    // Check additionalProperties: false
    if (obj.additionalProperties !== false) {
      violations.push(`${jsonPath}: missing "additionalProperties: false"`);
    }

    // Check all properties are in required
    const required = Array.isArray(obj.required) ? obj.required as string[] : [];
    for (const propName of propNames) {
      if (!required.includes(propName)) {
        violations.push(`${jsonPath}: property "${propName}" not listed in "required"`);
      }
    }

    // Recurse into properties
    for (const [propName, propValue] of Object.entries(props)) {
      violations.push(...validateNode(propValue, `${jsonPath}.properties.${propName}`));
    }
  }

  // Recurse into array items
  if (obj.type === 'array' && obj.items) {
    violations.push(...validateNode(obj.items, `${jsonPath}.items`));
  }

  return violations;
}

describe('OpenAI structured output schema compliance', () => {
  const schemaFiles = ['plan-review.schema.json', 'review-result.schema.json'];

  for (const filename of schemaFiles) {
    test(`${filename} has no "default" keywords`, () => {
      const schemaPath = path.join(SCHEMAS_DIR, filename);
      const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
      const violations = validateNode(schema, '$').filter(v => v.includes('"default"'));
      expect(violations).toEqual([]);
    });

    test(`${filename} has all properties in "required"`, () => {
      const schemaPath = path.join(SCHEMAS_DIR, filename);
      const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
      const violations = validateNode(schema, '$').filter(v => v.includes('not listed in "required"'));
      expect(violations).toEqual([]);
    });

    test(`${filename} has "additionalProperties: false" on all objects`, () => {
      const schemaPath = path.join(SCHEMAS_DIR, filename);
      const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
      const violations = validateNode(schema, '$').filter(v => v.includes('additionalProperties'));
      expect(violations).toEqual([]);
    });
  }
});
