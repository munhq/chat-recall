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
 * So this file creates its own NON-SUPERUSER role and connects as that. It is
 * the only place RLS is actually exercised.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { createStore } from './index.js';
import { createMetadataCache, createOutcomeCache } from './caches.js';
import { runWithAuthor } from './tenant-context.js';

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
  admin = new pg.Pool({ connectionString: PG_URL, max: 2 });
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
  // membership, which is the property that keeps this probe honest.
  const owner = (await admin.query(`SELECT current_user AS u`)).rows[0].u;
  await admin.query(`GRANT ${owner} TO ${PROBE_ROLE}`);
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
