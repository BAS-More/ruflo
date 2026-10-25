/**
 * Import an optional dependency without letting an unloadable native addon in
 * its graph surface as an unhandled rejection (see ./native-probe.ts).
 *
 * @module v3/integration/optional-import
 */

import { nativeDepsLoadable, type NativeProbe } from './native-probe.js';

/**
 * Import an optional module, returning `null` when it is not installed, fails
 * to load, or (with a probe) when one of its native dependencies cannot load.
 * Use this instead of `import(x).catch(() => null)` for any module whose graph
 * contains native addons.
 */
export async function importOptional<T = unknown>(
  specifier: string,
  probe?: NativeProbe,
): Promise<T | null> {
  if (probe && !nativeDepsLoadable(specifier, probe)) {
    return null;
  }
  try {
    return (await import(specifier)) as T;
  } catch {
    return null;
  }
}
