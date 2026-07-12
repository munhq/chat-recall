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
  createStore, createControlPlane, createMetadataCache, runWithTenant,
  gunzipContainer, parseTranscriptFromContainer, TRANSCRIPT_VERSION,
  getBackend,
  type SourceType,
} from '../imports.js';
import { replayFromEvents } from '@chat-recall/engine/core/generic-engine.js';
import { chunksFromTurns, subagentChunks, type EnvSubagent } from './session-chunks.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';

const log = createLogger('self-heal');

type Store = Awaited<ReturnType<typeof createStore>>;
type MetaCache = Awaited<ReturnType<typeof createMetadataCache>>;

// Edit-tool markers — a cheap gate before the (heavier) diff replay: no edit
// tool in the transcript ⇒ the diff is legitimately empty, skip the replay.
const EDIT_TOOL_RE = /"(Edit|Write|MultiEdit|NotebookEdit)"/;

export interface HealResult {
  sessionId: string;
  damaged: boolean;  // archive is fuller than the current view
  healed: boolean;   // we actually rebuilt (damaged && !dryRun && wrote)
  from: number;      // message count before
  to: number;        // message count after / would-be (archive count)
  reason?: 'no-archive' | 'corrupt-archive' | 'healthy' | 'error';
}

/**
 * Rebuild ONE session from its raw archive: the conversation VIEW (envelope +
 * FTS chunks) AND the derived DIFF (the Changes tab). Both were clobbered by the
 * truncated re-sync — the envelope by the thin transcript, the diff by replaying
 * the truncated disk file. Heal both from the archive (the full, untrimmed
 * bytes). Only ever GROWS (more messages / more changed files); never shrinks.
 * With `dryRun`, detects damage but writes nothing. `opts.metaCache` enables the
 * diff heal (it lives in the metadata cache, not the store). Must run inside the
 * target tenant's context.
 */
export async function healSessionFromArchive(store: Store, sessionId: string, opts: { dryRun?: boolean; metaCache?: MetaCache } = {}): Promise<HealResult> {
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
    const envelopeDamaged = archiveMsgs > itemMsgs; // only ever grow

    const item = await store.getItem(sessionId, 'session');
    const projectPath = item?.project_path || '';
    const projectId = item?.project_id || undefined;
    // Heal with an mtime >= whatever the read path requests, so the primary
    // getCachedContent(>=mtime) hits (not just the stale fallback).
    const mtime = Math.max(raw.mtime || 0, item?.mtime || 0);

    // ── Derived diff: replay the archive's edit tool-calls and (re)build the
    // diff when it's thinner than the archive's. Gated to claude sessions that
    // actually edited files, and — to bound replay cost — only when the envelope
    // is damaged (a truncation victim, its diff is clobbered too) or the stored
    // diff is empty. The archive holds the full, untrimmed tool inputs replay needs.
    let newDiff: { files?: unknown[] } | null = null;
    if (opts.metaCache && container.tool === 'claude') {
      const jsonlText = container.files.filter((f) => f.name.endsWith('.jsonl')).map((f) => f.text).join('\n');
      if (EDIT_TOOL_RE.test(jsonlText)) {
        let storedFiles = 0;
        try {
          const sd = await opts.metaCache.getComputeStale<{ files?: unknown[] }>(sessionId, 'diff');
          storedFiles = Array.isArray(sd?.data?.files) ? sd!.data.files!.length : 0;
        } catch { /* no stored diff */ }
        if (envelopeDamaged || storedFiles === 0) {
          try {
            const backend = getBackend('claude');
            const events = container.files
              .filter((f) => f.name.endsWith('.jsonl'))
              .flatMap((f) => backend.readEventsFromText?.(f.text, raw.mtime) ?? []);
            const d = replayFromEvents(sessionId, events, backend.fileToolMap, backend.extractEditDelta?.bind(backend), { projectPath, found: true }) as { files?: unknown[] };
            if ((Array.isArray(d.files) ? d.files.length : 0) > storedFiles) newDiff = d;
          } catch (e) { log.error({ err: e, session: sessionId }, 'diff replay from archive failed'); }
        }
      }
    }
    const diffDamaged = newDiff !== null;

    const damaged = envelopeDamaged || diffDamaged;
    if (!damaged) return { sessionId, damaged: false, healed: false, from: itemMsgs, to: archiveMsgs, reason: 'healthy' };
    if (opts.dryRun) return { sessionId, damaged: true, healed: false, from: itemMsgs, to: archiveMsgs };

    // 1. Envelope — the viewer's source of truth.
    if (envelopeDamaged) {
      const envelope = { v: TRANSCRIPT_VERSION, messages: parsed.messages, subagents: parsed.subagents, o: storedOffset };
      await store.setCachedContent(sessionId, 'session', mtime, JSON.stringify(envelope));

      // 2. FTS chunks — search. Same builders the sync ingest uses; addChunksFTS
      //    deletes the item's rows first, so this replaces cleanly.
      const textSource = parsed.messages
        .filter((m) => m.content?.trim())
        .map((m) => ({ role: m.role as 'user' | 'assistant', text: m.content! }));
      const healFirstPrompt = parsed.messages.find((m) => m.role === 'user' && m.content?.trim())?.content;
      const cks = chunksFromTurns(sessionId, textSource, projectPath, mtime, projectId, healFirstPrompt);
      const subs = subagentChunks(sessionId, (parsed.subagents ?? []) as unknown as EnvSubagent[], projectPath, mtime);
      const all = subs.length > 0 ? [...cks, ...subs] : cks;
      if (all.length > 0) await store.addChunksFTS(all);
    }

    // 3. Derived diff — the Changes tab. Same store/key /api/.../diff reads.
    if (diffDamaged && newDiff && opts.metaCache) {
      await opts.metaCache.setCompute(sessionId, 'diff', mtime, newDiff);
    }

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
export async function selfHealTenant(store: Store, opts: { sinceMs?: number; dryRun?: boolean } = {}): Promise<{ scanned: number; healed: number; damaged: number; recheckEnqueued: number; damagedIds: string[] }> {
  const sinceMs = opts.sinceMs ?? 0;
  let scanned = 0, healed = 0, damaged = 0, recheckEnqueued = 0;
  const damagedIds: string[] = [];

  // The diff heal lives in the metadata cache (compute_cache), not the store.
  const metaCache = await createMetadataCache();
  try {
    // 1. Server-side heal (archive fuller than view). No cap — a full backlog
    //    pass must cover EVERY session, or old-but-damaged ones get left behind.
    let rows = await store.listRawSessionVersions(); // [{ session_id, mtime, size }]
    if (sinceMs > 0) rows = rows.filter((r) => (r.mtime || 0) >= sinceMs);
    rows.sort((a, b) => (b.mtime || 0) - (a.mtime || 0)); // freshest first (only matters if ever capped upstream)
    for (const r of rows) {
      scanned++;
      const res = await healSessionFromArchive(store, r.session_id, { dryRun: opts.dryRun, metaCache });
      if (res.damaged) { damaged++; if (damagedIds.length < 200) damagedIds.push(`${r.session_id}:${res.from}->${res.to}`); }
      if (res.healed) healed++;
    }
  } finally {
    await metaCache.close();
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

  return { scanned, healed, damaged, recheckEnqueued, damagedIds };
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
