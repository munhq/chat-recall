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

/**
 * The cut of message text. One message keeps up to 200,000 characters, and a transcript keeps up
 * to 96 million characters of message text; the messages after that keep 2,000 characters each.
 * A message that a person reads is far below the cap, so only a pasted file or a dumped log is cut.
 */
export const SYNC_TEXT_CAP = 200_000;
export const SYNC_TEXT_BUDGET = 96 * 1024 * 1024;
export const SYNC_TEXT_CAP_TIGHT = 2000;

/** Characters of cut payloads one transcript keeps before every later payload is cut to `SYNC_PAYLOAD_CAP_TIGHT`. */
export const SYNC_PAYLOAD_BUDGET = 48 * 1024 * 1024;
export const SYNC_PAYLOAD_CAP_TIGHT = 200;

/** Characters a cut payload holds, as the wire counts them. */
function payloadLength(v: unknown): number {
  if (v === undefined || v === null) return 0;
  if (typeof v === 'string') return v.length;
  try { return JSON.stringify(v)?.length ?? 0; } catch { return 0; }
}

/**
 * A cut that keeps the memory of a transcript bounded. Each payload is cut to `capChars` until the
 * payloads kept add up to `budgetChars`; the payloads after that are cut to `tightChars`. A session
 * of 300 MB holds about the same number of payload characters as one of 100 MB, whatever its size.
 * One cut is made for a whole session and shared by its main file and its subagent files.
 */
export function budgetedCut(
  capChars: number,
  budgetChars = SYNC_PAYLOAD_BUDGET,
  tightChars = SYNC_PAYLOAD_CAP_TIGHT,
): (v: unknown) => unknown {
  let kept = 0;
  return (v) => {
    const out = capPayload(v, kept >= budgetChars ? Math.min(tightChars, capChars) : capChars);
    kept += payloadLength(out);
    return out;
  };
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
