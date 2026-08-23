/**
 * Redact every string anywhere inside a JSON-serializable value.
 *
 * Used for DERIVED payloads — diffs carry file content, outcomes carry prompt
 * text — where field-by-field redaction would be fragile: the shapes are nested,
 * they change when the extractors change, and a missed field ships a secret.
 * Walking everything is the only version that stays correct as those shapes move.
 *
 * Extracted from sync-client so the derived-data path can be shared between the
 * worker thread and the inline fallback without either importing the sync client.
 */
import { redactSecrets } from '@chat-recall/engine/core/secret-redactor.js';

export function redactDeep<T>(v: T, count: { redactions: number }): T {
  if (typeof v === 'string') return redactSecrets(v, { force: true, count }) as unknown as T;
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, count)) as unknown as T;
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = redactDeep(val, count);
    return o as unknown as T;
  }
  return v;
}
