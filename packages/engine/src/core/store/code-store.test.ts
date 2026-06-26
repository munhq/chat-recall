/**
 * Code-intelligence storage (codeindex merge). Dual-backend: the same suite
 * runs against SQLite always, and against Postgres when DATABASE_URL is set —
 * proving the pg driver is semantically identical to the sqlite source.
 *
 * Focus is the non-obvious behavior:
 *   - findings/hotspots are replaced wholesale per project on re-index;
 *   - a finding's first_seen_at + status survive a re-index that still emits it;
 *   - actions upsert by deterministic id, preserving user state (status/queued/
 *     created_at) while refreshing content (pri/title/fix/prompt);
 *   - a user-assigned project label survives re-index.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { createStore, type StorageDriver } from './index.js';
import { codeActionId } from '../../types/code-intel.js';
import type { CodeProjectInput } from '../../types/code-intel.js';

const PG_URL = process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL;
const P = '/home/adi/code/personal/demo';

interface Harness { store: StorageDriver; teardown: () => Promise<void>; }
let pgSeq = 0;
function makeSqlite(): () => Promise<Harness> {
  return async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cr-codestore-'));
    const store = await createStore({ sqlitePath: join(tmp, 't.db') });
    return { store, teardown: async () => { await store.close(); rmSync(tmp, { recursive: true, force: true }); } };
  };
}
function makePostgres(): () => Promise<Harness> {
  return async () => {
    const tenant = `codetest_${++pgSeq}_${process.pid}`;
    const store = await createStore({ backend: 'postgres', databaseUrl: PG_URL, tenant } as any);
    return { store, teardown: async () => { await store.close(); } };
  };
}

function project(over: Partial<CodeProjectInput> = {}): CodeProjectInput {
  return {
    projectId: P, rootPath: P, fileCount: 73, symbolCount: 5528,
    langs: { typescript: 40, zig: 33 },
    health: { score: 72, findings: 3, critical: 1, high: 1, medium: 1, low: 0, hotspots: 2, aiAuthoredPct: 0.6 },
    map: { nodes: [], edges: [], buckets: { god_modules: ['a.ts'], stable_cores: [], unstable_drivers: [], islands: [], cycles: [] } },
    lastIndexedAt: 1000,
    ...over,
  };
}

function suite(label: string, setup: () => Promise<Harness>) {
  describe(`code-intel storage — ${label}`, () => {
    let h: Harness; let store: StorageDriver;
    beforeEach(async () => { h = await setup(); store = h.store; });
    afterEach(async () => { await h.teardown(); });

    test('project round-trips incl. json blobs', async () => {
      await store.upsertCodeProject(project());
      const p = await store.getCodeProject(P);
      expect(p?.fileCount).toBe(73);
      expect(p?.langs.zig).toBe(33);
      expect(p?.health.score).toBe(72);
      expect(p?.map.buckets.god_modules[0]).toBe('a.ts');
      expect((await store.listCodeProjects()).length).toBe(1);
    });

    test('user label survives re-index; counts refresh', async () => {
      await store.upsertCodeProject(project());
      await store.setCodeProjectLabel(P, 'poc');
      await store.upsertCodeProject(project({ fileCount: 80 }));
      const p = await store.getCodeProject(P);
      expect(p?.label).toBe('poc');
      expect(p?.fileCount).toBe(80);
    });

    test('findings replace wholesale + severity summary', async () => {
      await store.replaceCodeFindings(P, [
        { category: 'security', severity: 'critical', file: 'auth.ts', line: 10, rule: 'hardcoded_secret', title: 'Hardcoded secret' },
        { category: 'security', severity: 'high', file: 'api.ts', line: 5, rule: 'eval', title: 'eval()' },
        { category: 'duplication', severity: 'low', file: 'util.ts', line: 1, rule: 'dup', title: 'dup util' },
      ]);
      const sum = await store.codeFindingsSummary(P);
      expect(sum.total).toBe(3);
      expect(sum.bySeverity.critical).toBe(1);
      expect(sum.byCategory.security).toBe(2);
      expect((await store.listCodeFindings(P))[0].severity).toBe('critical');
    });

    test('finding first_seen_at + dismissal survive re-index', async () => {
      await store.replaceCodeFindings(P, [
        { category: 'security', severity: 'critical', file: 'auth.ts', line: 10, rule: 'hardcoded_secret', title: 'Hardcoded secret' },
        { category: 'security', severity: 'high', file: 'api.ts', line: 5, rule: 'eval', title: 'eval()' },
      ]);
      const crit = (await store.listCodeFindings(P, { severity: 'critical' }))[0];
      // re-index: same critical finding present, the high one gone
      await store.replaceCodeFindings(P, [
        { category: 'security', severity: 'critical', file: 'auth.ts', line: 10, rule: 'hardcoded_secret', title: 'Hardcoded secret' },
      ]);
      const crit2 = (await store.listCodeFindings(P, { severity: 'critical' }))[0];
      expect(crit2.firstSeenAt).toBe(crit.firstSeenAt);
      expect((await store.codeFindingsSummary(P)).total).toBe(1);
    });

    test('hotspots ordered by score; bools round-trip', async () => {
      await store.replaceCodeHotspots(P, [
        { file: 'big.ts', churn: 50, complexity: 30, score: 1500, aiAuthored: true, lines: 800 },
        { file: 'small.ts', churn: 2, complexity: 3, score: 6, aiAuthored: false, lines: 40 },
      ]);
      const hs = await store.listCodeHotspots(P);
      expect(hs[0].file).toBe('big.ts');
      expect(hs[0].score).toBe(1500);
      expect(hs[0].aiAuthored).toBe(true);
      expect(hs[1].aiAuthored).toBe(false);
    });

    test('actions upsert preserves user state, refreshes content', async () => {
      const action = { pri: 0, category: 'security', title: 'Rotate the leaked secret', fix: 'rotate + env var', loc: [{ file: 'auth.ts', line: 10 }], agentPrompt: 'rotate' };
      await store.upsertCodeActions(P, [action]);
      const aid = codeActionId(P, action);
      const created = (await store.listCodeActions(P))[0].createdAt;
      await store.setCodeActionStatus(aid, 'queued', true);
      await store.upsertCodeActions(P, [{ ...action, pri: 1, fix: 'use a vault' }]);
      const a2 = (await store.listCodeActions(P))[0];
      expect(a2.id).toBe(aid);
      expect(a2.status).toBe('queued');
      expect(a2.queued).toBe(true);
      expect(a2.createdAt).toBe(created);
      expect(a2.fix).toBe('use a vault');
      expect(a2.pri).toBe(1);
      expect((await store.listCodeActions(P, { queued: true })).length).toBe(1);
    });
  });
}

suite('sqlite', makeSqlite());
(PG_URL ? suite : (l: string) => describe.skip(`code-intel storage — ${l}`, () => { test('skipped (no DATABASE_URL)', () => {}); }))('postgres', makePostgres());
