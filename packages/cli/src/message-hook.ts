/**
 * The message hook. Claude Code runs it with the hook payload on stdin:
 *
 *   message-hook.js           on SessionStart, UserPromptSubmit, Stop, SessionEnd
 *   message-hook.js --wait    with asyncRewake, on SessionStart, UserPromptSubmit, Stop
 *
 * message-hook-core.ts says what each run does. It is its own bundle and
 * imports only what one run needs, because it starts on every turn.
 *
 * Silent on every failure. A hook that prints a stack trace into a turn is a
 * hook the user removes. CHAT_RECALL_MESSAGE_HOOK=0 turns it off.
 * CHAT_RECALL_MESSAGE_HOOK_DEBUG=1 writes the reason for each silent exit to
 * stderr, which Claude Code shows only in its debug output.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recallTarget } from '@chat-recall/engine/core/remote-target.js';
import { getDataDir } from '@chat-recall/engine/core/data-dir.js';
import type { WireMessage } from '@chat-recall/engine/core/session-messages.js';
import { fetchWithTimeout } from './http.js';
import {
  EMPTY_STATE, planRun, renderRun, renderWake, sessionIdOf, type HookPayload, type HookState,
} from './message-hook-core.js';

/** State files of sessions that never reported their end are removed after a week. */
const STATE_TTL_MS = 7 * 24 * 3600_000;
/** One long-poll; the server holds it for at most 25 s. */
const WAIT_SECS = 25;

type Target = { base: string; token: string };

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
  } catch { /* the next run starts from empty state, which only costs one extra introduction */ }
}

function removeFile(name: string): void {
  try { unlinkSync(join(stateDir(), name)); } catch { /* already gone */ }
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

function headers(target: Target): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (target.token) h.authorization = `Bearer ${target.token}`;
  return h;
}

async function post<T>(target: Target, path: string, body: unknown, ms: number): Promise<{ status: number; body: T | null }> {
  const res = await fetchWithTimeout(`${target.base}${path}`, { method: 'POST', headers: headers(target), body: JSON.stringify(body) }, ms);
  if (!res.ok) return { status: res.status, body: null };
  return { status: res.status, body: await res.json() as T };
}

async function ack(target: Target, sessionId: string, messages: readonly WireMessage[]): Promise<void> {
  try {
    const r = await post(target, '/api/live-sessions/ack', { sessionId, ids: messages.map((m) => m.id) }, 3000);
    if (r.status !== 200) debug(`acknowledgement answered HTTP ${r.status}`);
  } catch (e) { debug(`acknowledgement failed: ${e instanceof Error ? e.message : String(e)}`); }
}

/** Write, and wait until the bytes have left this process. */
function writeOut(stream: NodeJS.WriteStream, text: string): Promise<void> {
  return new Promise((resolve) => stream.write(text, () => resolve()));
}

// ── Turn hooks ──────────────────────────────────────────────────────────────

async function turn(payload: HookPayload, target: Target): Promise<void> {
  setTimeout(() => process.exit(0), 6000).unref();
  const sessionId = sessionIdOf(payload);
  const state = sessionId ? readState(sessionId) : { ...EMPTY_STATE };
  const plan = planRun(payload, state);
  if (!plan) return debug('no session id, or an event this hook does not handle');

  // A session that a parent started (recall_session_spawn) carries its name,
  // its parent and its task in the environment; SessionStart links it.
  const link = plan.event === 'SessionStart' ? {
    parent: process.env.CHAT_RECALL_PARENT_SESSION || undefined,
    label: process.env.CHAT_RECALL_SESSION_NAME || undefined,
    doing: process.env.CHAT_RECALL_SESSION_DOING || undefined,
  } : {};

  let messages: WireMessage[] = [];
  let labels: Record<string, string> = {};
  try {
    const r = await post<{ messages?: WireMessage[]; labels?: Record<string, string> }>(target, '/api/live-sessions/event', {
      sessionId: plan.sessionId, event: plan.event, cwd: plan.cwd, take: plan.take, ...link,
    }, 4000);
    if (!r.body) return debug(`server answered HTTP ${r.status}`);
    messages = r.body.messages ?? [];
    labels = r.body.labels ?? {};
  } catch (e) { return debug(`request failed: ${e instanceof Error ? e.message : String(e)}`); }

  const now = Date.now();
  if (plan.event === 'SessionEnd') {
    removeFile(`${plan.sessionId}.json`);
    return;
  }
  if (plan.event === 'SessionStart') pruneStates(now);

  const result = renderRun(plan, messages, state, now, new Map(Object.entries(labels)));
  // Empty is the default profile; recall_session_spawn starts a child in the same one.
  result.state.configDir = process.env.CLAUDE_CONFIG_DIR ?? '';
  writeState(plan.sessionId, result.state);
  if (!result.stdout) return;
  // Acknowledge only after the messages are written out. If this process is
  // stopped before the acknowledgement, the server offers them again when the
  // lease ends: a message can arrive twice, and it is never lost.
  await writeOut(process.stdout, result.stdout);
  if (messages.length) await ack(target, plan.sessionId, messages);
}

// ── The waiter ──────────────────────────────────────────────────────────────

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * The processes above this one that must stay alive: the parent and, when it
 * can be read, the grandparent. Claude Code may run the hook through a shell,
 * and a shell can outlive the Claude process that started it.
 */
function ancestors(): number[] {
  const out = [process.ppid];
  try {
    const stat = readFileSync(`/proc/${process.ppid}/stat`, 'utf-8');
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    if (ppid > 1) out.push(ppid);
  } catch {
    try {
      const ppid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(process.ppid)], { encoding: 'utf8', timeout: 2000 }).trim());
      if (ppid > 1) out.push(ppid);
    } catch { /* the parent alone */ }
  }
  return out;
}

/** Take the session's waiter slot; false when a live waiter already holds it. */
function claimWaiter(sessionId: string): boolean {
  const lock = join(stateDir(), `${sessionId}.waiter`);
  try {
    const pid = Number(readFileSync(lock, 'utf-8'));
    if (pid && pid !== process.pid && alive(pid)) return false;
  } catch { /* no waiter yet */ }
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(lock, String(process.pid));
  } catch { return false; }
  return true;
}

function releaseWaiter(sessionId: string): void {
  try {
    if (Number(readFileSync(join(stateDir(), `${sessionId}.waiter`), 'utf-8')) === process.pid) removeFile(`${sessionId}.waiter`);
  } catch { /* gone */ }
}

async function wait(payload: HookPayload, target: Target): Promise<number> {
  const sessionId = sessionIdOf(payload);
  if (!sessionId) { debug('waiter: no session id'); return 0; }
  if (typeof payload.agent_id === 'string' && payload.agent_id) { debug('waiter: not inside a subagent'); return 0; }
  if (!claimWaiter(sessionId)) { debug('waiter: another waiter runs for this session'); return 0; }
  const watch = ancestors();
  let failures = 0;
  let notFound = 0;
  try {
    for (;;) {
      if (!watch.every(alive)) { debug('waiter: the session process is gone'); return 0; }
      let r: { status: number; body: { ended?: boolean; messages?: WireMessage[]; labels?: Record<string, string> } | null };
      try {
        r = await post(target, '/api/live-sessions/wait', { sessionId, timeoutSecs: WAIT_SECS }, (WAIT_SECS + 15) * 1000);
      } catch (e) {
        r = { status: 0, body: null };
        debug(`waiter: request failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (r.status === 401 || r.status === 402 || r.status === 403) { debug(`waiter: HTTP ${r.status}`); return 0; }
      if (!r.body) {
        // A 404 at start is the SessionStart report still on its way, so a few
        // are retried. More of them mean a server without this route, or a
        // session it will never know: polling it for longer only adds load.
        // Anything else is the network: back off, and stop after an hour.
        failures += 1;
        notFound = r.status === 404 ? notFound + 1 : 0;
        if (notFound >= 5 || failures > 120) return 0;
        await new Promise((res) => setTimeout(res, Math.min(30_000, 1000 * 2 ** Math.min(failures, 5))));
        continue;
      }
      failures = 0;
      notFound = 0;
      if (r.body.ended) { debug('waiter: the session ended'); return 0; }
      const messages = r.body.messages ?? [];
      if (!messages.length) continue;
      await writeOut(process.stderr, renderWake(sessionId, messages, Date.now(), new Map(Object.entries(r.body.labels ?? {}))) + '\n');
      await ack(target, sessionId, messages);
      // Exit code 2 is what makes Claude Code wake the session with stderr.
      return 2;
    }
  } finally {
    releaseWaiter(sessionId);
  }
}

async function main(): Promise<number> {
  if (process.env.CHAT_RECALL_MESSAGE_HOOK === '0') return 0;
  const raw = await readStdin();
  let payload: HookPayload;
  try { payload = JSON.parse(raw) as HookPayload; } catch { debug('stdin is not JSON'); return 0; }
  const target = recallTarget();
  if (!target) { debug('no login: run `chat-recall login`'); return 0; }
  if (process.argv.includes('--wait')) return wait(payload, target);
  await turn(payload, target);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => { debug(e instanceof Error ? e.message : String(e)); process.exit(0); },
);
