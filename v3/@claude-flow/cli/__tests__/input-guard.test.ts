/**
 * Stdio tools/call input guard tests (ADR-061 S-5)
 *
 * The CLI stdio MCP loops passed tools/call arguments straight to
 * callMCPTool, which does no validation. A message under the 1 MiB line cap
 * can still hold hundreds of thousands of values. guardToolInput bounds the
 * shape of the arguments and the three entry points reject with -32602
 * before the tool handler runs. callMCPTool itself is left unguarded because
 * CLI commands call it in-process.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { guardToolInput, INPUT_GUARD_LIMITS } from '../src/mcp-input-guard.js';

const mcpClient = vi.hoisted(() => ({
  listMCPTools: vi.fn(),
  callMCPTool: vi.fn(),
  hasTool: vi.fn(),
}));

vi.mock('../src/mcp-client.js', () => mcpClient);

import { MCPServerManager } from '../src/mcp-server.js';

const CLI_DIR = path.join(__dirname, '..');

function nested(depth: number): unknown {
  let value: unknown = {};
  for (let i = 1; i < depth; i++) value = { child: value };
  return value;
}

describe('guardToolInput', () => {
  it('uses the documented limits', () => {
    expect(INPUT_GUARD_LIMITS).toEqual({
      maxArrayItems: 10_000,
      maxObjectKeys: 10_000,
      maxNodes: 100_000,
      maxDepth: 32,
    });
  });

  it('accepts ordinary tool input and primitives', () => {
    expect(guardToolInput({ key: 'k', value: { a: [1, 2, { b: 'c' }] }, tags: ['x'] })).toEqual({ ok: true });
    expect(guardToolInput(undefined)).toEqual({ ok: true });
    expect(guardToolInput('text')).toEqual({ ok: true });
  });

  it('accepts 10,000 array items and rejects 10,001', () => {
    expect(guardToolInput({ tags: new Array(10_000).fill('t') })).toEqual({ ok: true });
    const result = guardToolInput({ tags: new Array(10_001).fill('t') });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('input.tags');
      expect(result.reason).toContain('10000');
    }
  });

  it('accepts 10,000 object keys and rejects 10,001', () => {
    const keys = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));
    expect(guardToolInput({ data: keys(10_000) })).toEqual({ ok: true });
    const result = guardToolInput({ data: keys(10_001) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/more than 10000 keys/);
  });

  it('rejects more than 100,000 values spread across small arrays', () => {
    const within = { batches: Array.from({ length: 10 }, () => new Array(9_990).fill(0)) };
    expect(guardToolInput(within)).toEqual({ ok: true });
    const over = { batches: Array.from({ length: 11 }, () => new Array(9_100).fill(0)) };
    const result = guardToolInput(over);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/more than 100000 values/);
  });

  it('accepts depth 32 and rejects depth 33', () => {
    expect(guardToolInput(nested(32))).toEqual({ ok: true });
    const result = guardToolInput(nested(33));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/nesting exceeds 32/);
  });

  it('terminates on cyclic input', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(guardToolInput(cyclic).ok).toBe(false);
  });

  it('rejects a 3.4M-item array without walking it', () => {
    const huge = new Array(3_400_000).fill({});
    const start = performance.now();
    const result = guardToolInput({ items: huge });
    expect(performance.now() - start).toBeLessThan(50);
    expect(result.ok).toBe(false);
  });

  it('clips long paths in the reason', () => {
    const longKey = 'k'.repeat(100_000);
    const result = guardToolInput({ [longKey]: new Array(10_001).fill(0) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeLessThan(300);
  });
});

describe('MCPServerManager stdio tools/call', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mcpClient.hasTool.mockImplementation(() => true);
    mcpClient.listMCPTools.mockImplementation(() => []);
    mcpClient.callMCPTool.mockImplementation(async () => ({ ok: true }));
  });

  function call(args: unknown) {
    const manager = new MCPServerManager();
    return (manager as unknown as {
      handleMCPMessage(m: unknown, s: string): Promise<{ id?: unknown; result?: unknown; error?: { code: number; message: string } } | null>;
    }).handleMCPMessage(
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'memory_store', arguments: args } },
      'test-session'
    );
  }

  it('rejects oversized arguments with -32602 and does not call the tool', async () => {
    const response = await call({ key: 'k', value: 'v', tags: new Array(10_001).fill('t') });
    expect(response?.id).toBe(7);
    expect(response?.error?.code).toBe(-32602);
    expect(response?.error?.message).toContain('input.tags');
    expect(response!.error!.message.length).toBeLessThan(400);
    expect(mcpClient.callMCPTool).not.toHaveBeenCalled();
  });

  it('still calls the tool for ordinary arguments', async () => {
    const response = await call({ key: 'k', value: 'v', tags: ['a'] });
    expect(response?.error).toBeUndefined();
    expect(mcpClient.callMCPTool).toHaveBeenCalledTimes(1);
  });

  it('keeps -32601 for an unknown tool', async () => {
    mcpClient.hasTool.mockImplementation(() => false);
    const response = await call({ tags: new Array(10_001).fill('t') });
    expect(response?.error?.code).toBe(-32601);
  });
});

describe('stdio entry points guard tools/call', () => {
  for (const file of ['bin/cli.js', 'bin/mcp-server.js', 'src/mcp-server.ts']) {
    it(`${file} runs guardToolInput before callMCPTool and replies -32602`, () => {
      const content = fs.readFileSync(path.join(CLI_DIR, file), 'utf-8');
      const block = content.slice(content.indexOf("case 'tools/call'"));
      const guardAt = block.indexOf('guardToolInput(');
      const callAt = block.indexOf('callMCPTool(');
      expect(guardAt).toBeGreaterThan(-1);
      expect(callAt).toBeGreaterThan(guardAt);
      expect(block.slice(guardAt, callAt)).toContain('-32602');
    });
  }
});
