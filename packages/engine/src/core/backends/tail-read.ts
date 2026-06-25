/**
 * Shared tail-read helper for append-only JSONL backends (Claude/Gemini/Codex).
 * See docs/SYNC-INCREMENTAL.md.
 *
 * Reads `path` from `offset` to EOF and returns the tail text plus the byte
 * position to persist as the new cursor. `newOffset` is the byte position of
 * the LAST `\n` in the read window, NOT EOF — a sync tick can fire mid-write
 * while the AI tool has flushed only part of a trailing JSONL line; advancing
 * to EOF would resume next tick inside that torn line → permanent
 * misalignment. Snapping to the last newline means the partial trailing line
 * is re-read (and completed) next tick.
 *
 * If the window contains no newline (offset already past the last complete
 * line, or the file is empty/truncated to before offset), returns
 * `{ text: '', newOffset: offset }` — nothing to ship this tick.
 */
import { openSync, readSync, closeSync, statSync } from 'node:fs';

export function readTailFromOffset(path: string, offset: number): { text: string; newOffset: number } {
  let size = 0;
  try { size = statSync(path).size; } catch { return { text: '', newOffset: offset }; }
  if (size <= offset) return { text: '', newOffset: offset };

  // Read the tail window [offset, size) in one shot. Transcripts grow by
  // appends; the tail is typically small (a few turns). Cap at 16 MB to stay
  // safe against a pathological gap (e.g. a missed tick after a long idle).
  const len = Math.min(size - offset, 16 * 1024 * 1024);
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
    if (lastNl < 0) {
      // No complete line in this window yet — wait for the next tick.
      return { text: '', newOffset: offset };
    }
    const text = slice.subarray(0, lastNl + 1).toString('utf-8');
    return { text, newOffset: offset + lastNl + 1 };
  } catch {
    return { text: '', newOffset: offset };
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* best-effort */ } }
  }
}