/**
 * The message hook: Claude Code runs this on SessionStart, UserPromptSubmit,
 * PostToolUse, Stop and SessionEnd, with the hook payload on stdin.
 *
 * It is its own bundle and imports only what one run needs, because it runs on
 * every tool call. message-hook-core.ts decides what each run does.
 *
 * Silent on every failure. A hook that prints a stack trace into a turn is a
 * hook the user removes. CHAT_RECALL_MESSAGE_HOOK=0 turns it off.
 * CHAT_RECALL_MESSAGE_HOOK_DEBUG=1 writes the reason for each silent exit to
 * stderr, which Claude Code shows only in its debug output.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recallTarget } from '@chat-recall/engine/core/remote-target.js';
import { getDataDir } from '@chat-recall/engine/core/data-dir.js';
import type { WireMessage } from '@chat-recall/engine/core/session-messages.js';
import { fetchWithTimeout } from './http.js';
import { EMPTY_STATE, planRun, renderRun, type HookPayload, type HookState } from './message-hook-core.js';

/** State files of sessions that never reported their end are removed after a week. */
const STATE_TTL_MS = 7 * 24 * 3600_000;

function debug(reason: string): void {
  if (process.env.CHAT_RECALL_MESSAGE_HOOK_DEBUG === '1') process.stderr.write(`chat-recall message hook: ${reason}\n`);
}

function stateDir(): string {
  return join(getDataDir(), 'hook-state', 'messages');
}

function readState(sessionId: string): HookState {
  try {
    return { ...EMPTY_STATE, ...JSON.parse(readFileSync(join(stateDir(), `${sessionId}.json`), 'utf-8')) as Partial<HookState> };
  } catch { return { ...EMPTY_STATE }; }
}

function writeState(sessionId: string, state: HookState): void {
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(join(stateDir(), `${sessionId}.json`), JSON.stringify(state));
  } catch { /* the next run starts from empty state, which only costs one extra poll */ }
}

function dropState(sessionId: string): void {
  try { unlinkSync(join(stateDir(), `${sessionId}.json`)); } catch { /* already gone */ }
}

function pruneStates(now: number): void {
  try {
    for (const f of readdirSync(stateDir())) {
      const p = join(stateDir(), f);
      if (now - statSync(p).mtimeMs > STATE_TTL_MS) unlinkSync(p);
    }
  } catch { /* no directory yet */ }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    const t = setTimeout(() => resolve(buf), 2000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => { clearTimeout(t); resolve(buf); });
    process.stdin.on('error', () => { clearTimeout(t); resolve(buf); });
  });
}

async function main(): Promise<void> {
  if (process.env.CHAT_RECALL_MESSAGE_HOOK === '0') return;
  // The ceiling for the whole run. `unref` lets a finished run exit at once.
  setTimeout(() => process.exit(0), 6000).unref();

  const raw = await readStdin();
  let payload: HookPayload;
  try { payload = JSON.parse(raw) as HookPayload; } catch { return debug('stdin is not JSON'); }

  const now = Date.now();
  const pollSecs = Number(process.env.CHAT_RECALL_MESSAGE_POLL_SECS);
  const pollMs = (Number.isFinite(pollSecs) && pollSecs >= 0 ? pollSecs : 15) * 1000;
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
  const state = sessionId ? readState(sessionId) : { ...EMPTY_STATE };
  const plan = planRun(payload, state, now, pollMs);
  if (!plan) return debug('no session id, or an event this hook does not handle');
  if (plan.skip) return debug('inside the poll window');

  const target = recallTarget();
  if (!target) return debug('no login: run `chat-recall login`');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (target.token) headers.authorization = `Bearer ${target.token}`;

  let messages: WireMessage[] = [];
  let labels: Record<string, string> = {};
  try {
    const res = await fetchWithTimeout(`${target.base}/api/live-sessions/event`, {
      method: 'POST', headers,
      body: JSON.stringify({ sessionId: plan.sessionId, event: plan.event, cwd: plan.cwd, take: plan.take }),
    }, 4000);
    if (!res.ok) return debug(`server answered HTTP ${res.status}`);
    const body = (await res.json()) as { messages?: WireMessage[]; labels?: Record<string, string> };
    messages = body.messages ?? [];
    labels = body.labels ?? {};
  } catch (e) { return debug(`request failed: ${e instanceof Error ? e.message : String(e)}`); }

  if (plan.event === 'SessionEnd') {
    dropState(plan.sessionId);
    return;
  }
  if (plan.event === 'SessionStart') pruneStates(now);

  const result = renderRun(plan, messages, state, now, new Map(Object.entries(labels)));
  writeState(plan.sessionId, result.state);
  if (!result.stdout) return;
  // Acknowledge only after the messages are written out. If this process is
  // stopped before the acknowledgement, the server offers them again when the
  // lease ends: a message can arrive twice, and it is never lost.
  await new Promise<void>((resolve) => process.stdout.write(result.stdout, () => resolve()));
  if (!messages.length) return;
  try {
    const res = await fetchWithTimeout(`${target.base}/api/live-sessions/ack`, {
      method: 'POST', headers,
      body: JSON.stringify({ sessionId: plan.sessionId, ids: messages.map((m) => m.id) }),
    }, 3000);
    if (!res.ok) debug(`acknowledgement answered HTTP ${res.status}`);
  } catch (e) { debug(`acknowledgement failed: ${e instanceof Error ? e.message : String(e)}`); }
}

main().catch((e) => debug(e instanceof Error ? e.message : String(e)));
