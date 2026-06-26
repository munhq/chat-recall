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

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadAllCredentials } from './sync-client.js';
import {
  executeSyncAll, executeCopy,
  type SyncType, type SyncTargetTool,
} from '@chat-recall/engine';

interface PendingIntent {
  id: string;
  kind: 'copy' | 'sync_all' | 'code_apply';
  artifact_type: string | null;
  name: string | null;
  from_tool: string | null;
  to_tool: string | null;
}

/** Apply a code recommendation locally. Currently: append a rule to the
 *  project's CLAUDE.md (idempotent — skips if the exact rule is already there). */
function applyCodeRecommendation(intent: PendingIntent): { status: 'done' | 'error'; result: string } {
  try {
    const meta = JSON.parse(intent.name || '{}') as { rootPath?: string; filename?: string; content?: string; global?: boolean; payload?: { text?: string; global?: boolean } };
    if (intent.artifact_type === 'write_tasks_file') {
      if (!meta.rootPath || !meta.content) return { status: 'error', result: JSON.stringify({ error: 'missing rootPath or content' }) };
      const file = join(meta.rootPath, meta.filename || 'CODE_TASKS.md');
      writeFileSync(file, meta.content);   // overwrite — it's a regenerated task list
      return { status: 'done', result: JSON.stringify({ wrote: file }) };
    }
    if (intent.artifact_type === 'append_claude_md') {
      const text = meta.payload?.text?.trim();
      const isGlobal = meta.global || meta.payload?.global;
      if (!text) return { status: 'error', result: JSON.stringify({ error: 'missing text' }) };
      // global → ~/.claude/CLAUDE.md (user-wide); else the project's CLAUDE.md.
      let file: string;
      if (isGlobal) {
        const dir = join(homedir(), '.claude');
        try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
        file = join(dir, 'CLAUDE.md');
      } else {
        if (!meta.rootPath) return { status: 'error', result: JSON.stringify({ error: 'missing rootPath' }) };
        file = join(meta.rootPath, 'CLAUDE.md');
      }
      const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
      if (existing.includes(text)) return { status: 'done', result: JSON.stringify({ skipped: 'rule already present', file }) };
      const block = `${existing && !existing.endsWith('\n') ? '\n' : ''}\n## Rule (added by chat-recall recommendation)\n${text}\n`;
      if (existing) appendFileSync(file, block);
      else writeFileSync(file, `# ${(meta.rootPath?.split('/').pop()) || 'Global'} instructions\n${block}`);
      return { status: 'done', result: JSON.stringify({ appended: file }) };
    }
    return { status: 'error', result: JSON.stringify({ error: `unsupported code_apply action: ${intent.artifact_type}` }) };
  } catch (e) {
    return { status: 'error', result: JSON.stringify({ error: e instanceof Error ? e.message : 'failed' }) };
  }
}

export interface DrainResult {
  processed: number;
  done: number;
  errored: number;
}

/** Run one intent and return the (status, result-json) to ack with. */
async function runIntent(intent: PendingIntent): Promise<{ status: 'done' | 'error'; result: string }> {
  try {
    if (intent.kind === 'code_apply') {
      return applyCodeRecommendation(intent);
    }
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
