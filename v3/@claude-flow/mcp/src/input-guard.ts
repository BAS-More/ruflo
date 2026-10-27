/**
 * @claude-flow/mcp - Input Guard
 *
 * Bounds the cost of a single tool call before schema validation runs.
 * The schema validator only walks declared properties, so content under
 * undeclared keys is never counted there; guardInput walks the whole raw
 * input iteratively (no recursion, no spread) and rejects oversized arrays,
 * objects, total size or nesting depth.
 */

import { DEFAULT_VALIDATION_LIMITS } from './schema-validator.js';

/** Taken from the schema validator's defaults so the two cannot drift */
export const INPUT_GUARD_LIMITS = {
  /** Items in any one array */
  maxArrayItems: DEFAULT_VALIDATION_LIMITS.maxArrayItems,
  /** Keys in any one object */
  maxObjectKeys: DEFAULT_VALIDATION_LIMITS.maxProperties,
  /** Values in the whole input, containers included */
  maxNodes: DEFAULT_VALIDATION_LIMITS.maxNodes,
  /** Nesting depth of objects and arrays */
  maxDepth: DEFAULT_VALIDATION_LIMITS.maxDepth,
} as const;

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
