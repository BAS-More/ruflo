/**
 * memory_store value size tests (ADR-061 S-5)
 *
 * MCP messages are capped at 1 MiB. memory_store used to accept values up to
 * 1 MiB characters, which no longer fit once JSON escaping, UTF-8 and the
 * JSON-RPC envelope are added. The tool now measures the JSON-encoded value
 * in UTF-8 bytes against 1 MiB - 4 KiB, so the value alone always fits in a
 * message; the 4 KiB headroom covers a typical key, tags and envelope but is
 * not a guarantee. The `memory store` CLI command does not go through this
 * tool.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const memory = vi.hoisted(() => ({
  storeEntry: vi.fn(),
  initializeMemoryDatabase: vi.fn(),
  checkMemoryInitialization: vi.fn(),
}));

vi.mock('../src/memory/memory-initializer.js', () => ({
  storeEntry: memory.storeEntry,
  searchEntries: vi.fn(),
  listEntries: vi.fn(),
  getEntry: vi.fn(),
  deleteEntry: vi.fn(),
  initializeMemoryDatabase: memory.initializeMemoryDatabase,
  checkMemoryInitialization: memory.checkMemoryInitialization,
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  // No legacy JSON store, so no migration runs
  return { ...actual, existsSync: vi.fn(() => false), mkdirSync: vi.fn(), writeFileSync: vi.fn() };
});

import { memoryTools } from '../src/mcp-tools/memory-tools.js';

const MAX_VALUE_BYTES = 1024 * 1024 - 4 * 1024;
const store = memoryTools.find(t => t.name === 'memory_store')!;

describe('memory_store value size', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    memory.checkMemoryInitialization.mockImplementation(async () => ({ initialized: true }));
    memory.initializeMemoryDatabase.mockImplementation(async () => ({ success: true }));
    memory.storeEntry.mockImplementation(async () => ({ success: true, id: 'id' }));
  });

  it('accepts a string whose JSON encoding is exactly 1 MiB - 4 KiB', async () => {
    // JSON.stringify adds the two quotes
    const value = 'x'.repeat(MAX_VALUE_BYTES - 2);
    const result = await store.handler({ key: 'k', value });
    expect((result as { success: boolean }).success).toBe(true);
    expect(memory.storeEntry).toHaveBeenCalledTimes(1);
  });

  it('rejects one byte more with a clear error', async () => {
    const value = 'x'.repeat(MAX_VALUE_BYTES - 1);
    await expect(store.handler({ key: 'k', value })).rejects.toThrow(
      `Value exceeds maximum size of ${MAX_VALUE_BYTES} bytes`
    );
    expect(memory.storeEntry).not.toHaveBeenCalled();
  });

  it('counts JSON escaping: 600k quote characters are 1.2 MB encoded', async () => {
    const value = '"'.repeat(600_000);
    await expect(store.handler({ key: 'k', value })).rejects.toThrow(/maximum size/);
    expect(memory.storeEntry).not.toHaveBeenCalled();
  });

  it('counts UTF-8 bytes, not characters', async () => {
    // 400k characters, 1.2 MB in UTF-8
    const value = '€'.repeat(400_000);
    await expect(store.handler({ key: 'k', value })).rejects.toThrow(/maximum size/);
    expect(memory.storeEntry).not.toHaveBeenCalled();
  });

  it('measures object values by their JSON encoding', async () => {
    const value = { text: 'y'.repeat(MAX_VALUE_BYTES) };
    await expect(store.handler({ key: 'k', value })).rejects.toThrow(/maximum size/);

    const small = { text: 'y'.repeat(1000), n: [1, 2, 3] };
    const result = await store.handler({ key: 'k2', value: small });
    expect((result as { success: boolean }).success).toBe(true);
    expect(memory.storeEntry).toHaveBeenCalledTimes(1);
  });
});
