/**
 * Native-addon probe for optional imports.
 *
 * Why this exists: on Node 20, when an ESM graph that contains a module with
 * top-level await statically imports a CommonJS package that throws while
 * loading, the `import()` promise rejects as expected AND the ESM loader
 * reports the same error a second time as an unhandled rejection. A `.catch()`
 * on the import cannot intercept that second report. Node 22 does not do this.
 *
 * `agentic-flow` (and `agentic-flow/reasoningbank`) statically import
 * `@xenova/transformers`, which statically imports `sharp` and
 * `onnxruntime-node`; agentic-flow's graph also has top-level-await modules
 * (e.g. dist/router/providers/onnx-local.js). transformers.js pins
 * onnxruntime-node 1.14.0, whose Linux binding registers through the legacy
 * static-constructor `napi_module_register`, so it can only be loaded by one
 * thread per process: loading it again from a second worker thread fails with
 * "Module did not self-register" (ERR_DLOPEN_FAILED). Vitest's threads pool,
 * and any host that uses worker threads, hits exactly that.
 *
 * The probe loads the native modules through `require` first: a CommonJS load
 * failure is an ordinary synchronous throw that can be caught. If any of them
 * cannot load, the ESM import would have failed anyway, so callers skip it.
 * If they load, the import proceeds and reuses the already-cached CommonJS
 * modules.
 *
 * Mirrors @claude-flow/cli/src/services/optional-import.ts (this package does
 * not depend on the CLI).
 *
 * @module v3/integration/native-probe
 */

import { createRequire } from 'node:module';

export interface NativeProbe {
  /**
   * Packages to resolve, in order, starting from the target module, to reach
   * the package that actually depends on the native modules. If any link in
   * this chain cannot be resolved the probe is skipped and the import decides.
   */
  via?: string[];
  /** Native packages that must load (via `require`) for the import to work. */
  natives: string[];
}

/** agentic-flow -> @xenova/transformers -> sharp, onnxruntime-node. */
export const AGENTIC_FLOW_NATIVE_PROBE: NativeProbe = {
  via: ['@xenova/transformers'],
  natives: ['sharp', 'onnxruntime-node'],
};

const localRequire = createRequire(import.meta.url);

/**
 * Returns false only when a native module that the target statically depends
 * on is known to fail to load. Returns true when everything loads or when the
 * dependency chain cannot be resolved (so the import itself decides).
 */
export function nativeDepsLoadable(specifier: string, probe: NativeProbe): boolean {
  let requireFromBase: NodeRequire;
  try {
    let base = localRequire.resolve(specifier);
    for (const pkg of probe.via ?? []) {
      base = createRequire(base).resolve(pkg);
    }
    // Throws for a builtin such as 'node:path', which has no native graph.
    requireFromBase = createRequire(base);
  } catch {
    // Target or an intermediate package is not resolvable to a file from here;
    // nothing to probe. The import will report a plain module-not-found.
    return true;
  }

  for (const native of probe.natives) {
    let resolved: string;
    try {
      resolved = requireFromBase.resolve(native);
    } catch {
      // Not installed where the target would look for it: a missing static
      // dependency is an ordinary resolution error, not the double-reported
      // load failure, so the import decides.
      continue;
    }
    try {
      requireFromBase(resolved);
    } catch {
      return false;
    }
  }
  return true;
}
