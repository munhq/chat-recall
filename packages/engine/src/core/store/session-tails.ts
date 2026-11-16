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
}

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
    return { seq, o: t.o, lastLine: t.lastLine };
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
