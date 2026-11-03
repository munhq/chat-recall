/**
 * The channel: chat-recall's messages delivered into a session that is idle.
 *
 * Every other delivery path chat-recall has is a hook, and a hook runs at the
 * edge of a turn. A session that finished its turn and is waiting for the user
 * runs no hooks at all, so the only thing that could reach it was a waiter
 * process held open with `asyncRewake` and woken by exit code 2 — a process
 * with a lifetime, a timeout, a lock file and a parent to watch. Claude Code's
 * channels need none of that: a local MCP server that declares
 * `capabilities.experimental["claude/channel"]` sends
 * `notifications/claude/channel` and the session takes a turn with it, exactly
 * as if the user had typed it. No turn, no timeout, no lock.
 *
 * What this file does is the half that is ours: find out which session this
 * process belongs to, hold the same long-poll the waiter holds, and hand each
 * batch to the client. The store, the lease and the acknowledgement are the
 * ones already there — a message that the channel takes is leased like any
 * other, so a session cannot get it twice.
 *
 * It runs only when the session named our server on the command line
 * (channel-detect.ts). A session that did not gets nothing from here: its
 * notifications would be dropped by the client, and dropping a message we have
 * already acknowledged is losing it, so we must not start polling at all.
 */
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { recallTarget } from '@chat-recall/engine/core/remote-target.js';
import { formatDelivery, type WireMessage } from '@chat-recall/engine/core/session-messages.js';
import { ancestorPids, channelDecision } from './channel-detect.js';
import { clearChannelAlive, markChannelAlive, sessionIdFromPids } from './channel-state.js';
import { fetchWithTimeout } from './http.js';

/** One long-poll; the server holds it for at most 25 s. */
const WAIT_SECS = 25;
/** How long a session with no id yet keeps asking the hook for one. */
const SESSION_ID_WAIT_MS = 90_000;
/** How often the marker is refreshed; a waiter treats an older one as gone. */
const MARK_EVERY_MS = 30_000;

export interface Target { base: string; token: string }

/**
 * Declare the capability the client looks for.
 *
 * It must be registered BEFORE the transport connects: the client reads
 * `capabilities` from the initialize result and decides once, at connect, that
 * this server may push messages into the session. Registering later is silent —
 * the client has already made up its mind.
 */
export function declareChannel(server: Server): void {
  server.registerCapabilities({ experimental: { 'claude/channel': {} } });
}

/**
 * Prepare a session for channel delivery: declare the capability, and return the
 * function that starts delivering, or null when this session did not ask.
 *
 * The two halves are separate because of when the client decides: it reads the
 * capability once, from the initialize result, and never looks again. So the
 * capability goes in before `connect()`, and the loop starts after — polling a
 * server that is not connected yet would deliver into nothing.
 */
export function beginChannel(server: Server, debug?: (reason: string) => void): (() => void) | null {
  const decision = channelDecision();
  const log = debug ?? ((reason: string) => {
    if (process.env.CHAT_RECALL_MESSAGE_HOOK_DEBUG === '1') process.stderr.write(`chat-recall channel: ${reason}\n`);
  });
  if (!decision.enabled) return null;
  const target = recallTarget();
  if (!target) { log('asked for, but this machine has no login'); return null; }
  declareChannel(server);
  const pids = ancestorPids();
  return () => {
    void runChannel({ server, target, sessionId: () => sessionIdFromPids(pids), debug: log })
      .catch((e) => log(`stopped: ${e instanceof Error ? e.message : String(e)}`));
  };
}

export interface ChannelDeps {
  server: Server;
  target: Target;
  /** The session id, once the hook has recorded it. */
  sessionId: () => string | null;
  debug?: (reason: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  post?: (target: Target, path: string, body: unknown, ms: number) => Promise<{ status: number; body: unknown }>;
}

type WaitBody = { ended?: boolean; messages?: WireMessage[]; labels?: Record<string, string> };

function headers(target: Target): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (target.token) h.authorization = `Bearer ${target.token}`;
  return h;
}

async function postJson(target: Target, path: string, body: unknown, ms: number): Promise<{ status: number; body: unknown }> {
  const res = await fetchWithTimeout(`${target.base}${path}`, {
    method: 'POST', headers: headers(target), body: JSON.stringify(body),
  }, ms);
  return { status: res.status, body: res.ok ? await res.json() : null };
}

/**
 * Deliver messages until the session ends.
 *
 * The loop mirrors the waiter's, on purpose: same endpoint, same lease, same
 * acknowledgement rule (ack only after the message has left this process), and
 * the same give-up rules, so a server without this route costs a few retries
 * rather than a spin.
 */
export async function runChannel(deps: ChannelDeps): Promise<void> {
  const debug = deps.debug ?? (() => {});
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
  const post = deps.post ?? postJson;

  let sessionId = deps.sessionId();
  const giveUpAt = Date.now() + SESSION_ID_WAIT_MS;
  while (!sessionId) {
    if (Date.now() > giveUpAt) { debug('channel: the hook never recorded this session'); return; }
    await sleep(500);
    sessionId = deps.sessionId();
  }
  debug(`channel: delivering for ${sessionId}`);
  markChannelAlive(sessionId);

  let markedAt = Date.now();
  let failures = 0;
  let notFound = 0;
  try {
    for (;;) {
      if (Date.now() - markedAt >= MARK_EVERY_MS) { markChannelAlive(sessionId); markedAt = Date.now(); }
      let r: { status: number; body: unknown };
      try {
        r = await post(deps.target, '/api/live-sessions/wait', { sessionId, timeoutSecs: WAIT_SECS }, (WAIT_SECS + 15) * 1000);
      } catch (e) {
        r = { status: 0, body: null };
        debug(`channel: request failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (r.status === 401 || r.status === 402 || r.status === 403) {
        debug(`channel: HTTP ${r.status}`);
        return;
      }
      const body = r.body as WaitBody | null;
      if (!body) {
        // The same numbers as the waiter: a 404 at the start is the
        // SessionStart report still on its way, and a network that keeps
        // failing is not worth an hour of retries from a process the session
        // cannot see.
        failures += 1;
        notFound = r.status === 404 ? notFound + 1 : 0;
        if (notFound >= 5 || failures > 120) { debug('channel: giving up on the server'); return; }
        await sleep(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)));
        continue;
      }
      failures = 0;
      notFound = 0;
      if (body.ended) { debug('channel: the session ended'); return; }
      const messages = body.messages ?? [];
      if (!messages.length) continue;
      const content = formatDelivery(sessionId, messages, {
        now: (deps.now ?? Date.now)(),
        labels: new Map(Object.entries(body.labels ?? {})),
      });
      try {
        await deps.server.notification({
          method: 'notifications/claude/channel',
          params: { content, meta: { from: 'chat-recall', session: sessionId } },
        });
      } catch (e) {
        // A message the client never got must not be acknowledged: the lease
        // ends and the waiter, or the next turn, offers it again.
        debug(`channel: could not emit: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      await post(deps.target, '/api/live-sessions/ack', { sessionId, ids: messages.map((m) => m.id) }, 3000)
        .catch(() => { /* the lease expiry covers it */ });
    }
  } finally {
    clearChannelAlive(sessionId);
  }
}
