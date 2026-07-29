/**
 * `chat-recall repair` — rebuild sessions whose history an upstream tool
 * truncated in place (Claude Code 2.1.20x resume rewrite) before the shadow
 * archive existed to catch it.
 *
 * SOURCES OF TRUTH, in order of fullness (we take whichever has the MOST
 * messages, then union them):
 *   1. the local shadow archive (if this machine already recovered it)
 *   2. each configured server's shrink-protected raw archive
 *      (`GET /api/conversations/:id/raw-archive`) — the SaaS keeps the
 *      pre-truncation original because putRawSession never overwrites with a
 *      smaller capture; a frozen self-host server is an equally good backstop.
 *
 * FLOW per session: fetch every candidate → pick/​union the fullest → seed the
 * local shadow with it → rebuild the conversation from that shadow (the normal
 * sync builder now reads the shadow) → push the recovered FULL conversation to
 * every server whose current copy is smaller. The server-side shrink guard
 * accepts it because it GROWS the stored conversation.
 *
 * This is the deliberate, audited inverse of the silent truncation: it only
 * ever makes a conversation FULLER, never smaller.
 */

import { createHash } from 'node:crypto';
import { gunzipContainer, parseTranscriptFromContainer, seedShadow, readShadowContainer, type RawContainer } from '@chat-recall/engine/transcript/index.js';
import { getBackendForId, getBackend, type SessionRef } from '@chat-recall/engine/core/tool-backend.js';
import { loadSettings } from '@chat-recall/engine/core/settings.js';
import { fetchWithTimeout } from './http.js';
import { loadAllCredentials } from './sync-client.js';
import { buildConversationSync } from './sync-client.js';

interface Endpoint { url: string; token?: string; }

/** The configured sync targets (settings.sync.endpoint), each with its token
 *  if we have one. Mirrors how the watch daemon resolves targets. */
function resolveEndpoints(only?: string): Endpoint[] {
  const settings = loadSettings();
  const creds = loadAllCredentials();
  const raw = (settings.sync.endpoint || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  const urls = only ? [only.replace(/\/+$/, '')] : raw;
  // Fall back to credential URLs if settings has no endpoint recorded.
  const all = urls.length > 0 ? urls : creds.map((c) => c.serverUrl.replace(/\/+$/, ''));
  return all.map((url) => ({ url, token: creds.find((c) => c.serverUrl.replace(/\/+$/, '') === url)?.token }));
}

const hashPath = (p: string): string => (p ? 'p_' + createHash('sha256').update(p).digest('hex').slice(0, 12) : '');

/** Pull cwd out of a raw container's main transcript (claude/codex jsonl) so an
 *  off-disk session still lands under the right project. '' when unknown. */
function cwdFromContainer(c: RawContainer): string {
  const main = c.files.find((f) => f.name.endsWith('.jsonl') && !f.name.startsWith('subagents/')) ?? c.files[0];
  if (!main) return '';
  for (const line of main.text.split('\n')) {
    if (!line.includes('"cwd"')) continue;
    try { const o = JSON.parse(line); if (typeof o.cwd === 'string' && o.cwd) return o.cwd; } catch { /* skip */ }
  }
  return '';
}

async function fetchJson(url: string, token?: string, timeoutMs = 30000): Promise<any | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: ac.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
  finally { clearTimeout(timer); }
}

interface Candidate { container: RawContainer; messages: number; source: string; }

export interface RepairResult {
  sessionId: string;
  status: 'repaired' | 'would-repair' | 'already-full' | 'no-archive' | 'error';
  fullestMessages: number;
  fullestSource: string;
  pushed: Array<{ server: string; before: number; after: number }>;
  note?: string;
}

/**
 * Repair one session: gather the fullest archive across the local shadow and
 * every configured server, seed the shadow, rebuild, and push where smaller.
 */
export async function repairSession(id: string, opts: { dryRun?: boolean; force?: boolean; verbose?: boolean; server?: string } = {}): Promise<RepairResult> {
  const backend = getBackendForId(id) ?? getBackend('claude');
  const tool = backend.id;
  const rawId = backend.toRawId(id);
  const endpoints = resolveEndpoints(opts.server);
  const log = (m: string) => { if (opts.verbose) console.error(`  [repair ${id}] ${m}`); };

  const candidates: Candidate[] = [];

  // 1. Local shadow (already-known-fullest on this machine).
  const localShadow = readShadowContainer(tool, rawId);
  if (localShadow) {
    try { candidates.push({ container: localShadow, messages: parseTranscriptFromContainer(localShadow).messages.length, source: 'local-shadow' }); }
    catch { /* corrupt shadow — ignore */ }
  }

  // 2. Each server's shrink-protected raw archive + its current item count.
  const currentOnServer = new Map<string, number>();
  for (const ep of endpoints) {
    const cur = await fetchJson(`${ep.url}/api/conversations/${id}?limit=0`, ep.token);
    if (cur && Array.isArray(cur.messages)) currentOnServer.set(ep.url, cur.messages.length);
    const arch = await fetchJson(`${ep.url}/api/conversations/${id}/raw-archive`, ep.token);
    if (arch?.gzB64) {
      try {
        const container = gunzipContainer(Buffer.from(arch.gzB64, 'base64'));
        if (container) candidates.push({ container, messages: parseTranscriptFromContainer(container).messages.length, source: ep.url });
      } catch { /* corrupt archive — ignore */ }
    }
  }

  if (candidates.length === 0) {
    return { sessionId: id, status: 'no-archive', fullestMessages: 0, fullestSource: '', pushed: [], note: 'no shadow or server archive found' };
  }

  const fullest = candidates.reduce((a, b) => (b.messages > a.messages ? b : a));
  log(`fullest archive = ${fullest.messages} msg(s) from ${fullest.source}`);

  if (opts.dryRun) {
    // Report the archive count as a LOWER BOUND — the real rebuild also unions
    // the current disk tail (post-resume continuation), which can only add more.
    const needy = endpoints.filter((ep) => (currentOnServer.get(ep.url) ?? 0) < fullest.messages || opts.force);
    if (needy.length === 0) {
      return { sessionId: id, status: 'already-full', fullestMessages: fullest.messages, fullestSource: fullest.source, pushed: [] };
    }
    return {
      sessionId: id, status: 'would-repair', fullestMessages: fullest.messages, fullestSource: fullest.source,
      pushed: needy.map((ep) => ({ server: ep.url, before: currentOnServer.get(ep.url) ?? 0, after: fullest.messages })),
      note: 'archive count is a lower bound; the rebuild also unions the on-disk tail',
    };
  }

  // Seed the shadow so the sync builder reads the recovered-full transcript.
  // buildConversationSync then re-exports the CURRENT disk file and unions it
  // with this seed via the shadow, so the rebuilt conversation is the true
  // union of {pre-truncation archive} ∪ {post-resume on-disk tail}.
  seedShadow(rawId, fullest.container);

  // Synthesize a SessionRef. On disk → use the real location (lets the builder
  // read cwd + telemetry live); off disk → derive from the container.
  const located = backend.findSession(rawId);
  const projectPath = located?.projectPath || cwdFromContainer(fullest.container);
  const mtime = fullest.container.mtime || located?.mtime || Date.now();
  const ref: SessionRef = {
    toolId: tool,
    rawId,
    prefixedId: id,
    projectPath,
    projectDir: located?.projectDir || '',
    fullPath: located?.path || '',
    created: new Date(mtime).toISOString(),
    modified: new Date(mtime).toISOString(),
    mtime,
    firstPrompt: '',
    messageCount: fullest.messages,
  };

  const cleartext = loadSettings().sync?.pathsCleartext === true;
  const mapPath = (p: string): string => (cleartext ? p : hashPath(p));

  const built = await buildConversationSync(ref, Math.floor(mtime), {
    mapPath, includeRaw: true, includeMeta: true, scanSecrets: false,
  });
  // No priorContentHash passed → the unchanged-content early-out can't fire here;
  // the `'unchanged' in built` arm is only for exhaustive narrowing.
  if (!built || 'unchanged' in built) {
    return { sessionId: id, status: 'error', fullestMessages: fullest.messages, fullestSource: fullest.source, pushed: [], note: 'rebuild produced no conversation' };
  }
  // The rebuilt count is the true fullness (archive ∪ on-disk tail) and drives
  // both the push decision and the report — never the pre-build candidate.
  const builtEnv = built.conv.envelope as { messages?: unknown[] } | undefined;
  const builtCount = Array.isArray(builtEnv?.messages) ? builtEnv.messages.length : fullest.messages;
  const needy = endpoints.filter((ep) => (currentOnServer.get(ep.url) ?? 0) < builtCount || opts.force);
  if (needy.length === 0) {
    return { sessionId: id, status: 'already-full', fullestMessages: builtCount, fullestSource: fullest.source, pushed: [] };
  }

  const pushed: RepairResult['pushed'] = [];
  for (const ep of needy) {
    const before = currentOnServer.get(ep.url) ?? 0;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (ep.token) headers.authorization = `Bearer ${ep.token}`;
    try {
      // Bounded (60s — a repair push carries a whole transcript): repair runs
      // inside the intent drain, and an unbounded upload wedges every later tick.
      const res = await fetchWithTimeout(`${ep.url}/api/sync`, { method: 'POST', headers, body: JSON.stringify({ conversations: [built.conv] }) }, 60_000);
      if (!res.ok) { pushed.push({ server: ep.url, before, after: before }); log(`push to ${ep.url} FAILED: HTTP ${res.status}`); continue; }
      // Confirm the new count.
      const after = await fetchJson(`${ep.url}/api/conversations/${id}?limit=0`, ep.token);
      const afterN = after && Array.isArray(after.messages) ? after.messages.length : before;
      pushed.push({ server: ep.url, before, after: afterN });
      log(`pushed to ${ep.url}: ${before} → ${afterN} msg(s)`);
    } catch (e) {
      pushed.push({ server: ep.url, before, after: before });
      log(`push to ${ep.url} errored: ${e instanceof Error ? e.message : e}`);
    }
  }

  return { sessionId: id, status: 'repaired', fullestMessages: builtCount, fullestSource: fullest.source, pushed };
}

export async function repairSessions(ids: string[], opts: { dryRun?: boolean; force?: boolean; verbose?: boolean; server?: string } = {}): Promise<RepairResult[]> {
  const out: RepairResult[] = [];
  for (const id of ids) {
    try { out.push(await repairSession(id, opts)); }
    catch (e) { out.push({ sessionId: id, status: 'error', fullestMessages: 0, fullestSource: '', pushed: [], note: e instanceof Error ? e.message : String(e) }); }
  }
  return out;
}

export interface RepairAllReport {
  scanned: number;
  candidates: RepairResult[];
  discoveryServer: string;
}

/**
 * Discover every damaged session in a recency window and repair it — the
 * automated sweep behind `repair --all`. A session is DAMAGED when its
 * shrink-protected raw archive parses to MORE messages than the server's
 * current item count (the exact fingerprint of the resume-truncation
 * incident). Discovery reads the primary server only (the one we hold a token
 * for); repairSession then fixes every configured target that's behind.
 *
 * Read-only unless opts.apply — the default is a dry run that mutates nothing.
 */
export async function repairAll(opts: { sinceHours?: number; apply?: boolean; verbose?: boolean; minMessages?: number; server?: string } = {}): Promise<RepairAllReport> {
  const sinceHours = opts.sinceHours ?? 72;
  const minMessages = opts.minMessages ?? 2;
  const endpoints = resolveEndpoints(opts.server);
  const primary = endpoints.find((e) => e.token) ?? endpoints[0];
  if (!primary) return { scanned: 0, candidates: [], discoveryServer: '' };
  const log = (m: string) => { if (opts.verbose) console.error(`  [repair --all] ${m}`); };

  // Page through the sessions modified in the window.
  const ids: string[] = [];
  const limit = 200;
  for (let offset = 0; ; offset += limit) {
    const page = await fetchJson(`${primary.url}/api/conversations/recent?since_hours=${sinceHours}&limit=${limit}&offset=${offset}&include_untracked=1`, primary.token);
    const sessions: Array<{ sessionId: string }> = page?.sessions ?? [];
    for (const s of sessions) if (s.sessionId) ids.push(s.sessionId);
    if (!page?.hasMore || sessions.length === 0) break;
  }
  log(`window=${sinceHours}h → ${ids.length} session(s) to check on ${primary.url}`);

  const candidates: RepairResult[] = [];
  let scanned = 0;
  for (const id of ids) {
    scanned++;
    if (opts.verbose && scanned % 50 === 0) log(`checked ${scanned}/${ids.length}…`);
    const arch = await fetchJson(`${primary.url}/api/conversations/${id}/raw-archive?count=1`, primary.token);
    const archiveMsgs = typeof arch?.messages === 'number' ? arch.messages : 0;
    if (archiveMsgs < minMessages) continue; // no/thin archive — nothing to recover
    const meta = await fetchJson(`${primary.url}/api/conversations/${id}/metadata`, primary.token);
    const current = typeof meta?.messageCount === 'number' ? meta.messageCount : 0;
    if (archiveMsgs <= current) continue; // healthy — archive not fuller than the live view
    // Damaged. Dry-run reports; apply rebuilds + pushes via the canonical path.
    const r = await repairSession(id, { dryRun: !opts.apply, verbose: opts.verbose, server: opts.server });
    // Skip the 'already-full' verdict repairSession may return once the on-disk
    // tail union doesn't actually beat the server (rare; keeps the report clean).
    if (r.status === 'already-full') continue;
    candidates.push(r);
  }
  return { scanned, candidates, discoveryServer: primary.url };
}
