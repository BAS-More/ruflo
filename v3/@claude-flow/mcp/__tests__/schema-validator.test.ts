/**
 * @claude-flow/mcp - Schema Validator resource bounds
 *
 * Untrusted tool input must not be able to blow the stack, collect unbounded
 * errors, or make error text grow with the size of the input.
 */

import { describe, it, expect } from 'vitest';
import {
  validateSchema,
  formatValidationErrors,
  createValidator,
  DEFAULT_VALIDATION_LIMITS,
  guardInput,
  INPUT_GUARD_LIMITS,
} from '../src/index.js';
import type { JSONSchema } from '../src/types.js';

const itemsSchema: JSONSchema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  },
};

describe('validateSchema resource limits', () => {
  it('exports the default limits', () => {
    expect(DEFAULT_VALIDATION_LIMITS).toEqual({
      maxErrors: 20,
      maxArrayItems: 10_000,
      maxProperties: 10_000,
      maxNodes: 100_000,
      maxDepth: 32,
    });
  });

  it('rejects a 200k-item array with one maxItems error, without walking it', () => {
    const data = { items: Array.from({ length: 200_000 }, () => ({})) };
    const start = performance.now();
    const result = validateSchema(data, itemsSchema);
    const elapsed = performance.now() - start;

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].keyword).toBe('maxItems');
    expect(result.errors[0].params).toMatchObject({ limit: 10_000, actual: 200_000 });
    expect(elapsed).toBeLessThan(50);
  });

  it('stops at 20 errors for 10k invalid items', () => {
    const data = { items: Array.from({ length: 10_000 }, () => ({})) };
    const start = performance.now();
    const result = validateSchema(data, itemsSchema);
    const elapsed = performance.now() - start;

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(20);
    expect(result.truncated).toBe(true);
    expect(elapsed).toBeLessThan(200);
  });

  it('honours a schema maxItems below the hard cap', () => {
    const schema: JSONSchema = { type: 'array', maxItems: 5 };
    const over = validateSchema([1, 2, 3, 4, 5, 6], schema);
    expect(over.errors).toHaveLength(1);
    expect(over.errors[0].keyword).toBe('maxItems');
    expect(over.errors[0].params).toMatchObject({ limit: 5, actual: 6 });

    expect(validateSchema([1, 2, 3, 4, 5], schema).valid).toBe(true);
  });

  it('checks minItems', () => {
    const result = validateSchema([1], { type: 'array', minItems: 2 });
    expect(result.valid).toBe(false);
    expect(result.errors[0].keyword).toBe('minItems');
  });

  it('applies the hard cap to an array schema with no items schema', () => {
    const result = validateSchema(new Array(10_001).fill(0), { type: 'array' });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].keyword).toBe('maxItems');
  });

  it('a schema maxItems above the hard cap cannot raise it', () => {
    const result = validateSchema(new Array(10_001).fill(0), { type: 'array', maxItems: 50_000 });
    expect(result.errors[0].keyword).toBe('maxItems');
    expect(result.errors[0].params).toMatchObject({ limit: 10_000 });
  });

  it('stops at 20 errors for 5k additional properties', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: false,
    };
    const data: Record<string, unknown> = {};
    for (let i = 0; i < 5_000; i++) data[`extra${i}`] = i;

    const result = validateSchema(data, schema);
    expect(result.errors).toHaveLength(20);
    expect(result.truncated).toBe(true);
  });

  it('clips a 100k-character property name in the error', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: false,
    };
    const result = validateSchema({ ['k'.repeat(100_000)]: 1 }, schema);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].path.length).toBeLessThanOrEqual(203);
    expect(result.errors[0].message.length).toBeLessThan(300);
    expect(String(result.errors[0].params?.additionalProperty).length).toBeLessThanOrEqual(203);
  });

  it('rejects an object with more than 10,000 keys', () => {
    const data: Record<string, unknown> = {};
    for (let i = 0; i <= 10_000; i++) data[`k${i}`] = i;
    const result = validateSchema(data, { type: 'object' });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].keyword).toBe('maxProperties');
  });

  it('honours a schema maxProperties', () => {
    const result = validateSchema({ a: 1, b: 2, c: 3 }, { type: 'object', maxProperties: 2 });
    expect(result.errors[0].keyword).toBe('maxProperties');
    expect(validateSchema({ a: 1, b: 2 }, { type: 'object', maxProperties: 2 }).valid).toBe(true);
  });

  it('stops at maxNodes, and does not report it as truncated errors', () => {
    const schema: JSONSchema = {
      type: 'array',
      items: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
    };
    const data = Array.from({ length: 50 }, () =>
      Array.from({ length: 50 }, () => Array.from({ length: 50 }, () => 1))
    );

    const result = validateSchema(data, schema, '', { maxNodes: 1000 });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].keyword).toBe('maxNodes');
    expect(result.limitHit).toBe(true);
    expect(result.truncated).toBeUndefined();
  });

  it('stops at maxDepth for a deep schema', () => {
    const schema: JSONSchema = { type: 'array' };
    let cursor = schema;
    let data: unknown[] = [];
    const root = data;
    for (let i = 0; i < 40; i++) {
      cursor.items = { type: 'array' };
      cursor = cursor.items;
      const next: unknown[] = [];
      data.push(next);
      data = next;
    }

    const result = validateSchema(root, schema);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].keyword).toBe('maxDepth');
    expect(result.limitHit).toBe(true);
  });

  it('terminates on a cyclic schema', () => {
    const schema: JSONSchema = { type: 'array' };
    schema.items = schema;
    let data: unknown[] = [];
    const root = data;
    for (let i = 0; i < 40; i++) {
      const next: unknown[] = [];
      data.push(next);
      data = next;
    }

    const result = validateSchema(root, schema);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].keyword).toBe('maxDepth');
  });

  it('lets a caller raise the array cap explicitly', () => {
    const schema: JSONSchema = { type: 'array', items: { type: 'number' } };
    const data = new Array(20_000).fill(1);
    expect(validateSchema(data, schema, '', { maxArrayItems: 50_000 }).valid).toBe(true);
    expect(createValidator(schema, { maxArrayItems: 50_000 })(data).valid).toBe(true);
    expect(createValidator(schema)(data).valid).toBe(false);
  });

  it('does not run pattern or enum on a string over maxLength', () => {
    const result = validateSchema('x'.repeat(20), {
      type: 'string',
      maxLength: 10,
      pattern: '^a+$',
      enum: ['a'],
    });
    expect(result.errors.map((e) => e.keyword)).toEqual(['maxLength']);
  });
});

describe('validateSchema existing behaviour', () => {
  it('reports a type mismatch', () => {
    const result = validateSchema('x', { type: 'number' });
    expect(result.errors).toEqual([
      expect.objectContaining({ path: 'root', keyword: 'type' }),
    ]);
  });

  it('reports a missing required property', () => {
    const result = validateSchema({}, { type: 'object', required: ['id'] });
    expect(result.errors[0]).toMatchObject({ path: 'id', keyword: 'required' });
  });

  it('reports string, number, pattern and enum violations', () => {
    expect(validateSchema('a', { type: 'string', minLength: 2 }).errors[0].keyword).toBe('minLength');
    expect(validateSchema('abc', { type: 'string', maxLength: 2 }).errors[0].keyword).toBe('maxLength');
    expect(validateSchema('b', { type: 'string', pattern: '^a$' }).errors[0].keyword).toBe('pattern');
    expect(validateSchema('b', { type: 'string', enum: ['a'] }).errors[0].keyword).toBe('enum');
    expect(validateSchema(1, { type: 'number', minimum: 2 }).errors[0].keyword).toBe('minimum');
    expect(validateSchema(3, { type: 'number', maximum: 2 }).errors[0].keyword).toBe('maximum');
  });

  it('reports additional properties and nested paths', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: { list: { type: 'array', items: { type: 'number' } } },
      additionalProperties: false,
    };
    const result = validateSchema({ list: [1, 'two'], extra: true }, schema);
    expect(result.errors.map((e) => `${e.path}:${e.keyword}`)).toEqual([
      'list[1]:type',
      'extra:additionalProperties',
    ]);
    expect(result.truncated).toBeUndefined();
  });

  it('accepts valid input', () => {
    const result = validateSchema({ items: [{ id: 'a' }, { id: 'b' }] }, itemsSchema);
    expect(result).toEqual({ valid: true, errors: [] });
  });
});

describe('formatValidationErrors', () => {
  it('shows at most 10 errors', () => {
    const errors = Array.from({ length: 50 }, (_, i) => ({
      path: `p${i}`,
      message: 'bad',
      keyword: 'type',
    }));
    const text = formatValidationErrors(errors);
    expect(text.split('; ')).toHaveLength(11);
    expect(text.endsWith('... and 40 more')).toBe(true);
  });

  it('is unchanged for a few errors', () => {
    expect(formatValidationErrors([{ path: 'a', message: 'bad', keyword: 'type' }])).toBe('a: bad');
  });
});

describe('guardInput', () => {
  it('exports the guard limits', () => {
    expect(INPUT_GUARD_LIMITS).toEqual({
      maxArrayItems: 10_000,
      maxObjectKeys: 10_000,
      maxNodes: 100_000,
      maxDepth: 32,
    });
  });

  it('uses the same limits as the schema validator', () => {
    expect(INPUT_GUARD_LIMITS.maxArrayItems).toBe(DEFAULT_VALIDATION_LIMITS.maxArrayItems);
    expect(INPUT_GUARD_LIMITS.maxObjectKeys).toBe(DEFAULT_VALIDATION_LIMITS.maxProperties);
    expect(INPUT_GUARD_LIMITS.maxNodes).toBe(DEFAULT_VALIDATION_LIMITS.maxNodes);
    expect(INPUT_GUARD_LIMITS.maxDepth).toBe(DEFAULT_VALIDATION_LIMITS.maxDepth);
  });

  it('accepts ordinary input and arrays at the cap', () => {
    expect(guardInput({ a: 1, b: [1, 2, { c: 'x' }] })).toEqual({ ok: true });
    expect(guardInput({ tags: new Array(10_000).fill('t') })).toEqual({ ok: true });
  });

  it('rejects an array over the cap without walking it', () => {
    const data = { junk: Array.from({ length: 3_400_000 }, () => ({})) };
    const start = performance.now();
    const result = guardInput(data);
    expect(performance.now() - start).toBeLessThan(50);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('10000');
  });

  it('rejects too many keys, too many values and too much depth', () => {
    const keys: Record<string, unknown> = {};
    for (let i = 0; i <= 10_000; i++) keys[`k${i}`] = i;
    expect(guardInput(keys).ok).toBe(false);

    const many = { junk: Array.from({ length: 25 }, () => new Array(9_999).fill(0)) };
    expect(guardInput(many).ok).toBe(false);

    let deep: unknown = 1;
    for (let i = 0; i < 33; i++) deep = [deep];
    expect(guardInput(deep).ok).toBe(false);

    let ok: unknown = 1;
    for (let i = 0; i < 31; i++) ok = [ok];
    expect(guardInput(ok).ok).toBe(true);
  });

  it('terminates on cyclic input', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(guardInput(cyclic).ok).toBe(false);
  });

  it('clips long paths in the reason', () => {
    const data = { ['k'.repeat(100_000)]: new Array(10_001).fill(0) };
    const result = guardInput(data);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeLessThan(300);
  });
});
