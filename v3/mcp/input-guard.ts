/**
 * V3 MCP Input Guard
 *
 * Bounds the cost of a single tools/call before Ajv or zod run:
 * - guardInput walks the raw input iteratively (no recursion, no spread) and
 *   rejects oversized arrays, objects, total size or nesting depth. It also
 *   covers z.record(z.unknown()) fields, which Ajv only sees as 'object'.
 * - formatToolError cuts ZodError text, which zod 3 renders with one entry
 *   per issue, to the first few issues.
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

/** ZodError issues kept in an error message */
const MAX_ERROR_ISSUES = 5;

/** Characters of a path kept in a reason */
const MAX_PATH_LENGTH = 200;

export type InputGuardResult = { ok: true } | { ok: false; reason: string };

function clip(path: string): string {
  return path.length > MAX_PATH_LENGTH ? `${path.slice(0, MAX_PATH_LENGTH)}...` : path;
}

/**
 * Check the shape of tool input against INPUT_GUARD_LIMITS.
 * Lengths are checked before any child is visited, so a huge array is
 * rejected without walking it.
 */
export function guardInput(input: unknown): InputGuardResult {
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

/**
 * Error text for a failed tool call, bounded for ZodErrors.
 */
export function formatToolError(error: unknown): string {
  const err = error as { name?: string; issues?: Array<{ path?: unknown[]; message?: string }> } | undefined;
  if (err && err.name === 'ZodError' && Array.isArray(err.issues)) {
    const shown = err.issues.slice(0, MAX_ERROR_ISSUES).map((issue) => {
      const path = Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.join('.') : 'input';
      return `${clip(path)}: ${issue.message}`;
    });
    const more = err.issues.length - shown.length;
    return `Invalid input: ${shown.join('; ')}${more > 0 ? ` (${more} more)` : ''}`;
  }
  return error instanceof Error ? error.message : String(error);
}
