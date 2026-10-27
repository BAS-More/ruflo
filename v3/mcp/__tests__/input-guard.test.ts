/**
 * V3 MCP Input Guard Tests
 *
 * The tool registry must bound the cost of validating one tools/call before
 * Ajv or zod see it:
 * - a structural guard rejects oversized or deeply nested input, including
 *   content hidden under z.record(z.unknown()) fields that Ajv sees as 'object'
 * - Ajv stops at the first error instead of reporting one per bad item
 * - logged and returned error text stays small, also for ZodErrors
 */

import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import { z } from 'zod';

// ajv is declared by @claude-flow/mcp, not by v3/mcp, and pnpm does not hoist
// it, so the registry's bare 'ajv' import cannot resolve from here. Load the
// same real Ajv from the package that declares it.
vi.mock('ajv', () => {
  const requireFromMcp = createRequire(
    new URL('../../@claude-flow/mcp/package.json', import.meta.url)
  );
  return { default: requireFromMcp('ajv') };
});

import { guardInput, formatToolError, INPUT_GUARD_LIMITS } from '../input-guard.js';
import { ToolRegistry } from '../tool-registry.js';
import { ILogger, MCPTool } from '../types.js';

function nest(depth: number): unknown {
  let value: unknown = 'leaf';
  for (let i = 0; i < depth; i++) value = { a: value };
  return value;
}

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createTool(handler: MCPTool['handler'], inputSchema: MCPTool['inputSchema']): MCPTool {
  return { name: 'guarded_tool', description: 'test tool', inputSchema, handler };
}

describe('guardInput', () => {
  it('uses the documented limits', () => {
    expect(INPUT_GUARD_LIMITS).toEqual({
      maxArrayItems: 10_000,
      maxObjectKeys: 10_000,
      maxNodes: 100_000,
      maxDepth: 32,
    });
  });

  it('accepts ordinary input', () => {
    expect(guardInput({ key: 'k', value: { a: [1, 2, { b: null }] }, tags: ['x'] })).toEqual({ ok: true });
  });

  it('accepts an array at the item limit and rejects one above it', () => {
    expect(guardInput({ tags: Array(10_000).fill('t') }).ok).toBe(true);
    const result = guardInput({ tags: Array(10_001).fill('t') });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('input.tags');
    expect(result.ok === false && result.reason).toContain('10000');
  });

  it('accepts an object at the key limit and rejects one above it', () => {
    const keys = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));
    expect(guardInput({ metadata: keys(10_000) }).ok).toBe(true);
    const result = guardInput({ metadata: keys(10_001) });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('input.metadata');
  });

  it('rejects input with more than 100,000 values in total', () => {
    // 11 arrays of 9,999 items: each passes the per-array limit, the total does not
    const input = { input: Array.from({ length: 11 }, () => Array(9_999).fill(0)) };
    const result = guardInput(input);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('100000');
  });

  it('accepts nesting 32 levels deep and rejects 33', () => {
    expect(guardInput(nest(32) as Record<string, unknown>).ok).toBe(true);
    const result = guardInput(nest(33) as Record<string, unknown>);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('32');
  });

  it('terminates on cyclic input from in-process callers', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(guardInput(cyclic).ok).toBe(false);
  });

  it('rejects a 3.4M-item array quickly, without walking it', () => {
    const huge = { metadata: { junk: new Array(3_400_000) } };
    const start = performance.now();
    expect(guardInput(huge).ok).toBe(false);
    expect(performance.now() - start).toBeLessThan(50);
  });

  it('keeps the reason short when a key is very long', () => {
    const result = guardInput({ ['x'.repeat(100_000)]: Array(10_001).fill(0) });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason.length).toBeLessThan(300);
  });
});

describe('formatToolError', () => {
  it('cuts ZodError text to the first 5 issues', () => {
    const parsed = z.array(z.string()).safeParse(Array(1_000).fill(1));
    expect(parsed.success).toBe(false);
    const text = formatToolError(!parsed.success ? parsed.error : undefined);
    expect(text).toContain('(995 more)');
    expect(text.length).toBeLessThan(1_000);
  });

  it('passes ordinary error messages through', () => {
    expect(formatToolError(new Error('boom'))).toBe('boom');
    expect(formatToolError('plain')).toBe('plain');
  });
});

describe('ToolRegistry.execute input bounds', () => {
  it('rejects an oversized array hidden under a record field before the handler runs', async () => {
    const logger = createLogger();
    const registry = new ToolRegistry(logger as ILogger);
    const handler = vi.fn(async () => 'ran');
    // metadata mirrors z.record(z.unknown()): Ajv only sees type 'object'
    registry.register(createTool(handler, {
      type: 'object',
      properties: { metadata: { type: 'object' } },
    }));

    const result = await registry.execute('guarded_tool', { metadata: { junk: Array(200_000).fill({}) } });

    expect(result.isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(result.content[0].text!.length).toBeLessThan(2_000);
  });

  it('reports one Ajv error, not one per invalid item', async () => {
    const logger = createLogger();
    const registry = new ToolRegistry(logger as ILogger);
    const handler = vi.fn(async () => 'ran');
    registry.register(createTool(handler, {
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } } },
    }));

    const result = await registry.execute('guarded_tool', { tags: Array(10_000).fill(1) });

    expect(result.isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(result.content[0].text!.length).toBeLessThan(2_000);
    const logged = logger.warn.mock.calls[0][1] as { errors: string[] };
    expect(logged.errors.length).toBeLessThanOrEqual(5);
  });

  it('enforces a schema maxItems through Ajv', async () => {
    const registry = new ToolRegistry(createLogger() as ILogger);
    const handler = vi.fn(async () => 'ran');
    registry.register(createTool(handler, {
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' }, maxItems: 50 } },
    }));

    const result = await registry.execute('guarded_tool', { tags: Array(51).fill('t') });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('50');
    expect(handler).not.toHaveBeenCalled();
  });

  it('still runs the handler for valid input', async () => {
    const registry = new ToolRegistry(createLogger() as ILogger);
    const handler = vi.fn(async () => 'ran');
    registry.register(createTool(handler, {
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' }, maxItems: 50 } },
    }));

    const result = await registry.execute('guarded_tool', { tags: ['a', 'b'] });

    expect(result.isError).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('bounds the returned and logged text of a ZodError thrown by the handler', async () => {
    const logger = createLogger();
    const registry = new ToolRegistry(logger as ILogger);
    registry.register(createTool(async (input) => z.object({ tags: z.array(z.string()) }).parse(input), {
      type: 'object',
      properties: { tags: { type: 'array' } },
    }));

    const result = await registry.execute('guarded_tool', { tags: Array(5_000).fill(1) });

    expect(result.isError).toBe(true);
    expect(result.content[0].text!.length).toBeLessThan(2_000);
    expect(result.content[0].text).toContain('more)');
    expect(JSON.stringify(logger.error.mock.calls[0][1]).length).toBeLessThan(2_000);
  });
});
