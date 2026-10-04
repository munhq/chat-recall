/**
 * /api/live-sessions — running AI sessions and the messages between them.
 *
 * The message hook reports every prompt, tool call and turn end of a Claude
 * Code session here, and receives the messages that wait for that session in
 * the same round trip. The MCP tools send messages, name a session, link a
 * child to its parent, and read the state of the children.
 *
 * Every row carries the user behind the token (`owner_sub`), and every query
 * filters on it, so a session reaches only the sessions of the same person.
 *
 *   POST /api/live-sessions/event     {sessionId, event, cwd?, take?}  → {session, messages}
 *   POST /api/live-sessions/register  {sessionId, label?, parent?, doing?} → {session}
 *   GET  /api/live-sessions?parent=&includeEnded=&limit=              → {sessions}
 *   GET  /api/live-sessions/:address?messages=                        → {session, messages}
 *   POST /api/live-sessions/messages  {from?, to, body, replyTo?}      → {messages}
 *   POST /api/live-sessions/inbox     {sessionId, limit?}              → {messages}
 *   POST /api/live-sessions/ack       {sessionId, ids}                 → {acked}
 *
 * `/event` with take, and `/inbox`, lease the messages they return for 60
 * seconds. The caller acknowledges them with `/ack` once it has shown them; an
 * unacknowledged message is offered again when its lease ends.
 *
 * `to` is a session id, a unique leading part of one, a label, or one of the
 * words `parent`, `children` and `group`, which are read relative to `from`.
 * The group is the parent and all its running children.
 *
 * Every session row in a list or detail response carries `cards`: the board
 * cards in progress that name the session as the one doing the work.
 */
import express from 'express';
import { createStore } from '../imports.js';
import { actor } from '../util/actor.js';
import { SessionOwnedElsewhereError, type LiveSession, type LiveSessionState, type StorageDriver } from '@chat-recall/engine/core/store/driver.js';

const router = express.Router();

/** Claude session ids are UUIDs; other tools prefix theirs (`codex_…`). */
const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const LABEL = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_BODY = 16_000;
const MAX_DOING = 280;

/** The state each hook event leaves a session in. */
const EVENT_STATE: Record<string, LiveSessionState> = {
  SessionStart: 'idle',
  UserPromptSubmit: 'working',
  PostToolUse: 'working',
  Stop: 'idle',
  SessionEnd: 'ended',
};

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

function sessionIdOf(v: unknown, field: string): string {
  if (typeof v !== 'string' || !SESSION_ID.test(v)) {
    throw new HttpError(400, `${field} must be a session id (letters, digits, '.', '_', ':' or '-', at most 128)`);
  }
  return v;
}

/** One session for an address, or a 404 / 409 that says why there is none. */
async function resolveOne(store: StorageDriver, owner: string, address: string): Promise<LiveSession> {
  const found = await store.resolveLiveSessions(owner, address);
  if (found.length === 1) return found[0];
  if (found.length === 0) {
    throw new HttpError(404,
      `No session matches "${address}". A session appears after its first prompt with the message hook installed, `
      + 'or after it calls recall_session_register.');
  }
  const list = found.map((s) => s.label ? `${s.sessionId} (${s.label})` : s.sessionId).join(', ');
  throw new HttpError(409, `"${address}" matches ${found.length} sessions: ${list}. Use a session id.`, {
    candidates: found.map((s) => ({ sessionId: s.sessionId, label: s.label, cwd: s.cwd, state: s.state })),
  });
}

type Card = { id: string; title: string; status: string };

/**
 * The board cards in progress for each session, keyed by session id.
 *
 * Cards are tenant-wide, so only the ids of this owner's sessions are looked
 * up: a teammate's card never appears beside these sessions.
 */
async function cardsBySession(store: StorageDriver, sessions: readonly LiveSession[]): Promise<Map<string, Card[]>> {
  const ids = new Set(sessions.map((s) => s.sessionId));
  const out = new Map<string, Card[]>();
  if (!ids.size) return out;
  for (const t of await store.listTeamTasks({ status: 'in_progress' })) {
    if (!t.linkedSessionId || !ids.has(t.linkedSessionId)) continue;
    const list = out.get(t.linkedSessionId) ?? [];
    list.push({ id: t.id, title: t.title, status: t.status });
    out.set(t.linkedSessionId, list);
  }
  return out;
}

async function withCards(store: StorageDriver, sessions: LiveSession[]): Promise<Array<LiveSession & { cards: Card[] }>> {
  const cards = await cardsBySession(store, sessions);
  return sessions.map((s) => ({ ...s, cards: cards.get(s.sessionId) ?? [] }));
}

/** Run a handler with a store, and turn an HttpError into its response. */
function handle(fn: (req: express.Request, res: express.Response, store: StorageDriver) => Promise<void>) {
  return async (req: express.Request, res: express.Response) => {
    const store = await createStore();
    try {
      await fn(req, res, store);
    } catch (e) {
      if (e instanceof HttpError) res.status(e.status).json({ error: e.message, ...e.extra });
      else if (e instanceof SessionOwnedElsewhereError) res.status(403).json({ error: e.message });
      else res.status(500).json({ error: e instanceof Error ? e.message : 'live session request failed' });
    } finally {
      await store.close();
    }
  };
}

router.post('/event', handle(async (req, res, store) => {
  const { event, cwd, take } = req.body ?? {};
  const sessionId = sessionIdOf(req.body?.sessionId, 'sessionId');
  const state = typeof event === 'string' ? EVENT_STATE[event] : undefined;
  if (!state) throw new HttpError(400, `event must be one of ${Object.keys(EVENT_STATE).join(', ')}`);
  const owner = actor(req);
  const session = await store.upsertLiveSession({
    sessionId, ownerSub: owner, state, lastEvent: event,
    cwd: typeof cwd === 'string' && cwd ? cwd.slice(0, 1024) : undefined,
  });
  const messages = take === true && state !== 'ended' ? await store.takeSessionMessages(owner, sessionId) : [];
  // The sender's name, so the hook can show "worker-a" in place of an id.
  const labels: Record<string, string> = {};
  for (const from of new Set(messages.map((m) => m.fromSession).filter((f): f is string => !!f))) {
    const label = (await store.getLiveSession(owner, from))?.label;
    if (label) labels[from] = label;
  }
  res.json({
    session: messages.length ? { ...session, unread: Math.max(0, session.unread - messages.length) } : session,
    messages, labels,
  });
}));

router.post('/register', handle(async (req, res, store) => {
  const { label, parent, doing } = req.body ?? {};
  const sessionId = sessionIdOf(req.body?.sessionId, 'sessionId');
  if (doing !== undefined && (typeof doing !== 'string' || doing.length > MAX_DOING)) {
    throw new HttpError(400, `doing must be a line of at most ${MAX_DOING} characters`);
  }
  const owner = actor(req);
  if (label !== undefined && label !== '' && (typeof label !== 'string' || !LABEL.test(label))) {
    throw new HttpError(400, "label must be 1-64 letters, digits, '.', '_' or '-'");
  }
  if (typeof label === 'string' && label) {
    // A label is an address, so two running sessions with one label would
    // make every message to it fail as ambiguous.
    const holder = (await store.resolveLiveSessions(owner, label)).find((s) => s.sessionId !== sessionId && s.label === label);
    if (holder) throw new HttpError(409, `The label "${label}" belongs to the running session ${holder.sessionId}.`);
  }
  let parentSession: string | undefined;
  if (parent === '') parentSession = '';
  else if (parent !== undefined) {
    if (typeof parent !== 'string') throw new HttpError(400, 'parent must be a session id or a label');
    parentSession = (await resolveOne(store, owner, parent)).sessionId;
    if (parentSession === sessionId) throw new HttpError(400, 'a session cannot be its own parent');
  }
  const session = await store.upsertLiveSession({
    sessionId, ownerSub: owner, label: label as string | undefined, parentSession,
    doing: typeof doing === 'string' ? doing.replace(/\s+/g, ' ').trim() : undefined,
  });
  res.json({ session });
}));

router.get('/', handle(async (req, res, store) => {
  const owner = actor(req);
  let parentSession: string | undefined;
  if (typeof req.query.parent === 'string' && req.query.parent) {
    parentSession = (await resolveOne(store, owner, req.query.parent)).sessionId;
  }
  const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
  const sessions = await store.listLiveSessions(owner, {
    parentSession,
    includeEnded: req.query.includeEnded === 'true' || req.query.includeEnded === '1',
    limit: Number.isFinite(limit) ? limit : undefined,
  });
  res.json({ sessions: await withCards(store, sessions) });
}));

router.post('/messages', handle(async (req, res, store) => {
  const { from, to, body, replyTo } = req.body ?? {};
  const owner = actor(req);
  if (typeof body !== 'string' || !body.trim()) throw new HttpError(400, 'body is required');
  if (body.length > MAX_BODY) throw new HttpError(413, `body is ${body.length} characters; the limit is ${MAX_BODY}`);
  if (typeof to !== 'string' || !to) throw new HttpError(400, 'to is required');
  if (replyTo !== undefined && replyTo !== null && typeof replyTo !== 'string') throw new HttpError(400, 'replyTo must be a message id');

  let fromSession: string | null = null;
  if (from !== undefined && from !== null && from !== '') {
    fromSession = sessionIdOf(from, 'from');
    // A sender without hooks (another AI tool) has no row yet. Its first
    // message creates one, so the recipient can reply to it.
    if (!(await store.getLiveSession(owner, fromSession))) {
      await store.upsertLiveSession({ sessionId: fromSession, ownerSub: owner, state: 'working', lastEvent: 'message' });
    }
  }

  let recipients: LiveSession[];
  if (to === 'parent' || to === 'children' || to === 'group') {
    if (!fromSession) throw new HttpError(400, `to: "${to}" needs from, the id of the sending session`);
    const sender = (await store.getLiveSession(owner, fromSession))!;
    if (to === 'parent') {
      if (!sender.parentSession) throw new HttpError(404, 'This session has no parent. Link one with recall_session_register.');
      const parentRow = await store.getLiveSession(owner, sender.parentSession);
      if (!parentRow) throw new HttpError(404, `The parent session ${sender.parentSession} is gone.`);
      recipients = [parentRow];
    } else if (to === 'children') {
      recipients = await store.listLiveSessions(owner, { parentSession: fromSession });
      if (!recipients.length) throw new HttpError(404, 'This session has no running children.');
    } else {
      // The group is rooted at the parent, or at this session when it has none.
      const rootId = sender.parentSession ?? sender.sessionId;
      const root = await store.getLiveSession(owner, rootId);
      const members = [
        ...(root && root.state !== 'ended' ? [root] : []),
        ...(await store.listLiveSessions(owner, { parentSession: rootId })),
      ];
      recipients = members.filter((m) => m.sessionId !== fromSession);
      if (!recipients.length) throw new HttpError(404, 'No other running session is in this group.');
    }
  } else {
    recipients = [await resolveOne(store, owner, to)];
  }
  if (fromSession && recipients.some((r) => r.sessionId === fromSession)) {
    throw new HttpError(400, 'a session cannot send a message to itself');
  }

  const messages = await store.sendSessionMessages(owner, {
    fromSession, toSessions: recipients.map((r) => r.sessionId), body, replyTo: replyTo || null,
  });
  res.json({
    messages,
    recipients: recipients.map((r) => ({ sessionId: r.sessionId, label: r.label, state: r.state })),
  });
}));

router.post('/inbox', handle(async (req, res, store) => {
  const sessionId = sessionIdOf(req.body?.sessionId, 'sessionId');
  const limit = typeof req.body?.limit === 'number' ? req.body.limit : undefined;
  res.json({ messages: await store.takeSessionMessages(actor(req), sessionId, limit) });
}));

router.post('/ack', handle(async (req, res, store) => {
  const sessionId = sessionIdOf(req.body?.sessionId, 'sessionId');
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || ids.length > 200 || !ids.every((i) => typeof i === 'string' && /^m_[0-9a-f]{1,64}$/.test(i))) {
    throw new HttpError(400, 'ids must be a list of at most 200 message ids');
  }
  res.json({ acked: await store.ackSessionMessages(actor(req), sessionId, ids) });
}));

// Registered last: `/:address` would otherwise also match the fixed paths.
router.get('/:address', handle(async (req, res, store) => {
  const owner = actor(req);
  const session = await resolveOne(store, owner, req.params.address);
  const n = req.query.messages ? parseInt(String(req.query.messages), 10) : 20;
  const messages = await store.listSessionMessages(owner, session.sessionId, Number.isFinite(n) ? n : 20);
  res.json({ session: (await withCards(store, [session]))[0], messages });
}));

export default router;
