/**
 * @claude-flow/shared - MCP transport size limits
 *
 * One cap for every transport: the stdio line, the HTTP body, and the
 * WebSocket frame (standalone and the HTTP /ws endpoint).
 */

/** Largest accepted JSON-RPC message, in bytes (1 MiB). */
export const DEFAULT_MAX_MESSAGE_BYTES = 1_048_576;

const UNITS: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };

/**
 * Largest size that can be configured. ws reads maxPayload as `value | 0`
 * and only enforces it when that is above 0, so 2 GiB or more would wrap and
 * switch the WebSocket frame cap off.
 */
const MAX_CONFIGURABLE_BYTES = 0x7fffffff;

/**
 * Resolve a configured size to a byte count.
 *
 * Only an unset value falls back to the default. Zero, negative, fractional,
 * malformed or 2 GiB-and-larger values throw, so a bad config can never
 * disable the cap.
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
    // Trim once so two whitespace quantifiers cannot split the same run
    // around an absent optional unit (quadratic backtracking on malformed input).
    const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(value.trim());
    if (match) {
      bytes = Math.floor(Number(match[1]) * UNITS[(match[2] || 'b').toLowerCase()]);
    }
  }

  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_CONFIGURABLE_BYTES) {
    throw new Error(
      `${name} must be a positive integer number of bytes below 2 GiB, got ${JSON.stringify(value)}`
    );
  }
  return bytes;
}

export type LineEvent = { line: string } | { oversized: number };

const LF = 0x0a;
const CR = 0x0d;
const EMPTY = Buffer.alloc(0);
const MIN_PENDING_BYTES = 256;

/**
 * Newline splitter with a byte cap.
 *
 * Splits on 0x0A in raw bytes and decodes only complete lines, so multibyte
 * characters split across chunks stay intact. A line over the cap is reported
 * once, as soon as the cap is crossed, and the rest of it is discarded up to
 * the next newline without being buffered.
 *
 * A partial line is copied into one growable buffer, so a client that drips
 * one byte per chunk costs about one byte per byte, and a small pending piece
 * never keeps the caller's larger chunk alive.
 */
export class LineSplitter {
  private pending: Buffer = EMPTY;
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
          this.append(piece);
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
    const line = this.take(EMPTY);
    if (line.length > this.maxBytes) {
      return [{ oversized: line.length }];
    }
    return line.length > 0 ? [{ line: line.toString('utf8') }] : [];
  }

  /** Copy a piece onto the pending line, doubling the buffer up to the cap. */
  private append(piece: Buffer): void {
    const needed = this.size + piece.length;
    if (needed > this.pending.length) {
      const capacity = Math.min(
        this.maxBytes + 1,
        Math.max(needed, MIN_PENDING_BYTES, this.pending.length * 2)
      );
      const grown = Buffer.allocUnsafe(capacity);
      this.pending.copy(grown, 0, 0, this.size);
      this.pending = grown;
    }
    piece.copy(this.pending, this.size);
    this.size = needed;
  }

  /** Complete the pending line with `last` (decoded by the caller at once). */
  private take(last: Buffer): Buffer {
    let line = last;
    if (this.size > 0) {
      this.append(last);
      line = this.pending.subarray(0, this.size);
    }
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
    // Drop the buffer rather than reuse it: a returned line may still point
    // into it, and a 1 MiB buffer should not outlive its line.
    this.pending = EMPTY;
    this.size = 0;
  }
}
