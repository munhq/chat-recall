/**
 * Un-strand sessions found by `chat-recall verify --deep`.
 *
 * A stranded session is one whose ledger cursor says "the server has all of
 * this" while the server demonstrably has less. Nothing re-ships it, because
 * `syncMode` reads that cursor and returns SKIP. Clearing the cursor is what
 * puts it back in the queue — the next sync then re-derives and re-ships from
 * scratch.
 *
 * Only the CURSOR is cleared, not the whole row: per-field coverage (`f`) is
 * owned by field reconciliation and dropping it would make every field re-scan
 * from zero. The mtime is cleared too, since leaving it would let the
 * mtime-unchanged branch SKIP the session straight back out again.
 *
 * Writes a timestamped backup first. This edits the file that decides what gets
 * uploaded, and a bad edit here re-ships a 10k-session corpus.
 */

import { copyFileSync, existsSync } from 'fs';
import { getLedgerData, persistLedgerData, ledgerFilePath } from './sync-ledger.js';

/** Clear the sync cursor for `sessionIds` on `server`. Returns how many rows
 *  were actually cleared (ids with no ledger entry need no work). */
export function forceFullResync(server: string, sessionIds: string[]): number {
  if (sessionIds.length === 0) return 0;

  const path = ledgerFilePath();
  if (existsSync(path)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '').replace(/-/g, '');
    try { copyFileSync(path, `${path}.bak-${stamp}`); } catch { /* backup best-effort */ }
  }

  const data = getLedgerData(server);
  const wanted = new Set(sessionIds);
  let cleared = 0;

  for (const key of Object.keys(data)) {
    // Ledger keys are prefixed ids for non-Claude tools; match either form.
    const bare = key.replace(/^(opencode_|gemini_|codex_|agy_)/, '');
    if (!wanted.has(key) && !wanted.has(bare)) continue;
    const row = data[key];
    if (typeof row !== 'object' || row === null) { delete data[key]; cleared++; continue; }
    const r = row as unknown as Record<string, unknown>;
    delete r.o;      // byte cursor
    delete r.s;      // synced-through size
    delete r.h;      // content hash — else the "unchanged" fast path skips again
    delete r.m;      // mtime — else the mtime-unchanged branch skips again
    cleared++;
  }

  if (cleared > 0) persistLedgerData(server, data);
  return cleared;
}
