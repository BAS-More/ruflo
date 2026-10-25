/**
 * Stdio line splitter tests (ADR-061 S-5)
 *
 * The CLI stdio MCP loops (bin/cli.js, bin/mcp-server.js, src/mcp-server.ts)
 * used to append every chunk to one string and re-split it. A line with no
 * newline grew until the process ran out of memory. The splitter caps each
 * line in UTF-8 bytes and drops an oversized line up to its newline.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createLineSplitter } from '../src/mcp-stdio-splitter.js';

const MiB = 1024 * 1024;

function lines(events: ReturnType<ReturnType<typeof createLineSplitter>['push']>): string[] {
  return events.filter(e => e.type === 'line').map(e => (e as { line: string }).line);
}

function oversized(events: ReturnType<ReturnType<typeof createLineSplitter>['push']>) {
  return events.filter(e => e.type === 'oversize');
}

describe('createLineSplitter', () => {
  it('rejects a limit that is not a positive integer', () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => createLineSplitter(bad)).toThrow(/maxLineBytes/);
    }
  });

  it('splits many small lines in one chunk and keeps the tail', () => {
    const splitter = createLineSplitter(MiB);
    const events = splitter.push('{"a":1}\n{"b":2}\n{"c"');
    expect(lines(events)).toEqual(['{"a":1}', '{"b":2}']);
    expect(lines(splitter.push(':3}\n'))).toEqual(['{"c":3}']);
  });

  it('joins a line split across chunks, including multibyte characters', () => {
    const splitter = createLineSplitter(MiB);
    expect(splitter.push('{"t":"h\u00e9')).toEqual([]);
    expect(splitter.push('\u20ac\u{1F600}"}')).toEqual([]);
    expect(lines(splitter.push('\n'))).toEqual(['{"t":"h\u00e9\u20ac\u{1F600}"}']);
  });

  it('counts the limit in UTF-8 bytes, not characters', () => {
    // '\u20ac' is 3 bytes in UTF-8
    const splitter = createLineSplitter(4);
    expect(lines(splitter.push('\u20aca\n'))).toEqual(['\u20aca']);   // 4 bytes: allowed
    const events = splitter.push('\u20acab\nok\n');                   // 5 bytes: too large
    expect(oversized(events)).toHaveLength(1);
    expect(lines(events)).toEqual(['ok']);
  });

  it('allows exactly N bytes and rejects N + 1', () => {
    const splitter = createLineSplitter(1024);
    expect(lines(splitter.push('x'.repeat(1024) + '\n'))).toHaveLength(1);
    const events = splitter.push('x'.repeat(1025) + '\n');
    expect(oversized(events)).toHaveLength(1);
    expect(lines(events)).toEqual([]);
  });

  it('reports a 2 MiB line once, before its newline arrives, then resumes', () => {
    const splitter = createLineSplitter(MiB);
    const chunk = 'x'.repeat(64 * 1024);
    let reports = 0;
    let reportedAt = -1;
    for (let i = 0; i < 32; i++) {
      const events = splitter.push(chunk);
      expect(lines(events)).toEqual([]);
      if (oversized(events).length > 0 && reportedAt < 0) reportedAt = i;
      reports += oversized(events).length;
    }
    expect(reports).toBe(1);
    expect(reportedAt).toBe(16); // the 17th 64 KiB chunk crosses 1 MiB

    const events = splitter.push('tail of the big line\n{"jsonrpc":"2.0","id":2}\n');
    expect(oversized(events)).toHaveLength(0);
    expect(lines(events)).toEqual(['{"jsonrpc":"2.0","id":2}']);
  });

  it('reports a line that is too large and complete within one chunk', () => {
    const splitter = createLineSplitter(MiB);
    const events = splitter.push('y'.repeat(MiB + 1) + '\n{"ok":true}\n');
    expect(oversized(events)).toHaveLength(1);
    expect(oversized(events)[0]).toMatchObject({ type: 'oversize' });
    expect(lines(events)).toEqual(['{"ok":true}']);
  });

  it('keeps event order when an oversized line sits between valid ones', () => {
    const splitter = createLineSplitter(8);
    const events = splitter.push('a\n' + 'z'.repeat(20) + '\nb\n');
    expect(events.map(e => e.type)).toEqual(['line', 'oversize', 'line']);
  });

  it('does not re-scan buffered data for every chunk', () => {
    // 1 MiB arriving in 1 KiB chunks with no newline: quadratic re-splitting
    // would take seconds; a linear splitter finishes in milliseconds.
    const splitter = createLineSplitter(2 * MiB);
    const chunk = 'q'.repeat(1024);
    const start = Date.now();
    for (let i = 0; i < 1024; i++) splitter.push(chunk);
    expect(lines(splitter.push('\n'))[0]).toHaveLength(MiB);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

describe('CLI stdio entry points use a 1 MiB line cap', () => {
  const CLI_DIR = path.join(__dirname, '..');
  const entryPoints = ['bin/cli.js', 'bin/mcp-server.js', 'src/mcp-server.ts'];

  for (const file of entryPoints) {
    it(`${file} declares MAX_BUFFER_SIZE = 1024 * 1024 and uses the splitter`, () => {
      const content = fs.readFileSync(path.join(CLI_DIR, file), 'utf-8');
      expect(content).toMatch(/const MAX_BUFFER_SIZE = 1024 \* 1024;/);
      expect(content).toContain('createLineSplitter(MAX_BUFFER_SIZE)');
      expect(content).not.toMatch(/buffer\.split\('\\n'\)/);
    });
  }
});
