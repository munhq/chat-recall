/**
 * Dismissing a recommendation, and why it needs a reason.
 *
 * Apply existed; dismiss did not. So advice that did not fit a repo came back on
 * every load — which is how a panel earns being ignored, and it is exactly what
 * happened here: the reuse rule sat in CLAUDE.md, applied and done, while the card
 * kept asking.
 *
 * The reason is REQUIRED, and that is the interesting decision. These tools are
 * reachable by an agent, so a dismissal is a machine changing how future sessions
 * treat someone's codebase. An unexplained one is indistinguishable from a misclick
 * six weeks later, and it cannot be reviewed. Refusing the write without a reason is
 * what keeps that reviewable.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const kv = new Map<string, string>();

/** Set by the listing tests; null keeps the dismissal tests' 404-on-GET behavior. */
let project: Record<string, unknown> | null = null;

vi.mock('../imports.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createStore: async () => ({
    kvSet: async (scope: string, key: string, value: string) => { kv.set(`${scope}|${key}`, value); },
    kvDelete: async (scope: string, key: string) => { kv.delete(`${scope}|${key}`); },
    kvList: async (scope?: string) => [...kv.entries()]
      .filter(([k]) => !scope || k.startsWith(`${scope}|`))
      .map(([k, value]) => ({ scope: scope ?? '', key: k.split('|').slice(1).join('|'), value })),
    // The listing path. An UNLABELLED project deterministically yields the
    // 'classify-project' recommendation, which is what the dismissal tests below
    // dismiss — no findings needed to produce it.
    getCodeProject: async (id: string) => (project ? { ...project, projectId: id } : null),
    codeFindingsSummary: async () => ({ total: 0, byCategory: {}, bySeverity: {} }),
    listCodeFindings: async () => [],
    listCodeHotspots: async () => [],
    listItemsByProjectId: async () => [],
    listSyncIntents: async () => [],
    close: async () => {},
  }),
}));

const { default: codeRouter } = await import('./code.js');

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { (req as never as { userId: string }).userId = 'alice'; next(); });
  a.use('/api/code', codeRouter);
  return a;
}

beforeEach(() => { kv.clear(); project = null; });

describe('dismiss requires a reason', () => {
  test('THE POINT: no reason, no write', async () => {
    const r = await request(app())
      .post('/api/code/recommendations/rec_abc/dismiss')
      .send({ project: 'p1' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/reason is required/);
    expect(kv.size).toBe(0);
  });

  test('a whitespace-only reason is not a reason', async () => {
    const r = await request(app())
      .post('/api/code/recommendations/rec_abc/dismiss')
      .send({ project: 'p1', reason: '   ' });
    expect(r.status).toBe(400);
    expect(kv.size).toBe(0);
  });

  test('project is required — a dismissal is per repo, not global', async () => {
    // The same advice can be right for one repo and wrong for another. A global
    // dismissal would silence it everywhere from one judgement call.
    const r = await request(app())
      .post('/api/code/recommendations/rec_abc/dismiss')
      .send({ reason: 'this repo is deliberately duplicated per environment' });
    expect(r.status).toBe(400);
    expect(kv.size).toBe(0);
  });

  test('with both, it records the reason and who decided', async () => {
    const r = await request(app())
      .post('/api/code/recommendations/rec_abc/dismiss')
      .send({ project: 'p1', reason: 'versioned contracts, duplication is deliberate' });
    expect(r.status).toBe(200);
    expect(r.body.dismissed).toBe(true);
    const stored = JSON.parse([...kv.values()][0]);
    expect(stored.reason).toBe('versioned contracts, duplication is deliberate');
    expect(stored.by).toBe('alice');
    expect(stored.at).toBeGreaterThan(0);
  });

  test('it is keyed per project, so two repos decide independently', async () => {
    const send = (project: string) => request(app())
      .post('/api/code/recommendations/rec_abc/dismiss')
      .send({ project, reason: 'not here' });
    await send('p1');
    await send('p2');
    expect(kv.size).toBe(2);
  });

  test('undismiss puts it back — a dismissal that cannot be undone is a trap', async () => {
    await request(app()).post('/api/code/recommendations/rec_abc/dismiss')
      .send({ project: 'p1', reason: 'wrong call' });
    expect(kv.size).toBe(1);
    const r = await request(app()).post('/api/code/recommendations/rec_abc/undismiss')
      .send({ project: 'p1' });
    expect(r.status).toBe(200);
    expect(r.body.dismissed).toBe(false);
    expect(kv.size).toBe(0);
  });

  test('dismissing twice is idempotent, not an error', async () => {
    const send = () => request(app()).post('/api/code/recommendations/rec_abc/dismiss')
      .send({ project: 'p1', reason: 'same call twice' });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect(kv.size).toBe(1);
  });
});

/**
 * A dismissal has to be UNDOABLE by someone who was not there when it happened.
 *
 * The first version suppressed dismissed recommendations at build time, exactly
 * like applied ones. That made the button one-way: the card vanished from the
 * only screen that could have offered to bring it back, and the reason was
 * written to a store nothing read. The listing now returns them apart from the
 * live ones, with the reason attached.
 */
describe('the listing keeps dismissed recommendations reachable', () => {
  const PID = 'p1';
  // Same input, same id — buildRecommendations is pure and its ids are stable.
  const recIdFor = async (kind: string, key: string) => {
    const { createHash } = await import('crypto');
    return 'rec_' + createHash('sha256').update([PID, kind, key].join('|')).digest('hex').slice(0, 16);
  };
  const unlabelled = {
    projectId: PID, rootPath: '/home/user/code/example', label: null,
    langs: {}, health: { score: 100, stats: {} }, map: { buckets: [], coupling: [] },
  };

  test('THE POINT: a dismissed card comes back in `dismissed`, with its reason', async () => {
    project = unlabelled;
    const id = await recIdFor('label', 'classify-project');

    const before = await request(app()).get('/api/code/recommendations?project=' + PID);
    expect(before.status).toBe(200);
    expect(before.body.recommendations.map((r: { id: string }) => r.id)).toContain(id);
    expect(before.body.dismissed).toEqual([]);

    await request(app()).post(`/api/code/recommendations/${id}/dismiss`)
      .send({ project: PID, reason: 'labels are set by our provisioning, not by hand' });

    const after = await request(app()).get('/api/code/recommendations?project=' + PID);
    // Gone from the live list…
    expect(after.body.recommendations.map((r: { id: string }) => r.id)).not.toContain(id);
    // …and still readable, so the UI can offer "put it back".
    expect(after.body.dismissed).toHaveLength(1);
    expect(after.body.dismissed[0].id).toBe(id);
    expect(after.body.dismissed[0].title).toMatch(/Label this project/);
    expect(after.body.dismissed[0].dismissal.reason).toBe('labels are set by our provisioning, not by hand');
    expect(after.body.dismissed[0].dismissal.by).toBe('alice');
  });

  test('undismiss returns it to the live list', async () => {
    project = unlabelled;
    const id = await recIdFor('label', 'classify-project');
    await request(app()).post(`/api/code/recommendations/${id}/dismiss`)
      .send({ project: PID, reason: 'wrong call' });
    await request(app()).post(`/api/code/recommendations/${id}/undismiss`).send({ project: PID });

    const r = await request(app()).get('/api/code/recommendations?project=' + PID);
    expect(r.body.recommendations.map((x: { id: string }) => x.id)).toContain(id);
    expect(r.body.dismissed).toEqual([]);
  });

  test("another project's dismissal does not silence this one", async () => {
    project = unlabelled;
    const id = await recIdFor('label', 'classify-project');
    // Dismissed for p2 — the same recommendation id, a different repo.
    await request(app()).post(`/api/code/recommendations/${id}/dismiss`)
      .send({ project: 'p2', reason: 'not there' });

    const r = await request(app()).get('/api/code/recommendations?project=' + PID);
    expect(r.body.recommendations.map((x: { id: string }) => x.id)).toContain(id);
    expect(r.body.dismissed).toEqual([]);
  });
});
