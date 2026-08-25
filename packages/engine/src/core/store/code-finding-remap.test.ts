/**
 * A finding's id is a hash of its content, so ANY change to the hashing renames
 * every finding at once. This proves the rename is absorbed rather than mistaken
 * for work being finished.
 *
 * WHY IT MATTERS. `replaceCodeFindings` carries `status` and `first_seen_at`
 * forward, and a card names its finding by id. Keyed on the STORED id, a rename
 * means: every triage verdict is discarded, every age resets to now, and every
 * card points at a row that no longer exists — which auto-tasks reads as "the
 * finding is gone, so the work is done". That closed 93 of 97 cards on one board
 * while all 313 findings were still open.
 *
 * The fix is to recompute the OLD rows' ids with today's function, which makes
 * the two comparable, and to move the cards in the same transaction.
 *
 * Gated on DATABASE_URL: this is the pg driver's behaviour, and team_tasks does
 * not exist in the sqlite driver (server-only table).
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { codeFindingIds } from '../../types/code-intel.js';

const PG_URL = process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL;
const T = 'remap_team';
const PROJ = 'git:h/o/remap-repo';

const finding = (o: Record<string, unknown> = {}) => ({
  category: 'security', severity: 'high', file: 'src/main.rs', rule: 'unwrap',
  title: 'Unwrap in main', line: 10, snippet: 'let x = y.unwrap();',
  why: 'panics', agentPrompt: 'fix it', ...o,
});

(PG_URL ? describe : describe.skip)('a finding id change is absorbed, not read as "fixed"', () => {
  let sudo: pg.Pool;
  let store: { replaceCodeFindings: Function; close: Function };

  const clean = async () => {
    for (const t of ['code_findings', 'team_tasks', 'code_projects']) {
      await sudo.query(`DELETE FROM ${t} WHERE tenant=$1`, [T]);
    }
  };
  const findings = async () => (await sudo.query(
    `SELECT id, status, first_seen_at, title FROM code_findings WHERE tenant=$1 ORDER BY id`, [T])).rows;
  const cards = async () => (await sudo.query(
    `SELECT id, linked_finding_id, linked_finding_identity FROM team_tasks WHERE tenant=$1 ORDER BY id`, [T])).rows;

  beforeAll(async () => {
    sudo = new pg.Pool({ connectionString: PG_URL });
    const { createStore } = await import('./index.js');
    const seed = await createStore({ backend: 'postgres', databaseUrl: PG_URL, tenant: 'seed' } as never);
    await seed.close();
    await clean();
    store = await createStore({ backend: 'postgres', databaseUrl: PG_URL, tenant: T } as never) as never;
  }, 30000);

  afterAll(async () => {
    try { await clean(); } catch { /* best effort */ }
    await store?.close();
    await sudo?.end();
  });

  test('THE POINT: a stale id is renamed, and status + age + card all follow', async () => {
    const f = finding();
    const trueId = codeFindingIds(PROJ, [f])[0];
    // Seed the row under a DIFFERENT id — exactly what an older hashing scheme
    // leaves behind — with a triage verdict and an age worth keeping.
    await sudo.query(
      `INSERT INTO code_findings (tenant,id,project_id,category,severity,file,line,rule,title,snippet,why,agent_prompt,status,first_seen_at,last_seen_at,extra_json)
       VALUES ($1,'cf_stale_scheme_01',$2,'security','high','src/main.rs',10,'unwrap','Unwrap in main','let x = y.unwrap();','panics','fix it','acknowledged',1000,1000,'{}')`,
      [T, PROJ]);
    await sudo.query(
      `INSERT INTO team_tasks (tenant,id,project_id,title,description,status,created_by,linked_finding_id,linked_finding_identity,created_at,updated_at)
       VALUES ($1,'t_card_1',$2,'[high] Unwrap in main','','todo','auto-tasks','cf_stale_scheme_01','cf_stale_scheme_01',1000,1000)`,
      [T, PROJ]);

    await store.replaceCodeFindings(PROJ, [f]);

    const rows = await findings();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(trueId);                       // renamed
    expect(rows[0].status).toBe('acknowledged');           // verdict kept
    expect(Number(rows[0].first_seen_at)).toBe(1000);      // age kept

    const [card] = await cards();
    expect(card.linked_finding_id).toBe(trueId);           // the card came along
    expect(card.linked_finding_identity).toBe(trueId);
  });

  test('a card whose identity was already something else keeps it', async () => {
    await clean();
    const f = finding({ title: 'Unwrap in shutdown' });
    const trueId = codeFindingIds(PROJ, [f])[0];
    await sudo.query(
      `INSERT INTO code_findings (tenant,id,project_id,category,severity,file,line,rule,title,snippet,why,agent_prompt,status,first_seen_at,last_seen_at,extra_json)
       VALUES ($1,'cf_stale_scheme_02',$2,'security','high','src/main.rs',10,'unwrap','Unwrap in shutdown','let x = y.unwrap();','panics','fix it','open',1000,1000,'{}')`,
      [T, PROJ]);
    // An ACTION-derived identity: not the finding id, and not ours to overwrite.
    await sudo.query(
      `INSERT INTO team_tasks (tenant,id,project_id,title,description,status,created_by,linked_finding_id,linked_finding_identity,created_at,updated_at)
       VALUES ($1,'t_card_2',$2,'[high] x','','todo','auto-tasks','cf_stale_scheme_02','proj|security|title|file',1000,1000)`,
      [T, PROJ]);

    await store.replaceCodeFindings(PROJ, [f]);

    const [card] = await cards();
    expect(card.linked_finding_id).toBe(trueId);
    expect(card.linked_finding_identity).toBe('proj|security|title|file');
  });

  test('four byte-identical emissions become ONE row, and the count says one', async () => {
    await clean();
    const f = finding();
    const stored = await store.replaceCodeFindings(PROJ, [f, f, f, f]);
    expect(stored).toBe(1);                                // not 4
    expect(await findings()).toHaveLength(1);
  });

  test('two old rows collapsing keep the earliest age and the triaged status', async () => {
    await clean();
    const f = finding();
    const trueId = codeFindingIds(PROJ, [f])[0];
    // Two stale rows that are the same finding: one triaged, one not, different ages.
    for (const [id, status, seen] of [['cf_dup_a', 'open', 5000], ['cf_dup_b', 'acknowledged', 2000]] as const) {
      await sudo.query(
        `INSERT INTO code_findings (tenant,id,project_id,category,severity,file,line,rule,title,snippet,why,agent_prompt,status,first_seen_at,last_seen_at,extra_json)
         VALUES ($1,$3,$2,'security','high','src/main.rs',10,'unwrap','Unwrap in main','let x = y.unwrap();','panics','fix it',$4,$5,$5,'{}')`,
        [T, PROJ, id, status, seen]);
    }
    await store.replaceCodeFindings(PROJ, [f]);

    const rows = await findings();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(trueId);
    expect(rows[0].status).toBe('acknowledged');       // a verdict outlives a collapse
    expect(Number(rows[0].first_seen_at)).toBe(2000);  // the earliest age wins
  });

  test('an unchanged re-index moves nothing — no churn when the scheme is stable', async () => {
    await clean();
    const f = finding();
    await store.replaceCodeFindings(PROJ, [f]);
    const before = await findings();
    await sudo.query(`UPDATE code_findings SET status='wont_fix' WHERE tenant=$1`, [T]);
    await store.replaceCodeFindings(PROJ, [f]);
    const after = await findings();
    expect(after[0].id).toBe(before[0].id);
    expect(after[0].status).toBe('wont_fix');
    expect(Number(after[0].first_seen_at)).toBe(Number(before[0].first_seen_at));
  });
});
