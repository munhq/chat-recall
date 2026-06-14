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

/** Chunk a conversation's turns for FTS. Mirrors the local chunker's
 *  granularity goal (search hits land on a turn, not a 140KB blob) without
 *  needing the full SessionContent machinery. */
function chunksFromTurns(
  sessionId: string,
  turns: SyncTurn[],
  projectPath: string,
  mtime: number,
  projectId?: string,
): Array<{ chunkId: string; itemId: string; sourceType: SourceType; title: string; text: string; chunkType: string; projectPath: string; projectId?: string; filePath: string; mtime: number }> {
  const MAX_CHARS = 2000;
  const out: ReturnType<typeof chunksFromTurns> = [];
  let i = 0;
  for (const t of turns) {
    // Text turns only — 545 Bash outputs in the FTS table would bury the
    // conversational content in every search ranking. Tool turns are
    // served from the conversation envelope instead.
    if (t.role !== 'user' && t.role !== 'assistant') continue;
    if (!t.text?.trim()) continue;
    // Split very long turns so a single wall-of-text doesn't dominate BM25.
    for (let off = 0; off < t.text.length; off += MAX_CHARS) {
      const text = t.text.slice(off, off + MAX_CHARS);
      let chunkType = t.role === 'user' ? 'user_context' : 'assistant';
      const cls = classifyChunk(text);
      if (cls.memoryType !== 'general') chunkType = `${chunkType}:${cls.memoryType}:imp${cls.importance}`;
      out.push({
        chunkId: `${sessionId}:sync:${i++}`,
        itemId: sessionId,
        sourceType: 'session' as SourceType,
        title: '',
        text,
        chunkType,
        projectPath,
        projectId,
        filePath: '',
        mtime,
      });
    }
  }
  return out;
}

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
  const m = /^Bearer\s+(.+)$/.exec(req.get('authorization') || '');
  if (!m) return res.status(401).json({ error: 'agent token required' });
  const cp = await createControlPlane();
  let agent: { tenant: string; deviceId: string } | null;
  try { agent = await cp.resolveAgentToken(m[1]); }
  finally { await cp.close(); }
  if (!agent) return res.status(401).json({ error: 'invalid agent token' });

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

  try {
    const result = await runWithTenant(agent.tenant, async () => {
      const store = await createStore();
      const metaCache = await createMetadataCache();
      let conv = 0, item = 0, link = 0, find = 0, der = 0, kgE = 0, kgT = 0, chunks = 0, dead = 0;
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
          // Raw container (highest fidelity): archive shrink-protected and
          // derive the envelope from the bytes with the canonical parser.
          // Falls back to the client envelope, then legacy turns.
          let envelope: { v: number; messages: SyncEnvelopeMessage[]; subagents: unknown[] } | null = null;
          if (cv.raw_b64) {
            try {
              const gz = Buffer.from(cv.raw_b64, 'base64');
              const container = gunzipContainer(gz);
              if (container) {
                await store.putRawSession(cv.session_id, container.tool, mtime, gz, Number(cv.raw_size) || gz.length);
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
          if (cks.length > 0) chunks += await store.addChunksFTS(cks);

          // 3. First-prompt cache — what the conversation list hydrates from.
          await metaCache.set({
            sessionId: cv.session_id,
            firstPrompt,
            summary: (cv.meta?.summary as string) || '',
            summarySource: ((cv.meta?.summarySource as string) || 'original') as 'original' | 'gemini' | 'claude' | 'ollama',
            mtime,
            indexedAt: Date.now(),
          });

          // 4. Conversation envelope — the complete redacted turn view
          // (text + tool calls + result snippets), NOT the raw transcript.
          // Upsert by (id, source_type): re-syncs replace any stale
          // envelope a previous ingest version left behind.
          if (envelope) {
            await store.setCachedContent(cv.session_id, 'session', mtime, JSON.stringify(envelope));
          } else if (turns.length > 0) {
            await store.setCachedContent(
              cv.session_id, 'session', mtime,
              JSON.stringify({ v: PARSER_VERSION, messages: envelopeFromTurns(turns), subagents: [] }),
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
          await store.setItem({
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
          if (cks.length > 0) chunks += await store.addChunksFTS(cks);
          item++;
        }

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
        const bySession = new Map<string, SyncFinding[]>();
        for (const f of findings) {
          if (!f.session_id || !f.detector || !f.rule) continue;
          (bySession.get(f.session_id) ?? bySession.set(f.session_id, []).get(f.session_id)!).push(f);
        }
        for (const [sessionId, fs] of bySession) {
          const r = await store.replaceSecretFindings(sessionId, fs.map((f) => ({
            detector: f.detector,
            rule: f.rule,
            line: f.line,
            preview: f.preview,
            verified: f.verified_at ? true : undefined,
          })));
          find += r.written;
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
      return { conv, item, link, find, der, kgE, kgT, chunks, dead, pruned };
    });

    res.json({ ok: true, ...result, tenant: agent.tenant, ack_at: new Date().toISOString() });
  } catch (e) {
    console.error('sync ingest error:', e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
