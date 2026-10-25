/**
 * Claims MCP tool input bounds
 *
 * `claims/issue_list_available` filters with `labels.some(l => issue.labels.includes(l))`,
 * so an unbounded `labels` array costs time per stored issue. Both the zod schema
 * and the advertised JSON schema must cap it at the same value.
 */

import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import { issueListAvailableTool, claimsTools } from '../src/api/mcp-tools.js';

const MAX_LABELS = 20;

function labels(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `label-${i}`);
}

describe('claims/issue_list_available labels bound', () => {
  it('advertises maxItems on the labels JSON schema', () => {
    const schema = issueListAvailableTool.inputSchema.properties?.labels;
    expect(schema?.type).toBe('array');
    expect(schema?.maxItems).toBe(MAX_LABELS);
  });

  it('rejects one label over the limit with a too_big ZodError on labels', async () => {
    let caught: unknown;
    try {
      await issueListAvailableTool.handler({ labels: labels(MAX_LABELS + 1) });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ZodError);
    const issue = (caught as ZodError).issues[0];
    expect(issue.code).toBe('too_big');
    expect(issue.path).toEqual(['labels']);
  });

  it('accepts exactly the limit', async () => {
    const result = (await issueListAvailableTool.handler({ labels: labels(MAX_LABELS) })) as {
      issues: unknown[];
    };
    expect(Array.isArray(result.issues)).toBe(true);
  });

  it('every array in every claims tool JSON schema declares maxItems', () => {
    const missing: string[] = [];
    for (const tool of claimsTools) {
      const stack: Array<{ node: unknown; path: string }> = [
        { node: tool.inputSchema, path: tool.name },
      ];
      while (stack.length > 0) {
        const { node, path } = stack.pop()!;
        if (!node || typeof node !== 'object') continue;
        const s = node as Record<string, unknown>;
        if (s.type === 'array' && !(Number.isInteger(s.maxItems) && (s.maxItems as number) > 0)) {
          missing.push(path);
        }
        if (s.items) stack.push({ node: s.items, path: `${path}[]` });
        const props = s.properties as Record<string, unknown> | undefined;
        if (props) {
          for (const [k, v] of Object.entries(props)) stack.push({ node: v, path: `${path}.${k}` });
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
