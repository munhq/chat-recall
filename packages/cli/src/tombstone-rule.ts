/**
 * When the collector may tombstone a session (issue #20).
 *
 * The server keeps a tombstone and refuses the session afterwards. On
 * 2026-11-12 one collector sent 11,977 tombstones because those sessions were
 * not in the list of one walk, and the server stored 479 of 12,199 sessions
 * afterwards. "Not in the list" says nothing about the file, so the collector
 * asks the backend that owns the session whether its source is gone.
 *
 * Three answers exist for one session:
 *  - `present`: the backend finds the source.
 *  - `missing`: the backend is available, resolves the id and finds no source.
 *  - `unknown`: no backend owns the id, or the backend is not available (a folder
 *    that is not mounted, a database that is not readable). Nothing is sent.
 */

export type SessionProbe = 'present' | 'missing' | 'unknown';

/** `off` sends nothing, `report` logs what it would send, `act` sends. */
export type TombstoneMode = 'off' | 'report' | 'act';

/**
 * The mode of this release is `report`: the collector logs the count and the
 * first ids and sends nothing. `CHAT_RECALL_TOMBSTONES=act` sends them.
 * A value that does not parse keeps `report`.
 */
export function tombstoneMode(env: NodeJS.ProcessEnv = process.env): TombstoneMode {
  const raw = env.CHAT_RECALL_TOMBSTONES?.trim().toLowerCase();
  if (raw === 'act' || raw === 'off' || raw === 'report') return raw;
  return 'report';
}

/** Share of the ledger that one batch may hold, and the size below which the share is not checked. */
export const TOMBSTONE_MAX_SHARE = 0.05;
export const TOMBSTONE_MIN_GUARDED_BATCH = 50;

export interface TombstonePlan {
  /** Sessions whose source is confirmed missing. */
  ids: string[];
  /** Set when the batch is too large to send. `ids` still lists them for the log. */
  refused: 'batch_too_large' | null;
}

/**
 * The ids of the ledger that this walk did not visit and whose source the probe
 * confirms missing. A batch of more than `TOMBSTONE_MIN_GUARDED_BATCH` ids that
 * is also more than `TOMBSTONE_MAX_SHARE` of the ledger is refused: a source
 * that goes missing at that scale is a folder or a disk that is gone.
 */
export function planTombstones(opts: {
  ledgerIds: Iterable<string>;
  visited: ReadonlySet<string>;
  probe: (id: string) => SessionProbe;
}): TombstonePlan {
  const ids: string[] = [];
  let ledgerSize = 0;
  for (const id of opts.ledgerIds) {
    ledgerSize++;
    if (opts.visited.has(id)) continue;
    let answer: SessionProbe;
    try { answer = opts.probe(id); } catch { answer = 'unknown'; }
    if (answer === 'missing') ids.push(id);
  }
  const tooLarge = ids.length > TOMBSTONE_MIN_GUARDED_BATCH && ids.length > ledgerSize * TOMBSTONE_MAX_SHARE;
  return { ids, refused: tooLarge ? 'batch_too_large' : null };
}

/** The line the collector logs before it sends, or instead of sending. */
export function describeTombstonePlan(plan: TombstonePlan, mode: TombstoneMode): string {
  const first = plan.ids.slice(0, 5).join(', ');
  if (plan.refused) {
    return `[sync] ${plan.ids.length} session(s) have no source and the batch is too large to send (more than ${TOMBSTONE_MAX_SHARE * 100}% of the ledger); first ids: ${first}`;
  }
  return `[sync] ${plan.ids.length} session(s) have no source (mode ${mode}); first ids: ${first}`;
}
