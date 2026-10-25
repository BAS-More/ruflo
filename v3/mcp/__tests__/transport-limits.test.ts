/**
 * V3 MCP - Transport message-size limits
 *
 * One oversized message must be rejected without buffering it whole, and the
 * transport must keep serving the next message.
 *
 * Only the stdio transport and the limits module are tested here: express and
 * ws do not resolve from v3/mcp (they are not root dependencies), so the HTTP
 * and WebSocket copies are covered by the same tests in @claude-flow/mcp and
 * @claude-flow/shared.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { PassThrough } from 'stream';
import {
  DEFAULT_MAX_MESSAGE_BYTES,
  resolveMaxMessageBytes,
  LineSplitter,
} from '../transport/limits.js';
import { StdioTransport } from '../transport/stdio.js';
import type { ILogger, MCPRequest, MCPResponse } from '../types.js';

const MiB = 1024 * 1024;

const createLogger = (): ILogger => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

const echo = async (request: MCPRequest): Promise<MCPResponse> => ({
  jsonrpc: '2.0',
  id: request.id,
  result: { method: request.method },
});

/** A JSON-RPC request line whose UTF-8 size is at least `bytes`. */
const bigRequest = (id: number, bytes: number): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method: 'big', params: { pad: 'a'.repeat(bytes) } });

const smallRequest = (id: number, method = 'ping'): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method });

/** Collect newline-delimited JSON written by a transport. */
function collect(output: PassThrough): { messages: any[]; waitFor(n: number): Promise<any[]> } {
  const messages: any[] = [];
  let pending = '';
  const waiters: Array<() => void> = [];
  output.setEncoding('utf8');
  output.on('data', (chunk: string) => {
    pending += chunk;
    let idx: number;
    while ((idx = pending.indexOf('\n')) !== -1) {
      messages.push(JSON.parse(pending.slice(0, idx)));
      pending = pending.slice(idx + 1);
    }
    waiters.splice(0).forEach((w) => w());
  });
  return {
    messages,
    waitFor(n: number) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${n} messages, got ${messages.length}`)), 5000);
        const check = () => {
          if (messages.length >= n) {
            clearTimeout(timer);
            resolve(messages);
          } else {
            waiters.push(check);
          }
        };
        check();
      });
    },
  };
}

describe('transport limits', () => {
  it('defaults to 1 MiB', () => {
    expect(DEFAULT_MAX_MESSAGE_BYTES).toBe(1_048_576);
  });

  it('resolveMaxMessageBytes uses the default only when unset', () => {
    expect(resolveMaxMessageBytes(undefined)).toBe(DEFAULT_MAX_MESSAGE_BYTES);
    expect(resolveMaxMessageBytes(null)).toBe(DEFAULT_MAX_MESSAGE_BYTES);
    expect(resolveMaxMessageBytes(4096)).toBe(4096);
    expect(resolveMaxMessageBytes('2048')).toBe(2048);
    expect(resolveMaxMessageBytes('2mb')).toBe(2 * MiB);
    expect(resolveMaxMessageBytes('64kb')).toBe(64 * 1024);
  });

  it('resolveMaxMessageBytes rejects zero, negative and malformed values', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '0', '-5', 'lots', '']) {
      expect(() => resolveMaxMessageBytes(bad as any), String(bad)).toThrow(/positive/);
    }
  });
});

describe('LineSplitter', () => {
  it('splits lines, strips CR, and keeps multibyte characters split across chunks', () => {
    const splitter = new LineSplitter(1024);
    const bytes = Buffer.from('é€😀\r\nsecond\n', 'utf8');
    const events = [
      ...splitter.push(bytes.subarray(0, 1)),
      ...splitter.push(bytes.subarray(1, 5)),
      ...splitter.push(bytes.subarray(5)),
    ];
    expect(events).toEqual([{ line: 'é€😀' }, { line: 'second' }]);
  });

  it('reports an oversized line once, discards to the newline, then resumes', () => {
    const splitter = new LineSplitter(100);
    const events = [
      ...splitter.push('x'.repeat(60)),
      ...splitter.push('x'.repeat(60)),
      ...splitter.push('x'.repeat(500)),
      ...splitter.push('tail\nnext\n'),
    ];
    expect(events.filter((e) => 'oversized' in e)).toHaveLength(1);
    expect(events.filter((e) => 'line' in e)).toEqual([{ line: 'next' }]);
  });

  it('accepts a line of exactly the limit and rejects one byte more', () => {
    const splitter = new LineSplitter(10);
    expect(splitter.push('0123456789\r\n')).toEqual([{ line: '0123456789' }]);
    const events = splitter.push('0123456789A\n');
    expect(events).toHaveLength(1);
    expect('oversized' in events[0]).toBe(true);
  });

  it('flushes a final unterminated line on end', () => {
    const splitter = new LineSplitter(100);
    expect(splitter.push('a\nlast')).toEqual([{ line: 'a' }]);
    expect(splitter.end()).toEqual([{ line: 'last' }]);
    expect(splitter.end()).toEqual([]);
  });
});

describe('StdioTransport size cap', () => {
  const started: StdioTransport[] = [];

  afterEach(async () => {
    for (const t of started.splice(0)) await t.stop();
  });

  const setup = (config: { maxMessageSize?: number } = {}) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const logger = createLogger();
    const transport = new StdioTransport(logger, { inputStream: input, outputStream: output, ...config });
    const handler = vi.fn(echo);
    transport.onRequest(handler);
    started.push(transport);
    return { input, output: collect(output), transport, handler, logger };
  };

  it('rejects a 1 MiB + 1 line with id:null and still answers the next line', async () => {
    const { input, output, transport, handler } = setup();
    await transport.start();

    input.write(bigRequest(1, MiB + 1) + '\n');
    input.write(smallRequest(2) + '\n');

    const [first, second] = await output.waitFor(2);
    expect(first).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32600 } });
    expect(second).toEqual({ jsonrpc: '2.0', id: 2, result: { method: 'ping' } });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('rejects a 2 MiB line sent in small chunks without waiting for its newline', async () => {
    const { input, output, transport, handler } = setup();
    await transport.start();

    const line = Buffer.from(bigRequest(1, 2 * MiB));
    for (let i = 0; i < line.length; i += 64 * 1024) {
      input.write(line.subarray(i, i + 64 * 1024));
    }
    // The error is sent as soon as the cap is crossed, before the newline arrives.
    const [first] = await output.waitFor(1);
    expect(first).toMatchObject({ id: null, error: { code: -32600 } });

    input.write('\n' + smallRequest(2) + '\n');
    const messages = await output.waitFor(2);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ id: 2, result: { method: 'ping' } });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('processes several messages in one chunk whose total exceeds the cap', async () => {
    const { input, output, transport, handler } = setup();
    await transport.start();

    input.write(bigRequest(1, 600 * 1024) + '\r\n' + bigRequest(2, 600 * 1024) + '\n');
    const messages = await output.waitFor(2);
    expect(messages.map((m) => m.id).sort()).toEqual([1, 2]);
    expect(messages.every((m) => m.result?.method === 'big')).toBe(true);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('decodes multibyte characters split across chunks', async () => {
    const { input, output, transport } = setup();
    await transport.start();

    const bytes = Buffer.from(smallRequest(7, 'é€😀') + '\n', 'utf8');
    const cut = bytes.indexOf(Buffer.from('😀', 'utf8')) + 2;
    input.write(bytes.subarray(0, cut));
    input.write(bytes.subarray(cut));

    const [reply] = await output.waitFor(1);
    expect(reply).toEqual({ jsonrpc: '2.0', id: 7, result: { method: 'é€😀' } });
  });

  it('honours a custom maxMessageSize in bytes', async () => {
    const { input, output, transport } = setup({ maxMessageSize: 64 });
    await transport.start();

    // 30 three-byte characters: 30 characters but 90 bytes.
    input.write(smallRequest(1, '€'.repeat(30)) + '\n');
    const [reply] = await output.waitFor(1);
    expect(reply).toMatchObject({ id: null, error: { code: -32600 } });
  });

  it('rejects maxMessageSize <= 0 instead of silently falling back', () => {
    const logger = createLogger();
    expect(() => new StdioTransport(logger, { maxMessageSize: 0 })).toThrow(/positive/);
    expect(() => new StdioTransport(logger, { maxMessageSize: -1 })).toThrow(/positive/);
  });

  it('still emits close when the input ends, after the final unterminated line', async () => {
    const { input, output, transport } = setup();
    await transport.start();
    const closed = new Promise<void>((resolve) => transport.once('close', () => resolve()));

    input.end(smallRequest(9));
    await closed;
    const [reply] = await output.waitFor(1);
    expect(reply).toMatchObject({ id: 9 });
  });
});
