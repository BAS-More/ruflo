/**
 * Input guard for stdio tools/call (ADR-061 S-5)
 *
 * Used by bin/cli.js, bin/mcp-server.js and src/mcp-server.ts before
 * callMCPTool, which does no validation of its own. It is called only at
 * those MCP entry points, not inside callMCPTool, so in-process CLI callers
 * are unaffected; a rejection is answered with -32602.
 *
 * The walk is iterative (no recursion, no spread). Array and object sizes
 * are checked before any child is visited, so a huge array is rejected
 * without walking it. Same limits as guardInput in @claude-flow/mcp.
 */

export const INPUT_GUARD_LIMITS = {
  /** Items in any one array */
  maxArrayItems: 10_000,
  /** Keys in any one object */
  maxObjectKeys: 10_000,
  /** Values in the whole input, containers included */
  maxNodes: 100_000,
  /** Nesting depth of objects and arrays */
  maxDepth: 32,
} as const;

/** Characters of a path kept in a reason */
const MAX_PATH_LENGTH = 200;

export type InputGuardResult = { ok: true } | { ok: false; reason: string };

function clip(path: string): string {
  return path.length > MAX_PATH_LENGTH ? `${path.slice(0, MAX_PATH_LENGTH)}...` : path;
}

/**
 * Check the shape of tool arguments against INPUT_GUARD_LIMITS.
 */
export function guardToolInput(input: unknown): InputGuardResult {
  const limits = INPUT_GUARD_LIMITS;
  const stack: Array<{ value: unknown; path: string; depth: number }> = [
    { value: input, path: 'input', depth: 1 },
  ];
  let nodes = 1;

  while (stack.length > 0) {
    const { value, path, depth } = stack.pop()!;
    if (value === null || typeof value !== 'object') continue;

    if (depth > limits.maxDepth) {
      return { ok: false, reason: `${clip(path)}: nesting exceeds ${limits.maxDepth} levels` };
    }

    const isArray = Array.isArray(value);
    const keys = isArray ? null : Object.keys(value);
    const count = isArray ? (value as unknown[]).length : keys!.length;

    if (isArray && count > limits.maxArrayItems) {
      return { ok: false, reason: `${clip(path)}: array has more than ${limits.maxArrayItems} items` };
    }
    if (!isArray && count > limits.maxObjectKeys) {
      return { ok: false, reason: `${clip(path)}: object has more than ${limits.maxObjectKeys} keys` };
    }

    nodes += count;
    if (nodes > limits.maxNodes) {
      return { ok: false, reason: `input has more than ${limits.maxNodes} values` };
    }

    for (let i = 0; i < count; i++) {
      const key = isArray ? String(i) : keys![i];
      const child = (value as Record<string, unknown>)[key];
      if (child !== null && typeof child === 'object') {
        stack.push({ value: child, path: isArray ? `${path}[${i}]` : `${path}.${key}`, depth: depth + 1 });
      }
    }
  }

  return { ok: true };
}
