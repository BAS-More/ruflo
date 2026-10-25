/**
 * @claude-flow/mcp - Transport message-size limits
 *
 * One oversized message must be rejected without buffering it whole, and the
 * transport must keep serving the next message.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { PassThrough, Readable } from 'stream';
import type { AddressInfo } from 'net';
import express from 'express';
import { WebSocket } from 'ws';
import {
  DEFAULT_MAX_MESSAGE_BYTES,
  resolveMaxMessageBytes,
  LineSplitter,
} from '../src/transport/limits.js';
import { StdioTransport } from '../src/transport/stdio.js';
import { HttpTransport, mapBodyParserError } from '../src/transport/http.js';
import { WebSocketTransport } from '../src/transport/websocket.js';
import type { ILogger, MCPRequest, MCPResponse } from '../src/types.js';

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

  it('resolveMaxMessageBytes rejects sizes ws cannot hold in an int32 (2 GiB and up)', () => {
    // ws reads maxPayload as `value | 0` and skips the check when that is <= 0,
    // so 2 GiB would wrap to a negative number and switch the frame cap off.
    expect(resolveMaxMessageBytes(0x7fffffff)).toBe(0x7fffffff);
    expect(resolveMaxMessageBytes('1gb')).toBe(1024 * MiB);
    for (const bad of ['2gb', '4gb', 2 ** 31, 3 * 2 ** 30, Number.MAX_SAFE_INTEGER]) {
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

  it('reports a final unterminated line over the limit on end', () => {
    const splitter = new LineSplitter(10);
    expect(splitter.push('a'.repeat(11))).toEqual([]);
    expect(splitter.end()).toEqual([{ oversized: 11 }]);
    // A trailing \r is still allowed on top of the limit
    expect(splitter.push('0123456789\r')).toEqual([]);
    expect(splitter.end()).toEqual([{ line: '0123456789' }]);
  });

  it('holds a slowly dripped line in one buffer, not one object per chunk', () => {
    const splitter = new LineSplitter(4096);
    for (let i = 0; i < 1000; i++) {
      expect(splitter.push(Buffer.from('x'))).toEqual([]);
    }
    const arrays = Object.values(splitter as object).filter(Array.isArray);
    expect(arrays.every((a) => a.length <= 1)).toBe(true);
    expect(splitter.push('\n')).toEqual([{ line: 'x'.repeat(1000) }]);
  });

  it('copies buffered bytes so a small pending piece does not pin its chunk', () => {
    const splitter = new LineSplitter(1024);
    const big = Buffer.alloc(64 * 1024, 'y');
    big.write('{"a"', big.length - 4);
    expect(splitter.push(big.subarray(big.length - 4))).toEqual([]);
    big.fill('z'); // the caller may reuse its buffer
    expect(splitter.push(':1}\n')).toEqual([{ line: '{"a":1}' }]);
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

/** Run the real express.json middleware on a body, without the router. */
function parseBody(body: string, limit: number): Promise<unknown> {
  const buf = Buffer.from(body);
  const req = Readable.from([buf]) as any;
  req.headers = { 'content-type': 'application/json', 'content-length': String(buf.length) };
  return new Promise((resolve) => express.json({ limit })(req, {} as any, (err?: unknown) => resolve(err)));
}

// The workspace override `path-to-regexp >=8.4.0` (v3/package.json) breaks the
// express 4 router, so `express().use()` throws there. The end-to-end HTTP
// tests run only where the router works; the error mapping is tested directly.
const expressRouterWorks = (() => {
  try {
    express().use(() => undefined);
    return true;
  } catch {
    return false;
  }
})();

describe('mapBodyParserError', () => {
  it('maps a too-large body to 413 / -32600', async () => {
    const err = await parseBody('x'.repeat(2048), 1024);
    expect(mapBodyParserError(err)).toMatchObject({ status: 413, code: -32600 });
  });

  it('maps malformed JSON to 400 / -32700', async () => {
    const err = await parseBody('{"jsonrpc":"2.0",', 1024);
    expect(mapBodyParserError(err)).toMatchObject({ status: 400, code: -32700 });
  });

  it('leaves other errors to the 500 fallback', () => {
    expect(mapBodyParserError(new Error('boom'))).toBeUndefined();
    expect(mapBodyParserError(undefined)).toBeUndefined();
  });
});

describe('HttpTransport config', () => {
  it('rejects maxRequestSize <= 0', () => {
    expect(() => new HttpTransport(createLogger(), { host: '127.0.0.1', port: 0, maxRequestSize: '0' })).toThrow(/positive/);
    expect(() => new HttpTransport(createLogger(), { host: '127.0.0.1', port: 0, maxMessageSize: -1 })).toThrow(/positive/);
  });
});

describe.skipIf(!expressRouterWorks)('HttpTransport size cap', () => {
  let transport: HttpTransport | undefined;

  afterEach(async () => {
    await transport?.stop();
    transport = undefined;
  });

  const start = async (config: Record<string, unknown> = {}) => {
    const logger = createLogger();
    transport = new HttpTransport(logger, { host: '127.0.0.1', port: 0, ...config });
    transport.onRequest(echo);
    await transport.start();
    const { port } = ((transport as any).server.address() as AddressInfo);
    return { logger, url: `http://127.0.0.1:${port}` };
  };

  const post = (url: string, body: string) =>
    fetch(`${url}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });

  it('returns 413 with -32600 for a 1.1 MiB body, and does not log the raw error', async () => {
    const { url, logger } = await start();

    const res = await post(url, bigRequest(1, Math.ceil(1.1 * MiB)));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32600 } });
    expect(logger.error).not.toHaveBeenCalled();

    const ok = await post(url, smallRequest(2));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id: 2, result: { method: 'ping' } });
  });

  it('returns 400 with -32700 for a malformed JSON body', async () => {
    const { url } = await start();

    const res = await post(url, '{"jsonrpc":"2.0",');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ id: null, error: { code: -32700 } });
  });

  it('closes a /ws connection with 1009 for a 1.1 MiB frame', async () => {
    const { url } = await start();
    const ws = new WebSocket(`${url.replace('http', 'ws')}/ws`);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });

    const code = await new Promise<number>((resolve) => {
      ws.once('close', (c) => resolve(c));
      ws.send(bigRequest(1, Math.ceil(1.1 * MiB)));
    });
    expect(code).toBe(1009);
  });
});

describe('WebSocketTransport size cap', () => {
  let transport: WebSocketTransport | undefined;

  afterEach(async () => {
    await transport?.stop();
    transport = undefined;
  });

  it('closes with 1009 for a 1.1 MiB frame, including a compressed one', async () => {
    transport = new WebSocketTransport(createLogger(), { host: '127.0.0.1', port: 0 });
    transport.onRequest(echo);
    await transport.start();
    const { port } = ((transport as any).server.address() as AddressInfo);

    // perMessageDeflate is negotiated, so this frame is tiny on the wire;
    // the limit must apply to the inflated size.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { perMessageDeflate: true });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });

    const reply = new Promise<any>((resolve) => ws.once('message', (d) => resolve(JSON.parse(d.toString()))));
    ws.send(smallRequest(1));
    expect(await reply).toMatchObject({ id: 1, result: { method: 'ping' } });

    const code = await new Promise<number>((resolve) => {
      ws.once('close', (c) => resolve(c));
      ws.send(bigRequest(2, Math.ceil(1.1 * MiB)));
    });
    expect(code).toBe(1009);
  });

  it('rejects maxMessageSize <= 0', () => {
    expect(() => new WebSocketTransport(createLogger(), { host: '127.0.0.1', port: 0, maxMessageSize: 0 })).toThrow(/positive/);
  });
});
