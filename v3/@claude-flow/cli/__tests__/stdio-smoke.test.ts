/**
 * Stdio MCP smoke test (ADR-061 S-5)
 *
 * Spawns the real bin entry points and sends a 1.1 MiB line followed by
 * tools/list. The oversized line must get a -32600 reply with id:null and the
 * next message must still be answered. Needs the built dist; skipped otherwise.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';

const CLI_DIR = path.join(__dirname, '..');
const DIST_READY =
  existsSync(path.join(CLI_DIR, 'dist', 'src', 'mcp-client.js')) &&
  existsSync(path.join(CLI_DIR, 'dist', 'src', 'mcp-stdio-splitter.js'));

const ENTRY_POINTS: Array<{ name: string; args: string[] }> = [
  { name: 'bin/cli.js', args: ['mcp', 'start'] },
  { name: 'bin/mcp-server.js', args: [] },
];

interface RpcMessage {
  jsonrpc?: string;
  id?: unknown;
  result?: { tools?: unknown[] };
  error?: { code: number; message: string };
}

let child: ChildProcess | undefined;
let workDir: string | undefined;

afterEach(() => {
  if (child) {
    child.stdin?.end();
    child.kill();
    child = undefined;
  }
  if (workDir) {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
    workDir = undefined;
  }
});

function startServer(entry: { name: string; args: string[] }) {
  workDir = mkdtempSync(path.join(tmpdir(), 'cf-stdio-smoke-'));
  const proc = spawn(process.execPath, [path.join(CLI_DIR, entry.name), ...entry.args], {
    cwd: workDir,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child = proc;

  const messages: RpcMessage[] = [];
  const waiters: Array<() => void> = [];
  let pending = '';
  proc.stdout!.setEncoding('utf8');
  proc.stdout!.on('data', (chunk: string) => {
    pending += chunk;
    const parts = pending.split('\n');
    pending = parts.pop() || '';
    for (const part of parts) {
      try { messages.push(JSON.parse(part)); } catch { /* not a protocol line */ }
    }
    waiters.splice(0).forEach(w => w());
  });
  proc.stderr!.resume();

  function waitFor(predicate: (m: RpcMessage) => boolean, timeoutMs = 25_000): Promise<RpcMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for reply')), timeoutMs);
      const check = () => {
        const found = messages.find(predicate);
        if (found) {
          clearTimeout(timer);
          resolve(found);
        } else {
          waiters.push(check);
        }
      };
      check();
    });
  }

  return { proc, messages, waitFor };
}

describe.skipIf(!DIST_READY)('CLI stdio MCP: 1 MiB line cap', () => {
  for (const entry of ENTRY_POINTS) {
    it(`${entry.name} rejects a 1.1 MiB line with -32600/id:null and keeps serving`, async () => {
      const { proc, messages, waitFor } = startServer(entry);

      const big = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'memory_store', arguments: { value: 'x'.repeat(1.1 * 1024 * 1024) } },
      });
      proc.stdin!.write(big + '\n');
      proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');

      const rejected = await waitFor(m => m.error?.code === -32600);
      expect(rejected.id).toBeNull();

      const list = await waitFor(m => m.id === 2);
      expect(Array.isArray(list.result?.tools)).toBe(true);
      expect(list.result!.tools!.length).toBeGreaterThan(0);

      // The oversized request was never parsed or answered under its own id.
      expect(messages.some(m => m.id === 1)).toBe(false);
      expect(messages.filter(m => m.error?.code === -32600)).toHaveLength(1);
    }, 30_000);
  }
});
