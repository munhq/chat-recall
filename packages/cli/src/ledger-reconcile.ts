/**
 * Compare the ledger with the server and queue the sessions the server lacks
 * (issue #21).
 *
 * For four days the ledger said 4,000 sessions were synced while the server held
 * 479, and nothing compared the two. One request to `/api/status/sessions` (about
 * 1 MB for 12,000 sessions) gives the server's list. A ledger row whose session
 * the server does not list is cleared, and the next bounded walk sends the
 * session. A session with a tombstone on the server is left alone: the server
 * refuses it.
 */
import { fetchWithTimeout } from './http.js';
import { getSyncedRows, forgetSessions } from './sync-ledger.js';

export type ReconcileMode = 'off' | 'report' | 'act';

/** Rows one run may clear, so the walks that follow stay inside their bounds. */
export const RECONCILE_MAX_PER_RUN = 2000;
export const RECONCILE_INTERVAL_MS = 24 * 60 * 60_000;

/** `CHAT_RECALL_LEDGER_RECONCILE`: `act` (default), `report` or `off`. */
export function reconcileMode(env: NodeJS.ProcessEnv = process.env): ReconcileMode {
  const raw = env.CHAT_RECALL_LEDGER_RECONCILE?.trim().toLowerCase();
  if (raw === 'off' || raw === 'report' || raw === 'act') return raw;
  return 'act';
}

export interface ReconcilePlan {
  /** Every ledger session that the server lacks, newest first. */
  missing: string[];
  /** The part of `missing` that one run clears. */
  queued: string[];
}

export function planReconcile(opts: {
  ledger: ReadonlyMap<string, { m: number }>;
  serverIds: ReadonlySet<string>;
  deletedIds?: ReadonlySet<string>;
  limit?: number;
}): ReconcilePlan {
  const limit = opts.limit ?? RECONCILE_MAX_PER_RUN;
  const missing: Array<[string, number]> = [];
  for (const [id, row] of opts.ledger) {
    if (opts.serverIds.has(id) || opts.deletedIds?.has(id)) continue;
    missing.push([id, row.m]);
  }
  missing.sort((a, b) => b[1] - a[1]);
  const ids = missing.map(([id]) => id);
  return { missing: ids, queued: ids.slice(0, limit) };
}

export interface ServerSessionList { ids: Set<string>; deleted: Set<string> }

type Fetcher = (url: string, init?: RequestInit, ms?: number) => Promise<Response>;

/** One request. Throws when the answer is not a session list, so a failed call never reads as an empty server. */
export async function fetchServerSessions(server: string, token: string, fetcher: Fetcher = fetchWithTimeout): Promise<ServerSessionList> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetcher(`${server}/api/status/sessions`, { headers }, 120_000);
  if (!res.ok) throw new Error(`HTTP ${res.status} from /api/status/sessions`);
  const body = await res.json() as { sessions?: Array<{ id?: unknown }>; deleted?: unknown[] };
  if (!Array.isArray(body.sessions)) throw new Error('/api/status/sessions did not return a session list');
  const ids = new Set<string>();
  for (const s of body.sessions) if (typeof s.id === 'string') ids.add(s.id);
  const deleted = new Set<string>();
  for (const d of body.deleted ?? []) if (typeof d === 'string') deleted.add(d);
  return { ids, deleted };
}

export interface ReconcileResult { mode: ReconcileMode; missing: number; cleared: number; first: string[] }

export interface ReconcileDeps {
  listServer?: (server: string, token: string) => Promise<ServerSessionList>;
  ledgerRows?: (server: string) => ReadonlyMap<string, { m: number }>;
  forget?: (server: string, ids: string[]) => void;
  log?: (line: string) => void;
}

export async function reconcileLedger(
  server: string, token: string, mode: ReconcileMode = reconcileMode(), deps: ReconcileDeps = {},
): Promise<ReconcileResult> {
  const log = deps.log ?? ((l: string) => console.error(l));
  if (mode === 'off') return { mode, missing: 0, cleared: 0, first: [] };
  const list = await (deps.listServer ?? fetchServerSessions)(server, token);
  const plan = planReconcile({
    ledger: (deps.ledgerRows ?? getSyncedRows)(server),
    serverIds: list.ids,
    deletedIds: list.deleted,
  });
  const first = plan.queued.slice(0, 5);
  if (plan.missing.length === 0) return { mode, missing: 0, cleared: 0, first };
  log(`[sync] the server lacks ${plan.missing.length} session(s) that the ledger marks as synced (mode ${mode}); first ids: ${first.join(', ')}`);
  if (mode === 'report') return { mode, missing: plan.missing.length, cleared: 0, first };
  (deps.forget ?? forgetSessions)(server, plan.queued);
  return { mode, missing: plan.missing.length, cleared: plan.queued.length, first };
}

const lastRunAt = new Map<string, number>();

/**
 * The first call of a process runs, and later calls run once a day. A failure is
 * logged and does not stop the walk: the ledger stays as it was.
 */
export async function reconcileLedgerIfDue(
  server: string, token: string, now: number = Date.now(), deps: ReconcileDeps = {},
): Promise<ReconcileResult | null> {
  const last = lastRunAt.get(server);
  if (last !== undefined && now - last < RECONCILE_INTERVAL_MS) return null;
  lastRunAt.set(server, now);
  try {
    return await reconcileLedger(server, token, reconcileMode(), deps);
  } catch (err) {
    lastRunAt.delete(server);
    (deps.log ?? ((l: string) => console.error(l)))(`[sync] ledger check against the server failed (the walk goes on): ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

export function _resetReconcileClockForTests(): void { lastRunAt.clear(); }
