/**
 * Registry of DERIVED SYNC FIELDS — values computed locally from a session and
 * pushed into one specific server-side column, INDEPENDENTLY of the heavy
 * conversation payload (chunks / envelope / raw transcript).
 *
 * Why this exists: adding or changing ONE small field must never drag every
 * conversation (multi-MB chunks + derived compute + secret scan + upload) back
 * through sync. Each field is reconciled per session against a coverage ledger:
 *
 *   - not covered (new field, bumped `version`, or — for mtime-sensitive fields
 *     — the transcript changed) → `scan()` it locally and push
 *     `{ session_id, field, value }`; mark the session covered/present.
 *   - `scan()` returns `null` (an older session simply has no such field) →
 *     mark covered/ABSENT. It is NEVER re-scanned again until the field's
 *     `version` bumps or the user explicitly asks for a re-scan. No retries.
 *
 * This is the general mechanism — the ledger, the `fields[]` sync batch, and the
 * server's field router are all field-agnostic. Adding a field = appending one
 * entry here; nothing else changes.
 */
import { getBackendForId, type SessionRef } from './tool-backend.js';

export interface SyncField {
  /** Wire name AND server column key. Must match a key in the server's field
   *  router (routes/sync.ts FIELD_SETTERS). */
  name: string;
  /** Bump to re-scan this field for every session — WITHOUT re-pushing any
   *  conversation. The ledger records the version each session was covered at;
   *  a session is stale when its recorded version < this. */
  version: number;
  /** When true the value can change if the source transcript changes, so a
   *  session is re-scanned once its mtime moves past the mtime it was scanned
   *  at. When false the value is treated as immutable once known. */
  mtimeSensitive: boolean;
  /** Scan local for this session's value. Return the string value, or `null`
   *  for "scanned, this session has no such field" (recorded as absent so it is
   *  never re-scanned until a version bump / forced re-scan). Must not throw —
   *  swallow tool-specific errors and return null. */
  scan(ref: SessionRef): string | null;
}

export const SYNC_FIELDS: readonly SyncField[] = [
  {
    // The session's native title (Claude `ai-title`, OpenCode `session.title`).
    name: 'tool_title',
    version: 1,
    mtimeSensitive: true,
    scan(ref) {
      try {
        const t = getBackendForId(ref.prefixedId)?.getNativeTitle?.(ref.rawId);
        return t && t.trim() ? t.trim() : null;
      } catch {
        return null;
      }
    },
  },
];

export function getSyncField(name: string): SyncField | undefined {
  return SYNC_FIELDS.find((f) => f.name === name);
}
