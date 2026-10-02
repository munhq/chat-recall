/**
 * Shared tail-read helper for append-only JSONL backends (Claude/Gemini/Codex).
 * See docs/SYNC-INCREMENTAL.md.
 *
 * Reads `path` from `offset`, at most `maxBytes`, and returns the text plus the
 * byte position to persist as the new cursor. `newOffset` is the byte position
 * of the LAST `\n` in the read window, NOT EOF — a sync tick can fire mid-write
 * while the AI tool has flushed only part of a trailing JSONL line; advancing
 * to EOF would resume next tick inside that torn line → permanent
 * misalignment. Snapping to the last newline means the partial trailing line
 * is re-read (and completed) next tick.
 *
 * The bound is what lets a large transcript ship as a sequence of chunks: each
 * call holds at most `maxBytes` of it.
 *
 * If the window contains no newline and the file ends inside it (a partial
 * last line), returns `{ text: '', newOffset: offset }` — nothing to ship this
 * tick. If the window is FULL and contains no newline, the line at `offset` is
 * longer than `maxBytes` and would stop the cursor there forever, so it is
 * skipped: the result has `skippedBytes` > 0, an empty `text`, and `newOffset`
 * just past that line's newline.
 */
import { openSync, readSync, closeSync, statSync, fstatSync } from 'node:fs';

/** Default read bound. Transcripts grow by appends, so a tail is usually a few
 *  turns; the bound only matters for a missed tick after a long idle or for a
 *  large transcript shipped in chunks. */
export const TAIL_READ_MAX_BYTES = 16 * 1024 * 1024;

/** Block size for scanning past a line longer than the read bound. */
const SKIP_SCAN_BYTES = 1024 * 1024;

export interface TailRead {
  text: string;
  newOffset: number;
  skippedBytes?: number;
  /** Lines in the file before `offset`. A line the tail's parser numbers `n`
   *  is line `baseLine + n` of the file. */
  baseLine?: number;
}

/** Per file: a byte offset at a line start and the lines before it. A watch
 *  daemon reads each session's tail again and again, so counting forward from
 *  the last answer reads each byte once. `ino` and `edge` (the bytes just
 *  before `offset`) prove the file is still the one counted: a resume rewrites
 *  a transcript in place, and a count from the old content is wrong. */
const lineCounts = new Map<string, { offset: number; lines: number; ino: number; edge: Buffer }>();
const LINE_COUNT_CACHE_MAX = 2048;
const EDGE_BYTES = 64;

function readAt(fd: number, pos: number, len: number): Buffer {
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = readSync(fd, buf, got, len - got, pos + got);
    if (n <= 0) break;
    got += n;
  }
  return buf.subarray(0, got);
}

/** Number of `\n` bytes in `path` before `offset`, or undefined when the file
 *  cannot be read that far. */
export function linesBeforeOffset(path: string, offset: number): number | undefined {
  if (offset <= 0) return 0;
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const ino = fstatSync(fd).ino;
    const known = lineCounts.get(path);
    let pos = 0;
    let lines = 0;
    if (known && known.ino === ino && known.offset <= offset) {
      const edgeStart = Math.max(0, known.offset - EDGE_BYTES);
      if (readAt(fd, edgeStart, known.offset - edgeStart).equals(known.edge)) {
        pos = known.offset;
        lines = known.lines;
      }
    }
    const block = Buffer.allocUnsafe(SKIP_SCAN_BYTES);
    while (pos < offset) {
      const n = readSync(fd, block, 0, Math.min(SKIP_SCAN_BYTES, offset - pos), pos);
      if (n <= 0) return undefined;
      for (let i = block.indexOf(0x0a, 0); i >= 0 && i < n; i = block.indexOf(0x0a, i + 1)) lines++;
      pos += n;
    }
    const edgeStart = Math.max(0, offset - EDGE_BYTES);
    const edge = readAt(fd, edgeStart, offset - edgeStart);
    if (lineCounts.size >= LINE_COUNT_CACHE_MAX && !lineCounts.has(path)) {
      const oldest = lineCounts.keys().next().value;
      if (oldest !== undefined) lineCounts.delete(oldest);
    }
    lineCounts.set(path, { offset, lines, ino, edge });
    return lines;
  } catch {
    return undefined;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* best-effort */ } }
  }
}

export function readTailFromOffset(path: string, offset: number, maxBytes: number = TAIL_READ_MAX_BYTES): TailRead {
  let size = 0;
  try { size = statSync(path).size; } catch { return { text: '', newOffset: offset }; }
  if (size <= offset) return { text: '', newOffset: offset };

  const len = Math.min(size - offset, Math.max(1, maxBytes));
  const buf = Buffer.allocUnsafe(len);
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    // readSync may return fewer bytes than requested; loop until the buffer is
    // full or the file gives nothing more.
    let got = 0;
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, offset + got);
      if (n <= 0) break;
      got += n;
    }
    if (got === 0) return { text: '', newOffset: offset };
    const slice = got < len ? buf.subarray(0, got) : buf;
    // Snap to the last newline in the window. Bytes after it (a partial line
    // mid-write) are excluded this tick and re-read next tick.
    const lastNl = slice.lastIndexOf(0x0a);
    if (lastNl >= 0) {
      const text = slice.subarray(0, lastNl + 1).toString('utf-8');
      return { text, newOffset: offset + lastNl + 1, baseLine: linesBeforeOffset(path, offset) };
    }
    // No newline. The file ends inside this window: a line still being
    // written. Wait for the next tick.
    if (offset + got >= size) return { text: '', newOffset: offset };
    // The window is full and holds no newline: one line longer than the bound.
    // Find where it ends and step past it.
    const end = findNewline(fd, offset + got, size);
    if (end < 0) return { text: '', newOffset: offset };
    return { text: '', newOffset: end + 1, skippedBytes: end + 1 - offset };
  } catch {
    return { text: '', newOffset: offset };
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* best-effort */ } }
  }
}

/** Byte position of the first `\n` at or after `from`, or -1 when the file
 *  ends first (the line is still being written). Reads in fixed blocks, so the
 *  line itself is never held in memory. */
function findNewline(fd: number, from: number, size: number): number {
  const block = Buffer.allocUnsafe(SKIP_SCAN_BYTES);
  let pos = from;
  while (pos < size) {
    const n = readSync(fd, block, 0, Math.min(SKIP_SCAN_BYTES, size - pos), pos);
    if (n <= 0) return -1;
    const i = block.subarray(0, n).indexOf(0x0a);
    if (i >= 0) return pos + i;
    pos += n;
  }
  return -1;
}
