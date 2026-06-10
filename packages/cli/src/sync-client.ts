/**
 * The one conversation-sync client: walk local sessions, redact secrets
 * (ALWAYS — `force:true`, never gated on the index-time toggle), optionally
 * hash project paths, and push to the server's `/api/sync` (the contract in
 * packages/server/cloud/server.mjs). Credentials live in a 0600 file, never in
 * settings.json.
 */
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { redactSecrets } from '@chat-recall/engine/core/secret-redactor.js';
import { loadSettings, saveSettings } from '@chat-recall/engine/core/settings.js';
import { getDataDir } from '@chat-recall/engine/core/paths.js';
import { listAvailableBackends } from '@chat-recall/engine/core/tool-backend.js';
import { extractTurnsAny } from '@chat-recall/engine/core/session-multi-tool.js';
import { createStore, type StorageDriver } from '@chat-recall/engine/core/store/index.js';
import '@chat-recall/engine/core/backends/index.js'; // register the tool backends

// Local store handle for telemetry lookups during a sync walk. Opened once,
// closed by the caller's process exit (CLI) / kept by the daemon.
let _localStore: Promise<StorageDriver> | null = null;
function localStore(): Promise<StorageDriver> {
  if (!_localStore) _localStore = createStore();
  return _localStore;
}

// Lives under the data dir so CHAT_RECALL_DATA_DIR isolates credentials the
// same way it isolates the index (tests, multi-profile setups).
const credPath = () => join(getDataDir(), 'credentials.json');

export interface Credentials { serverUrl: string; token: string; }

export function saveCredentials(c: Credentials): void {
  mkdirSync(dirname(credPath()), { recursive: true });
  writeFileSync(credPath(), JSON.stringify(c, null, 2));
  try { chmodSync(credPath(), 0o600); } catch { /* windows */ }
  // Logging in IS the sync opt-in: enable background sync and record the
  // endpoint so the watch daemon starts pushing without further setup.
  try {
    const s = loadSettings();
    s.sync.enabled = true;
    s.sync.endpoint = c.serverUrl;
    saveSettings(s);
  } catch { /* settings unwritable — manual `chat-recall sync` still works */ }
}
export function loadCredentials(): Credentials | null {
  try { return JSON.parse(readFileSync(credPath(), 'utf-8')) as Credentials; } catch { return null; }
}

/** Tokenize an absolute project path so the server can group by project
 *  without learning the developer's filesystem layout. */
const hashPath = (p: string): string => (p ? 'p_' + createHash('sha256').update(p).digest('hex').slice(0, 12) : '');

export interface SyncResult { uploaded: number; skipped: number; redactions: number; }

export async function syncSessions(opts: { sinceMs?: number; cleartextPaths?: boolean; limit?: number } = {}): Promise<SyncResult> {
  const cred = loadCredentials();
  if (!cred) throw new Error('Not logged in — run `chat-recall login <server-url> --token <token>`');
  const sync = loadSettings().sync;
  const excludeTools = new Set(sync?.excludeTools ?? []);
  const excludeProjects = sync?.excludeProjects ?? [];

  const refs = listAvailableBackends().flatMap((b) => {
    try { return b.listSessions({ sinceMs: opts.sinceMs }); } catch { return []; }
  });

  const conversations: any[] = [];
  let skipped = 0, redactions = 0;
  for (const ref of refs.slice(0, opts.limit ?? refs.length)) {
    if (excludeTools.has(ref.toolId as any)) { skipped++; continue; }
    if (excludeProjects.some((x) => x && ref.projectPath.includes(x))) { skipped++; continue; }
    let turns;
    try { turns = extractTurnsAny(ref.prefixedId, { maxTurns: 5000 }); } catch { skipped++; continue; }
    if (!turns.found) { skipped++; continue; }

    // Structured per-turn payload (each turn redacted independently) — the
    // server indexes turns into chunks and serves them back as the
    // conversation view. `redacted_text` stays for the legacy sync server.
    const count = { redactions: 0 };
    const structured: Array<{ role: 'user' | 'assistant'; text: string; ts?: number }> = [];
    for (const t of turns.turns) {
      if ((t.kind !== 'user' && t.kind !== 'assistant_text') || !t.text) continue;
      structured.push({
        role: t.kind === 'user' ? 'user' : 'assistant',
        text: redactSecrets(t.text, { force: true, count }),
        ts: t.ts || undefined,
      });
    }
    if (structured.length === 0) { skipped++; continue; }
    redactions += count.redactions;

    // Session telemetry for server-side analytics — copied from the local
    // index's extra_json (tokens/models/cost/duration carry no content).
    let meta: Record<string, unknown> = { messageCount: structured.length };
    try {
      const row = await (await localStore()).getItem(ref.prefixedId, 'session');
      if (row?.extra_json) {
        const extra = JSON.parse(row.extra_json);
        for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens',
                         'peakContextTokens', 'costUsd', 'durationMs', 'modelsUsed', 'toolsUsed',
                         'messageCount', 'gitBranch'] as const) {
          if (extra[k] !== undefined) meta[k] = extra[k];
        }
      }
    } catch { /* meta is best-effort */ }

    conversations.push({
      session_id: ref.prefixedId,
      tool: ref.toolId,
      project_path: opts.cleartextPaths ? ref.projectPath : hashPath(ref.projectPath),
      redacted_text: structured.map((t) => t.text).join('\n'),
      turns: structured,
      first_prompt: structured.find((t) => t.role === 'user')?.text.slice(0, 200),
      meta,
      mtime: Math.floor(ref.mtime) || 0,
    });
  }

  const base = cred.serverUrl.replace(/\/$/, '');
  let uploaded = 0;
  // Byte-aware batching: cap each POST at ~8MB of serialized payload (and 50
  // items) so a run of transcript-heavy sessions can't blow the server's body
  // limit. A single conversation larger than the cap still ships alone.
  const MAX_BATCH_BYTES = 8 * 1024 * 1024;
  const MAX_BATCH_ITEMS = 50;
  let batch: any[] = [];
  let batchBytes = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    const res = await fetch(`${base}/api/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cred.token}` },
      body: JSON.stringify({ conversations: batch }),
    });
    if (!res.ok) throw new Error(`sync failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
    uploaded += batch.length;
    batch = [];
    batchBytes = 0;
  };
  for (const cv of conversations) {
    const size = JSON.stringify(cv).length;
    if (batch.length > 0 && (batchBytes + size > MAX_BATCH_BYTES || batch.length >= MAX_BATCH_ITEMS)) {
      await flush();
    }
    batch.push(cv);
    batchBytes += size;
  }
  await flush();
  return { uploaded, skipped, redactions };
}

/**
 * Incremental sync for the watch daemon and parameterless `chat-recall sync`:
 * push only sessions modified after `settings.sync.lastSyncAt`, then advance
 * the watermark. The watermark is captured BEFORE the walk so sessions that
 * change mid-sync are re-pushed next time instead of being skipped forever.
 *
 * Returns null when sync isn't configured (no credentials) — callers treat
 * that as "feature off", not an error.
 */
export async function syncIncremental(): Promise<SyncResult | null> {
  const cred = loadCredentials();
  if (!cred) return null;
  let settings = loadSettings();
  // Master switch (settings.sync.enabled) — `chat-recall login` flips it on;
  // the user can turn background sync off without logging out. Legacy logins
  // (credentials.json written before login set the flag) have enabled=false
  // AND no endpoint recorded: treat that as consent (the only way to get
  // credentials is an explicit login) and migrate the settings once. An
  // endpoint WITH enabled=false means the user deliberately paused — respect it.
  if (!settings.sync.enabled) {
    if (settings.sync.endpoint) return null; // user paused
    settings.sync.enabled = true;
    settings.sync.endpoint = cred.serverUrl;
    saveSettings(settings);
    settings = loadSettings();
  }
  const startedAt = Date.now();
  const sinceMs = settings.sync.lastSyncAt;
  const result = await syncSessions({ sinceMs });
  // Re-load before saving so we don't clobber settings written mid-sync.
  const fresh = loadSettings();
  fresh.sync.lastSyncAt = startedAt;
  saveSettings(fresh);
  return result;
}
