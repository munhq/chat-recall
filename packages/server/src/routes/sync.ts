/**
 * /api/sync — the one ingestion surface the local binary calls.
 *
 * Every uploaded conversation is chunked, classified, and written through
 * the SAME engine stores the dashboard reads (memory_metadata + FTS chunks
 * + session_metadata), so search / recent / conversation view / analytics
 * work on synced data with no separate read path.
 *
 * Auth: agent (device) bearer token only — resolved here, NOT by the
 * tenantAuth middleware, because the nested runWithTenant() below must
 * scope the writes to the token's tenant regardless of what the outer
 * middleware resolved.
 *
 * Payload (from packages/cli/src/sync-client.ts) — every field optional,
 * batches arrive as separate POSTs:
 *   conversations: [{ session_id, tool, project_path, redacted_text,
 *                     turns?: [{role,text,ts?}], first_prompt?, mtime, meta? }]
 *   items:       [{ id, source_type, title, project_path, content_preview,
 *                   mtime, extra?, chunks: [{text, chunk_type, title}] }]
 *   links:       [{ source_type, source_id, target_type, target_id,
 *                   link_type, confidence }]
 *   findings:    [{ session_id, detector, rule, line, preview, verified_at? }]
 *   derived:     [{ session_id, mtime, compute: [{kind, mtime, data}],
 *                   outcome_row? }]
 *   kg_entities: [{ name, type, properties }]
 *   kg_triples:  [{ subject, predicate, object, valid_from, valid_to,
 *                   confidence, source_session }]
 *   dismissals:  [{ preview, status, reason }]
 *   custom_rules:[{ name, regex, severity, description, enabled }]
 *
 * Everything in the payload was redacted client-side (`redactSecrets` with
 * force:true) before it hit the wire; the server never sees raw secrets.
 * The RAW transcript JSON never ships. The conversation view is rebuilt
 * server-side from the redacted turn stream (text + tool calls + result
 * snippets) into content_cache; the per-turn chunks remain the search
 * index and the fallback view.
 */

import express from 'express';
import {
  createControlPlane, createStore, createMetadataCache, createOutcomeCache,
  createKnowledgeGraph, runWithTenant, classifyChunk,
  gunzipContainer, parseTranscriptFromContainer,
} from '../imports.js';
import type { SourceType } from '../imports.js';
import { dropFuzzyFindings } from '@chat-recall/engine/core/secret-precision.js';
import { notifyVerifiedSecrets, type VerifiedHit } from '../services/notify.js';
import { ingestGate } from '../middleware/rate-limit.js';
import { chunksFromTurns, subagentChunks, type EnvSubagent } from '../services/session-chunks.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';

const log = createLogger('sync');

const router = express.Router();

interface SyncTurn {
  role: 'user' | 'assistant' | 'tool_use' | 'tool_result';
  text: string;
  ts?: number;
  /** tool_use only */
  tool_name?: string;
  /** correlates a tool_result with its tool_use */
  tool_use_id?: string;
  /** tool_result only */
  is_error?: boolean;
}
interface SyncEnvelopeMessage {
  line?: number;
  role: 'user' | 'assistant' | 'summary';
  content?: string;
  thinking?: string;
  toolCalls?: Array<{ name: string; input?: unknown; result?: unknown; isError?: boolean }>;
  timestamp?: string;
}
interface SyncConversation {
  session_id: string;
  tool?: string;
  project_path?: string;
  /** Locally-resolved logical project id (git:…/ws:…) — stored verbatim. */
  project_id?: string;
  redacted_text?: string;
  /** Canonical transcript envelope (R3) — preferred. Stored verbatim. */
  envelope?: { v: number; messages: SyncEnvelopeMessage[]; subagents?: unknown[] };
  /** Redacted raw container, gzipped+base64 (Phase 2 archive). When present
   *  the server stores it shrink-protected and derives the envelope+chunks
   *  from it — the client envelope becomes a fallback. */
  raw_b64?: string;
  raw_size?: number;
  /** Legacy per-turn payload (older clients). */
  turns?: SyncTurn[];
  first_prompt?: string;
  mtime?: number;
  meta?: Record<string, unknown>;
  /** Tail-only append sync (docs/SYNC-INCREMENTAL.md). When true, the server
   *  appends this envelope's messages to the existing content_cache envelope
   *  + appends chunks WITHOUT deleting the head's chunks. The payload omits
   *  title/first_prompt/meta/raw_b64 (all head-derived; prior values stand). */
  append?: boolean;
  /** Byte offset the tail STARTS at (= the prior synced-through offset). The
   *  server merges the tail ONLY if its stored envelope's `o` equals this — the
   *  offset-continuity guard against a truncated/stale base. */
  base_offset?: number;
  /** Byte offset the tail ENDS at (the new synced-through offset). Persisted
   *  server-side (`o`) and client-side (ledger) on a successful append/full. */
  from_offset?: number;
}
interface SyncItem {
  id: string;
  source_type: string;
  title?: string;
  project_path?: string;
  project_id?: string;
  content_preview?: string;
  mtime?: number;
  extra?: Record<string, unknown>;
  chunks?: Array<{ text: string; chunk_type?: string; title?: string }>;
}
interface SyncLink {
  source_type: string;
  source_id: string;
  target_type: string;
  target_id: string;
  link_type: string;
  confidence?: number;
}
interface SyncFinding {
  session_id: string;
  detector: string;
  rule: string;
  line: number;
  preview: string;
  verified_at?: string | null;
}
interface SyncDerived {
  session_id: string;
  mtime?: number;
  compute?: Array<{ kind: string; mtime: number; data: unknown }>;
  outcome_row?: Record<string, unknown> | null;
}
interface SyncKgEntity { name: string; type?: string; properties?: Record<string, unknown> }
interface SyncKgTriple {
  subject: string;
  predicate: string;
  object: string;
  valid_from?: string | null;
  valid_to?: string | null;
  confidence?: number;
  source_session?: string | null;
}
interface SyncTombstone { session_id: string; deleted_at?: number }
interface SyncDismissal { preview: string; status: string; reason?: string | null }
interface SyncCustomRule { name: string; regex: string; severity: string; description?: string | null; enabled?: boolean }
/** Generic derived-field row (see engine core/sync-fields.ts + the client's
 *  field reconciliation): set ONE column for one session WITHOUT re-pushing the
 *  conversation. `value: null` clears it. `field` is routed through FIELD_SETTERS. */
interface SyncFieldRow { session_id: string; field: string; value?: string | null }

/** Non-session source types the items[] path accepts. Sessions must come
 *  through conversations[] (they carry turns + telemetry meta). */
const ITEM_SOURCE_TYPES = new Set<string>([
  'plan', 'task', 'claude_md', 'paste', 'history', 'diary',
  'skill', 'mcp', 'command', 'agent', 'hook', 'plugin',
]);

/** compute_cache kinds the conversation deep-dive routes read. */
const COMPUTE_KINDS = new Set(['diff', 'outcome', 'commits', 'markers']);

const DISMISSAL_STATUSES = new Set(['rotated', 'false_positive', 'dismissed']);
const RULE_SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);

/** Derived-field router: field name → how its value lands server-side. The
 *  client scans these locally (engine core/sync-fields.ts) and ships them via
 *  the fields[] batch, conversation-free. Add a field in BOTH places. */
type MetaCache = Awaited<ReturnType<typeof createMetadataCache>>;
const FIELD_SETTERS: Record<string, (cache: MetaCache, sessionId: string, value: string | null) => Promise<void>> = {
  tool_title: (cache, id, v) => cache.setToolTitle(id, v),
};

// chunksFromTurns + subagentChunks now live in services/session-chunks.ts —
// the SINGLE source of truth shared by this ingest path and the server-side
// self-heal (services/self-heal.ts), so a rebuilt-from-archive session indexes
// identically to a freshly-synced one.

/** The {v, messages} envelope the conversations/:id route serves from
 *  content_cache — version must match its PARSER_VERSION. */
const PARSER_VERSION = 6;

/**
 * Rebuild the conversation envelope the dashboard renders, in the SAME
 * shape the local parser produces (services/parser.ts Message): text
 * messages with tool calls folded into the preceding assistant message's
 * `toolCalls` array, results attached by tool_use_id. This is what makes
 * a synced tool-heavy session (90%+ tool activity) look like the local
 * one instead of a gutted text skeleton.
 */
interface EnvelopeMessage {
  line: number;
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
  toolCalls?: Array<{ name: string; input: unknown; result?: unknown; isError?: boolean }>;
}
function envelopeFromTurns(turns: SyncTurn[]): EnvelopeMessage[] {
  const messages: EnvelopeMessage[] = [];
  const callsById = new Map<string, NonNullable<EnvelopeMessage['toolCalls']>[number]>();
  let line = 0;
  for (const t of turns) {
    const timestamp = t.ts ? new Date(t.ts).toISOString() : undefined;
    if (t.role === 'user' || t.role === 'assistant') {
      messages.push({ line: ++line, role: t.role, content: t.text || '', timestamp });
    } else if (t.role === 'tool_use') {
      // Fold into the preceding assistant message; tool calls at the very
      // start (or right after a user turn) get a content-less assistant
      // carrier message, mirroring how the local parser groups them.
      let last = messages[messages.length - 1];
      if (!last || last.role !== 'assistant') {
        last = { line: ++line, role: 'assistant', content: '', timestamp };
        messages.push(last);
      }
      const call = { name: t.tool_name || 'tool', input: t.text || '' };
      (last.toolCalls ??= []).push(call);
      if (t.tool_use_id) callsById.set(t.tool_use_id, call);
    } else if (t.role === 'tool_result') {
      const call = t.tool_use_id ? callsById.get(t.tool_use_id) : undefined;
      if (call) {
        call.result = t.text || '';
        if (t.is_error) call.isError = true;
      }
    }
  }
  return messages;
}

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

router.post('/', async (req, res) => {
  // Agent-token auth (ct_…). The tenantAuth middleware may have resolved a
  // different tenant for this request; the token's tenant wins for writes.
  // Agent-token auth (ct_…) normally. But local self-host (AUTH_PROVIDER=none)
  // is single-tenant and already trusts the network (the dashboard has no auth
  // either), so a TOKENLESS push is accepted and written to the single
  // 'default' tenant the dashboard reads — that's how a local collector syncs
  // with no token. Any other auth mode still requires a valid agent token.
  const m = /^Bearer\s+(.+)$/.exec(req.get('authorization') || '');
  let agent: { tenant: string; deviceId: string } | null;
  if (m) {
    const cp = await createControlPlane();
    try { agent = await cp.resolveAgentToken(m[1]); }
    finally { await cp.close(); }
    if (!agent) return res.status(401).json({ error: 'invalid agent token' });
  } else if ((process.env.AUTH_PROVIDER || 'none').toLowerCase() === 'none') {
    agent = { tenant: 'default', deviceId: 'local' };
  } else {
    return res.status(401).json({ error: 'agent token required' });
  }

  const conversations = arr<SyncConversation>(req.body?.conversations);
  const items = arr<SyncItem>(req.body?.items);
  const links = arr<SyncLink>(req.body?.links);
  const findings = arr<SyncFinding>(req.body?.findings);
  const derived = arr<SyncDerived>(req.body?.derived);
  const kgEntities = arr<SyncKgEntity>(req.body?.kg_entities);
  const kgTriples = arr<SyncKgTriple>(req.body?.kg_triples);
  const tombstones = arr<SyncTombstone>(req.body?.tombstones);
  const dismissals = arr<SyncDismissal>(req.body?.dismissals);
  const customRules = arr<SyncCustomRule>(req.body?.custom_rules);
  const fields = arr<SyncFieldRow>(req.body?.fields);

  // Ingest backpressure: bound concurrent ingestion (per-tenant + global) and
  // cost the batch by row count, shedding with 429 + Retry-After (which the
  // collector honors). This guards the one surface the per-IP limiter skips —
  // the DB-write path that browned out a node before. Keyed on the token tenant.
  const rowCount = conversations.length + items.length + links.length + findings.length
    + derived.length + kgEntities.length + kgTriples.length + tombstones.length
    + dismissals.length + customRules.length + fields.length;
  (req as any).rlClass = 'ingest';          // cost-telemetry tags
  (req as any).tenant = (req as any).tenant || agent.tenant;
  const gate = await ingestGate(agent.tenant, rowCount);
  if (!gate.ok) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(gate.retryAfterMs / 1000))));
    return res.status(429).json({ error: 'ingest rate limit — retry shortly', retry_after_ms: gate.retryAfterMs });
  }

  try {
    const result = await runWithTenant(agent.tenant, async () => {
      const store = await createStore();
      const metaCache = await createMetadataCache();
      let conv = 0, item = 0, link = 0, find = 0, der = 0, kgE = 0, kgT = 0, chunks = 0, dead = 0, fielded = 0;
      let appendConv = 0, shrinkGuarded = 0;
      const fullResyncNeeded: string[] = [];
      // Accumulate chunks + item-metadata across the WHOLE batch and flush each
      // ONCE (bulk, single transaction) instead of per conversation/item — turns
      // thousands of round-trips into a handful. Chunks from different items are
      // safe to co-batch: addChunksFTS deletes per-(item) then bulk-inserts.
      const chunkBatch: Parameters<typeof store.addChunksFTS>[0] = [];
      const itemBatch: Parameters<typeof store.setItem>[0][] = [];
      // Append chunks go through a SEPARATE batch (appendChunksFTS — no per-item
      // delete) so they don't wipe the head's chunks.
      const appendChunkBatch: Parameters<typeof store.appendChunksFTS>[0] = [];
      try {
        // Tombstones first: purge + remember, and build the do-not-write set
        // so nothing in THIS payload resurrects a deleted session.
        for (const t of tombstones) {
          if (!t.session_id) continue;
          await store.purgeSession(t.session_id);
          await store.addTombstone(t.session_id);
          dead++;
        }
        const deadSet = new Set((await store.listTombstones()).map((t) => t.session_id));

        for (const cv of conversations) {
          if (!cv.session_id) continue;
          if (deadSet.has(cv.session_id)) continue; // deleted — never resurrect
          const mtime = Math.floor(Number(cv.mtime) || 0);
          const projectPath = cv.project_path || '';

          // ── APPEND path (tail-only sync, docs/SYNC-INCREMENTAL.md) ──────
          // The client shipped only the new tail. Merge the envelope + append
          // chunks WITHOUT deleting the head's chunks. Touch ONLY mtime on the
          // metadata row (title/preview/extra are head-derived; prior values
          // stand). If the server has no prior envelope, signal full_resync.
          if (cv.append) {
            // Emergency off-switch (default ON now that the continuity check
            // below makes append safe). CHAT_RECALL_TAIL_APPEND=0 disables.
            if (process.env.CHAT_RECALL_TAIL_APPEND === '0') {
              fullResyncNeeded.push(cv.session_id);
              continue;
            }
            // Need a client envelope for the tail messages.
            if (!cv.envelope || cv.envelope.v !== PARSER_VERSION || !Array.isArray(cv.envelope.messages)) {
              // No usable tail envelope → ask for full. (Shouldn't happen — the
              // client always sends an envelope on append — but be defensive.)
              fullResyncNeeded.push(cv.session_id);
              continue;
            }
            // Read the existing envelope from content_cache (stale read —
            // the stored mtime may be older than the incoming append's mtime;
            // we want the prior envelope regardless, to merge into it).
            const existing = await store.getCachedContentStale(cv.session_id, 'session');
            if (!existing || !existing.content) {
              // No prior envelope on the server (data loss, first sync, rotation)
              // → the client must FULL re-sync this session.
              fullResyncNeeded.push(cv.session_id);
              continue;
            }
            try {
              const prev = JSON.parse(existing.content) as { v: number; messages: EnvelopeMessage[]; subagents?: unknown[]; o?: number };
              // ── OFFSET-CONTINUITY GUARD (the fix that makes append safe) ──
              // The append's tail starts at byte `base_offset`. It is valid to
              // merge ONLY if our stored envelope is synced through exactly that
              // offset (`prev.o`). Any mismatch — a base truncated by an
              // interrupted full sync, a server purge, a re-ordered tick, or an
              // envelope stored before this field existed (prev.o undefined) —
              // means the tail would graft onto the wrong base. Refuse → FULL
              // re-sync. This is what the original append lacked: it trusted the
              // base was complete. (1079-msg session stored as 65 was a base at
              // a different offset than the tail expected — now caught here.)
              if (typeof prev.o !== 'number' || prev.o !== (cv.base_offset ?? -1)) {
                fullResyncNeeded.push(cv.session_id);
                continue;
              }
              const prevMsgs = Array.isArray(prev.messages) ? prev.messages : [];
              // Continue line numbers from the stored envelope's last line.
              const startLine = prevMsgs.length > 0 ? (prevMsgs[prevMsgs.length - 1].line ?? 0) : 0;
              const tailMsgs = cv.envelope.messages as EnvelopeMessage[];
              const mergedMsgs = [...prevMsgs, ...tailMsgs.map((m, i) => ({ ...m, line: startLine + i + 1 }))];
              // Advance the synced-through offset to where this tail ends.
              const merged = { v: PARSER_VERSION, messages: mergedMsgs, subagents: prev.subagents ?? [], o: cv.from_offset ?? prev.o };
              await store.setCachedContent(cv.session_id, 'session', mtime, JSON.stringify(merged));

              // Append chunks for the tail's text turns. The server owns the
              // chunk-id index: continue from MAX(existing :sync: index) + 1.
              const textSource = tailMsgs.filter((m) => m.content?.trim()).map((m) => ({ role: m.role, text: m.content! }));
              if (textSource.length > 0) {
                const maxIdx = await store.maxSyncChunkIndex(cv.session_id);
                const tailChunks = chunksFromTurns(
                  cv.session_id,
                  textSource.map((t) => ({ role: t.role as SyncTurn['role'], text: t.text })),
                  projectPath, mtime, cv.project_id || undefined,
                );
                // Re-number: shift each chunk's :sync:<i> to continue from maxIdx+1.
                for (let i = 0; i < tailChunks.length; i++) {
                  tailChunks[i].chunkId = `${cv.session_id}:sync:${maxIdx + 1 + i}`;
                }
                appendChunkBatch.push(...tailChunks);
              }

              // Touch ONLY mtime on the metadata row — title/preview/extra are
              // head-derived and must survive the append untouched.
              await store.touchSessionMtime(cv.session_id, mtime);
              appendConv++;
            } catch {
              // Merge failed (corrupt prior envelope, etc.) → ask for full.
              fullResyncNeeded.push(cv.session_id);
            }
            continue;
          }

          // ── FULL path (the existing whole-conversation ingest) ──────────
          // Raw container (highest fidelity): archive shrink-protected and
          // derive the envelope from the bytes with the canonical parser.
          // Falls back to the client envelope, then legacy turns.
          let envelope: { v: number; messages: SyncEnvelopeMessage[]; subagents: unknown[] } | null = null;
          let rawArchiveResult: 'stored' | 'shrink-protected' | 'unchanged' | null = null;
          if (cv.raw_b64) {
            try {
              const gz = Buffer.from(cv.raw_b64, 'base64');
              const container = gunzipContainer(gz);
              if (container) {
                rawArchiveResult = await store.putRawSession(cv.session_id, container.tool, mtime, gz, Number(cv.raw_size) || gz.length);
                const t = parseTranscriptFromContainer(container);
                if (t.messages.length > 0 || t.subagents.length > 0) {
                  envelope = { v: PARSER_VERSION, messages: t.messages as any, subagents: t.subagents };
                }
              }
            } catch { /* corrupt raw — derived fallbacks below still apply */ }
          }
          if (!envelope && cv.envelope && cv.envelope.v === PARSER_VERSION && Array.isArray(cv.envelope.messages)) {
            envelope = { v: PARSER_VERSION, messages: cv.envelope.messages, subagents: cv.envelope.subagents ?? [] };
          }

          // ── SHRINK GUARD (server-side defense-in-depth) ─────────────────
          // The client shadow (packages/engine/src/transcript/shadow.ts) is the
          // primary fix: it merges a resume-truncated transcript back to full
          // BEFORE shipping, so a current client never sends a shrink. But an
          // OLD client (no shadow), or one whose local shadow was wiped, can
          // still send a FULL sync carrying LESS than the server already holds —
          // the exact way the 2026-07-09 incident emptied conversations. The raw
          // archive is already shrink-protected in putRawSession; extend that to
          // the envelope + search chunks: never overwrite a fuller stored
          // conversation with a smaller one. Two-signal test (bytes shrank AND
          // fewer messages, or — when no raw was sent — a large message drop)
          // keeps false positives near zero; a genuine edit that merely re-trims
          // is not fewer messages. Best-effort: any error falls through to the
          // normal ingest, never blocking a legitimate sync.
          if (envelope) {
            try {
              const stored = await store.getCachedContentStale(cv.session_id, 'session');
              if (stored?.content) {
                const prevEnv = JSON.parse(stored.content) as { messages?: unknown[] };
                const storedCount = Array.isArray(prevEnv.messages) ? prevEnv.messages.length : 0;
                const incomingCount = envelope.messages.length;
                const bytesShrank = rawArchiveResult === 'shrink-protected';
                const suspectedShrink = incomingCount < storedCount &&
                  (bytesShrank || (rawArchiveResult === null && incomingCount * 2 < storedCount));
                if (suspectedShrink) {
                  log.warn(
                    { session: cv.session_id, storedCount, incomingCount, bytesShrank, device: agent.deviceId },
                    'shrink-guard: kept fuller stored conversation, ignored a smaller full sync (upstream in-place truncation reached a client without a shadow)',
                  );
                  shrinkGuarded++;
                  continue; // preserve stored envelope/chunks/title — write nothing
                }
              }
            } catch { /* guard is best-effort — fall through to normal ingest */ }
          }
          const turns: SyncTurn[] = envelope
            ? []
            : Array.isArray(cv.turns) && cv.turns.length > 0
              ? cv.turns
              : cv.redacted_text
                ? [{ role: 'assistant', text: cv.redacted_text }]
                : [];
          const textSource: Array<{ role: string; text: string }> = envelope
            ? envelope.messages.filter((m) => m.content?.trim()).map((m) => ({ role: m.role, text: m.content! }))
            : turns.filter((t) => t.role === 'user' || t.role === 'assistant').map((t) => ({ role: t.role, text: t.text }));
          const firstPrompt = (cv.first_prompt
            || textSource.find((t) => t.role === 'user')?.text
            || '').slice(0, 200);

          // 1. Metadata row — what recent/analytics/search enrichment read.
          await store.setItem({
            id: cv.session_id,
            sourceType: 'session' as SourceType,
            title: firstPrompt.slice(0, 100),
            projectPath,
            projectId: cv.project_id || undefined,
            contentPreview: firstPrompt,
            filePath: '',
            mtime,
            extra: {
              tool: cv.tool || 'claude',
              synced: true,
              syncedDeviceId: agent.deviceId,
              ...(cv.meta && typeof cv.meta === 'object' ? cv.meta : {}),
            },
          } as Parameters<typeof store.setItem>[0]);

          // 2. FTS chunks — what search reads (text turns only; see
          // chunksFromTurns). Replace-then-insert semantics come from
          // addChunksFTS itself (it deletes the item's rows first).
          const cks = chunksFromTurns(
            cv.session_id,
            textSource.map((t) => ({ role: t.role as SyncTurn['role'], text: t.text })),
            projectPath, mtime, cv.project_id || undefined,
          );
          // Subagent chunks — the envelope carries each subagent's (redacted,
          // trimmed) messages; index them as `subagent:<kind>` chunks so
          // recall_subagent_search can query them server-side (chunkId encodes
          // the subagent id for result rendering). MUST go in the SAME
          // addChunksFTS call as the turn chunks: addChunksFTS deletes all of an
          // item's rows first, so a second call for the same session would wipe
          // the turn chunks.
          const subagents = (envelope?.subagents ?? []) as EnvSubagent[];
          // Subagent transcripts → embed-safe windowed chunks (see
          // services/session-chunks.ts). Same call the self-heal uses.
          const subChunks = subagentChunks(cv.session_id, subagents, projectPath, mtime);
          const allChunks = subChunks.length > 0 ? [...cks, ...subChunks] : cks;
          if (allChunks.length > 0) chunkBatch.push(...allChunks);

          // 3. First-prompt cache — what the conversation list hydrates from.
          await metaCache.set({
            sessionId: cv.session_id,
            firstPrompt,
            summary: (cv.meta?.summary as string) || '',
            summarySource: ((cv.meta?.summarySource as string) || 'original') as 'original' | 'gemini' | 'claude' | 'ollama',
            mtime,
            indexedAt: Date.now(),
          });
          // Native tool title is NOT set here — it's a derived field reconciled
          // via the fields[] batch (sync-fields.ts), conversation-free.

          // 4. Conversation envelope — the complete redacted turn view
          // (text + tool calls + result snippets), NOT the raw transcript.
          // Upsert by (id, source_type): re-syncs replace any stale
          // envelope a previous ingest version left behind.
          // Record the byte offset this FULL sync is synced THROUGH (`o`) — the
          // next append validates its base against it (offset-continuity guard).
          // `cv.from_offset` is the file size at full-sync time for append-only
          // backends (0/undefined otherwise — those never append).
          const syncedOffset = typeof cv.from_offset === 'number' ? cv.from_offset : 0;
          if (envelope) {
            await store.setCachedContent(cv.session_id, 'session', mtime, JSON.stringify({ ...envelope, o: syncedOffset }));
          } else if (turns.length > 0) {
            await store.setCachedContent(
              cv.session_id, 'session', mtime,
              JSON.stringify({ v: PARSER_VERSION, messages: envelopeFromTurns(turns), subagents: [], o: syncedOffset }),
            );
          }
          conv++;
        }

        // Non-session source items (plan/task/claude_md/skill/…): metadata
        // row + FTS chunks, same write path the local indexer uses.
        for (const it of items) {
          if (!it.id || !ITEM_SOURCE_TYPES.has(it.source_type)) continue;
          const mtime = Math.floor(Number(it.mtime) || 0);
          const sourceType = it.source_type as SourceType;
          itemBatch.push({
            id: it.id,
            sourceType,
            title: (it.title || '').slice(0, 200),
            projectPath: it.project_path || '',
            projectId: it.project_id || undefined,
            contentPreview: (it.content_preview || '').slice(0, 500),
            filePath: '',
            mtime,
            extra: {
              synced: true,
              syncedDeviceId: agent.deviceId,
              ...(it.extra && typeof it.extra === 'object' ? it.extra : {}),
            },
          } as Parameters<typeof store.setItem>[0]);

          const cks = (it.chunks ?? [])
            .filter((c) => c.text?.trim())
            .map((c, i) => {
              let chunkType = c.chunk_type || sourceType;
              const cls = classifyChunk(c.text);
              if (cls.memoryType !== 'general') chunkType = `${chunkType}:${cls.memoryType}:imp${cls.importance}`;
              return {
                chunkId: `${it.id}:sync:${i}`,
                itemId: it.id,
                sourceType,
                title: c.title || it.title || '',
                text: c.text,
                chunkType,
                projectPath: it.project_path || '',
                filePath: '',
                mtime,
              };
            });
          if (cks.length > 0) chunkBatch.push(...cks);
          item++;
        }

        // Flush the whole batch's metadata + chunks ONCE (bulk, one tx each).
        if (itemBatch.length > 0) await store.setItems(itemBatch);
        if (chunkBatch.length > 0) chunks += await store.addChunksFTS(chunkBatch);
        // Append chunks (tail-only sync) — inserted WITHOUT per-item delete so
        // the head's chunks survive. Idempotent on retry (ON CONFLICT update).
        if (appendChunkBatch.length > 0) chunks += await store.appendChunksFTS(appendChunkBatch);

        // Relationship links — upsert semantics (pg ON CONFLICT) make
        // re-syncs idempotent.
        const validLinks = links.filter((l) =>
          l.source_type && l.source_id && l.target_type && l.target_id && l.link_type);
        if (validLinks.length > 0) {
          await store.addLinks(validLinks.map((l) => ({
            sourceType: l.source_type as SourceType,
            sourceId: l.source_id,
            targetType: l.target_type as SourceType,
            targetId: l.target_id,
            linkType: l.link_type as any,
            confidence: typeof l.confidence === 'number' ? l.confidence : 1.0,
          })));
          link += validLinks.length;
        }

        // Findings: group per session, replace wholesale (idempotent re-sync).
        // Drop fuzzy/low-precision rules on the way in too (defense for older
        // collectors that still ship them); CHAT_RECALL_INCLUDE_FUZZY=1 keeps them.
        const bySession = new Map<string, SyncFinding[]>();
        for (const f of dropFuzzyFindings(findings, (x) => ({ detector: x.detector, rule: x.rule }))) {
          if (!f.session_id || !f.detector || !f.rule) continue;
          (bySession.get(f.session_id) ?? bySession.set(f.session_id, []).get(f.session_id)!).push(f);
        }
        const verifiedHits: VerifiedHit[] = [];
        for (const [sessionId, fs] of bySession) {
          const r = await store.replaceSecretFindings(sessionId, fs.map((f) => ({
            detector: f.detector,
            rule: f.rule,
            line: f.line,
            preview: f.preview,
            verified: f.verified_at ? true : undefined,
          })));
          find += r.written;
          for (const f of fs) {
            if (f.verified_at && f.preview) verifiedHits.push({ sessionId, detector: f.detector, rule: f.rule, preview: f.preview });
          }
        }
        // Fire customer alerts for newly-seen verified-live secrets. Paid +
        // deduped + non-blocking — a webhook hiccup must never fail a sync.
        if (verifiedHits.length > 0) {
          try { await notifyVerifiedSecrets(agent.tenant, verifiedHits); }
          catch (e) { log.error({ err: e }, 'secret alert failed'); }
        }

        // Derived data: compute_cache rows (what the diff/outcome/commits/
        // markers routes serve via the heavy cache) + outcome-badge rows.
        // The server never recomputes these — it has no FS/git; the CLI is
        // the only producer.
        if (derived.length > 0) {
          const outcomeCache = await createOutcomeCache();
          try {
            for (const d of derived) {
              if (!d.session_id) continue;
              for (const c of d.compute ?? []) {
                if (!COMPUTE_KINDS.has(c.kind) || c.data == null) continue;
                await metaCache.setCompute(d.session_id, c.kind, Math.floor(Number(c.mtime) || 0), c.data);
                der++;
              }
              const row = d.outcome_row;
              if (row && typeof row === 'object' && typeof row.status === 'string') {
                await outcomeCache.put({
                  sessionId: d.session_id,
                  tool: String(row.tool ?? 'claude'),
                  status: row.status as any,
                  reason: String(row.reason ?? ''),
                  fileMtime: Math.floor(Number(row.fileMtime) || 0),
                  fileSize: Number(row.fileSize) || 0,
                  contentHash: String(row.contentHash ?? ''),
                  fileCount: Number(row.fileCount) || 0,
                  linesAdded: Number(row.linesAdded) || 0,
                  linesRemoved: Number(row.linesRemoved) || 0,
                  commits: Number(row.commits) || 0,
                  isFull: !!row.isFull,
                  classifiedAt: Number(row.classifiedAt) || Date.now(),
                  lastScannedOffset: Number(row.lastScannedOffset) || 0,
                });
                der++;
              }
            }
          } finally {
            await outcomeCache.close();
          }
        }

        // Knowledge graph: idempotent imports (importTriple matches expired
        // facts too, so re-syncs never duplicate).
        if (kgEntities.length > 0 || kgTriples.length > 0) {
          const kg = await createKnowledgeGraph();
          try {
            for (const e of kgEntities) {
              if (!e.name) continue;
              await kg.addEntity(e.name, e.type ?? 'unknown', e.properties ?? {});
              kgE++;
            }
            for (const t of kgTriples) {
              if (!t.subject || !t.predicate || !t.object) continue;
              if (await kg.importTriple(t) === 'inserted') kgT++;
            }
          } finally {
            await kg.close();
          }
        }

        // Secret dismissals + custom rules — small tables, upserted whole.
        for (const d of dismissals) {
          if (!d.preview || !DISMISSAL_STATUSES.has(d.status)) continue;
          await store.setSecretDismissal(d.preview, d.status as any, d.reason ?? undefined);
        }
        for (const r of customRules) {
          if (!r.name || !r.regex || !RULE_SEVERITIES.has(r.severity)) continue;
          await store.upsertSecretRule({
            name: r.name,
            regex: r.regex,
            severity: r.severity,
            description: r.description ?? undefined,
            enabled: r.enabled !== false,
          });
        }
        // Derived-field backfill: set ONE column per row (no conversation
        // re-push). Idempotent; routed by field name. Unknown fields are
        // ignored (forward-compat: a newer client may send a field this server
        // doesn't know yet). value:null clears.
        for (const fr of fields) {
          if (!fr.session_id || !fr.field) continue;
          const setter = FIELD_SETTERS[fr.field];
          if (!setter) continue;
          const v = typeof fr.value === 'string' ? fr.value.trim().slice(0, 200) : '';
          await setter(metaCache, fr.session_id, v || null);
          fielded++;
        }
      } finally {
        await metaCache.close();
        await store.close();
      }
      // Maintenance: drop unopenable ghost session rows (no envelope, no
      // chunks) — e.g. rows seeded from a stale local copy. Opt-in per POST.
      let pruned = 0;
      if (req.body?.prune_empty_sessions === true) {
        try { pruned = await store.pruneEmptySessions(); } catch { /* best-effort */ }
      }
      return { conv, item, link, find, der, kgE, kgT, chunks, dead, pruned, fielded, appendConv, shrinkGuarded, full_resync_needed: fullResyncNeeded };
    });

    res.json({ ok: true, ...result, tenant: agent.tenant, ack_at: new Date().toISOString() });
  } catch (e) {
    log.error({ err: e }, 'sync ingest error');
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    gate.release();   // free the ingest concurrency slot
  }
});

export default router;
