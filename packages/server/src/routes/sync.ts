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
  createKnowledgeGraph, runWithTenant, runWithAuthor, classifyChunk,
  gunzipContainer, gzipContainer, mergeContainer, parseTranscriptFromContainer,
} from '../imports.js';
import type { SourceType } from '../imports.js';
import type { StorageDriver } from '@chat-recall/engine/core/store/driver.js';
import type { MemoryItem, MemoryChunk } from '@chat-recall/engine/types/memory.js';
import type { IngestBatch, IngestSessionMeta } from '@chat-recall/engine/core/store/ingest-batch.js';
import { dropFuzzyFindings } from '@chat-recall/engine/core/secret-precision.js';
import { isEntitled, syncAdmission, recordSyncUsage, recordSyncPresence } from '../util/billing.js';
import { notifyVerifiedSecrets, type VerifiedHit } from '../services/notify.js';
import { ingestGate } from '../middleware/rate-limit.js';
import { tenantIngestConcurrency } from '../middleware/rate-limit.js';
import { chunksFromTurns, subagentChunks, type EnvSubagent } from '../services/session-chunks.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';
import { growth } from '../util/growth.js';

const log = createLogger('sync');


/** What ingestConversation needs. Named, rather than closed over. */
interface ConvContext {
  store: StorageDriver;
  agent: { tenant: string; deviceId: string };
  /** Sessions tombstoned in this request — never resurrect one. */
  deadSet: Set<string>;
  /** Prefetched for the whole batch, so the loop makes no database call. */
  priorContent: Map<string, { content: string; mtime: number }>;
  priorChunkIdx: Map<string, number>;
  priorArchive: Map<string, { size: number; mtime: number; project_id: string }>;
  /** Appended to, never written — the handler flushes the batch once. */
  itemBatch: MemoryItem[];
  chunkBatch: MemoryChunk[];
  appendChunkBatch: MemoryChunk[];
  cachedContentBatch: NonNullable<IngestBatch['cachedContent']>;
  sessionMetaBatch: IngestSessionMeta[];
  touchBatch: NonNullable<IngestBatch['touchMtime']>;
  /** Sessions the client must re-send in full, returned in the response. */
  fullResyncNeeded: string[];
  /** Full syncs the shrink guard refused, with the offset the stored copy is
   *  synced through, returned in the response. */
  shrinkGuardedIds: Array<{ session_id: string; o: number | null }>;
  tally: { conv: number; appendConv: number; shrinkGuarded: number };
}

/**
 * Everything one conversation contributes to the batch.
 *
 * Extracted from the request handler, which ran as a single 588-line closure
 * with this 274-line loop body in the middle. The logic is unchanged: what it
 * used to reach out of scope for is named in `ctx`, and the counters it
 * incremented are in `tally`. The eight `continue`s that skipped to the next
 * conversation are `return`s — every one of them was at the top level of that
 * loop, so the translation is exact.
 *
 * It APPENDS to the batch arrays and writes nothing. The handler hands the
 * whole batch to the store once. See docs/SYNC-BATCH-WRITES.md §4.
 */
async function ingestConversation(cv: SyncConversation, ctx: ConvContext): Promise<void> {
  const {
    store, agent, deadSet, priorContent, priorChunkIdx, priorArchive,
    itemBatch, chunkBatch, appendChunkBatch, cachedContentBatch, sessionMetaBatch,
    touchBatch, fullResyncNeeded, shrinkGuardedIds, tally,
  } = ctx;
    if (!cv.session_id) return;
    if (deadSet.has(cv.session_id)) return; // deleted — never resurrect
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
        return;
      }
      // Need a client envelope for the tail messages.
      if (!cv.envelope || cv.envelope.v !== PARSER_VERSION || !Array.isArray(cv.envelope.messages)) {
        // No usable tail envelope → ask for full. (Shouldn't happen — the
        // client always sends an envelope on append — but be defensive.)
        fullResyncNeeded.push(cv.session_id);
        return;
      }
      // Read the existing envelope from content_cache (stale read —
      // the stored mtime may be older than the incoming append's mtime;
      // we want the prior envelope regardless, to merge into it).
      const existing = priorContent.get(cv.session_id) ?? null;
      if (!existing || !existing.content) {
        // No prior envelope on the server (data loss, first sync, rotation)
        // → the client must FULL re-sync this session.
        fullResyncNeeded.push(cv.session_id);
        return;
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
          return;
        }
        const prevMsgs = Array.isArray(prev.messages) ? prev.messages : [];
        // Continue line numbers from the stored envelope's last line.
        const startLine = prevMsgs.length > 0 ? (prevMsgs[prevMsgs.length - 1].line ?? 0) : 0;
        const tailMsgs = cv.envelope.messages as EnvelopeMessage[];
        const mergedMsgs = [...prevMsgs, ...tailMsgs.map((m, i) => ({ ...m, line: startLine + i + 1 }))];
        // Advance the synced-through offset to where this tail ends.
        const merged = { v: PARSER_VERSION, messages: mergedMsgs, subagents: prev.subagents ?? [], o: cv.from_offset ?? prev.o };
        cachedContentBatch.push({ id: cv.session_id, sourceType: 'session', mtime, content: JSON.stringify(merged) });

        // Append chunks for the tail's text turns. The server owns the
        // chunk-id index: continue from MAX(existing :sync: index) + 1.
        const textSource = tailMsgs.filter((m) => m.content?.trim()).map((m) => ({ role: m.role, text: m.content! }));
        if (textSource.length > 0) {
          const maxIdx = priorChunkIdx.get(cv.session_id) ?? 0;
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
        touchBatch.push({ sessionId: cv.session_id, mtime });
        tally.appendConv++;
      } catch {
        // Merge failed (corrupt prior envelope, etc.) → ask for full.
        fullResyncNeeded.push(cv.session_id);
      }
      return;
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
          // The archive metadata came with the batch's prefetch, so this
          // no longer reads per session — `?? null` says "prefetched, and
          // there is no row", which is what stops it reading again.
          rawArchiveResult = await store.putRawSession(cv.session_id, container.tool, mtime, gz, Number(cv.raw_size) || gz.length, cv.project_id || '', projectPath, priorArchive.get(cv.session_id) ?? null);

          // ── Smaller is not the same as stale ────────────────────────
          // The shrink guard exists to survive a resume-truncated file,
          // and for that it is exactly right. But it decides on SIZE, and
          // size cannot tell a truncation from a DISJOINT FRAGMENT: a
          // second device, or a session resumed under another profile,
          // legitimately holds records this archive has never seen while
          // being smaller overall. Rejecting those loses them silently —
          // the client has already moved on, and nothing ever retries.
          //
          // So on a rejection, merge by RECORD (the same union the client
          // shadow uses) and re-store only if the result actually grew.
          // Truncation still cannot shrink the archive: a strict subset
          // merges back to the stored container and is a no-op.
          if (rawArchiveResult === 'shrink-protected') {
            try {
              const prior = await store.getRawSession(cv.session_id);
              const priorContainer = prior?.gz ? gunzipContainer(prior.gz) : null;
              if (priorContainer) {
                const merged = mergeContainer(priorContainer, container);
                const { gz: mergedGz, size: mergedSize } = gzipContainer(merged.container);
                if (mergedSize > Number(prior!.size)) {
                  rawArchiveResult = await store.putRawSession(
                    cv.session_id, merged.container.tool, mtime, mergedGz, mergedSize,
                    cv.project_id || '', projectPath,
                  );
                  log.info(
                    { session: cv.session_id, priorSize: Number(prior!.size), incoming: Number(cv.raw_size) || gz.length, mergedSize },
                    'raw archive: merged a disjoint fragment that the shrink guard would have dropped',
                  );
                }
              }
            } catch (err) {
              // A failed merge must leave the stored archive exactly as it
              // was — the fragment is lost either way, but the history is not.
              log.warn({ err, session: cv.session_id }, 'raw archive fragment merge failed; kept the stored copy');
            }
          }
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
        const stored = priorContent.get(cv.session_id) ?? null;
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
            tally.shrinkGuarded++;
            // Tell the client where the stored copy is synced through. A
            // chunked session's head is always smaller than the stored
            // conversation, and without this offset its appends never match.
            const storedO = (prevEnv as { o?: unknown }).o;
            shrinkGuardedIds.push({ session_id: cv.session_id, o: typeof storedO === 'number' ? storedO : null });
            return; // preserve stored envelope/chunks/title — write nothing
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
    // Collected, not written — setItems flushes the batch after the loop.
    itemBatch.push({
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
      projectPath, mtime, cv.project_id || undefined, firstPrompt,
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
    sessionMetaBatch.push({
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
    // Collected, not written — flushed in one statement after the loop.
    if (envelope) {
      cachedContentBatch.push({ id: cv.session_id, sourceType: 'session', mtime, content: JSON.stringify({ ...envelope, o: syncedOffset }) });
    } else if (turns.length > 0) {
      cachedContentBatch.push({
        id: cv.session_id, sourceType: 'session', mtime,
        content: JSON.stringify({ v: PARSER_VERSION, messages: envelopeFromTurns(turns), subagents: [], o: syncedOffset }),
      });
    }
    tally.conv++;
}

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

/** Derived-field router: field name → the ingest-batch rows its value becomes.
 *  The client scans these locally (engine core/sync-fields.ts) and ships them
 *  via the fields[] batch, conversation-free. Add a field in BOTH places. */
const FIELD_SETTERS: Record<string, (batch: IngestBatch, sessionId: string, value: string | null) => void> = {
  tool_title: (batch, sessionId, title) => { (batch.toolTitles ??= []).push({ sessionId, title }); },
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
  let agent: { tenant: string; deviceId: string; userSub: string | null } | null;
  if (m) {
    const cp = await createControlPlane();
    try { agent = await cp.resolveAgentToken(m[1]); }
    finally { await cp.close(); }
    if (!agent) return res.status(401).json({ error: 'invalid agent token' });
  } else if ((process.env.AUTH_PROVIDER || 'none').toLowerCase() === 'none') {
    agent = { tenant: 'default', deviceId: 'local', userSub: null };
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

  // Entitlement + free-tier meters. This route authenticates its own device
  // token and never passed through requireEntitlement, so before this check a
  // lapsed tenant's CLI could push forever — "syncs pause" was enforced nowhere.
  // syncAdmission answers with the canonical 402 payloads (quota, storage cap,
  // unconfirmed email) so the CLI relays the same sentence the dashboard shows.
  // Wire size, not a re-serialization: stringifying a 20 MB parsed batch just
  // to measure it blocks the event loop for the whole copy, per request, on
  // the hottest path in the product. Content-Length is the bytes the client
  // actually sent; the stringify stays only as the fallback for the rare
  // caller that streams without the header.
  const declaredBytes = Number(req.get('content-length'));
  const batchBytes = Number.isFinite(declaredBytes) && declaredBytes > 0
    ? declaredBytes
    : Buffer.byteLength(JSON.stringify(req.body ?? {}));
  const admission = await syncAdmission(agent.tenant, batchBytes);
  if (!admission.ok) {
    // Release the concurrency slot ingestGate just acquired: this return runs
    // BEFORE the try/finally below, so without it four refused batches from one
    // over-quota tenant exhaust the global ingest semaphore for good.
    gate.release();
    // A refused batch still counts as PRESENCE: the retention sweep must be
    // able to tell a free tenant whose syncs are refused (over cap — data is
    // promised kept) from one who left. A zero-byte row marks the month
    // without consuming quota.
    try { await recordSyncPresence(agent.tenant); } catch { /* best effort */ }
    return res.status(admission.status).json(admission.body);
  }

  try {
    const result = await runWithTenant(agent.tenant, () => runWithAuthor({ sub: agent!.userSub, device: agent!.deviceId }, async () => {
      const store = await createStore();
      const metaCache = await createMetadataCache();

      // COLLECTOR PROGRESS. The web UI could only show an AGE ("25m behind"),
      // which during a first sync is indistinguishable from broken — and a first
      // sync on a large corpus runs for a long time. The collector already
      // computes walk progress for its own surfaces (doctor, the MCP banner);
      // carrying it on the sync body is what lets the UI answer "is this working
      // or is it stuck?" without a new endpoint or a schema change.
      //
      // Stored in the existing kv_store, which is already tenant-scoped by RLS,
      // and stamped with a server timestamp: a client that dies mid-walk stops
      // updating this, and a reader that sees a stale `at` treats the walk as
      // gone rather than eternally in progress.
      const prog = req.body?.progress;
      if (prog && typeof prog === 'object'
          && typeof prog.done === 'number' && typeof prog.total === 'number') {
        try {
          await store.kvSet('collector', 'walk_progress', JSON.stringify({
            done: Math.max(0, Math.floor(prog.done)),
            total: Math.max(0, Math.floor(prog.total)),
            complete: prog.complete === true,
            at: Date.now(),
          }));
        } catch { /* progress is cosmetic — never fail an ingest over it */ }
      }
      let conv = 0, item = 0, link = 0, find = 0, der = 0, kgE = 0, kgT = 0, chunks = 0, dead = 0, fielded = 0;
      let appendConv = 0, shrinkGuarded = 0;
      const fullResyncNeeded: string[] = [];
      const shrinkGuardedIds: Array<{ session_id: string; o: number | null }> = [];
      // Accumulate chunks + item-metadata across the WHOLE batch and flush each
      // ONCE (bulk, single transaction) instead of per conversation/item — turns
      // thousands of round-trips into a handful. Chunks from different items are
      // safe to co-batch: addChunksFTS deletes per-(item) then bulk-inserts.
      const chunkBatch: Parameters<typeof store.addChunksFTS>[0] = [];
      const itemBatch: Parameters<typeof store.setItem>[0][] = [];
      // Append chunks go through a SEPARATE batch (appendChunksFTS — no per-item
      // delete) so they don't wipe the head's chunks.
      const appendChunkBatch: Parameters<typeof store.appendChunksFTS>[0] = [];
      // Cached content, collected in the conversation loop and flushed once —
      // it was a round trip per session. See docs/SYNC-BATCH-WRITES.md §4.
      const cachedContentBatch: Array<{ id: string; sourceType: string; mtime: number; content: string }> = [];
      const sessionMetaBatch: Parameters<typeof metaCache.set>[0][] = [];
      const touchBatch: Array<{ sessionId: string; mtime: number }> = [];
      const computeBatch: Array<{ sessionId: string; kind: string; mtime: number; data: unknown }> = [];
      // Rows for the tables outside the memory store: outcome badges, tool
      // titles and the knowledge graph. They go into the same write as the rest.
      // Each was written through its own driver, on a connection of its own
      // that committed at once, so a request that failed after them kept them.
      const sideBatch: IngestBatch = {};
      // Verified secrets to alert on once the ingest has committed.
      const verifiedHits: VerifiedHit[] = [];
      try {
        // ONE transaction for the whole ingest. Tenant scoping is a
        // transaction-local GUC that RLS reads, so every store call outside a
        // transaction opened its own: measured on this route, 6 transactions and
        // 40 round trips for a push, 25 of them BEGIN, COMMIT and set_config, and
        // 6 PgBouncer checkouts from a pool of 20 shared by every tenant.
        //
        // It also gives the prefetches and the write one snapshot. The chunk-id
        // cursor was read in its own transaction and used in a later one, so two
        // devices pushing the same session between them both got the same cursor
        // and the second overwrote the first’s chunks.
        await store.withTransaction(async () => {
          // Tombstones first: purge + remember, and build the do-not-write set
          // so nothing in THIS payload resurrects a deleted session.
          // The whole set goes in one call each — purgeSession costs 12
          // statements, so a per-tombstone loop put 650 round trips at the top of
          // a request this file holds to 15 (docs/SYNC-BATCH-WRITES.md §4).
          const tombIds = tombstones.map((t) => t.session_id).filter(Boolean);
          if (tombIds.length > 0) {
            await store.purgeSessionsMany(tombIds);
            await store.addTombstonesMany(tombIds);
            dead += tombIds.length;
          }
          // Only this payload's sessions are ever asked about, so only they are
          // read. The tombstones written just above are already committed, so a
          // session deleted and re-sent in the SAME request still reads as dead.
          const deadSet = await store.tombstonedAmong(conversations.map((c) => c.session_id));

          // PREFETCHED, before the loop. Both of these were read once per session
          // inside it — `getCachedContentStale` twice. One query each for the
          // whole batch. See docs/SYNC-BATCH-WRITES.md §4.
          const convIds = conversations.map((c) => c.session_id).filter(Boolean);
          const priorContent = await store.getCachedContentStaleMany('session', convIds);
          const priorChunkIdx = await store.maxSyncChunkIndexMany(convIds);
          const priorArchive = await store.rawSessionMetaMany(convIds);

          const tally = { conv: 0, appendConv: 0, shrinkGuarded: 0 };
          for (const cv of conversations) {
            await ingestConversation(cv, {
              store, agent: { tenant: agent.tenant, deviceId: agent.deviceId },
              deadSet, priorContent, priorChunkIdx, priorArchive,
              itemBatch, chunkBatch, appendChunkBatch, cachedContentBatch,
              sessionMetaBatch, touchBatch, fullResyncNeeded, shrinkGuardedIds, tally,
            });
          }
          conv += tally.conv; appendConv += tally.appendConv; shrinkGuarded += tally.shrinkGuarded;

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

          // NOTHING IS WRITTEN YET. Collection continues to the end of this
          // handler and the whole batch goes to the database in one call, in one
          // transaction — see docs/SYNC-BATCH-WRITES.md §4.

          // Relationship links — upsert semantics make re-syncs idempotent.
          const validLinks = links.filter((l) =>
            l.source_type && l.source_id && l.target_type && l.target_id && l.link_type);
          const linkBatch = validLinks.map((l) => ({
            sourceType: l.source_type as SourceType,
            sourceId: l.source_id,
            targetType: l.target_type as SourceType,
            targetId: l.target_id,
            linkType: l.link_type as any,
            confidence: typeof l.confidence === 'number' ? l.confidence : 1.0,
          }));
          link += validLinks.length;

          // Findings: group per session, replace wholesale (idempotent re-sync).
          // Drop fuzzy/low-precision rules on the way in too (defense for older
          // collectors that still ship them); CHAT_RECALL_INCLUDE_FUZZY=1 keeps them.
          const bySession = new Map<string, SyncFinding[]>();
          for (const f of dropFuzzyFindings(findings, (x) => ({ detector: x.detector, rule: x.rule }))) {
            if (!f.session_id || !f.detector || !f.rule) continue;
            (bySession.get(f.session_id) ?? bySession.set(f.session_id, []).get(f.session_id)!).push(f);
          }
          // One existence query for every session carrying a finding, and one
          // write for all of them — it was two round trips per session.
          // See docs/SYNC-BATCH-WRITES.md §4.
          const findingSessions = [...bySession.keys()];
          // A session counts as present if it is ALREADY stored or is being
          // written by this very batch. The second half matters now that nothing
          // is written until the end: checking the database alone would drop
          // every finding belonging to a session in this request.
          const haveMetadata = findingSessions.length
            ? await store.existingItemIds('session', findingSessions)
            : new Set<string>();
          for (const it of itemBatch) if (it.sourceType === 'session') haveMetadata.add(it.id);
          const findingBatch: Array<{ sessionId: string; findings: Array<{ detector: string; rule: string; line: number; preview: string; verified?: boolean }> }> = [];

          for (const [sessionId, fs] of bySession) {
            // AN ORPHAN FINDING MUST NOT 500 THE WHOLE BATCH.
            //
            // `findings` is a top-level array keyed by session_id, independent of
            // the conversations in this request — so a collector can ship a
            // finding for a session whose metadata row was never uploaded (an
            // excluded project, a session the walk skipped). secret_findings
            // carries the RESTRICTIVE `author_visibility` policy whose USING needs
            // a VISIBLE memory_metadata session row, and PostgreSQL applies that
            // USING as the WITH CHECK of an `INSERT … ON CONFLICT`, so the write
            // fails with 42501 and takes the entire ingest request with it. Seen in
            // production: four findings blocked a sync that had otherwise landed.
            //
            // A finding is meaningless without its session, so skipping it is the
            // right answer rather than elevating the write — secret_findings DOES
            // carry an author-write-guard (see pg-schema.ts), and elevating would
            // bypass it. Logged, never silent.
            if (!haveMetadata.has(sessionId)) {
              log.warn({ sessionId, findings: fs.length },
                'skipping secret findings for a session with no metadata row on this server');
              continue;
            }
            findingBatch.push({
              sessionId,
              findings: fs.map((f) => ({
                detector: f.detector,
                rule: f.rule,
                line: f.line,
                preview: f.preview,
                verified: f.verified_at ? true : undefined,
              })),
            });
            for (const f of fs) {
              if (f.verified_at && f.preview) verifiedHits.push({ sessionId, detector: f.detector, rule: f.rule, preview: f.preview });
            }
          }

          // Derived data: compute_cache rows (what the diff/outcome/commits/
          // markers routes serve via the heavy cache) + outcome-badge rows.
          // The server never recomputes these — it has no FS/git; the CLI is
          // the only producer.
          for (const d of derived) {
            if (!d.session_id) continue;
            for (const c of d.compute ?? []) {
              if (!COMPUTE_KINDS.has(c.kind) || c.data == null) continue;
              // Collected — one statement for the whole batch below.
              computeBatch.push({ sessionId: d.session_id, kind: c.kind, mtime: Math.floor(Number(c.mtime) || 0), data: c.data });
            }
            const row = d.outcome_row;
            if (row && typeof row === 'object' && typeof row.status === 'string') {
              (sideBatch.outcomes ??= []).push({
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

          // Knowledge graph: idempotent imports (importTriple matches expired
          // facts too, so re-syncs never duplicate). One import for the whole
          // set: each importTriple is four sequential round trips, so a sync
          // carrying 5905 triples issued ~23600 queries in a row while holding a
          // pooled connection — long enough for the pooler to time the request
          // out at its 120s ceiling.
          for (const e of kgEntities) {
            if (!e.name) continue;
            (sideBatch.kgEntities ??= []).push({ name: e.name, type: e.type ?? 'unknown', properties: e.properties ?? {} });
            kgE++;
          }
          const usableTriples = kgTriples.filter((t) => t.subject && t.predicate && t.object);
          if (usableTriples.length) sideBatch.kgTriples = usableTriples;

          // Derived-field backfill: set ONE column per row (no conversation
          // re-push). Idempotent; routed by field name. Unknown fields are
          // ignored (forward-compat: a newer client may send a field this server
          // doesn't know yet). value:null clears.
          for (const fr of fields) {
            if (!fr.session_id || !fr.field) continue;
            const setter = FIELD_SETTERS[fr.field];
            if (!setter) continue;
            const v = typeof fr.value === 'string' ? fr.value.trim().slice(0, 200) : '';
            setter(sideBatch, fr.session_id, v || null);
            fielded++;
          }

          // ── THE WRITE ───────────────────────────────────────────────────────
          // Everything above collected; nothing above touched the database except
          // the tombstone purge and three batch reads. One call, one transaction,
          // one connection, a fixed number of statements — whatever the batch
          // size.
          // docs/SYNC-BATCH-WRITES.md §4.
          const written = await store.writeIngestBatch({
            items: itemBatch,
            chunks: chunkBatch,
            appendChunks: appendChunkBatch,
            cachedContent: cachedContentBatch,
            sessionMeta: sessionMetaBatch,
            touchMtime: touchBatch,
            compute: computeBatch,
            findings: findingBatch,
            links: linkBatch,
            ...sideBatch,
          }, metaCache, { outcomes: () => createOutcomeCache(), knowledgeGraph: () => createKnowledgeGraph() });
          chunks += written.chunks;
          find += written.findings;
          der += written.computeOffered;
          kgT += written.kgTriplesInserted;

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
        });
      } finally {
        await metaCache.close();
        await store.close();
      }
      // Customer alerts for newly-seen verified-live secrets, once the findings
      // they name are committed. The alert posts a webhook and marks the secret
      // alerted on a connection of its own. Inside the transaction it alerted on
      // findings that a failed request then rolled back, and it held the
      // transaction open for the length of the webhook call. Paid and deduped;
      // a webhook failure never fails the sync.
      if (verifiedHits.length > 0) {
        try { await notifyVerifiedSecrets(agent.tenant, verifiedHits); }
        catch (e) { log.error({ err: e }, 'secret alert failed'); }
      }
      // Maintenance: drop unopenable ghost session rows (no envelope, no
      // chunks) — e.g. rows seeded from a stale local copy. Opt-in per POST.
      let pruned = 0;
      if (req.body?.prune_empty_sessions === true) {
        try { pruned = await store.pruneEmptySessions(); } catch { /* best-effort */ }
      }
      return { conv, item, link, find, der, kgE, kgT, chunks, dead, pruned, fielded, appendConv, shrinkGuarded, full_resync_needed: fullResyncNeeded, shrink_guarded: shrinkGuardedIds };
    }));

    const { cliRelease } = await import('../util/cli-release.js');
    // Meter AFTER the write: a batch the server failed to store consumes no
    // quota. Never let the meter fail the sync that already succeeded.
    try { await recordSyncUsage(agent.tenant, batchBytes); }
    catch (err) { log.warn(`sync usage record failed for ${agent.tenant}: ${err instanceof Error ? err.message : String(err)}`); }
    // TELL THE CLIENT WHETHER IT MAY REPORT TELEMETRY. It cannot know its own
    // plan — the entitlement lives in the control plane — so it is told here, on
    // a response it already parses, and defaults to NOT eligible when an older
    // server says nothing. The client ALSO honours the user's own opt-out, which
    // this cannot override.
    let telemetry = false;
    try { telemetry = await isEntitled(agent.tenant); } catch { telemetry = false; }
    // THE TENANT'S OWN ingest allowance, not the class ceiling.
    // /api/capabilities is pre-auth so it cannot know the plan, and the ceiling
    // it advertises is scaled down per tenant by the gate. A free tenant told
    // "6" asks for 6 and has 5 shed — the exact 429 storm the advertisement
    // exists to prevent. This response is authenticated, so it can be right.
    let ingestConcurrency: number | undefined;
    try { ingestConcurrency = await tenantIngestConcurrency(agent.tenant); } catch { /* client keeps its default */ }
    // activate — it worked. The only one of the three that predicts whether a
    // tenant stays: an install that never syncs is a signup that never used the
    // product.
    //
    // oncePerDay is NOT optional here. Measured in production: clients hit this
    // route ~51 times an hour for a single tenant, which is ~1,200 identical rows
    // a day for a fact that only needs to be "this tenant activated". Funnel
    // queries count DISTINCT tenant, so the duplicates were harmless and the
    // volume was not.
    growth('activate', { tenant: agent.tenant, oncePerDay: true });
    res.json({
      ok: true, ...result, tenant: agent.tenant, ack_at: new Date().toISOString(),
      cli: cliRelease(), telemetry,
      ...(ingestConcurrency ? { limits: { ingestConcurrencyPerTenant: ingestConcurrency } } : {}),
    });
  } catch (e) {
    log.error({ err: e }, 'sync ingest error');
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    gate.release();   // free the ingest concurrency slot
  }
});

export default router;
