/**
 * The message hook. Claude Code runs it with the hook payload on stdin:
 *
 *   message-hook.js           on SessionStart, UserPromptSubmit, Stop, SessionEnd
 *   message-hook.js --wait    with asyncRewake, on SessionStart, UserPromptSubmit, Stop
 *
 * The other AI tools run it as `message-hook.js --tool <id>` (Antigravity adds
 * `--event <name>`, because its payload names no event). The opencode plugin
 * and the pi extension also run the waiter: it prints the messages on stdout
 * and exits 0, and the plugin starts a turn with them. The other tools have no
 * way to wake an idle session.
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
import { adoptSealkeepSecrets } from '@chat-recall/engine/core/stored-token.js';
import { getDataDir } from '@chat-recall/engine/core/data-dir.js';
import { projectOfFolder } from '@chat-recall/engine/core/session-project.js';
import type { WireMessage } from '@chat-recall/engine/core/session-messages.js';
import { fetchWithTimeout } from './http.js';
import { channelOwnsSession, pruneSessionPids, recordSessionForPids } from './channel-state.js';
import {
  EMPTY_STATE, emptyOutput, isHookTool, normalizePayload, planRun, processKindOf, renderRun, renderWake, sessionIdOf,
  type HookPayload, type HookState, type HookTool,
} from './message-hook-core.js';

/** State files of sessions that never reported their end are removed after a week. */
const STATE_TTL_MS = 7 * 24 * 3600_000;
/** One long-poll; the server holds it for at most 25 s. */
const WAIT_SECS = 25;
/** The unit of the wait between two failed requests of the waiter: 1 s, then 2, 4, 8, 16 and 32 units, at most 30 s.
 *  A test of the waiter sets a short unit through CHAT_RECALL_WAIT_BACKOFF_UNIT_MS. */
const BACKOFF_UNIT_MS = (() => {
  const v = Number(process.env.CHAT_RECALL_WAIT_BACKOFF_UNIT_MS);
  return Number.isFinite(v) && v > 0 ? v : 1000;
})();

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
      try {
        // by-pid/ is a directory in here, and unlinking it would abort the
        // loop and leave every stale file behind.
        if (!statSync(p).isFile()) continue;
        if (now - statSync(p).mtimeMs > STATE_TTL_MS) unlinkSync(p);
      } catch { /* another session pruned it first */ }
    }
  } catch { /* no directory yet */ }
  pruneSessionPids();
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

/** The repository of a folder, or undefined. Never throws: a hook stays silent on every failure. */
function projectOf(folder: string | undefined): string | undefined {
  if (!folder) return undefined;
  try { return projectOfFolder(folder) ?? undefined; } catch { return undefined; }
}

// ── Turn hooks ──────────────────────────────────────────────────────────────

async function turn(payload: HookPayload, target: Target, tool: HookTool): Promise<void> {
  setTimeout(() => process.exit(0), 6000).unref();
  const sessionId = sessionIdOf(payload);
  const state = sessionId ? readState(sessionId) : { ...EMPTY_STATE };
  const plan = planRun(payload, state, tool);
  if (!plan) return debug('no session id, or an event this hook does not handle');

  // A session that a parent started (recall_session_spawn) carries its name,
  // its parent and its task in the environment; SessionStart links it.
  const link = plan.event === 'SessionStart' ? {
    parent: process.env.CHAT_RECALL_PARENT_SESSION || undefined,
    label: process.env.CHAT_RECALL_SESSION_NAME || undefined,
    doing: process.env.CHAT_RECALL_SESSION_DOING || undefined,
  } : {};

  // The MCP server of this same session has no way to learn its id, and a
  // channel needs it to poll. This is the only process that is told.
  recordSessionForPids(plan.sessionId, ancestors());

  let messages: WireMessage[] = [];
  let labels: Record<string, string> = {};
  try {
    const r = await post<{ messages?: WireMessage[]; labels?: Record<string, string> }>(target, '/api/live-sessions/event', {
      sessionId: plan.sessionId, event: plan.event, cwd: plan.cwd, take: plan.take,
      project: projectOf(plan.cwd),
      kind: processKindOf(tool, payload), pid: processPid(payload), ...link,
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

  const result = renderRun(plan, messages, state, now, new Map(Object.entries(labels)), tool);
  // Empty is the default profile; recall_session_spawn starts a child in the same one.
  if (tool === 'claude') result.state.configDir = process.env.CLAUDE_CONFIG_DIR ?? '';
  writeState(plan.sessionId, result.state);
  if (!result.stdout) {
    const empty = emptyOutput(tool, plan.event);
    if (empty) await writeOut(process.stdout, empty);
    return;
  }
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
    // Windows has no ps that takes -o: the ps of Git Bash printed its usage to the hook's stderr.
    if (process.platform === 'win32') return out;
    try {
      const ppid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(process.ppid)], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim());
      if (ppid > 1) out.push(ppid);
    } catch { /* the parent alone */ }
  }
  return out;
}

/**
 * The process id the session's row carries: the tool's own, from the payload
 * of a plugin that knows it, else the nearest ancestor that is an AI tool. The
 * hook may run under a shell, so the parent alone is not it.
 */
function processPid(payload: HookPayload): number | undefined {
  const given = payload.pid;
  if (typeof given === 'number' && Number.isInteger(given) && given > 0) return given;
  for (const pid of ancestors()) {
    try {
      const comm = readFileSync(`/proc/${pid}/comm`, 'utf-8').trim();
      if (comm === 'opencode' || comm === 'claude' || comm === 'pi') return pid;
    } catch { /* gone, or no /proc */ }
  }
  return process.ppid > 1 ? process.ppid : undefined;
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

/** Tools whose plugin runs the waiter and starts a turn with what it prints. */
const PLUGIN_WAITERS: ReadonlySet<HookTool> = new Set(['opencode', 'pi']);

async function wait(payload: HookPayload, target: Target, tool: HookTool = 'claude', supervised = false): Promise<number> {
  const sessionId = sessionIdOf(payload);
  if (!sessionId) { debug('waiter: no session id'); return supervised ? 77 : 0; }
  if (typeof payload.agent_id === 'string' && payload.agent_id) { debug('waiter: not inside a subagent'); return supervised ? 77 : 0; }
  // A session whose channel is delivering has no need of this process, and two
  // consumers of the same lease would each deliver: the loser is spared only
  // while the winner's lease holds. The marker is fresh only while the channel
  // polls, so a channel that died hands delivery back here.
  if (channelOwnsSession(sessionId)) { debug('waiter: the channel is delivering for this session'); return 0; }
  if (!claimWaiter(sessionId)) { debug('waiter: another waiter runs for this session'); return supervised ? 76 : 0; }
  const watch = ancestors();
  let failures = 0;
  let notFound = 0;
  try {
    for (;;) {
      if (!watch.every(alive)) { debug('waiter: the session process is gone'); return 0; }
      // Both hooks of a session start at SessionStart, and this one may claim
      // the slot a moment before the channel has the session id it needs. The
      // check at the top therefore cannot be the only one: it would leave two
      // consumers polling the same lease for as long as the session lives.
      // Here the channel's marker can only have been written by a later tick.
      if (channelOwnsSession(sessionId)) { debug('waiter: the channel took over'); return 0; }
      let r: { status: number; body: { ended?: boolean; messages?: WireMessage[]; labels?: Record<string, string> } | null };
      try {
        r = await post(target, '/api/live-sessions/wait', { sessionId, timeoutSecs: WAIT_SECS }, (WAIT_SECS + 15) * 1000);
      } catch (e) {
        r = { status: 0, body: null };
        debug(`waiter: request failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (r.status === 401 || r.status === 402 || r.status === 403) { debug(`waiter: HTTP ${r.status}`); return supervised ? 77 : 0; }
      if (!r.body) {
        // A 404 at start is the SessionStart report still on its way, so a few
        // are retried. More of them mean a server without this route, or a
        // session it will never know: polling it for longer only adds load.
        // Anything else is the network: back off, and stop after an hour.
        failures += 1;
        notFound = r.status === 404 ? notFound + 1 : 0;
        if (notFound >= 5 || failures > 120) return supervised ? 77 : 0;
        await new Promise((res) => setTimeout(res, Math.min(30_000, BACKOFF_UNIT_MS * 2 ** Math.min(failures, 5))));
        continue;
      }
      failures = 0;
      notFound = 0;
      if (r.body.ended) { debug('waiter: the session ended'); return supervised ? 75 : 0; }
      const messages = r.body.messages ?? [];
      if (!messages.length) continue;
      // A lease that this process took while the channel was claiming the
      // session: deliver it through neither. Not acknowledging leaves the
      // message on the server, and the channel takes it when the lease ends —
      // late by a minute, never lost, and never twice.
      if (channelOwnsSession(sessionId)) { debug('waiter: handing the lease to the channel'); return 0; }
      const text = renderWake(sessionId, messages, Date.now(), new Map(Object.entries(r.body.labels ?? {}))) + '\n';
      if (tool === 'claude') {
        await writeOut(process.stderr, text);
        await ack(target, sessionId, messages);
        // Exit code 2 is what makes Claude Code wake the session with stderr.
        return 2;
      }
      await writeOut(process.stdout, text);
      await ack(target, sessionId, messages);
      return 0;
    }
  } finally {
    releaseWaiter(sessionId);
  }
}

// ── A TUI that has no session yet ───────────────────────────────────────────

/**
 * What the opencode TUI plugin runs for as long as its TUI is open.
 *
 * It registers the TUI with its folder before any session exists, so a send to
 * the folder has an address, then long-polls for a message. A message is
 * printed as `{text, ids}` and the run exits without acknowledging it: the
 * plugin creates a session with the text and acknowledges only then, so a TUI
 * that fails before its first prompt leaves the message waiting.
 */
async function presence(payload: HookPayload, target: Target): Promise<number> {
  const sessionId = sessionIdOf(payload);
  if (!sessionId) { debug('presence: no session id'); return 0; }
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : undefined;
  const pid = processPid(payload);
  // The TUI that started this run holds the row. When it exits, the row ends
  // now instead of waiting out the stale window.
  const supervisor = typeof payload.pid === 'number' && Number.isInteger(payload.pid) && payload.pid > 0
    ? payload.pid : undefined;
  let failures = 0;
  const end = async () => {
    await post(target, '/api/live-sessions/event', { sessionId, event: 'SessionEnd' }, 3000).catch(() => null);
    return 0;
  };
  for (;;) {
    if (supervisor && !alive(supervisor)) return end();
    const reg = await post(target, '/api/live-sessions/register', { sessionId, kind: 'tui', cwd, pid, project: projectOf(cwd) }, 4000).catch(() => null);
    if (!reg || reg.status !== 200) {
      failures += 1;
      if (failures > 20) { debug(`presence: registration answered HTTP ${reg?.status ?? 0}`); return 0; }
      await new Promise((res) => setTimeout(res, Math.min(30_000, 2000 * failures)));
      continue;
    }
    for (;;) {
      if (supervisor && !alive(supervisor)) return end();
      let r: { status: number; body: { ended?: boolean; messages?: WireMessage[]; labels?: Record<string, string> } | null };
      try {
        r = await post(target, '/api/live-sessions/wait', { sessionId, timeoutSecs: WAIT_SECS }, (WAIT_SECS + 15) * 1000);
      } catch (e) {
        r = { status: 0, body: null };
        debug(`presence: request failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (r.body && r.body.ended) { debug('presence: the row ended'); return 0; }
      if (!r.body) {
        failures += 1;
        if (r.status === 404) break; // the row is gone: register it again
        if (failures > 20) { debug(`presence: HTTP ${r.status}`); return 0; }
        await new Promise((res) => setTimeout(res, Math.min(30_000, 1000 * 2 ** Math.min(failures, 5))));
        continue;
      }
      failures = 0;
      const messages = r.body.messages ?? [];
      if (!messages.length) continue;
      const text = renderWake(sessionId, messages, Date.now(), new Map(Object.entries(r.body.labels ?? {})));
      await writeOut(process.stdout, JSON.stringify({ text, ids: messages.map((m) => m.id) }) + '\n');
      return 0;
    }
  }
}

/**
 * Report a session's process kind once. The TUI plugin runs it when the
 * session it shows changes, so a session that a `serve` process also reports
 * is marked `tui` (the store never lets another kind overwrite it).
 */
async function report(payload: HookPayload, target: Target): Promise<number> {
  const sessionId = sessionIdOf(payload);
  if (!sessionId) { debug('report: no session id'); return 0; }
  const r = await post(target, '/api/live-sessions/register', {
    sessionId,
    kind: processKindOf('opencode', payload),
    cwd: typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : undefined,
    pid: processPid(payload),
    project: projectOf(typeof payload.cwd === 'string' ? payload.cwd : undefined),
  }, 4000).catch(() => null);
  if (!r || r.status !== 200) debug(`report: HTTP ${r?.status ?? 0}`);
  return 0;
}

/** Acknowledge messages the TUI plugin has delivered. */
async function acknowledge(payload: HookPayload, target: Target): Promise<number> {
  const sessionId = sessionIdOf(payload);
  const ids = Array.isArray(payload.ids) ? payload.ids.filter((i): i is string => typeof i === 'string') : [];
  if (!sessionId || !ids.length) { debug('ack: no session id or no ids'); return 0; }
  try {
    const r = await post(target, '/api/live-sessions/ack', { sessionId, ids }, 3000);
    if (r.status !== 200) debug(`ack: HTTP ${r.status}`);
  } catch (e) { debug(`ack failed: ${e instanceof Error ? e.message : String(e)}`); }
  return 0;
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
async function main(): Promise<number> {
  if (process.env.CHAT_RECALL_MESSAGE_HOOK === '0') return 0;
  // A login that the kit keeps in sealkeep is readable only in a process that `sealkeep run` starts; the hook says nothing if it fails.
  await adoptSealkeepSecrets({ say: (l) => debug(l) });
  const toolArg = argValue('--tool') ?? 'claude';
  if (!isHookTool(toolArg)) { debug(`unknown tool ${toolArg}`); return 0; }
  const raw = await readStdin();
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { debug('stdin is not JSON'); return 0; }

  // The three modes of the opencode TUI plugin. They carry their own payload
  // (a presence id, the session the TUI shows, the ids it delivered), so they
  // run before the turn-hook mapping, which knows no event for them.
  if (process.argv.includes('--presence') || process.argv.includes('--report') || process.argv.includes('--ack')) {
    const target = recallTarget();
    if (!target) { debug('no login: run `chat-recall login`'); return 0; }
    const p = parsed as HookPayload;
    if (process.argv.includes('--presence')) return presence(p, target);
    if (process.argv.includes('--report')) return report(p, target);
    return acknowledge(p, target);
  }

  const payload = normalizePayload(toolArg, parsed, argValue('--event'));
  if (!payload) { debug(`${toolArg}: an event this hook does not handle`); return 0; }
  const target = recallTarget();
  if (!target) { debug('no login: run `chat-recall login`'); return 0; }
  if (process.argv.includes('--wait')) {
    return toolArg === 'claude' || PLUGIN_WAITERS.has(toolArg)
      ? wait(payload, target, toolArg, process.argv.includes('--supervised'))
      : 0;
  }
  await turn(payload, target, toolArg);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => { debug(e instanceof Error ? e.message : String(e)); process.exit(0); },
);
