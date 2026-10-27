/**
 * V3 MCP Tool-Input Array Limits Tests
 *
 * Every array a tool accepts must be bounded, both in the JSON inputSchema
 * (checked by Ajv in the tool registry) and in the zod schema (checked by the
 * handler). An unbounded array lets one tools/call send millions of items.
 *
 * The tools are imported through the .js paths the server uses, so these tests
 * also fail if the tracked compiled copies drift from the .ts sources.
 */

import { describe, it, expect, vi } from 'vitest';

// hooks-tools imports @claude-flow/neural, whose tracked compiled modes/*.js
// copies have a circular import that fails at load time under vitest. The
// ReasoningBank is created lazily and never reached here, so stub the module.
vi.mock('../../@claude-flow/neural/src/index.js', () => ({
  createReasoningBank: vi.fn(),
}));

import { getAllTools } from '../tools/index.js';
import { spawnEphemeralTool, registerSwarmTool } from '../tools/federation-tools.js';
import { routeTool } from '../tools/hooks-tools.js';
import { storeMemoryTool, searchMemoryTool, listMemoryTool } from '../tools/memory-tools.js';
import { saveSessionTool, listSessionsTool } from '../tools/session-tools.js';
import { scaleSwarmTool } from '../tools/swarm-tools.js';
import { systemMetricsTool, systemHealthTool } from '../tools/system-tools.js';
import { createTaskTool, taskDependenciesTool } from '../tools/task-tools.js';
import { MCPTool, ToolContext, JSONSchema } from '../types.js';

interface Issue {
  code: string;
  path: (string | number)[];
}

const context: ToolContext = { sessionId: 'array-limits-test' } as ToolContext;

/**
 * Run the handler and return the ZodError issues it throws.
 * Every input below carries one invalid element, so parse always throws and
 * no handler side effect (hub, timers, stores) ever runs.
 */
async function zodIssues(tool: MCPTool, input: Record<string, unknown>): Promise<Issue[]> {
  try {
    await tool.handler(input, context);
  } catch (error) {
    const err = error as { name?: string; issues?: Issue[] };
    if (err && err.name === 'ZodError' && Array.isArray(err.issues)) {
      return err.issues;
    }
    throw error;
  }
  throw new Error(`${tool.name} accepted an input with an invalid element`);
}

/** n items: n - 1 valid ones and a trailing invalid one */
function poisoned(n: number, valid: string): unknown[] {
  const items: unknown[] = Array.from({ length: n - 1 }, () => valid);
  items.push(123);
  return items;
}

function tooBigOn(issues: Issue[], field: string): boolean {
  return issues.some((i) => i.code === 'too_big' && i.path.length === 1 && i.path[0] === field);
}

/** Paths of every type:'array' node that has no maxItems */
function unboundedArrays(schema: JSONSchema, path: string): string[] {
  const found: string[] = [];
  const stack: Array<{ node: JSONSchema; path: string }> = [{ node: schema, path }];
  while (stack.length > 0) {
    const { node, path: p } = stack.pop()!;
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'array' && !(Number.isInteger(node.maxItems) && (node.maxItems as number) > 0)) {
      found.push(p);
    }
    if (node.items) stack.push({ node: node.items, path: `${p}[]` });
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      stack.push({ node: child, path: `${p}.${key}` });
    }
    if (node.additionalProperties && typeof node.additionalProperties === 'object') {
      stack.push({ node: node.additionalProperties, path: `${p}.*` });
    }
  }
  return found;
}

const cases: Array<{ tool: MCPTool; field: string; limit: number; base: Record<string, unknown>; valid?: string }> = [
  { tool: spawnEphemeralTool, field: 'capabilities', limit: 50, base: { type: 'coder', task: 't' } },
  { tool: registerSwarmTool, field: 'capabilities', limit: 100, base: { swarmId: 's', name: 'n' } },
  { tool: routeTool, field: 'preferredAgents', limit: 100, base: { task: 't' } },
  { tool: storeMemoryTool, field: 'tags', limit: 50, base: { content: 'c' } },
  { tool: searchMemoryTool, field: 'tags', limit: 20, base: { query: 'q' } },
  { tool: listMemoryTool, field: 'tags', limit: 20, base: {} },
  { tool: saveSessionTool, field: 'tags', limit: 50, base: {} },
  { tool: listSessionsTool, field: 'tags', limit: 20, base: {} },
  { tool: scaleSwarmTool, field: 'agentTypes', limit: 100, base: { targetAgents: 1 } },
  { tool: systemMetricsTool, field: 'components', limit: 5, base: {}, valid: 'all' },
  { tool: systemHealthTool, field: 'components', limit: 20, base: {} },
  { tool: createTaskTool, field: 'dependencies', limit: 100, base: { type: 'code', description: 'd' } },
  { tool: taskDependenciesTool, field: 'dependencies', limit: 100, base: { taskId: 't', action: 'add' } },
];

describe('MCP tool-input array limits', () => {
  it('declares maxItems on every array in every tool inputSchema', () => {
    const unbounded = getAllTools().flatMap((tool) => unboundedArrays(tool.inputSchema, tool.name));
    expect(unbounded).toEqual([]);
  });

  describe.each(cases)('$tool.name $field (limit $limit)', ({ tool, field, limit, base, valid = 'x' }) => {
    it('declares the same maxItems in its JSON inputSchema', () => {
      expect(tool.inputSchema.properties?.[field]?.maxItems).toBe(limit);
    });

    it('rejects limit + 1 items with too_big on the field', async () => {
      const issues = await zodIssues(tool, { ...base, [field]: poisoned(limit + 1, valid) });
      expect(tooBigOn(issues, field)).toBe(true);
    });

    it('accepts limit items without too_big', async () => {
      const issues = await zodIssues(tool, { ...base, [field]: poisoned(limit, valid) });
      expect(tooBigOn(issues, field)).toBe(false);
    });
  });
});
