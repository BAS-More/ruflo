/**
 * importOptional / nativeDepsLoadable
 *
 * Guards optional imports whose dependency graph contains native addons; see
 * ../native-probe.ts for the Node 20 unhandled rejection this prevents.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeDepsLoadable, AGENTIC_FLOW_NATIVE_PROBE } from '../native-probe.js';
import { importOptional } from '../optional-import.js';

// The fixture reproduces the shape of agentic-flow's module graph: a native ESM
// package (under node_modules, so Vitest hands it to Node's own loader) that
// contains a top-level-await module and statically imports a CommonJS module
// that throws while loading, like onnxruntime-node@1.14.0 failing to dlopen in
// a second worker thread. On Node 20, importing it rejects AND reports the same
// error again as an unhandled rejection, which fails the whole Vitest run; that
// is what an unguarded `import(x).catch(() => null)` did in CI.
let fixtureDir: string;
let throwingNative: string;
let loadableNative: string;
let fixtureEntry: string;

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'cf-integration-optional-import-'));
  const pkgDir = join(fixtureDir, 'node_modules', 'cf-native-graph-fixture');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'cf-native-graph-fixture', version: '1.0.0', type: 'module', main: 'index.js' }),
  );
  loadableNative = join(pkgDir, 'loadable-binding.cjs');
  writeFileSync(loadableNative, 'module.exports = { loaded: true };\n');
  throwingNative = join(pkgDir, 'native-binding.cjs');
  writeFileSync(
    throwingNative,
    "const e = new Error('Module did not self-register (fixture)');\n" +
      "e.code = 'ERR_DLOPEN_FAILED';\n" +
      'throw e;\n',
  );
  writeFileSync(
    join(pkgDir, 'tla.js'),
    "let os = null;\ntry { os = await import('node:os'); } catch {}\nexport const hasOs = os !== null;\n",
  );
  writeFileSync(
    join(pkgDir, 'uses-native.js'),
    "import * as binding from './native-binding.cjs';\nexport const native = binding;\n",
  );
  fixtureEntry = join(pkgDir, 'index.js');
  writeFileSync(fixtureEntry, "export * from './tla.js';\nexport * from './uses-native.js';\n");
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe('nativeDepsLoadable', () => {
  it('returns true when every probed module loads', () => {
    expect(nativeDepsLoadable(fixtureEntry, { natives: [loadableNative] })).toBe(true);
  });

  it('returns false when a probed module resolves but throws while loading', () => {
    expect(nativeDepsLoadable(fixtureEntry, { natives: [throwingNative] })).toBe(false);
  });

  it('returns false when any one of several probed modules fails to load', () => {
    expect(nativeDepsLoadable(fixtureEntry, { natives: [loadableNative, throwingNative] })).toBe(false);
  });

  it('leaves the decision to the import (returns true) when a probed module is not installed', () => {
    expect(nativeDepsLoadable(fixtureEntry, { natives: ['claude-flow-no-such-native-addon'] })).toBe(true);
  });

  it('skips probing (returns true) when the target is not resolvable', () => {
    expect(
      nativeDepsLoadable('claude-flow-no-such-package', { natives: [throwingNative] }),
    ).toBe(true);
  });

  it('skips probing (returns true) when a via link is not resolvable', () => {
    expect(
      nativeDepsLoadable(fixtureEntry, { via: ['claude-flow-no-such-package'], natives: [throwingNative] }),
    ).toBe(true);
  });

  it('probes agentic-flow through @xenova/transformers for sharp and onnxruntime-node', () => {
    expect(AGENTIC_FLOW_NATIVE_PROBE).toEqual({
      via: ['@xenova/transformers'],
      natives: ['sharp', 'onnxruntime-node'],
    });
  });
});

describe('importOptional', () => {
  it('returns the module when it imports', async () => {
    const mod = await importOptional<typeof import('node:path')>('node:path');
    expect(mod).not.toBeNull();
    expect(mod!.join('a', 'b')).toBe(join('a', 'b'));
  });

  it('returns null when the module is not installed', async () => {
    await expect(importOptional('claude-flow-no-such-package')).resolves.toBeNull();
  });

  it('still imports when a probed native is simply not installed', async () => {
    const mod = await importOptional<typeof import('node:path')>('node:path', {
      natives: ['claude-flow-no-such-native-addon'],
    });
    expect(mod).not.toBeNull();
  });

  // Regression for the CI failure on Node 20: without the probe this import is
  // attempted, and the loader's second report of the native load failure fails
  // the run as an unhandled rejection even though the import itself is caught.
  it('returns null without importing a graph whose native dependency cannot load', async () => {
    await expect(importOptional(fixtureEntry, { natives: [throwingNative] })).resolves.toBeNull();
  });
});
