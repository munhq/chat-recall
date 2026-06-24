/**
 * Cross-tool sync intent drainer (Model B, local executor side).
 *
 * The web UI (local or SaaS) enqueues intents on the server. This runs on the
 * user's machine — where the actual `~/.claude` / `~/.config/opencode` dirs
 * live — polls each logged-in server for pending intents, performs the
 * filesystem copy via the engine executor, and acks status back.
 *
 * Invoked on a short interval from the watch daemon, and once via the
 * `chat-recall toolkit drain` command.
 */

import { loadAllCredentials } from './sync-client.js';
import {
  executeSyncAll, executeCopy,
  type SyncType, type SyncTargetTool,
} from '@chat-recall/engine';

interface PendingIntent {
  id: string;
  kind: 'copy' | 'sync_all';
  artifact_type: string | null;
  name: string | null;
  from_tool: string | null;
  to_tool: string | null;
}

export interface DrainResult {
  processed: number;
  done: number;
  errored: number;
}

/** Run one intent and return the (status, result-json) to ack with. */
async function runIntent(intent: PendingIntent): Promise<{ status: 'done' | 'error'; result: string }> {
  try {
    if (intent.kind === 'sync_all') {
      const report = await executeSyncAll();
      const status = report.failed.length > 0 ? 'error' : 'done';
      return { status, result: JSON.stringify({ copied: report.copied.length, skipped: report.skipped.length, failed: report.failed }) };
    }
    // copy
    if (!intent.artifact_type || !intent.name || !intent.from_tool || !intent.to_tool) {
      return { status: 'error', result: JSON.stringify({ error: 'copy intent missing fields' }) };
    }
    const r = await executeCopy(intent.artifact_type as SyncType, intent.name, intent.from_tool, intent.to_tool as SyncTargetTool);
    // 409 (already exists) is a benign skip, not a failure.
    const status = r.ok || r.status === 409 ? 'done' : 'error';
    return { status, result: JSON.stringify(r) };
  } catch (e) {
    return { status: 'error', result: JSON.stringify({ error: e instanceof Error ? e.message : 'failed' }) };
  }
}

/**
 * Poll every logged-in server once, execute pending intents locally, ack each.
 * Best-effort: network failures are swallowed (the intent stays pending and is
 * retried on the next drain since it was never acked).
 */
export async function drainSyncIntents(opts: { verbose?: boolean } = {}): Promise<DrainResult> {
  const out: DrainResult = { processed: 0, done: 0, errored: 0 };
  for (const cred of loadAllCredentials()) {
    const base = cred.serverUrl.replace(/\/+$/, '');
    const authHeaders: Record<string, string> = cred.token ? { authorization: `Bearer ${cred.token}` } : {};

    let pending: PendingIntent[];
    try {
      const res = await fetch(`${base}/api/sync-intents/pending`, { headers: authHeaders });
      if (!res.ok) continue;
      pending = ((await res.json()) as { intents?: PendingIntent[] }).intents || [];
    } catch {
      continue; // server unreachable — try again next tick
    }

    for (const intent of pending) {
      const { status, result } = await runIntent(intent);
      out.processed++;
      if (status === 'done') out.done++; else out.errored++;
      if (opts.verbose) {
        const label = intent.kind === 'sync_all' ? 'sync_all' : `${intent.artifact_type} "${intent.name}" ${intent.from_tool}→${intent.to_tool}`;
        console.error(`[sync-intent] ${label}: ${status}`);
      }
      try {
        await fetch(`${base}/api/sync-intents/${intent.id}/ack`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders },
          body: JSON.stringify({ status, result }),
        });
      } catch {
        // Ack failed — leave it; it'll be re-pulled and re-run (copy is
        // idempotent: an already-present target acks as a 409 skip).
      }
    }
  }
  return out;
}
