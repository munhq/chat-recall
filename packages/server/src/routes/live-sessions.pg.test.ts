/**
 * /api/live-sessions over HTTP against Postgres: hook events, labels, parent
 * links, messages between sessions, and the wall between two users of one
 * tenant. Gated on DATABASE_URL.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import pg from 'pg';
import { pgAdminUrl, pgTestUrl } from '@chat-recall/engine/test-support/pg-urls.js';
import { runWithTenant } from '@chat-recall/engine/core/store/tenant-context.js';
import { createStore } from '@chat-recall/engine/core/store/index.js';
import router from './live-sessions.js';

const PG_URL = pgTestUrl();
const TENANT = `live_sessions_${process.pid}`;
const PARENT = '11111111-0000-4000-8000-000000000001';
const CHILD_A = '11111111-0000-4000-8000-0000000000a1';
const CHILD_B = '11111111-0000-4000-8000-0000000000b1';
const OTHER_USER_SESSION = '22222222-0000-4000-8000-000000000001';

(PG_URL ? describe : describe.skip)('/api/live-sessions (postgres)', () => {
  const saved = process.env.CHAT_RECALL_STORAGE;
  let admin: pg.Pool;
  let app: express.Express;

  /** A request as one user of the test tenant. */
  const as = (sub: string) => ({
    get: (path: string) => request(app).get(path).set('x-test-sub', sub),
    post: (path: string, body: unknown) => request(app).post(path).set('x-test-sub', sub).send(body as object),
  });
  const alice = as('alice');
  const bob = as('bob');

  async function clean(): Promise<void> {
    for (const t of ['session_messages', 'live_sessions', 'team_task_comments', 'team_tasks']) {
      await admin.query(`DELETE FROM ${t} WHERE tenant = $1`, [TENANT]);
    }
  }

  beforeAll(async () => {
    process.env.CHAT_RECALL_STORAGE = 'postgres';
    admin = new pg.Pool({ connectionString: pgAdminUrl() });
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.authorSub = req.header('x-test-sub') || null;
      runWithTenant(TENANT, () => next());
    });
    app.use('/api/live-sessions', router);
    // The first request creates the schema; clean after it.
    await alice.get('/api/live-sessions');
    await clean();
  });

  afterAll(async () => {
    await clean();
    await admin.end();
    process.env.CHAT_RECALL_STORAGE = saved;
  });

  test('a hook event records the session and its state', async () => {
    const r = await alice.post('/api/live-sessions/event', { sessionId: PARENT, event: 'SessionStart', cwd: '/home/user/code/example' });
    expect(r.status).toBe(200);
    expect(r.body.session).toMatchObject({ sessionId: PARENT, state: 'idle', cwd: '/home/user/code/example', unread: 0 });
    const w = await alice.post('/api/live-sessions/event', { sessionId: PARENT, event: 'UserPromptSubmit' });
    expect(w.body.session.state).toBe('working');
    expect(w.body.session.cwd).toBe('/home/user/code/example');
  });

  test('an unknown event is refused', async () => {
    for (const event of ['Notification', 'PostToolUse']) {
      expect((await alice.post('/api/live-sessions/event', { sessionId: PARENT, event })).status).toBe(400);
    }
  });

  test('children register with a label and a parent', async () => {
    await alice.post('/api/live-sessions/event', { sessionId: CHILD_A, event: 'SessionStart' });
    await alice.post('/api/live-sessions/register', { sessionId: PARENT, label: 'lead' });
    const a = await alice.post('/api/live-sessions/register', { sessionId: CHILD_A, label: 'worker-a', parent: 'lead' });
    expect(a.status).toBe(200);
    expect(a.body.session).toMatchObject({ label: 'worker-a', parentSession: PARENT });
    const b = await alice.post('/api/live-sessions/register', { sessionId: CHILD_B, label: 'worker-b', parent: PARENT });
    expect(b.body.session.parentSession).toBe(PARENT);

    const kids = await alice.get(`/api/live-sessions?parent=lead`);
    expect(kids.body.sessions.map((s: { sessionId: string }) => s.sessionId).sort()).toEqual([CHILD_A, CHILD_B]);
  });

  test('a label held by another running session is refused', async () => {
    const r = await alice.post('/api/live-sessions/register', { sessionId: CHILD_B, label: 'worker-a' });
    expect(r.status).toBe(409);
  });

  test('a session cannot be its own parent', async () => {
    const r = await alice.post('/api/live-sessions/register', { sessionId: PARENT, parent: PARENT });
    expect(r.status).toBe(400);
  });

  test('the parent sends to every child, and each child receives it once', async () => {
    const sent = await alice.post('/api/live-sessions/messages', { from: PARENT, to: 'children', body: 'Run the tests.' });
    expect(sent.status).toBe(200);
    expect(sent.body.messages).toHaveLength(2);

    const status = await alice.get('/api/live-sessions?parent=lead');
    for (const s of status.body.sessions) expect(s.unread).toBe(1);

    const got = await alice.post('/api/live-sessions/event', { sessionId: CHILD_A, event: 'UserPromptSubmit', take: true });
    expect(got.body.messages).toHaveLength(1);
    expect(got.body.messages[0]).toMatchObject({ fromSession: PARENT, toSession: CHILD_A, body: 'Run the tests.' });
    expect(got.body.session.unread).toBe(0);
    expect(got.body.labels).toEqual({ [PARENT]: 'lead' });

    // The hook acknowledges what it has shown.
    await alice.post('/api/live-sessions/ack', { sessionId: CHILD_A, ids: [got.body.messages[0].id] });

    const again = await alice.post('/api/live-sessions/inbox', { sessionId: CHILD_A });
    expect(again.body.messages).toHaveLength(0);
  });

  test('a taken message stays unread until it is acknowledged, and comes back when the lease ends', async () => {
    const sent = await alice.post('/api/live-sessions/messages', { from: PARENT, to: 'worker-a', body: 'lease me' });
    const id = sent.body.messages[0].id;

    const store = await createStore({ backend: 'postgres', databaseUrl: PG_URL, tenant: TENANT } as never);
    try {
      // A hook that stops before it acknowledges: the lease ends, the message is offered again.
      const first = await store.takeSessionMessages('alice', CHILD_A, 50, 1);
      expect(first.map((m) => m.id)).toEqual([id]);
      await new Promise((r) => setTimeout(r, 5));
      const again = await store.takeSessionMessages('alice', CHILD_A, 50, 60_000);
      expect(again.map((m) => m.id)).toEqual([id]);
      // Inside the lease nobody else receives it.
      expect(await store.takeSessionMessages('alice', CHILD_A)).toEqual([]);
    } finally { await store.close(); }

    expect((await alice.get('/api/live-sessions/worker-a')).body.session.unread).toBe(1);
    const ack = await alice.post('/api/live-sessions/ack', { sessionId: CHILD_A, ids: [id] });
    expect(ack.body.acked).toBe(1);
    expect((await alice.get('/api/live-sessions/worker-a')).body.session.unread).toBe(0);
    // A second acknowledgement, or one for another user, changes nothing.
    expect((await alice.post('/api/live-sessions/ack', { sessionId: CHILD_A, ids: [id] })).body.acked).toBe(0);
    expect((await bob.post('/api/live-sessions/ack', { sessionId: CHILD_A, ids: [id] })).body.acked).toBe(0);
    expect((await alice.post('/api/live-sessions/ack', { sessionId: CHILD_A, ids: ['DROP'] })).status).toBe(400);
  });

  test('an event without take leaves the messages waiting', async () => {
    const r = await alice.post('/api/live-sessions/event', { sessionId: CHILD_B, event: 'UserPromptSubmit' });
    expect(r.body.messages).toHaveLength(0);
    expect(r.body.session.unread).toBe(1);
    const inbox = await alice.post('/api/live-sessions/inbox', { sessionId: CHILD_B });
    expect(inbox.body.messages).toHaveLength(1);
  });

  test('a child replies to its parent', async () => {
    const r = await alice.post('/api/live-sessions/messages', { from: CHILD_A, to: 'parent', body: 'Tests pass.', replyTo: 'm_x' });
    expect(r.status).toBe(200);
    expect(r.body.recipients).toEqual([{ sessionId: PARENT, label: 'lead', state: 'working' }]);
    const inbox = await alice.post('/api/live-sessions/inbox', { sessionId: PARENT });
    expect(inbox.body.messages).toHaveLength(1);
    expect(inbox.body.messages[0]).toMatchObject({ fromSession: CHILD_A, body: 'Tests pass.', replyTo: 'm_x' });
  });

  test('a unique leading part of a session id is an address', async () => {
    const r = await alice.post('/api/live-sessions/messages', { from: PARENT, to: CHILD_B.slice(0, 35), body: 'ping' });
    expect(r.status).toBe(200);
    expect(r.body.recipients[0].sessionId).toBe(CHILD_B);
  });

  test('an ambiguous leading part is refused with the candidates', async () => {
    const r = await alice.post('/api/live-sessions/messages', { from: PARENT, to: '11111111-0000', body: 'ping' });
    expect(r.status).toBe(409);
    expect(r.body.candidates.length).toBeGreaterThan(1);
  });

  test('a session cannot message itself', async () => {
    const r = await alice.post('/api/live-sessions/messages', { from: PARENT, to: 'lead', body: 'hi' });
    expect(r.status).toBe(400);
  });

  test('the detail view shows the thread of one session', async () => {
    const r = await alice.get('/api/live-sessions/worker-a');
    expect(r.status).toBe(200);
    expect(r.body.session.sessionId).toBe(CHILD_A);
    const bodies = r.body.messages.map((m: { body: string }) => m.body);
    expect(bodies).toEqual(['Tests pass.', 'lease me', 'Run the tests.']);
  });

  test('a session says what it works on, and the list shows it', async () => {
    const r = await alice.post('/api/live-sessions/register', { sessionId: CHILD_A, doing: '  Fix the  login\nredirect  ' });
    expect(r.status).toBe(200);
    expect(r.body.session.doing).toBe('Fix the login redirect');
    const kids = await alice.get('/api/live-sessions?parent=lead');
    expect(kids.body.sessions.find((s: { sessionId: string }) => s.sessionId === CHILD_A).doing).toBe('Fix the login redirect');
    // Registering again without `doing` keeps it; an empty string clears it.
    await alice.post('/api/live-sessions/register', { sessionId: CHILD_A, label: 'worker-a' });
    expect((await alice.get('/api/live-sessions/worker-a')).body.session.doing).toBe('Fix the login redirect');
    expect((await alice.post('/api/live-sessions/register', { sessionId: CHILD_A, doing: 'x'.repeat(281) })).status).toBe(400);
  });

  test('a board card in progress shows beside the session that works on it', async () => {
    const store = await createStore({ backend: 'postgres', databaseUrl: PG_URL, tenant: TENANT } as never);
    try {
      const mine = await store.createTeamTask({ title: 'Fix the login redirect', createdBy: 'alice', linkedSessionId: CHILD_A });
      await store.updateTeamTask(mine.id, { status: 'in_progress' });
      const open = await store.createTeamTask({ title: 'Not started', createdBy: 'alice', linkedSessionId: CHILD_A });
      const theirs = await store.createTeamTask({ title: 'Bob card', createdBy: 'bob', linkedSessionId: OTHER_USER_SESSION });
      await store.updateTeamTask(theirs.id, { status: 'in_progress' });
      const detail = await alice.get('/api/live-sessions/worker-a');
      expect(detail.body.session.cards).toEqual([{ id: mine.id, title: 'Fix the login redirect', status: 'in_progress' }]);
      const list = await alice.get('/api/live-sessions');
      const cards = list.body.sessions.flatMap((s: { cards: Array<{ id: string }> }) => s.cards.map((c) => c.id));
      expect(cards).toEqual([mine.id]);
      expect(cards).not.toContain(open.id);
    } finally { await store.close(); }
  });

  test('a group message reaches the parent and every sibling, never the sender', async () => {
    const r = await alice.post('/api/live-sessions/messages', { from: CHILD_A, to: 'group', body: 'We use Postgres for this.' });
    expect(r.status).toBe(200);
    expect(r.body.recipients.map((x: { sessionId: string }) => x.sessionId).sort()).toEqual([PARENT, CHILD_B].sort());
    // From the parent, the group is its children.
    const p = await alice.post('/api/live-sessions/messages', { from: PARENT, to: 'group', body: 'Agreed.' });
    expect(p.body.recipients.map((x: { sessionId: string }) => x.sessionId).sort()).toEqual([CHILD_A, CHILD_B].sort());
    for (const id of [PARENT, CHILD_A, CHILD_B]) await alice.post('/api/live-sessions/inbox', { sessionId: id });
  });

  test('a session alone has no group to send to', async () => {
    const r = await bob.post('/api/live-sessions/messages', { from: OTHER_USER_SESSION, to: 'group', body: 'anyone?' });
    expect(r.status).toBe(404);
  });

  test('the long-poll returns a message as soon as one is sent, and records the poll', async () => {
    const started = Date.now();
    const pending = alice.post('/api/live-sessions/wait', { sessionId: CHILD_A, timeoutSecs: 10 });
    await new Promise((r) => setTimeout(r, 1500));
    await alice.post('/api/live-sessions/messages', { from: PARENT, to: 'worker-a', body: 'wake up' });
    const r = await pending;
    const took = Date.now() - started;
    expect(r.status).toBe(200);
    expect(r.body.messages.map((m: { body: string }) => m.body)).toEqual(['wake up']);
    expect(r.body.labels).toEqual({ [PARENT]: 'lead' });
    expect(took).toBeLessThan(4000);
    await alice.post('/api/live-sessions/ack', { sessionId: CHILD_A, ids: [r.body.messages[0].id] });
    expect((await alice.get('/api/live-sessions/worker-a')).body.session.lastSeen).toBeGreaterThanOrEqual(started);
  });

  test('the long-poll returns empty at its timeout, and 404 for a session that is not this owner\'s', async () => {
    const r = await alice.post('/api/live-sessions/wait', { sessionId: CHILD_A, timeoutSecs: 1 });
    expect(r.body).toEqual({ ended: false, messages: [] });
    expect((await bob.post('/api/live-sessions/wait', { sessionId: CHILD_A, timeoutSecs: 1 })).status).toBe(404);
  });

  test('a session that a parent started links itself at SessionStart', async () => {
    const KID = '11111111-0000-4000-8000-0000000000c1';
    const r = await alice.post('/api/live-sessions/event', {
      sessionId: KID, event: 'SessionStart', label: 'worker-c', parent: 'lead', doing: 'docs',
    });
    expect(r.status).toBe(200);
    expect(r.body.session).toMatchObject({ label: 'worker-c', parentSession: PARENT, doing: 'docs' });
    // A name that is taken does not cost the session its report.
    const KID2 = '11111111-0000-4000-8000-0000000000c2';
    const r2 = await alice.post('/api/live-sessions/event', { sessionId: KID2, event: 'SessionStart', label: 'worker-c', parent: 'lead', doing: 'more docs' });
    expect(r2.status).toBe(200);
    expect(r2.body.session).toMatchObject({ label: null, doing: 'more docs' });
    for (const id of [KID, KID2]) await alice.post('/api/live-sessions/event', { sessionId: id, event: 'SessionEnd' });
  });

  test('an ended session leaves the running list and takes no messages', async () => {
    const r = await alice.post('/api/live-sessions/event', { sessionId: CHILD_B, event: 'SessionEnd', take: true });
    expect(r.body.session.state).toBe('ended');
    expect(r.body.messages).toHaveLength(0);
    // Its waiter learns of the end at its next poll and stops.
    expect((await alice.post('/api/live-sessions/wait', { sessionId: CHILD_B, timeoutSecs: 5 })).body).toEqual({ ended: true, messages: [] });
    const kids = await alice.get('/api/live-sessions?parent=lead');
    expect(kids.body.sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual([CHILD_A]);
    const all = await alice.get('/api/live-sessions?parent=lead&includeEnded=true');
    const ids = all.body.sessions.map((s: { sessionId: string }) => s.sessionId);
    expect(ids).toContain(CHILD_A);
    expect(ids).toContain(CHILD_B);
  });

  test('another user of the same tenant cannot see or reach these sessions', async () => {
    await bob.post('/api/live-sessions/event', { sessionId: OTHER_USER_SESSION, event: 'SessionStart' });
    const list = await bob.get('/api/live-sessions');
    expect(list.body.sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual([OTHER_USER_SESSION]);

    const send = await bob.post('/api/live-sessions/messages', { from: OTHER_USER_SESSION, to: PARENT, body: 'hello' });
    expect(send.status).toBe(404);
    const byLabel = await bob.post('/api/live-sessions/messages', { from: OTHER_USER_SESSION, to: 'lead', body: 'hello' });
    expect(byLabel.status).toBe(404);

    // Writing to a session id that belongs to alice does not take it over.
    const steal = await bob.post('/api/live-sessions/event', { sessionId: PARENT, event: 'Stop' });
    expect(steal.status).toBe(403);
    expect(steal.body.error).toContain('belongs to another user');
    const parent = await alice.get(`/api/live-sessions/${PARENT}`);
    expect(parent.body.session.state).toBe('working');

    const inbox = await bob.post('/api/live-sessions/inbox', { sessionId: PARENT });
    expect(inbox.body.messages).toHaveLength(0);
  });

  test('bad input is refused', async () => {
    expect((await alice.post('/api/live-sessions/messages', { from: PARENT, to: 'worker-a', body: '' })).status).toBe(400);
    expect((await alice.post('/api/live-sessions/messages', { from: PARENT, to: 'worker-a', body: 'x'.repeat(16_001) })).status).toBe(413);
    expect((await alice.post('/api/live-sessions/event', { sessionId: 'has space', event: 'Stop' })).status).toBe(400);
    expect((await alice.post('/api/live-sessions/register', { sessionId: PARENT, label: 'no spaces' })).status).toBe(400);
    expect((await alice.post('/api/live-sessions/messages', { to: 'children', body: 'x' })).status).toBe(400);
  });
});
