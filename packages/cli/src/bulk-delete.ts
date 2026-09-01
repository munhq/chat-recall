/**
 * Bulk delete — purge many sessions from every logged-in server at once.
 *
 * Deletion existed only one session at a time (`DELETE /api/conversations/:id`,
 * and `recall_forget` over MCP). That is fine for "forget that conversation"
 * and useless for the case that actually produces junk: a tool that fabricates
 * sessions. A misfiring model-probe wrote 475 one-line transcripts into one
 * project — 94% of its indexed history — and clearing them meant 475 HTTP
 * round trips driven by hand.
 *
 * ── Why the sync endpoint rather than N deletes ────────────────────────────
 * `POST /api/sync { tombstones: [...] }` already purges AND tombstones a whole
 * array in one request, and it is the same path the collector uses when it
 * notices a transcript disappeared locally. Reusing it means bulk deletion is
 * not a second implementation of "remove a session everywhere" that has to stay
 * in agreement with the first one — it IS the first one, called with more rows.
 *
 * ── Resurrection ───────────────────────────────────────────────────────────
 * A tombstone is why this sticks. The server records every purged id and the
 * ingest path skips anything in that set (`deadSet` in routes/sync.ts), so a
 * later sync — from this machine with a stale ledger, or from a second device
 * that still has the transcript — cannot put it back. The consequence is worth
 * stating plainly to the caller: deleting a session whose local transcript
 * still exists means that transcript can never be indexed again.
 */
import { loadAllCredentials, type Credentials } from './sync-client.js';
import { getLedgerData, persistLedgerData } from './sync-ledger.js';

/** Rows as `/api/conversations/recent` returns them. */
export interface SessionRow {
  sessionId: string;
  firstPrompt?: string;
  projectId?: string;
  tool?: string;
}

export interface SelectOptions {
  /** Logical project id, e.g. `git:github.com/me/repo`. */
  project?: string;
  /** Keep only sessions whose first prompt is EXACTLY this, trimmed. */
  match?: string;
  /** Keep only sessions from this tool (claude, codex, …). */
  tool?: string;
  /** Stop after this many matches. */
  limit?: number;
}

export interface DeleteOutcome {
  requested: number;
  perTarget: Record<string, { deleted: number; error?: string }>;
  /** Deleted on at least one server. */
  deleted: number;
}

/** Page size for listing; the server caps `limit` at 200. */
const PAGE = 200;
/** Ids per tombstone POST. Large enough to be one request for a typical
 *  cleanup, small enough that a failure loses a bounded amount of work. */
export const BATCH = 250;

const base = (url: string) => url.replace(/\/+$/, '');

/**
 * Enumerate the sessions a selector matches, newest first.
 *
 * Paging walks the WHOLE project rather than trusting page 0 — the same trap
 * `/api/data/delete` had to fix: rows come back mtime-ordered, so a filter that
 * matches only old sessions finds nothing on the first page and would report an
 * empty selection on a project with thousands of rows.
 */
export async function selectSessions(
  target: Credentials,
  opts: SelectOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<SessionRow[]> {
  const found: SessionRow[] = [];
  const want = opts.match?.trim();

  for (let offset = 0; ; offset += PAGE) {
    const qs = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (opts.project) qs.set('project', opts.project);
    if (opts.tool) qs.set('tool', opts.tool);

    const res = await fetchImpl(`${base(target.serverUrl)}/api/conversations/recent?${qs}`, {
      headers: { authorization: `Bearer ${target.token}` },
    });
    if (!res.ok) throw new Error(`list failed: HTTP ${res.status}`);

    const body = await res.json() as { sessions?: SessionRow[] };
    const page = body.sessions ?? [];
    if (page.length === 0) break;

    for (const row of page) {
      if (!row.sessionId) continue;
      if (want !== undefined && (row.firstPrompt ?? '').trim() !== want) continue;
      found.push(row);
      if (opts.limit && found.length >= opts.limit) return found;
    }
    if (page.length < PAGE) break;
  }
  return found;
}

/**
 * Purge + tombstone `ids` on every logged-in server.
 *
 * Per-target failures are recorded, never thrown: with two servers configured,
 * one being unreachable must not hide that the other succeeded — the caller
 * has to be able to say which copies are actually gone.
 */
export async function bulkDelete(
  ids: string[],
  opts: { targets?: Credentials[]; fetchImpl?: typeof fetch; onProgress?: (done: number, total: number) => void } = {},
): Promise<DeleteOutcome> {
  const unique = [...new Set(ids.filter(Boolean))];
  const targets = opts.targets ?? loadAllCredentials();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const out: DeleteOutcome = { requested: unique.length, perTarget: {}, deleted: 0 };
  if (unique.length === 0 || targets.length === 0) return out;

  const succeeded = new Set<string>();

  for (const t of targets) {
    let deleted = 0;
    try {
      for (let i = 0; i < unique.length; i += BATCH) {
        const slice = unique.slice(i, i + BATCH);
        const res = await fetchImpl(`${base(t.serverUrl)}/api/sync`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${t.token}` },
          body: JSON.stringify({
            tombstones: slice.map((session_id) => ({ session_id, deleted_at: Date.now() })),
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        deleted += slice.length;
        for (const id of slice) succeeded.add(id);
        opts.onProgress?.(deleted, unique.length);
      }
      out.perTarget[t.serverUrl] = { deleted };
    } catch (e) {
      out.perTarget[t.serverUrl] = { deleted, error: e instanceof Error ? e.message : 'failed' };
    }
  }

  out.deleted = succeeded.size;

  // Drop the ids from this device's ledger. Without it the collector keeps a
  // record of having shipped them and re-offers them on the next full walk —
  // harmless (the server's deadSet refuses) but it means every later sync
  // carries traffic for sessions that are deliberately gone.
  for (const t of targets) {
    if (!out.perTarget[t.serverUrl] || out.perTarget[t.serverUrl].error) continue;
    try {
      const data = getLedgerData(t.serverUrl);
      let touched = false;
      for (const id of succeeded) {
        if (id in data) { delete data[id]; touched = true; }
      }
      if (touched) persistLedgerData(t.serverUrl, data);
    } catch { /* local bookkeeping — the delete itself already landed */ }
  }

  return out;
}

/** One recorded deletion. */
export interface Tombstone { session_id: string; deleted_at: number }

/**
 * What has been deleted on a server, newest first.
 *
 * A purged session leaves nothing else behind to find it by, so this list is
 * the only route back from a delete.
 */
export async function listTombstones(
  target: Credentials,
  limit = 500,
  fetchImpl: typeof fetch = fetch,
): Promise<{ total: number; tombstones: Tombstone[] }> {
  const res = await fetchImpl(`${base(target.serverUrl)}/api/data/tombstones?limit=${limit}`, {
    headers: { authorization: `Bearer ${target.token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json() as { total: number; tombstones: Tombstone[] };
}

/**
 * Lift tombstones so those sessions may be re-uploaded.
 *
 * Restores no content by itself — it removes the server's refusal. The
 * transcript has to still exist on some device, which is why the CLI tells the
 * caller to re-sync afterwards rather than claiming the data is back.
 */
export async function restoreSessions(
  ids: string[],
  opts: { targets?: Credentials[]; fetchImpl?: typeof fetch } = {},
): Promise<{ requested: number; restored: number; perTarget: Record<string, { restored: number; notDeleted: number; error?: string }> }> {
  const unique = [...new Set(ids.filter(Boolean))];
  const targets = opts.targets ?? loadAllCredentials();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const out = { requested: unique.length, restored: 0, perTarget: {} as Record<string, { restored: number; notDeleted: number; error?: string }> };
  if (unique.length === 0 || targets.length === 0) return out;

  let best = 0;
  for (const t of targets) {
    try {
      let restored = 0, notDeleted = 0;
      for (let i = 0; i < unique.length; i += BATCH) {
        const res = await fetchImpl(`${base(t.serverUrl)}/api/data/restore`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${t.token}` },
          body: JSON.stringify({ session_ids: unique.slice(i, i + BATCH) }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json() as { restored?: number; notDeleted?: string[] };
        restored += body.restored ?? 0;
        notDeleted += (body.notDeleted ?? []).length;
      }
      out.perTarget[t.serverUrl] = { restored, notDeleted };
      best = Math.max(best, restored);
    } catch (e) {
      out.perTarget[t.serverUrl] = { restored: 0, notDeleted: 0, error: e instanceof Error ? e.message : 'failed' };
    }
  }
  out.restored = best;
  return out;
}
