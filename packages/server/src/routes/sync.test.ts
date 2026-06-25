/**
 * Ingest pipeline test: a device token minted through the control plane
 * authorizes POST /api/sync; the uploaded conversation becomes visible to
 * the SAME stores the dashboard reads — metadata row, FTS chunks, first
 * prompt cache, and the parsed-messages envelope behind conversations/:id.
 *
 * Runs against an isolated CHAT_RECALL_DATA_DIR (sqlite backend) so it
 * never touches the developer's real index.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
let prevDataDir: string | undefined;
let prevAuth: string | undefined;

beforeAll(() => {
  prevDataDir = process.env.CHAT_RECALL_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'cr-sync-test-'));
  process.env.CHAT_RECALL_DATA_DIR = dataDir;
  // Default these tests to an auth-REQUIRED mode so "no token → 401" holds.
  // (Agent ct_ tokens authorize in every mode.) The self-host none-mode path,
  // which accepts a tokenless push, has its own dedicated test below.
  prevAuth = process.env.AUTH_PROVIDER;
  process.env.AUTH_PROVIDER = 'keycloak';
});

afterAll(() => {
  if (prevDataDir === undefined) delete process.env.CHAT_RECALL_DATA_DIR;
  else process.env.CHAT_RECALL_DATA_DIR = prevDataDir;
  if (prevAuth === undefined) delete process.env.AUTH_PROVIDER;
  else process.env.AUTH_PROVIDER = prevAuth;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('POST /api/sync (ingest)', () => {
  test('rejects without a token, ingests with one, and the stores see the data', async () => {
    // Import AFTER the env override so paths.ts resolves the temp dir.
    const { createControlPlane, createStore, createMetadataCache } = await import('../imports.js');
    const syncRouter = (await import('./sync.js')).default;

    const app = express();
    app.use(express.json({ limit: '16mb' }));
    app.use('/api/sync', syncRouter);

    // No token → 401.
    const unauth = await request(app).post('/api/sync').send({ conversations: [] });
    expect(unauth.status).toBe(401);

    // Mint a device token.
    const cp = await createControlPlane();
    const token = await cp.mintAgentToken('default', 'test-laptop');
    await cp.close();
    expect(token).toMatch(/^ct_/);

    // Garbage token → 401.
    const bad = await request(app)
      .post('/api/sync')
      .set('authorization', 'Bearer ct_nope')
      .send({ conversations: [] });
    expect(bad.status).toBe(401);

    const sessionId = '00000000-1111-2222-3333-444444444444';
    const mtime = 1750000000000;
    const res = await request(app)
      .post('/api/sync')
      .set('authorization', `Bearer ${token}`)
      .send({
        conversations: [{
          session_id: sessionId,
          tool: 'claude',
          project_path: 'p_abcdef123456',
          mtime,
          first_prompt: 'fix the flux capacitor in zorbofrang mode',
          turns: [
            { role: 'user', text: 'fix the flux capacitor in zorbofrang mode', ts: mtime - 1000 },
            { role: 'assistant', text: 'Decided: we will replace the zorbofrang coil entirely.', ts: mtime },
          ],
          meta: { inputTokens: 1000, outputTokens: 200, modelsUsed: ['claude-sonnet-4-6'], summary: 'Replaced the zorbofrang coil and shipped.', summarySource: 'gemini' },
        }],
        findings: [
          { session_id: sessionId, detector: 'gitleaks', rule: 'aws-key', line: 3, preview: '****QVGY' },
        ],
        items: [{
          id: 'plan-test-1',
          source_type: 'plan',
          title: 'Test plan',
          project_path: 'p_abcdef123456',
          content_preview: 'Ship the flux capacitor',
          mtime,
          chunks: [{ text: 'Step 1: replace the zorbofrang coil', chunk_type: 'plan_section' }],
        }],
        links: [{
          source_type: 'plan', source_id: 'plan-test-1',
          target_type: 'session', target_id: sessionId,
          link_type: 'plan_for_session', confidence: 1,
        }],
        derived: [{
          session_id: sessionId,
          mtime,
          compute: [{ kind: 'markers', mtime, data: { sessionId, prompts: [], summary: { total: 0 } } }],
          outcome_row: { tool: 'claude', status: 'completed', reason: 'test', fileMtime: mtime, isFull: true },
        }],
        kg_entities: [{ name: 'zorbofrang', type: 'tool' }],
        kg_triples: [{ subject: 'project', predicate: 'uses', object: 'zorbofrang' }],
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.conv).toBe(1);
    expect(res.body.find).toBe(1);
    expect(res.body.item).toBe(1);
    expect(res.body.link).toBe(1);
    expect(res.body.der).toBe(2);
    expect(res.body.kgE).toBe(1);
    expect(res.body.kgT).toBe(1);
    expect(res.body.chunks).toBeGreaterThan(0);

    // 1. Metadata row exists with the synced telemetry.
    const store = await createStore();
    const item = await store.getItem(sessionId, 'session');
    expect(item).not.toBeNull();
    const extra = JSON.parse(item!.extra_json);
    expect(extra.synced).toBe(true);
    expect(extra.inputTokens).toBe(1000);

    // 2. FTS search finds the conversation by a turn's content.
    const hits = await store.searchFTS('zorbofrang', { topK: 5 });
    expect(hits.some(h => h.itemId === sessionId)).toBe(true);

    // 3. The parsed-messages envelope serves the viewer.
    // The conversation envelope is rebuilt server-side from the redacted
    // turn stream (the RAW transcript still never ships) — see
    // sync-parity.test.ts for the full fidelity contract.
    const cached = await store.getCachedContent(sessionId, 'session', mtime);
    expect(cached).not.toBeNull();
    const envelope = JSON.parse(cached!);
    expect(envelope.v).toBe(6);
    expect(envelope.messages).toHaveLength(2);
    const chunks = await store.listChunksByItem('session', sessionId);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].chunk_type.startsWith('user')).toBe(true);
    expect(chunks[1].text).toContain('zorbofrang coil');

    const planItem = await store.getItem('plan-test-1', 'plan');
    expect(planItem).not.toBeNull();
    const planChunks = await store.listChunksByItem('plan', 'plan-test-1');
    expect(planChunks).toHaveLength(1);
    const links = await store.getLinksFrom('plan', 'plan-test-1');
    expect(links).toHaveLength(1);
    expect(links[0].target_id).toBe(sessionId);

    // 4. Secret finding landed (masked preview only).
    const findings = await store.secretFindingsForSession(sessionId);
    expect(findings).toHaveLength(1);
    expect(findings[0].preview).toBe('****QVGY');
    await store.close();

    // 5. First-prompt cache hydrates the list, and the shipped AI summary is
    // stored (so /api/conversations/:id/metadata serves it to recall_summary).
    const cache = await createMetadataCache();
    const row = await cache.get(sessionId);
    expect(row?.firstPrompt).toContain('flux capacitor');
    expect(row?.summary).toBe('Replaced the zorbofrang coil and shipped.');
    expect(row?.summarySource).toBe('gemini');
    await cache.close();

    // 6. The /metadata service attaches the synced summary (the actual path
    // recall_summary / recall_smart_resume read — computeMetadataResponse
    // alone drops it, so this guards that regression).
    const { getSessionMetadata } = await import('../services/sessions.js');
    const md = await getSessionMetadata(sessionId);
    expect(md?.summary).toBe('Replaced the zorbofrang coil and shipped.');
  });

  test('tombstones purge a session everywhere and make it resurrection-proof', async () => {
    const { createControlPlane, createStore } = await import('../imports.js');
    const syncRouter = (await import('./sync.js')).default;
    const app = express();
    app.use(express.json({ limit: '16mb' }));
    app.use('/api/sync', syncRouter);
    const cp = await createControlPlane();
    const token = await cp.mintAgentToken('default', 'tombstone-test');
    await cp.close();

    const sessionId = '99999999-aaaa-bbbb-cccc-dddddddddddd';
    const mtime = 1750000500000;
    const conv = { session_id: sessionId, tool: 'claude', project_path: '/tmp/ts', mtime,
      envelope: { v: 6, messages: [{ line: 1, role: 'user', content: 'delete me later' }], subagents: [] } };

    // Seed it.
    let res = await request(app).post('/api/sync').set('authorization', `Bearer ${token}`)
      .send({ conversations: [conv] });
    expect(res.body.conv).toBe(1);
    const store = await createStore();
    expect(await store.getItem(sessionId, 'session')).not.toBeNull();

    // Tombstone it — purged everywhere.
    res = await request(app).post('/api/sync').set('authorization', `Bearer ${token}`)
      .send({ tombstones: [{ session_id: sessionId }] });
    expect(res.body.dead).toBe(1);
    expect(await store.getItem(sessionId, 'session')).toBeNull();
    expect(await store.getCachedContent(sessionId, 'session', mtime)).toBeNull();
    expect(await store.listChunksByItem('session', sessionId)).toHaveLength(0);

    // Resurrection attempt (stale client re-ships it) — refused.
    res = await request(app).post('/api/sync').set('authorization', `Bearer ${token}`)
      .send({ conversations: [conv] });
    expect(res.status).toBe(200);
    expect(await store.getItem(sessionId, 'session')).toBeNull();
    await store.close();
  });

  test('self-host none-mode accepts a TOKENLESS push as the default tenant', async () => {
    const prev = process.env.AUTH_PROVIDER;
    process.env.AUTH_PROVIDER = 'none';
    try {
      const { createStore } = await import('../imports.js');
      const syncRouter = (await import('./sync.js')).default;
      const app = express();
      app.use(express.json({ limit: '16mb' }));
      app.use('/api/sync', syncRouter);

      const sessionId = '11112222-3333-4444-5555-666677778888';
      const mtime = 1750001000000;
      // No Authorization header at all.
      const res = await request(app).post('/api/sync').send({
        conversations: [{
          session_id: sessionId, tool: 'claude', project_path: '/tmp/local', mtime,
          turns: [{ role: 'user', text: 'tokenless localhost ingest works', ts: mtime }],
        }],
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.tenant).toBe('default');
      expect(res.body.conv).toBe(1);

      const store = await createStore();
      expect(await store.getItem(sessionId, 'session')).not.toBeNull();
      await store.close();
    } finally {
      if (prev === undefined) delete process.env.AUTH_PROVIDER;
      else process.env.AUTH_PROVIDER = prev;
    }
  });

  // ── Tail-only append sync (docs/SYNC-INCREMENTAL.md) ──────────────────
  test('append:true merges the envelope, continues chunk ids, preserves head title/telemetry', async () => {
    const { createControlPlane, createStore, createMetadataCache } = await import('../imports.js');
    const syncRouter = (await import('./sync.js')).default;
    const app = express();
    app.use(express.json({ limit: '16mb' }));
    app.use('/api/sync', syncRouter);

    const cp = await createControlPlane();
    const token = await cp.mintAgentToken('default', 'append-test');
    await cp.close();

    const sessionId = 'aaaa0000-bbbb-cccc-dddd-eeeeeeeeeeee';
    const headMtime = 1750100000000;
    // 1. FULL seed: two head turns + a title + telemetry.
    let res = await request(app).post('/api/sync').set('authorization', `Bearer ${token}`)
      .send({
        conversations: [{
          session_id: sessionId, tool: 'claude', project_path: '/tmp/app', mtime: headMtime,
          first_prompt: 'set up the framis module',
          envelope: { v: 6, messages: [
            { line: 1, role: 'user', content: 'set up the framis module' },
            { line: 2, role: 'assistant', content: 'Created src/framis.ts with the init function.' },
          ], subagents: [] },
          meta: { inputTokens: 500, outputTokens: 100, modelsUsed: ['claude-sonnet-4-6'] },
        }],
      });
    expect(res.status).toBe(200);
    expect(res.body.conv).toBe(1);

    const store = await createStore();
    // Head state: 2 chunks, title = first prompt, telemetry in extra.
    let chunks = await store.listChunksByItem('session', sessionId);
    expect(chunks).toHaveLength(2);
    let item = await store.getItem(sessionId, 'session');
    expect(item?.title).toContain('framis module');
    expect(JSON.parse(item!.extra_json).inputTokens).toBe(500);
    let cached = await store.getCachedContentStale(sessionId, 'session');
    expect(cached).not.toBeNull();
    const headEnv = JSON.parse(cached!.content);
    expect(headEnv.messages).toHaveLength(2);

    // 2. APPEND: two new tail turns. No title, no meta, no raw_b64 — the
    //    append payload omits head-derived fields (the server keeps priors).
    const tailMtime = 1750100060000;
    res = await request(app).post('/api/sync').set('authorization', `Bearer ${token}`)
      .send({
        conversations: [{
          session_id: sessionId, tool: 'claude', project_path: '/tmp/app', mtime: tailMtime,
          append: true, from_offset: 9999,
          envelope: { v: 6, messages: [
            { line: 3, role: 'user', content: 'now add tests for framis' },
            { line: 4, role: 'assistant', content: 'Added framis.test.ts covering init and edge cases.' },
          ], subagents: [] },
        }],
      });
    expect(res.status).toBe(200);
    expect(res.body.appendConv).toBe(1);
    expect(res.body.full_resync_needed ?? []).not.toContain(sessionId);

    // 3. Envelope merged: 4 messages, lines continue 1..4.
    cached = await store.getCachedContentStale(sessionId, 'session');
    const mergedEnv = JSON.parse(cached!.content);
    expect(mergedEnv.messages).toHaveLength(4);
    expect(mergedEnv.messages[2].content).toContain('add tests for framis');
    expect(mergedEnv.messages[3].content).toContain('framis.test.ts');

    // 4. Chunks: head's 2 chunks SURVIVED + 2 new tail chunks appended.
    //    chunk ids continue from MAX(head :sync: index)+1 (no collision).
    chunks = await store.listChunksByItem('session', sessionId);
    expect(chunks).toHaveLength(4);
    const syncIdxs = chunks.map(c => { const m = /:sync:(\d+)$/.exec(c.chunk_id); return m ? Number(m[1]) : 0; });
    expect(Math.min(...syncIdxs)).toBeGreaterThanOrEqual(0);
    // No duplicate chunk ids.
    const ids = new Set(chunks.map(c => c.chunk_id));
    expect(ids.size).toBe(4);
    // Tail chunks are findable in FTS.
    const tailHits = await store.searchFTS('framis.test.ts', { topK: 5 });
    expect(tailHits.some(h => h.itemId === sessionId)).toBe(true);

    // 5. Title + telemetry PRESERVED from the head (append touched only mtime).
    item = await store.getItem(sessionId, 'session');
    expect(item?.title).toContain('framis module');       // head title, not clobbered
    expect(JSON.parse(item!.extra_json).inputTokens).toBe(500); // head telemetry
    expect(item?.mtime).toBe(tailMtime);                  // mtime advanced

    await store.close();
  });

  test('append:true with no prior envelope → full_resync_needed, no data written', async () => {
    const { createControlPlane, createStore } = await import('../imports.js');
    const syncRouter = (await import('./sync.js')).default;
    const app = express();
    app.use(express.json({ limit: '16mb' }));
    app.use('/api/sync', syncRouter);

    const cp = await createControlPlane();
    const token = await cp.mintAgentToken('default', 'append-missing');
    await cp.close();

    const sessionId = 'bbbb1111-cccc-dddd-eeee-ffffffffffff';
    // APPEND with NO prior FULL sync → server has no envelope → full_resync_needed.
    const res = await request(app).post('/api/sync').set('authorization', `Bearer ${token}`)
      .send({
        conversations: [{
          session_id: sessionId, tool: 'claude', project_path: '/tmp/miss', mtime: 1750200000000,
          append: true, from_offset: 100,
          envelope: { v: 6, messages: [{ line: 1, role: 'user', content: 'tail with no head' }], subagents: [] },
        }],
      });
    expect(res.status).toBe(200);
    expect(res.body.full_resync_needed).toContain(sessionId);
    expect(res.body.appendConv).toBe(0);

    // Nothing was written — no chunks, no envelope, no metadata.
    const store = await createStore();
    expect(await store.listChunksByItem('session', sessionId)).toHaveLength(0);
    expect(await store.getCachedContentStale(sessionId, 'session')).toBeNull();
    expect(await store.getItem(sessionId, 'session')).toBeNull();
    await store.close();
  });

  test('full_resync_needed then FULL re-seed lands the data (the recovery flow)', async () => {
    const { createControlPlane, createStore } = await import('../imports.js');
    const syncRouter = (await import('./sync.js')).default;
    const app = express();
    app.use(express.json({ limit: '16mb' }));
    app.use('/api/sync', syncRouter);

    const cp = await createControlPlane();
    const token = await cp.mintAgentToken('default', 'resync-flow');
    await cp.close();

    const sessionId = 'cccc2222-dddd-0000-1111-222233334444';
    // 1. APPEND with no prior envelope → full_resync_needed.
    let res = await request(app).post('/api/sync').set('authorization', `Bearer ${token}`)
      .send({ conversations: [{
        session_id: sessionId, tool: 'claude', project_path: '/tmp/rs', mtime: 1750300000000,
        append: true, from_offset: 50,
        envelope: { v: 6, messages: [{ line: 1, role: 'user', content: 'tail' }], subagents: [] },
      }] });
    expect(res.body.full_resync_needed).toContain(sessionId);

    // 2. Client wipes its ledger row → next tick sends FULL.
    res = await request(app).post('/api/sync').set('authorization', `Bearer ${token}`)
      .send({ conversations: [{
        session_id: sessionId, tool: 'claude', project_path: '/tmp/rs', mtime: 1750300000000,
        first_prompt: 'recovered full sync',
        envelope: { v: 6, messages: [
          { line: 1, role: 'user', content: 'recovered full sync' },
          { line: 2, role: 'assistant', content: 'back online' },
        ], subagents: [] },
      }] });
    expect(res.body.conv).toBe(1);

    // 3. Data landed — the session is now on the server.
    const store = await createStore();
    const item = await store.getItem(sessionId, 'session');
    expect(item?.title).toContain('recovered full sync');
    const chunks = await store.listChunksByItem('session', sessionId);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    await store.close();
  });
});
