/**
 * Bounded newline splitter for the stdio MCP loops (ADR-061 S-5)
 *
 * Used by bin/cli.js, bin/mcp-server.js and src/mcp-server.ts. Each caller
 * sets stdin to utf8 and pushes string chunks; the string decoder keeps
 * multibyte characters whole across chunk edges.
 *
 * - Only the new chunk is searched for '\n'; buffered data is never re-split.
 * - Line size is counted in UTF-8 bytes (Buffer.byteLength), not characters.
 * - A line over the cap is reported once, as soon as the cap is crossed, and
 *   the rest of it is discarded up to the next newline.
 */

export type StdioLineEvent =
  | { type: 'line'; line: string }
  | { type: 'oversize'; bytes: number };

export interface LineSplitter {
  /** Feed one chunk; returns complete lines and oversize reports in order */
  push(chunk: string): StdioLineEvent[];
}

export function createLineSplitter(maxLineBytes: number): LineSplitter {
  if (!Number.isInteger(maxLineBytes) || maxLineBytes <= 0) {
    throw new RangeError(`maxLineBytes must be a positive integer, got ${maxLineBytes}`);
  }

  let parts: string[] = [];
  let pendingBytes = 0;
  let discarding = false;

  return {
    push(chunk: string): StdioLineEvent[] {
      const events: StdioLineEvent[] = [];
      let start = 0;

      while (start <= chunk.length) {
        const newline = chunk.indexOf('\n', start);
        const end = newline === -1 ? chunk.length : newline;
        const piece = chunk.slice(start, end);

        if (!discarding && piece.length > 0) {
          pendingBytes += Buffer.byteLength(piece, 'utf8');
          if (pendingBytes > maxLineBytes) {
            events.push({ type: 'oversize', bytes: pendingBytes });
            parts = [];
            pendingBytes = 0;
            discarding = true;
          } else {
            parts.push(piece);
          }
        }

        if (newline === -1) break;

        // End of line: emit it, or finish discarding the oversized one
        if (!discarding) {
          events.push({ type: 'line', line: parts.join('') });
        }
        parts = [];
        pendingBytes = 0;
        discarding = false;
        start = newline + 1;
      }

      return events;
    },
  };
}
