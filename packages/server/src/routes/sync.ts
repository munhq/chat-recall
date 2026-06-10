/**
 * /api/sync — the one ingestion surface the local binary calls.
 *
 * Replaces cloud/server.mjs's blob-into-a-table approach with a real
 * server-side index: every uploaded conversation is chunked, classified,
 * and written through the SAME engine stores the dashboard reads
 * (memory_metadata + FTS chunks + session_metadata + content_cache), so
 * search / recent / conversation view / analytics work on synced data
 * with no separate read path.
 *
 * Auth: agent (device) bearer token only — resolved here, NOT by the
 * tenantAuth middleware, because the nested runWithTenant() below must
 * scope the writes to the token's tenant regardless of what the outer
 * middleware resolved.
 *
 * Payload (from packages/cli/src/sync-client.ts):
 *   conversations: [{
 *     session_id, tool, project_path,        // path may be sha-hashed client-side
 *     redacted_text,                         // legacy single-blob (kept for compat)
 *     turns?: [{ role, text, ts? }],         // structured + per-turn redacted
 *     first_prompt?, mtime,
 *     meta?: { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
 *              modelsUsed, costUsd, durationMs, messageCount }
 *   }],
 *   findings: [{ session_id, detector, rule, line, preview, verified_at? }]
 *
 * Everything in the payload was redacted client-side (`redactSecrets` with
 * force:true) before it hit the wire; the server never sees raw secrets.
 */

import express from 'express';
import {
  createControlPlane, createStore, createMetadataCache, runWithTenant, classifyChunk,
} from '../imports.js';
import type { SourceType } from '../imports.js';

const router = express.Router();

interface SyncTurn { role: 'user' | 'assistant'; text: string; ts?: number }
interface SyncConversation {
  session_id: string;
  tool?: string;
  project_path?: string;
  redacted_text?: string;
  turns?: SyncTurn[];
  first_prompt?: string;
  mtime?: number;
  meta?: Record<string, unknown>;
}
interface SyncFinding {
  session_id: string;
  detector: string;
  rule: string;
  line: number;
  preview: string;
  verified_at?: string | null;
}

/** Chunk a conversation's turns for FTS. Mirrors the local chunker's
 *  granularity goal (search hits land on a turn, not a 140KB blob) without
 *  needing the full SessionContent machinery. */
function chunksFromTurns(
  sessionId: string,
  turns: SyncTurn[],
  projectPath: string,
  mtime: number,
): Array<{ chunkId: string; itemId: string; sourceType: SourceType; title: string; text: string; chunkType: string; projectPath: string; filePath: string; mtime: number }> {
  const MAX_CHARS = 2000;
  const out: ReturnType<typeof chunksFromTurns> = [];
  let i = 0;
  for (const t of turns) {
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
        filePath: '',
        mtime,
      });
    }
  }
  return out;
}

/** The {v, messages} envelope the conversations/:id route serves from
 *  content_cache — version must match its PARSER_VERSION. */
const PARSER_VERSION = 5;

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

  const conversations = (Array.isArray(req.body?.conversations) ? req.body.conversations : []) as SyncConversation[];
  const findings = (Array.isArray(req.body?.findings) ? req.body.findings : []) as SyncFinding[];

  try {
    const result = await runWithTenant(agent.tenant, async () => {
      const store = await createStore();
      const metaCache = await createMetadataCache();
      let conv = 0, find = 0, chunks = 0;
      try {
        for (const cv of conversations) {
          if (!cv.session_id) continue;
          const mtime = Math.floor(Number(cv.mtime) || 0);
          const projectPath = cv.project_path || '';
          const turns: SyncTurn[] = Array.isArray(cv.turns) && cv.turns.length > 0
            ? cv.turns
            : cv.redacted_text
              ? [{ role: 'assistant', text: cv.redacted_text }]
              : [];
          const firstPrompt = (cv.first_prompt
            || turns.find((t) => t.role === 'user')?.text
            || '').slice(0, 200);

          // 1. Metadata row — what recent/analytics/search enrichment read.
          await store.setItem({
            id: cv.session_id,
            sourceType: 'session' as SourceType,
            title: firstPrompt.slice(0, 100),
            projectPath,
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

          // 2. FTS chunks — what search reads. Replace-then-insert semantics
          // come from addChunksFTS itself (it deletes the item's rows first).
          const cks = chunksFromTurns(cv.session_id, turns, projectPath, mtime);
          if (cks.length > 0) chunks += await store.addChunksFTS(cks);

          // 3. First-prompt cache — what the conversation list hydrates from.
          await metaCache.set({
            sessionId: cv.session_id,
            firstPrompt,
            summary: '',
            summarySource: 'original',
            mtime,
            indexedAt: Date.now(),
          });

          // 4. Parsed-messages envelope — what conversations/:id serves.
          if (turns.length > 0) {
            const messages = turns.map((t, idx) => ({
              line: idx + 1,
              role: t.role,
              content: t.text,
              timestamp: t.ts ? new Date(t.ts).toISOString() : undefined,
            }));
            await store.setCachedContent(
              cv.session_id, 'session', mtime,
              JSON.stringify({ v: PARSER_VERSION, messages, subagents: [] }),
            );
          }
          conv++;
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
      } finally {
        await metaCache.close();
        await store.close();
      }
      return { conv, find, chunks };
    });

    res.json({ ok: true, ...result, tenant: agent.tenant, ack_at: new Date().toISOString() });
  } catch (e) {
    console.error('sync ingest error:', e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
