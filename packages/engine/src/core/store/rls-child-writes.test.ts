/**
 * RLS, ENFORCED — writing a session-keyed child row before its parent exists.
 *
 * ── The production failure ────────────────────────────────────────────────
 * A user's first sync to the hosted service failed on every batch with
 *
 *   HTTP 500 {"error":"new row violates row-level security policy
 *             \"author_visibility\" for table \"compute_cache\""}
 *
 * and the same for `raw_sessions` and `secret_findings`. All three carry a
 * RESTRICTIVE `author_visibility` policy declared `FOR SELECT`, whose USING
 * requires a VISIBLE `memory_metadata` session row. PostgreSQL applies a SELECT
 * policy's USING as the WITH CHECK of an `INSERT … ON CONFLICT DO UPDATE` — the
 * resulting row must still be visible to the writer — so a child row written
 * before its parent fails with SQLSTATE 42501, and the whole ingest request 500s.
 *
 * The ingest cannot simply write the parent first: the raw archive's bytes are
 * parsed into the envelope whose first prompt becomes the metadata row's title,
 * so the archive write genuinely comes first.
 *
 * ── Why no existing test could catch it ───────────────────────────────────
 * THIS is the reason it reached production. Every Postgres-backed test connects
 * as the role in DATABASE_URL, and in the Docker Compose stack (self-host, and
 * the compose-integration CI job) that role is the container's bootstrap
 * superuser:
 *
 *     chat_recall  super=true  bypassrls=true
 *
 * PostgreSQL bypasses row-level security entirely for a superuser or a role with
 * BYPASSRLS — FORCE ROW LEVEL SECURITY does not change that. So the whole suite,
 * and the end-to-end compose job, ran with RLS switched off, and no test in the
 * repository was capable of failing on an RLS defect. Production runs as
 * `super=false bypassrls=false`, which is where every one of these surfaced.
 *
 * So this file creates its own NON-SUPERUSER role and connects as that.
 * vitest.global-setup.ts now does the same for every Postgres test.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { createStore } from './index.js';
import { createMetadataCache, createOutcomeCache } from './caches.js';
import { runWithAuthor } from './tenant-context.js';
import { pgAdminUrl } from '../../test-support/pg-urls.js';

const PG_URL = process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL;

/** A login role with neither SUPERUSER nor BYPASSRLS, so policies apply. */
const PROBE_ROLE = 'rls_probe_test';
const PROBE_PASSWORD = 'rls_probe_test_pw';

let probeUrl = '';
let admin: any;

/** The same URL with the probe role's credentials swapped in. */
function withRole(url: string, user: string, password: string): string {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
}

beforeAll(async () => {
  if (!PG_URL) return;
  const pg = (await import('pg')).default;
  admin = new pg.Pool({ connectionString: pgAdminUrl(), max: 2 });
  // The schema must exist before privileges are granted on it.
  const bootstrap = await createStore({ backend: 'postgres', databaseUrl: PG_URL, tenant: 'rls_bootstrap' } as any);
  await bootstrap.close();
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${PROBE_ROLE}') THEN
      CREATE ROLE ${PROBE_ROLE} LOGIN PASSWORD '${PROBE_PASSWORD}';
    END IF;
  END $$;`);
  // NOSUPERUSER / NOBYPASSRLS are the point of this role — state them explicitly
  // rather than relying on the CREATE ROLE defaults.
  await admin.query(`ALTER ROLE ${PROBE_ROLE} NOSUPERUSER NOBYPASSRLS`);
  // CREATE as well as USAGE: createStore() runs its idempotent schema check on
  // connect, exactly as the production app role does, and PostgreSQL 15 stopped
  // granting CREATE on `public` to PUBLIC. Without it the store fails with
  // "permission denied for schema public" before RLS is ever reached.
  await admin.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${PROBE_ROLE}`);
  await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${PROBE_ROLE}`);
  await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${PROBE_ROLE}`);
  // MIRROR PRODUCTION EXACTLY: there the app connects as the role that OWNS the
  // tables, and that role is NOT a superuser. The schema check runs ALTER TABLE
  // (… FORCE ROW LEVEL SECURITY), which requires ownership. Granting membership
  // in the owner role confers ownership privileges WITHOUT conferring SUPERUSER
  // or BYPASSRLS — those are role ATTRIBUTES and are never inherited through
  // membership, which is the property that keeps this probe honest. The role
  // in DATABASE_URL is that owner: vitest.global-setup.ts made it so.
  const owner = decodeURIComponent(new URL(PG_URL).username);
  await admin.query(`GRANT "${owner}" TO ${PROBE_ROLE}`);
  probeUrl = withRole(PG_URL, PROBE_ROLE, PROBE_PASSWORD);
});

afterAll(async () => {
  await admin?.end();
});

/** Skips cleanly when there is no Postgres — the sqlite driver has no RLS. */
const pgTest = PG_URL ? test : test.skip;

describe('a session-keyed child row written before its parent', () => {
  pgTest('the probe role really does have RLS applied to it', async () => {
    const r = await admin.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=$1`, [PROBE_ROLE]);
    // If this ever reports true, every assertion below becomes vacuous — which
    // is precisely how the production bug survived a green suite.
    expect(r.rows[0].rolsuper).toBe(false);
    expect(r.rows[0].rolbypassrls).toBe(false);
  });

  pgTest('raw_sessions accepts the archive before the metadata row exists', async () => {
    const tenant = `rls_raw_${process.pid}`;
    const store = await createStore({ backend: 'postgres', databaseUrl: probeUrl, tenant } as any);
    try {
      // A NAMED author, which is what a real device-token sync runs as. With the
      // viewer set to a sub (not the '*' worker sentinel) the RESTRICTIVE policy
      // is live, and no memory_metadata row exists yet for this session.
      await runWithAuthor({ sub: 'sub-under-test', device: 'dev-1' }, async () => {
        const res = await store.putRawSession(
          'sess-child-first', 'claude', 1_700_000_000_000,
          Buffer.from([0x1f, 0x8b, 0x00]), 3, 'proj', '/proj');
        expect(res).toBe('stored');
      });
    } finally {
      await store.close();
    }
  });

  pgTest('compute_cache accepts a derived row before the metadata row exists', async () => {
    const tenant = `rls_compute_${process.pid}`;
    // `backend: 'postgres'` is NOT optional here. Without it resolveBackend()
    // falls back to sqlite, which has no row-level security at all — so this
    // test passed identically with and without the fix, proving nothing. That is
    // the same shape of false green as the superuser problem this file exists to
    // end, so it is stated rather than just corrected.
    const cache = await createMetadataCache({ backend: 'postgres', databaseUrl: probeUrl, tenant } as any);
    try {
      await runWithAuthor({ sub: 'sub-under-test', device: 'dev-1' }, async () => {
        // Throws 42501 before the fix; the assertion is that it does not.
        await cache.setCompute('sess-derived-first', 'markers', 1, { prompts: ['a'] });
      });
      const back = await cache.getCompute('sess-derived-first', 'markers', 1);
      expect(back).toEqual({ prompts: ['a'] });
    } finally {
      await cache.close();
    }
  });

  pgTest('session_outcome_cache accepts an outcome before the metadata row exists', async () => {
    // The one missed when raw_sessions and compute_cache were fixed — a user hit
    // it on the very next sync. Same policy, same mechanism, different table.
    const tenant = `rls_outcome_${process.pid}`;
    const oc = await createOutcomeCache({ backend: 'postgres', databaseUrl: probeUrl, tenant } as any);
    try {
      await runWithAuthor({ sub: 'sub-under-test', device: 'dev-1' }, async () => {
        await oc.put({
          sessionId: 'sess-outcome-first', tool: 'claude', status: 'shipped', reason: 'test',
          fileMtime: 1, fileSize: 1, contentHash: 'h', fileCount: 1,
          linesAdded: 1, linesRemoved: 0, commits: 0, isFull: true, lastScannedOffset: 0,
        } as any);
      });
      expect((await oc.get('sess-outcome-first'))?.status).toBe('shipped');
    } finally {
      await oc.close();
    }
  });

  pgTest('the two write-GUARDED children accept a row before their parent too', async () => {
    // secret_findings and session_metadata cannot be fixed by elevating the
    // write — they carry an author-write-guard, and the '*' viewer would bypass
    // it. They get the escape that already makes diary_entries immune: your own
    // row is visible to you. Both threw 42501 before that change.
    const tenant = `rls_guarded_${process.pid}`;
    const store = await createStore({ backend: 'postgres', databaseUrl: probeUrl, tenant } as any);
    const cache = await createMetadataCache({ backend: 'postgres', databaseUrl: probeUrl, tenant } as any);
    try {
      await runWithAuthor({ sub: 'guarded-author', device: 'd1' }, async () => {
        await cache.set({ sessionId: 'sm-orphan', firstPrompt: 'no parent row yet', summary: 's', summarySource: 'test', mtime: 1, indexedAt: 1 } as any);
        await store.replaceSecretFindings('sf-orphan', [
          { detector: 'd', rule: 'r', line: 1, preview: 'p' } as any,
        ]);
      });
    } finally {
      await cache.close();
      await store.close();
    }
  });

  pgTest('and the author escape does NOT let another member read them', async () => {
    // The escape is `author_sub = viewer`. If it were wider than that, this is
    // where it shows.
    const tenant = `rls_guarded_read_${process.pid}`;
    const store = await createStore({ backend: 'postgres', databaseUrl: probeUrl, tenant } as any);
    try {
      await runWithAuthor({ sub: 'author-one', device: 'd1' }, () =>
        store.replaceSecretFindings('sf-private', [
          { detector: 'd', rule: 'r', line: 7, preview: 'secret-ish' } as any,
        ]));
      const mine = await runWithAuthor({ sub: 'author-one', device: 'd1' },
        () => store.secretFindingsSummary());
      expect(mine.totals.length).toBeGreaterThan(0);
      const theirs = await runWithAuthor({ sub: 'author-two', device: 'd2' },
        () => store.secretFindingsSummary());
      expect(theirs.totals).toEqual([]);
    } finally {
      await store.close();
    }
  });

  // EVERY session-keyed child, enumerated from the schema rather than listed by
  // hand. pg-schema.ts attaches `author_visibility` to exactly these five, and
  // the fix was applied to two of them, then three — this asserts the set is
  // covered so a fourth omission is a red test rather than a user's failed sync.
  pgTest('every table with this policy is accounted for', async () => {
    // The vulnerable shape is a policy gated PURELY on the parent session, with
    // no `author_sub = viewer` escape. `diary_entries` and `kg_triples` also
    // reference a session but allow their own author through, so a writer can
    // always see their own row and the upsert never fail-closes — they are
    // deliberately excluded by the `author_sub` condition below rather than by
    // being left off a hand-written list.
    // Gated PURELY on the parent — no author escape. These three MUST have an
    // elevated write, and each is asserted above.
    const parentOnly = (await admin.query(`
      SELECT tablename FROM pg_policies
       WHERE policyname='author_visibility' AND cmd='SELECT'
         AND qual LIKE '%.session_id%'
         AND qual NOT LIKE '%author_sub%'
       ORDER BY tablename`)).rows.map((r: { tablename: string }) => r.tablename);
    expect(parentOnly).toEqual(['compute_cache', 'raw_sessions', 'session_outcome_cache']);

    // Session-keyed AND author-aware: safe without elevating, because a writer
    // always sees their own row. The two write-guarded tables moved here.
    const authorAware = (await admin.query(`
      SELECT tablename FROM pg_policies
       WHERE policyname='author_visibility' AND cmd='SELECT'
         AND qual LIKE '%.session_id%'
         AND qual LIKE '%author_sub%'
       ORDER BY tablename`)).rows.map((r: { tablename: string }) => r.tablename);
    expect(authorAware).toEqual(['diary_entries', 'secret_findings', 'session_metadata']);
    // Of those five: three are elevated at the write (they carry no
    // author-write-guard) and are asserted above; session_metadata and
    // secret_findings DO carry a guard, so elevating them would bypass it — they
    // are written after their parent instead, and the ingest route additionally
    // skips an orphan finding rather than failing the batch.
    //
    // If this list grows, the new table needs one of those two treatments. The
    // fix was shipped for two of the five and a user hit the third on the next
    // sync; this assertion is what makes a fourth omission a red test.
  });

  pgTest('the sync ingest writes a batch inside its one transaction, stamped with its author', async () => {
    // The shape of POST /api/sync since the ingest became one transaction:
    // withTransaction() opens a pinned client whose app.viewer is the member's
    // sub, and writeIngestBatch() runs on it. Production failed every sync this
    // way, for every tenant:
    //   new row violates row-level security policy "author_write_insert" for table "memory_metadata"
    //   new row violates row-level security policy "author_visibility" for table "memory_links"
    const tenant = `rls_ingest_${process.pid}`;
    const store = await createStore({ backend: 'postgres', databaseUrl: probeUrl, tenant } as any);
    try {
      await runWithAuthor({ sub: 'ingest-author', device: 'dev-1' }, () => store.withTransaction(async () => {
        await store.writeIngestBatch({
          items: [{
            id: 'sess-ingest', sourceType: 'session', title: 'ingest',
            projectPath: '/home/user/code/example', projectId: 'example-app',
            filePath: '', mtime: 1, contentPreview: 'first prompt',
          }],
          chunks: [{
            chunkId: 'sess-ingest_user_0', itemId: 'sess-ingest', sourceType: 'session', title: 'ingest',
            text: 'first prompt', chunkType: 'user', projectPath: '/home/user/code/example',
            projectId: 'example-app', filePath: '', mtime: 1,
          } as any],
          sessionMeta: [{ sessionId: 'sess-ingest', firstPrompt: 'first prompt', summary: '', summarySource: 'original', mtime: 1, indexedAt: 1 } as any],
          compute: [{ sessionId: 'sess-ingest', kind: 'markers', mtime: 1, data: { prompts: ['a'] } }],
          findings: [{ sessionId: 'sess-ingest', findings: [{ detector: 'd', rule: 'r', line: 1, preview: 'p' }] }],
          // The target is not in this batch and not visible to the writer.
          links: [{ sourceType: 'session', sourceId: 'sess-ingest', targetType: 'plan', targetId: 'plan-elsewhere', linkType: 'session_plan', confidence: 1 } as any],
        });
      }));
      const authors = (await admin.query(
        `SELECT 'memory_metadata' AS t, author_sub FROM memory_metadata WHERE tenant=$1
         UNION ALL SELECT 'memory_chunks', author_sub FROM memory_chunks WHERE tenant=$1
         UNION ALL SELECT 'session_metadata', author_sub FROM session_metadata WHERE tenant=$1
         UNION ALL SELECT 'secret_findings', author_sub FROM secret_findings WHERE tenant=$1
         ORDER BY 1`, [tenant])).rows;
      expect(authors).toEqual([
        { t: 'memory_chunks', author_sub: 'ingest-author' },
        { t: 'memory_metadata', author_sub: 'ingest-author' },
        { t: 'secret_findings', author_sub: 'ingest-author' },
        { t: 'session_metadata', author_sub: 'ingest-author' },
      ]);
      const links = await admin.query(`SELECT count(*)::int AS n FROM memory_links WHERE tenant=$1`, [tenant]);
      expect(links.rows[0].n).toBe(1);
    } finally {
      await store.close();
    }
  });

  pgTest('an append sync claims a session that self-heal recreated with no author', async () => {
    // Self-heal recreates a lost metadata row from its archive, and the archive
    // records no author, so the row has author_sub NULL. The next append sync
    // from its owner only touches the mtime. Production failed that with
    //   new row violates row-level security policy "author_write_update" for table "memory_metadata"
    const tenant = `rls_touch_${process.pid}`;
    const store = await createStore({ backend: 'postgres', databaseUrl: probeUrl, tenant } as any);
    try {
      await store.setItem({ id: 'sess-healed', sourceType: 'session', title: 'healed', projectPath: '/p', projectId: 'p', filePath: '', mtime: 1, contentPreview: 'x' });
      await store.setItem({ id: 'sess-healed-2', sourceType: 'session', title: 'healed', projectPath: '/p', projectId: 'p', filePath: '', mtime: 1, contentPreview: 'x' });
      await store.setItem({ id: 'sess-healed-3', sourceType: 'session', title: 'healed', projectPath: '/p', projectId: 'p', filePath: '', mtime: 1, contentPreview: 'x' });
      const nulls = await admin.query(`SELECT count(*)::int AS n FROM memory_metadata WHERE tenant=$1 AND author_sub IS NULL`, [tenant]);
      expect(nulls.rows[0].n).toBe(3);

      await runWithAuthor({ sub: 'touch-author', device: 'dev-1' }, async () => {
        await store.withTransaction(() => store.writeIngestBatch({ touchMtime: [{ sessionId: 'sess-healed', mtime: 2 }] }));
        await store.touchSessionMtime('sess-healed-2', 2);
        expect(await store.updateItemProjectPath('sess-healed-3', 'session', '/q')).toBe(true);
      });
      const rows = (await admin.query(
        `SELECT id, mtime::int AS mtime, project_path, author_sub, author_device FROM memory_metadata WHERE tenant=$1 ORDER BY id`, [tenant])).rows;
      expect(rows).toEqual([
        { id: 'sess-healed', mtime: 2, project_path: '/p', author_sub: 'touch-author', author_device: 'dev-1' },
        { id: 'sess-healed-2', mtime: 2, project_path: '/p', author_sub: 'touch-author', author_device: 'dev-1' },
        { id: 'sess-healed-3', mtime: 1, project_path: '/q', author_sub: 'touch-author', author_device: 'dev-1' },
      ]);
    } finally {
      await store.close();
    }
  });

  pgTest('a member who deletes a session removes its archive and derived rows too', async () => {
    // The purge deleted memory_metadata first. The three tables visible only
    // through that parent then matched nothing, so a delete kept the archive,
    // and self-heal rebuilt the deleted session from it.
    const tenant = `rls_purge_${process.pid}`;
    const store = await createStore({ backend: 'postgres', databaseUrl: probeUrl, tenant } as any);
    const cache = await createMetadataCache({ backend: 'postgres', databaseUrl: probeUrl, tenant } as any);
    const oc = await createOutcomeCache({ backend: 'postgres', databaseUrl: probeUrl, tenant } as any);
    const member = { sub: 'purge-author', device: 'dev-1' };
    try {
      await runWithAuthor(member, async () => {
        await store.setItem({ id: 'sess-del', sourceType: 'session', title: 't', projectPath: '/p', projectId: 'p', filePath: '', mtime: 1, contentPreview: 'x' });
        await store.putRawSession('sess-del', 'claude', 1, Buffer.from([0x1f, 0x8b, 0x00]), 3, 'p', '/p');
        await cache.setCompute('sess-del', 'markers', 1, { prompts: ['a'] });
        await oc.put({
          sessionId: 'sess-del', tool: 'claude', status: 'shipped', reason: 'test',
          fileMtime: 1, fileSize: 1, contentHash: 'h', fileCount: 1,
          linesAdded: 1, linesRemoved: 0, commits: 0, isFull: true, lastScannedOffset: 0,
        } as any);
        await store.purgeSession('sess-del');
        await store.addTombstone('sess-del');
      });
      const left = (await admin.query(
        `SELECT 'raw_sessions' AS t, count(*)::int AS n FROM raw_sessions WHERE tenant=$1
         UNION ALL SELECT 'compute_cache', count(*)::int FROM compute_cache WHERE tenant=$1
         UNION ALL SELECT 'session_outcome_cache', count(*)::int FROM session_outcome_cache WHERE tenant=$1
         UNION ALL SELECT 'memory_metadata', count(*)::int FROM memory_metadata WHERE tenant=$1
         ORDER BY 1`, [tenant])).rows;
      expect(left).toEqual([
        { t: 'compute_cache', n: 0 },
        { t: 'memory_metadata', n: 0 },
        { t: 'raw_sessions', n: 0 },
        { t: 'session_outcome_cache', n: 0 },
      ]);
      expect(await store.tombstonedWithRemains(10)).toEqual([]);
    } finally {
      await oc.close();
      await cache.close();
      await store.close();
    }
  });

  pgTest('tombstonedWithRemains finds a deleted session that kept its archive', async () => {
    const tenant = `rls_remains_${process.pid}`;
    const store = await createStore({ backend: 'postgres', databaseUrl: probeUrl, tenant } as any);
    try {
      await store.putRawSession('sess-kept', 'claude', 1, Buffer.from([0x1f, 0x8b, 0x00]), 3, 'p', '/p');
      await store.addTombstone('sess-kept');
      await store.addTombstone('sess-clean');
      expect(await store.tombstonedWithRemains(10)).toEqual(['sess-kept']);
      await store.purgeSessionsMany(['sess-kept']);
      expect(await store.tombstonedWithRemains(10)).toEqual([]);
    } finally {
      await store.close();
    }
  });

  pgTest('a toolkit row goes only when the last device that had it stops reporting it', async () => {
    // One item id stands for every device that has the item, so one device's
    // inventory must not delete it while another device still has it.
    const tenant = `rls_inventory_${process.pid}`;
    const store = await createStore({ backend: 'postgres', databaseUrl: probeUrl, tenant } as any);
    const member = { sub: 'inventory-author', device: 'laptop' };
    const mcp = (id: string) => ({ id, sourceType: 'mcp' as const, title: id, projectPath: '', projectId: '', filePath: '', mtime: 1, contentPreview: 'x' });
    try {
      await runWithAuthor(member, async () => {
        await store.setItems([mcp('claude_mcp_shared'), mcp('claude_mcp_laptop_only'), mcp('claude_mcp_kept')]);
        await store.addChunksFTS([{ chunkId: 'claude_mcp_laptop_only:0', itemId: 'claude_mcp_laptop_only', sourceType: 'mcp', title: 't', text: 'laptop only server', chunkType: 'mcp', projectPath: '', filePath: '', mtime: 1 } as any]);
        await store.withTransaction(async () => {
          await store.reconcileToolkitInventory('laptop', [{ sourceType: 'mcp', ids: ['claude_mcp_shared', 'claude_mcp_laptop_only', 'claude_mcp_kept'] }]);
          await store.reconcileToolkitInventory('desktop', [{ sourceType: 'mcp', ids: ['claude_mcp_shared'] }]);
        });
        // The laptop removed two servers. The shared one is still on the desktop.
        const r = await store.withTransaction(() =>
          store.reconcileToolkitInventory('laptop', [{ sourceType: 'mcp', ids: ['claude_mcp_kept'] }]));
        expect(r.removed).toBe(1);
      });
      const ids = (await admin.query(`SELECT id FROM memory_metadata WHERE tenant=$1 ORDER BY id`, [tenant])).rows.map((x: any) => x.id);
      expect(ids).toEqual(['claude_mcp_kept', 'claude_mcp_shared']);
      const chunks = await admin.query(`SELECT count(*)::int AS n FROM memory_chunks WHERE tenant=$1 AND item_id='claude_mcp_laptop_only'`, [tenant]);
      expect(chunks.rows[0].n).toBe(0);

      // The desktop removes the shared one too: now no device has it.
      await runWithAuthor(member, () => store.withTransaction(() =>
        store.reconcileToolkitInventory('desktop', [{ sourceType: 'mcp', ids: [] }])));
      const left = (await admin.query(`SELECT id FROM memory_metadata WHERE tenant=$1 ORDER BY id`, [tenant])).rows.map((x: any) => x.id);
      expect(left).toEqual(['claude_mcp_kept']);
    } finally {
      await store.close();
    }
  });

  pgTest('a row with no presence at all is never deleted by an inventory', async () => {
    // A device that has not sent an inventory yet has no presence rows for its
    // items. Another device's inventory must leave those items alone.
    const tenant = `rls_inventory_legacy_${process.pid}`;
    const store = await createStore({ backend: 'postgres', databaseUrl: probeUrl, tenant } as any);
    try {
      await runWithAuthor({ sub: 'legacy-author', device: 'old-mac' }, async () => {
        await store.setItems([{ id: 'claude_skill_legacy', sourceType: 'skill', title: 'legacy', projectPath: '', projectId: '', filePath: '', mtime: 1, contentPreview: 'x' }]);
        await store.withTransaction(() => store.reconcileToolkitInventory('new-pc', [{ sourceType: 'skill', ids: [] }]));
      });
      const n = await admin.query(`SELECT count(*)::int AS n FROM memory_metadata WHERE tenant=$1`, [tenant]);
      expect(n.rows[0].n).toBe(1);
    } finally {
      await store.close();
    }
  });

  pgTest('runUnrestricted raises the viewer inside an open transaction, and puts it back', async () => {
    // addLinks() elevates with runUnrestricted(). Inside withTransaction() no new
    // transaction opens, so the elevation must reach the pinned client's GUC.
    const tenant = `rls_pinned_${process.pid}`;
    const store = await createStore({ backend: 'postgres', databaseUrl: probeUrl, tenant } as any);
    try {
      await runWithAuthor({ sub: 'pinned-author', device: 'dev-1' }, () => store.withTransaction(async () => {
        await store.addLinks([{ sourceType: 'session', sourceId: 'sess-a', targetType: 'plan', targetId: 'plan-b', linkType: 'session_plan', confidence: 1 } as any]);
        // Back under the member's viewer: another author's row stays hidden.
        await store.setItem({ id: 'sess-mine', sourceType: 'session', title: 'mine', projectPath: '/p', projectId: 'p', filePath: '', mtime: 1, contentPreview: 'x' });
      }));
      await admin.query(`UPDATE memory_metadata SET author_sub='someone-else' WHERE tenant=$1 AND id='sess-mine'`, [tenant]);
      const hidden = await runWithAuthor({ sub: 'pinned-author', device: 'dev-1' },
        () => store.withTransaction(async () => {
          await store.addLinks([{ sourceType: 'session', sourceId: 'sess-a', targetType: 'plan', targetId: 'plan-c', linkType: 'session_plan', confidence: 1 } as any]);
          return store.getItem('sess-mine', 'session');
        }));
      expect(hidden).toBeNull();
    } finally {
      await store.close();
    }
  });

  pgTest('THE PROTECTION IS INTACT: elevating the write did not widen any READ', async () => {
    // The whole safety argument for runUnrestricted is that it elevates a WRITE
    // and leaves reads gated. If that were wrong, this is where it shows: a
    // second named author must not see the first one's session.
    const tenant = `rls_read_${process.pid}`;
    const store = await createStore({ backend: 'postgres', databaseUrl: probeUrl, tenant } as any);
    try {
      await runWithAuthor({ sub: 'author-one', device: 'd1' }, async () => {
        await store.setItem({
          id: 'sess-owned-by-one', sourceType: 'session', title: 'one',
          projectPath: '/p', projectId: 'p', filePath: '', mtime: 1, contentPreview: 'x',
        });
      });
      // Author one sees it.
      const own = await runWithAuthor({ sub: 'author-one', device: 'd1' },
        () => store.getItem('sess-owned-by-one', 'session'));
      expect(own?.title).toBe('one');
      // Author two, same tenant, must NOT.
      const other = await runWithAuthor({ sub: 'author-two', device: 'd2' },
        () => store.getItem('sess-owned-by-one', 'session'));
      expect(other).toBeNull();
    } finally {
      await store.close();
    }
  });
});
