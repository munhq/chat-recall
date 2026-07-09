/**
 * Server-side automatic self-heal.
 *
 * The shrink-protected raw archive (`raw_sessions`) is the full history — the
 * shrink guard in putRawSession never lets a smaller capture overwrite it. So
 * whenever a session's rendered view (content_cache envelope + FTS chunks) is
 * THINNER than what its own archive parses to, the server can rebuild the view
 * from the archive with zero client involvement. That is the exact damage the
 * Claude Code 2.1.20x resume-truncation caused, and this is its automatic,
 * customer-action-free cure.
 *
 * Invariant: heal ONLY when the archive is strictly fuller (more messages) than
 * the current view. It can only ever GROW a conversation, never shrink it, and
 * it rebuilds from the session's OWN archived bytes — nothing is fabricated.
 *
 * Two complementary mechanisms:
 *   - ingest shrink-guard (routes/sync.ts) PREVENTS new damage: a truncated
 *     sync can't overwrite a fuller stored conversation, so nothing goes thin.
 *   - background sweep (this file, wired in server.ts) CURES existing damage:
 *     a full backlog pass shortly after boot + an hourly windowed pass, across
 *     every tenant. Together they need zero client or customer action.
 * (No heal-on-read: the sweep clears the backlog within one cycle and the guard
 *  stops new damage, so paying archive-parse latency on every open buys nothing.)
 */
import {
  createStore, createControlPlane, runWithTenant,
  gunzipContainer, parseTranscriptFromContainer, TRANSCRIPT_VERSION,
  type SourceType,
} from '../imports.js';
import { chunksFromTurns, subagentChunks, type EnvSubagent } from './session-chunks.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';

const log = createLogger('self-heal');

type Store = Awaited<ReturnType<typeof createStore>>;

export interface HealResult {
  sessionId: string;
  healed: boolean;
  from: number;   // message count before
  to: number;     // message count after (archive count)
  reason?: 'no-archive' | 'corrupt-archive' | 'healthy' | 'error';
}

/**
 * Rebuild ONE session's view (envelope + FTS chunks) from its raw archive when
 * the archive is fuller than the current view. No-op (fast) otherwise. Must be
 * called inside the target tenant's context (the store is tenant-scoped).
 */
export async function healSessionFromArchive(store: Store, sessionId: string): Promise<HealResult> {
  try {
    const raw = await store.getRawSession(sessionId);
    if (!raw) return { sessionId, healed: false, from: 0, to: 0, reason: 'no-archive' };
    const container = gunzipContainer(raw.gz);
    if (!container) return { sessionId, healed: false, from: 0, to: 0, reason: 'corrupt-archive' };

    const parsed = parseTranscriptFromContainer(container);
    const archiveMsgs = parsed.messages.length;

    // Current rendered view (stale read: latest regardless of mtime).
    const stored = await store.getCachedContentStale(sessionId, 'session');
    let itemMsgs = 0, storedOffset = 0;
    if (stored?.content) {
      try {
        const e = JSON.parse(stored.content) as { messages?: unknown[]; o?: number };
        itemMsgs = Array.isArray(e.messages) ? e.messages.length : 0;
        if (typeof e.o === 'number') storedOffset = e.o;
      } catch { /* corrupt envelope — treat as 0, heal will replace it */ }
    }

    // Only ever grow. Archive not fuller ⇒ nothing to do.
    if (archiveMsgs <= itemMsgs) return { sessionId, healed: false, from: itemMsgs, to: archiveMsgs, reason: 'healthy' };

    // Project context for chunk rows comes from the metadata row (title/project
    // are head-derived and unaffected by truncation, so they're trustworthy).
    const item = await store.getItem(sessionId, 'session');
    const projectPath = item?.project_path || '';
    const projectId = item?.project_id || undefined;
    // Heal with an mtime >= whatever the read path requests, so the primary
    // getCachedContent(>=mtime) hits (not just the stale fallback).
    const mtime = Math.max(raw.mtime || 0, item?.mtime || 0);

    // 1. Envelope — the viewer's source of truth.
    const envelope = { v: TRANSCRIPT_VERSION, messages: parsed.messages, subagents: parsed.subagents, o: storedOffset };
    await store.setCachedContent(sessionId, 'session', mtime, JSON.stringify(envelope));

    // 2. FTS chunks — search. Same builders the sync ingest uses; addChunksFTS
    //    deletes the item's rows first, so this replaces cleanly.
    const textSource = parsed.messages
      .filter((m) => m.content?.trim())
      .map((m) => ({ role: m.role as 'user' | 'assistant', text: m.content! }));
    const cks = chunksFromTurns(sessionId, textSource, projectPath, mtime, projectId);
    const subs = subagentChunks(sessionId, (parsed.subagents ?? []) as unknown as EnvSubagent[], projectPath, mtime);
    const all = subs.length > 0 ? [...cks, ...subs] : cks;
    if (all.length > 0) await store.addChunksFTS(all);

    return { sessionId, healed: true, from: itemMsgs, to: archiveMsgs };
  } catch (err) {
    log.error({ err, session: sessionId }, 'self-heal failed for session');
    return { sessionId, healed: false, from: 0, to: 0, reason: 'error' };
  }
}

export interface SweepResult { scanned: number; healed: number; tenants: number }

/**
 * Sweep every tenant, healing sessions whose archive is fuller than their view.
 * `sinceMs` bounds the scan to recently-captured archives (0 = all). Per-tenant
 * `limit` bounds one tick. Enumerates tenants from the control plane, exactly
 * like the vector/summary workers.
 */
export async function selfHealSweepAllTenants(opts: { sinceMs?: number; limitPerTenant?: number } = {}): Promise<SweepResult> {
  const sinceMs = opts.sinceMs ?? 0;
  const limit = opts.limitPerTenant ?? 5000;

  const cp = await createControlPlane();
  let tenants: string[] = [];
  try { tenants = await cp.listTenants(); } catch { /* fall through */ }
  finally { await cp.close?.(); }
  if (tenants.length === 0) tenants = [process.env.CHAT_RECALL_TENANT || 'default'];
  const excluded = new Set((process.env.SELFHEAL_EXCLUDE_TENANTS ?? 'synccheck').split(',').map((s) => s.trim()).filter(Boolean));
  tenants = tenants.filter((t) => !excluded.has(t));

  let scanned = 0, healed = 0;
  for (const tenant of tenants) {
    await runWithTenant(tenant, async () => {
      const store = await createStore();
      try {
        let rows = await store.listRawSessionVersions(); // [{ session_id, mtime, size }]
        if (sinceMs > 0) rows = rows.filter((r) => (r.mtime || 0) >= sinceMs);
        rows.sort((a, b) => (b.mtime || 0) - (a.mtime || 0)); // freshest first
        if (rows.length > limit) rows = rows.slice(0, limit);
        for (const r of rows) {
          scanned++;
          const res = await healSessionFromArchive(store, r.session_id);
          if (res.healed) {
            healed++;
            log.info({ tenant, session: r.session_id, from: res.from, to: res.to }, 'self-healed session from archive');
          }
        }
      } finally {
        await store.close();
      }
    });
  }
  return { scanned, healed, tenants: tenants.length };
}
