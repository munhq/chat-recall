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
  damaged: boolean;  // archive is fuller than the current view
  healed: boolean;   // we actually rebuilt (damaged && !dryRun && wrote)
  from: number;      // message count before
  to: number;        // message count after / would-be (archive count)
  reason?: 'no-archive' | 'corrupt-archive' | 'healthy' | 'error';
}

/**
 * Rebuild ONE session's view (envelope + FTS chunks) from its raw archive when
 * the archive is fuller than the current view. No-op (fast) otherwise. With
 * `dryRun`, detects damage but writes nothing (the audit path). Must run inside
 * the target tenant's context (the store is tenant-scoped).
 */
export async function healSessionFromArchive(store: Store, sessionId: string, opts: { dryRun?: boolean } = {}): Promise<HealResult> {
  try {
    const raw = await store.getRawSession(sessionId);
    if (!raw) return { sessionId, damaged: false, healed: false, from: 0, to: 0, reason: 'no-archive' };
    const container = gunzipContainer(raw.gz);
    if (!container) return { sessionId, damaged: false, healed: false, from: 0, to: 0, reason: 'corrupt-archive' };

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
    if (archiveMsgs <= itemMsgs) return { sessionId, damaged: false, healed: false, from: itemMsgs, to: archiveMsgs, reason: 'healthy' };
    if (opts.dryRun) return { sessionId, damaged: true, healed: false, from: itemMsgs, to: archiveMsgs };

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

    return { sessionId, damaged: true, healed: true, from: itemMsgs, to: archiveMsgs };
  } catch (err) {
    log.error({ err, session: sessionId }, 'self-heal failed for session');
    return { sessionId, damaged: false, healed: false, from: 0, to: 0, reason: 'error' };
  }
}

export interface SweepResult { scanned: number; healed: number; damaged: number; recheckEnqueued: number; tenants: number }

/** Heal every session in ONE (already tenant-scoped) store whose archive is
 *  fuller than its view; then enqueue client-recheck intents for sessions the
 *  server CANNOT heal (an envelope but no raw archive — the client may hold the
 *  fuller copy in its shadow). Returns per-tenant counts. */
export async function selfHealTenant(store: Store, opts: { sinceMs?: number; dryRun?: boolean } = {}): Promise<{ scanned: number; healed: number; damaged: number; recheckEnqueued: number }> {
  const sinceMs = opts.sinceMs ?? 0;
  let scanned = 0, healed = 0, damaged = 0, recheckEnqueued = 0;

  // 1. Server-side heal (archive fuller than view). No cap — a full backlog
  //    pass must cover EVERY session, or old-but-damaged ones get left behind.
  let rows = await store.listRawSessionVersions(); // [{ session_id, mtime, size }]
  if (sinceMs > 0) rows = rows.filter((r) => (r.mtime || 0) >= sinceMs);
  rows.sort((a, b) => (b.mtime || 0) - (a.mtime || 0)); // freshest first (only matters if ever capped upstream)
  for (const r of rows) {
    scanned++;
    const res = await healSessionFromArchive(store, r.session_id, { dryRun: opts.dryRun });
    if (res.damaged) damaged++;
    if (res.healed) healed++;
  }

  // 2. Client-recheck for what the server can't heal: sessions that HAVE a view
  //    but NO raw archive — the archive is the only server-side truth, so if
  //    it's absent the client (disk + shadow) is the only fuller source. Ask it.
  //    Deduped against already-pending recheck intents; bounded per tick.
  if (!opts.dryRun && typeof store.listEnvelopesMissingRawArchive === 'function') {
    try {
      const RECHECK_CAP = 200;
      const missing = await store.listEnvelopesMissingRawArchive(sinceMs, RECHECK_CAP);
      if (missing.length > 0) {
        const pending = await store.listPendingSyncIntents(undefined, 5000);
        const pendingRecheck = new Set(
          (pending as Array<{ kind?: string; name?: string }>).filter((p) => p.kind === 'recheck_session').map((p) => p.name),
        );
        for (const sid of missing) {
          if (pendingRecheck.has(sid)) continue;
          await store.enqueueSyncIntent({ kind: 'recheck_session', name: sid });
          recheckEnqueued++;
        }
      }
    } catch (err) {
      log.error({ err }, 'recheck-intent enqueue failed');
    }
  }

  return { scanned, healed, damaged, recheckEnqueued };
}

/**
 * Sweep every tenant. Enumerates tenants from the control plane (like the
 * vector/summary workers). `sinceMs` bounds to recently-captured archives
 * (0 = full backlog). `dryRun` = audit only, writes nothing.
 */
export async function selfHealSweepAllTenants(opts: { sinceMs?: number; dryRun?: boolean } = {}): Promise<SweepResult> {
  const sinceMs = opts.sinceMs ?? 0;

  const cp = await createControlPlane();
  let tenants: string[] = [];
  try { tenants = await cp.listTenants(); } catch { /* fall through */ }
  finally { await cp.close?.(); }
  if (tenants.length === 0) tenants = [process.env.CHAT_RECALL_TENANT || 'default'];
  const excluded = new Set((process.env.SELFHEAL_EXCLUDE_TENANTS ?? 'synccheck').split(',').map((s) => s.trim()).filter(Boolean));
  tenants = tenants.filter((t) => !excluded.has(t));

  let scanned = 0, healed = 0, damaged = 0, recheckEnqueued = 0;
  for (const tenant of tenants) {
    await runWithTenant(tenant, async () => {
      const store = await createStore();
      try {
        const r = await selfHealTenant(store, { sinceMs, dryRun: opts.dryRun });
        scanned += r.scanned; healed += r.healed; damaged += r.damaged; recheckEnqueued += r.recheckEnqueued;
        if (r.healed > 0 || r.recheckEnqueued > 0) {
          log.info({ tenant, ...r }, opts.dryRun ? 'self-heal audit (tenant)' : 'self-heal sweep (tenant)');
        }
      } finally {
        await store.close();
      }
    });
  }
  return { scanned, healed, damaged, recheckEnqueued, tenants: tenants.length };
}
