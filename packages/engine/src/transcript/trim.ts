/**
 * The cap the sync wire puts on one payload body (a tool input, a tool result,
 * a thinking block). Both the parser, which applies it while it reads a line,
 * and `trimTranscriptForSync`, which applies it to a parsed transcript, use
 * this one function, so the two give the same bytes.
 */

/**
 * A copy of a short string that holds no reference to the string it was cut
 * from. V8 makes `slice` of a long string a view onto the whole parent, so a
 * 2,000-character head of a 50 MB tool result would keep all 50 MB alive for as
 * long as the head lives. The JSON round trip builds a new string and keeps a
 * lone surrogate as it was.
 */
function detach(s: string): string {
  return JSON.parse(JSON.stringify(s)) as string;
}

/** Characters one payload keeps on the sync wire. */
export const SYNC_PAYLOAD_CAP = 2000;

/**
 * Preserve structure: objects (Edit inputs with old_string/new_string, tool
 * results) stay objects when they fit, because the viewer renders real diffs
 * from them. Only oversized values degrade to truncated strings.
 *
 * The cut is not idempotent: the suffix it appends makes the string longer than
 * `capChars`, so a second cut shortens it again. Cut each value once.
 */
export function capPayload(v: unknown, capChars = SYNC_PAYLOAD_CAP): unknown {
  if (v === undefined) return undefined;
  if (typeof v === 'string') {
    return v.length > capChars ? detach(v.slice(0, capChars)) + `… [+${v.length - capChars} chars]` : v;
  }
  let s = '';
  try { s = JSON.stringify(v) ?? ''; } catch { return undefined; }
  if (s.length <= capChars * 4) return v; // structured + reasonably sized → keep as-is
  if (Array.isArray(v)) return detach(s.slice(0, capChars)) + `… [+${s.length - capChars} chars]`;
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = capPayload(val, capChars);
    return o;
  }
  return v;
}
