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
import { fetchWithTimeout } from './http.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadAllCredentials } from './sync-client.js';
// Concrete module, NOT the engine barrel: the barrel statically re-exports
// MemoryIndex -> @lancedb/lancedb, and a static barrel import hoists that
// native dep to boot-time in the published bundle (breaks fresh installs).
import {
  executeSyncAll, executeCopy,
  type SyncType, type TargetTool as SyncTargetTool,
} from '@chat-recall/engine/core/toolkit-sync.js';
import { pushProjectTaskStatuses } from './project-tasks.js';

interface PendingIntent {
  id: string;
  kind: 'copy' | 'sync_all' | 'code_apply' | 'recheck_session';
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
async function runIntent(intent: PendingIntent, ctx: { base: string }): Promise<{ status: 'done' | 'error'; result: string }> {
  try {
    if (intent.kind === 'recheck_session') {
      // The server has a thin/absent copy of this session and is asking us to
      // re-verify from THIS machine (disk + shadow = the fullest local truth)
      // and re-push if we have more. repairSession does exactly that, scoped to
      // the requesting server, writing (not a dry run).
      const id = intent.name;
      if (!id) return { status: 'error', result: JSON.stringify({ error: 'recheck missing session id' }) };
      const { repairSession } = await import('./repair.js');
      const r = await repairSession(id, { dryRun: false, server: ctx.base });
      return { status: r.status === 'error' ? 'error' : 'done', result: JSON.stringify(r) };
    }
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

import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

let ownVersion = '0.0.0';
try {
  const dir = dirname(fileURLToPath(import.meta.url));
  ownVersion = (JSON.parse(readFileSync(join(dir, '../package.json'), 'utf-8')) as { version?: string }).version || ownVersion;
} catch {
  try {
    // @ts-ignore
    if (typeof __CLI_VERSION__ === 'string') ownVersion = __CLI_VERSION__;
  } catch {}
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
      const res = await fetchWithTimeout(`${base}/api/sync-intents/pending`, { headers: authHeaders });
      if (!res.ok) continue;
      const data = (await res.json()) as { intents?: PendingIntent[]; cli?: { version: string; sha256: string } | null };
      pending = data.intents || [];

      if (data.cli && data.cli.version) {
        const { planAutoUpdate, runAutoUpdate } = await import('./auto-update.js');
        const plan = planAutoUpdate(base, { cli: data.cli }, ownVersion, process.env.CHAT_RECALL_AUTO_UPDATE);
        if (plan.update) {
          void runAutoUpdate(base, authHeaders, ownVersion).catch(() => {});
        }
      }
    } catch {
      continue; // server unreachable — try again next tick
    }

    for (const intent of pending) {
      const { status, result } = await runIntent(intent, { base });
      out.processed++;
      if (status === 'done') out.done++; else out.errored++;
      if (opts.verbose) {
        const label = intent.kind === 'sync_all' ? 'sync_all'
          : intent.kind === 'recheck_session' ? `recheck ${intent.name}`
          : `${intent.artifact_type} "${intent.name}" ${intent.from_tool}→${intent.to_tool}`;
        console.error(`[sync-intent] ${label}: ${status}`);
      }
      try {
        await fetchWithTimeout(`${base}/api/sync-intents/${intent.id}/ack`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders },
          body: JSON.stringify({ status, result }),
        });
      } catch {
        // Ack failed — leave it; it'll be re-pulled and re-run (copy is
        // idempotent: an already-present target acks as a 409 skip).
      }
    }

    // Read-back: push any SECURITY_TASKS.md / CODE_TASKS.md edits (checkbox/
    // status) up to the server — the file→server half of the two-way sync.
    try {
      await pushProjectTaskStatuses(base, authHeaders, { verbose: opts.verbose });
    } catch { /* never let read-back abort the drain */ }
  }
  return out;
}
