/**
 * V3 MCP transport size limits
 *
 * One cap for every transport: the stdio line, the HTTP body, and the
 * WebSocket frame (standalone and the HTTP /ws endpoint).
 */

/** Largest accepted JSON-RPC message, in bytes (1 MiB). */
export const DEFAULT_MAX_MESSAGE_BYTES = 1_048_576;

const UNITS: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };

/**
 * Resolve a configured size to a byte count.
 *
 * Only an unset value falls back to the default. Zero, negative, fractional
 * or malformed values throw, so a bad config can never disable the cap.
 * Strings may be plain digits or use a b/kb/mb/gb suffix, as body-parser does.
 */
export function resolveMaxMessageBytes(
  value: number | string | null | undefined,
  name = 'maxMessageSize'
): number {
  if (value === undefined || value === null) {
    return DEFAULT_MAX_MESSAGE_BYTES;
  }

  let bytes = Number.NaN;
  if (typeof value === 'number') {
    bytes = value;
  } else if (typeof value === 'string') {
    const match = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?\s*$/i.exec(value);
    if (match) {
      bytes = Math.floor(Number(match[1]) * UNITS[(match[2] || 'b').toLowerCase()]);
    }
  }

  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error(`${name} must be a positive integer number of bytes, got ${JSON.stringify(value)}`);
  }
  return bytes;
}

export type LineEvent = { line: string } | { oversized: number };

const LF = 0x0a;
const CR = 0x0d;

/**
 * Newline splitter with a byte cap.
 *
 * Splits on 0x0A in raw bytes and decodes only complete lines, so multibyte
 * characters split across chunks stay intact. A line over the cap is reported
 * once, as soon as the cap is crossed, and the rest of it is discarded up to
 * the next newline without being buffered.
 */
export class LineSplitter {
  private chunks: Buffer[] = [];
  private size = 0;
  private discarding = false;

  constructor(private readonly maxBytes: number) {}

  push(data: Buffer | string): LineEvent[] {
    const chunk = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const events: LineEvent[] = [];
    let start = 0;

    while (start < chunk.length) {
      const idx = chunk.indexOf(LF, start);
      const end = idx === -1 ? chunk.length : idx;

      if (this.discarding) {
        if (idx !== -1) this.discarding = false;
      } else {
        const piece = chunk.subarray(start, end);
        // One extra byte is allowed for a trailing \r; the exact length is
        // checked once the line is complete.
        if (this.size + piece.length > this.maxBytes + 1) {
          events.push(this.reject(this.size + piece.length, idx === -1));
        } else if (idx === -1) {
          this.chunks.push(piece);
          this.size += piece.length;
        } else {
          const line = this.take(piece);
          if (line.length > this.maxBytes) {
            events.push({ oversized: line.length });
          } else {
            events.push({ line: line.toString('utf8') });
          }
        }
      }

      if (idx === -1) break;
      start = idx + 1;
    }

    return events;
  }

  /** Flush a final line that had no trailing newline. */
  end(): LineEvent[] {
    if (this.discarding || this.size === 0) {
      this.reset();
      return [];
    }
    const line = this.take(Buffer.alloc(0));
    return line.length > 0 ? [{ line: line.toString('utf8') }] : [];
  }

  private take(last: Buffer): Buffer {
    this.chunks.push(last);
    let line = this.chunks.length === 1 ? last : Buffer.concat(this.chunks);
    if (line.length > 0 && line[line.length - 1] === CR) {
      line = line.subarray(0, line.length - 1);
    }
    this.reset();
    return line;
  }

  private reject(seen: number, keepDiscarding: boolean): LineEvent {
    this.reset();
    this.discarding = keepDiscarding;
    return { oversized: seen };
  }

  private reset(): void {
    this.chunks = [];
    this.size = 0;
  }
}
