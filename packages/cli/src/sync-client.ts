/**
 * The one conversation-sync client: walk local sessions, redact secrets
 * (ALWAYS — `force:true`, never gated on the index-time toggle), optionally
 * hash project paths, and push to the server's `/api/sync` (the contract in
 * packages/server/cloud/server.mjs). Credentials live in a 0600 file, never in
 * settings.json.
 */
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { redactSecrets } from '@chat-recall/engine/core/secret-redactor.js';
import { loadSettings } from '@chat-recall/engine/core/settings.js';
import { listAvailableBackends } from '@chat-recall/engine/core/tool-backend.js';
import { extractTurnsAny } from '@chat-recall/engine/core/session-multi-tool.js';
import '@chat-recall/engine/core/backends/index.js'; // register the tool backends

const CRED_PATH = join(homedir(), '.chat-recall', 'credentials.json');

export interface Credentials { serverUrl: string; token: string; }

export function saveCredentials(c: Credentials): void {
  mkdirSync(dirname(CRED_PATH), { recursive: true });
  writeFileSync(CRED_PATH, JSON.stringify(c, null, 2));
  try { chmodSync(CRED_PATH, 0o600); } catch { /* windows */ }
}
export function loadCredentials(): Credentials | null {
  try { return JSON.parse(readFileSync(CRED_PATH, 'utf-8')) as Credentials; } catch { return null; }
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
    const text = turns.turns
      .filter((t) => (t.kind === 'user' || t.kind === 'assistant_text') && t.text)
      .map((t) => t.text)
      .join('\n');
    if (!text.trim()) { skipped++; continue; }
    const count = { redactions: 0 };
    const redacted = redactSecrets(text, { force: true, count });
    redactions += count.redactions;
    conversations.push({
      session_id: ref.prefixedId,
      tool: ref.toolId,
      project_path: opts.cleartextPaths ? ref.projectPath : hashPath(ref.projectPath),
      redacted_text: redacted,
      mtime: Math.floor(ref.mtime) || 0,
    });
  }

  const base = cred.serverUrl.replace(/\/$/, '');
  let uploaded = 0;
  const BATCH = 50;
  for (let i = 0; i < conversations.length; i += BATCH) {
    const batch = conversations.slice(i, i + BATCH);
    const res = await fetch(`${base}/api/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cred.token}` },
      body: JSON.stringify({ conversations: batch }),
    });
    if (!res.ok) throw new Error(`sync failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
    uploaded += batch.length;
  }
  return { uploaded, skipped, redactions };
}
