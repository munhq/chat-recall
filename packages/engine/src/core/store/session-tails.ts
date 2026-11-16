/**
 * Tail segments of a stored session envelope (issue #27).
 *
 * An append used to read the whole stored envelope, add the tail and write the
 * whole envelope back, so its cost grew with the size of the session: for a
 * session of 39 MB the envelope is 13 MB and it was rewritten every few seconds.
 * A segment holds only the tail of one append. The store keeps segments as rows
 * of `content_cache` with `source_type = 'session_tail'` and the id
 * `<session id>#<seq>`, and merges them with the base envelope when a reader asks.
 */

/** `content_cache.source_type` of a segment. */
export const TAIL_SOURCE_TYPE = 'session_tail';

/** Width of the sequence number in a segment id, so ids sort in order. */
const SEQ_WIDTH = 10;

export interface TailBody {
  v: number;
  /** Byte offset this tail started at (`base_offset` of the append). */
  base: number;
  /** Byte offset the stored envelope is synced through after this tail. */
  o: number;
  /** Line number of the last message after this tail. */
  lastLine: number;
  messages: unknown[];
  subagents?: unknown[];
}

export interface TailState {
  seq: number;
  o: number;
  lastLine: number;
  /** Size of the newest segment's body in bytes. */
  bytes: number;
}

/** A segment below this size takes the next append instead of a new segment, so a
 *  session that appends every few seconds adds one row for each 256 KB of tail. */
export const TAIL_SEGMENT_TARGET_BYTES = 256 * 1024;
/** A segment body below this size is kept in the row, with no object-store write. */
export const TAIL_INLINE_MAX_BYTES = 32 * 1024;
/** A session is compacted when its segments pass either limit and none is newer than the idle time. */
export const TAIL_COMPACT_MAX_SEGMENTS = 16;
export const TAIL_COMPACT_MAX_BYTES = 2 * 1024 * 1024;
export const TAIL_COMPACT_IDLE_MS = 5 * 60_000;

export function tailRowId(sessionId: string, seq: number): string {
  return `${sessionId}#${String(seq).padStart(SEQ_WIDTH, '0')}`;
}

/** The session id and sequence number of a segment id, or null when `id` is not one. */
export function parseTailRowId(id: string): { sessionId: string; seq: number } | null {
  const at = id.lastIndexOf('#');
  if (at <= 0) return null;
  const digits = id.slice(at + 1);
  if (digits.length !== SEQ_WIDTH || !/^\d+$/.test(digits)) return null;
  return { sessionId: id.slice(0, at), seq: Number(digits) };
}

/** The state a session's newest segment records, or null when the body is not a segment. */
export function tailStateOf(seq: number, body: string): TailState | null {
  try {
    const t = JSON.parse(body) as Partial<TailBody>;
    if (typeof t.o !== 'number' || typeof t.lastLine !== 'number') return null;
    return { seq, o: t.o, lastLine: t.lastLine, bytes: Buffer.byteLength(body, 'utf8') };
  } catch {
    return null;
  }
}

/**
 * Where a stored envelope ends, read from the end of its JSON text without
 * parsing it: the synced-through offset (the last key, `"o"`) and the line number
 * of its last message. A session with no tail state gets one from this, so its
 * first append does not parse and rewrite an envelope of many megabytes.
 * Returns null when the text does not end the way `JSON.stringify` of an envelope
 * does, and the caller then takes the path that parses it.
 */
export function peekEnvelopeTail(base: string): { o: number; lastLine: number } | null {
  const o = /,"o":(\d+)\}\s*$/.exec(base.slice(-48));
  if (!o) return null;
  const cut = base.lastIndexOf('],"subagents":');
  if (cut < 0) return null;
  if (base.slice(0, cut).endsWith('"messages":[')) return { o: Number(o[1]), lastLine: 0 };
  const at = base.lastIndexOf('"line":', cut);
  if (at < 0) return null;
  const digits = /^\d+/.exec(base.slice(at + 7, at + 27));
  return digits ? { o: Number(o[1]), lastLine: Number(digits[0]) } : null;
}

/** The body of the marker that gives a session its tail state. */
export function markerTail(version: number, o: number, lastLine: number): TailBody {
  return { v: version, base: o, o, lastLine, messages: [] };
}

/**
 * The stored envelope with its segments applied, as the JSON string a reader
 * parses. Segments are applied in sequence order. The result carries the offset of
 * the newest segment and the subagents of the newest segment that has any.
 * A base that is not an envelope, or a segment that cannot be read, gives the base
 * back unchanged: a reader then sees the last complete envelope, never a broken one.
 */
export function mergeEnvelopeWithTails(base: string, tails: ReadonlyArray<{ seq: number; body: string }>): string {
  if (tails.length === 0) return base;
  try {
    const env = JSON.parse(base) as { v?: number; messages?: unknown[]; subagents?: unknown[]; o?: number };
    if (!env || !Array.isArray(env.messages)) return base;
    const messages = [...env.messages];
    let subagents = env.subagents;
    let o = env.o;
    for (const { body } of [...tails].sort((a, b) => a.seq - b.seq)) {
      const t = JSON.parse(body) as Partial<TailBody>;
      if (!Array.isArray(t.messages)) return base;
      for (const m of t.messages) messages.push(m);
      if (Array.isArray(t.subagents) && t.subagents.length > 0) subagents = t.subagents;
      if (typeof t.o === 'number') o = t.o;
    }
    return JSON.stringify({ ...env, messages, subagents: subagents ?? [], o });
  } catch {
    return base;
  }
}

export interface EnvelopePage {
  v: number | undefined;
  total: number;
  messages: unknown[];
  subagents: unknown[];
  mtime: number;
}

/**
 * One page of messages from a stored envelope and its segments, without building
 * the merged envelope or writing it back to text. `limit` 0 means every message.
 * A segment that cannot be read leaves the base alone, as `mergeEnvelopeWithTails`
 * does. Returns null when the base is not an envelope.
 */
export function pageEnvelope(
  base: string,
  tails: ReadonlyArray<{ seq: number; body: string }>,
  offset: number,
  limit: number,
  mtime: number,
): EnvelopePage | null {
  let env: { v?: number; messages?: unknown[]; subagents?: unknown[] };
  try { env = JSON.parse(base); } catch { return null; }
  if (!env || !Array.isArray(env.messages)) return null;
  const parts: unknown[][] = [env.messages];
  let subagents = env.subagents;
  try {
    for (const { body } of [...tails].sort((a, b) => a.seq - b.seq)) {
      const t = JSON.parse(body) as Partial<TailBody>;
      if (!Array.isArray(t.messages)) throw new Error('segment without messages');
      parts.push(t.messages);
      if (Array.isArray(t.subagents) && t.subagents.length > 0) subagents = t.subagents;
    }
  } catch {
    parts.length = 1;
    subagents = env.subagents;
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const from = Math.max(0, offset);
  const to = limit === 0 ? total : Math.min(total, from + limit);
  const messages: unknown[] = [];
  let at = 0;
  for (const part of parts) {
    const lo = Math.max(from - at, 0);
    const hi = Math.min(to - at, part.length);
    for (let i = lo; i < hi; i++) messages.push(part[i]);
    at += part.length;
    if (at >= to) break;
  }
  return { v: env.v, total, messages, subagents: subagents ?? [], mtime };
}

/** A page of messages written by a compaction holds at most this many bytes of JSON. */
export const TAIL_PAGE_TARGET_BYTES = 512 * 1024;
/** A base of more than this many bytes that still holds its messages is split into pages. */
export const TAIL_REPAGE_MIN_BASE_BYTES = 2 * 1024 * 1024;

/**
 * Which parts of a session a window of messages touches. `counts` is the number of
 * messages of each part in reading order (the base, then the segments). Each entry
 * of the answer names a part and the range to take from it. `limit` 0 means all.
 */
export function planPageRead(counts: readonly number[], offset: number, limit: number): Array<{ part: number; from: number; to: number }> {
  const total = counts.reduce((n, c) => n + c, 0);
  const lo = Math.max(0, offset);
  const hi = limit === 0 ? total : Math.min(total, lo + limit);
  const out: Array<{ part: number; from: number; to: number }> = [];
  let at = 0;
  counts.forEach((c, part) => {
    const from = Math.max(lo - at, 0);
    const to = Math.min(hi - at, c);
    if (to > from) out.push({ part, from, to });
    at += c;
  });
  return out;
}

/** Split messages into pages of at most `targetBytes` of JSON each (a message larger than that is a page of its own). */
export function splitIntoPages<T>(messages: readonly T[], targetBytes: number = TAIL_PAGE_TARGET_BYTES): T[][] {
  const pages: T[][] = [];
  let page: T[] = [];
  let bytes = 0;
  for (const m of messages) {
    const size = JSON.stringify(m).length + 1;
    if (page.length > 0 && bytes + size > targetBytes) { pages.push(page); page = []; bytes = 0; }
    page.push(m);
    bytes += size;
  }
  if (page.length > 0) pages.push(page);
  return pages;
}
