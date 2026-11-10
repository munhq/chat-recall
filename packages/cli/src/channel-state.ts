/**
 * The two files the message hook and the channel share.
 *
 * They run in sibling processes — Claude Code starts one per hook and one MCP
 * server — and they can tell each other only through the state folder both
 * already use. Two questions cross it:
 *
 *   by-pid/<pid>      which Claude session is this process's parent?
 *                     The hook is told the session id; the MCP server is not,
 *                     and cannot ask. Written by the hook, read by the channel.
 *
 *   <session>.channel the channel is delivering for this session.
 *                     Written by the channel every 30 s, read by the waiter,
 *                     which stands down while it is fresh. Without it both hold
 *                     the same lease and race for the same message.
 *
 * Deliberately engine-free: the message hook is its own bundle and starts on
 * every turn of every session, so it must not pay for the tool surface.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@chat-recall/engine/core/data-dir.js';

/** After this with no refresh, a waiter stops trusting the marker. */
export const CHANNEL_GONE_MS = 120_000;

/** The state folder the message hook and the waiter already share. */
export function channelStateDir(): string {
  return join(getDataDir(), 'hook-state', 'messages');
}

function byPidDir(): string {
  return join(channelStateDir(), 'by-pid');
}

function markerPath(sessionId: string): string {
  return join(channelStateDir(), `${sessionId}.channel`);
}

function readText(path: string): string | null {
  try { return readFileSync(path, 'utf-8').trim(); } catch { return null; }
}

/**
 * The kernel's boot-relative start time of a process, or null.
 *
 * A pid is reused, and a record that outlived its process would then name
 * another session's claude. The start time is what tells two processes with the
 * same pid apart: it differs even when the pid does not.
 */
function startTimeOf(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const started = rest[19]; // field 22 of /proc/<pid>/stat
    if (started && /^\d+$/.test(started)) return started;
  } catch { /* not Linux, or the process is gone */ }
  // macOS has no /proc, and its `ps` prints the start time of a process as a date.
  // Windows has neither: the record then carries no start time.
  if (process.platform === 'win32') return null;
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const ms = out ? Date.parse(out) : NaN;
    return Number.isFinite(ms) ? String(ms) : null;
  } catch { return null; }
}

/**
 * Say which session this process belongs to, keyed by the processes above it.
 *
 * The hook is the only thing that ever learns the session id — Claude Code puts
 * it in the hook payload — and it runs in a sibling process of the MCP server,
 * so a file is the only thing they can share. Keyed by the parent pid because
 * that is what both processes have in common: their own `claude`.
 */
export function recordSessionForPids(sessionId: string, pids: readonly number[]): void {
  if (!sessionId || !pids.length) return;
  try {
    mkdirSync(byPidDir(), { recursive: true });
    for (const pid of pids) {
      if (!Number.isInteger(pid) || pid <= 1) continue;
      const path = join(byPidDir(), String(pid));
      const started = startTimeOf(pid);
      const want = started ? `${sessionId} ${started}` : sessionId;
      if (readText(path) === want) continue;
      writeFileSync(path, want);
    }
  } catch { /* a session without the file keeps the hook path */ }
}

/** The session id the hook recorded for one of the processes above us. */
export function sessionIdFromPids(pids: readonly number[]): string | null {
  for (const pid of pids) {
    const raw = readText(join(byPidDir(), String(pid)));
    if (!raw) continue;
    const [id, started] = raw.split(' ');
    // A record with a start time is only for the process that wrote it. One
    // without (an older build, or a platform with no /proc) is taken as is.
    if (started !== undefined && started !== startTimeOf(pid)) continue;
    if (id) return id;
  }
  return null;
}

/**
 * Forget the records of processes that are gone.
 *
 * One file per session, and nothing else would ever remove them: the hook is
 * the only writer and it writes only for its own session.
 */
export function pruneSessionPids(): void {
  try {
    for (const f of readdirSync(byPidDir())) {
      const pid = Number(f);
      if (!Number.isInteger(pid) || pid <= 1) { try { unlinkSync(join(byPidDir(), f)); } catch { /* raced */ } continue; }
      if (alive(pid)) continue;
      try { unlinkSync(join(byPidDir(), f)); } catch { /* raced */ }
    }
  } catch { /* no directory yet */ }
}

/**
 * Claim delivery for this session, so the waiter stops competing for it.
 *
 * Two consumers of the same lease would each deliver a message: the loser is
 * only spared a duplicate while the winner's lease holds. The marker is how the
 * waiter knows which of them owns the session.
 */
export function markChannelAlive(sessionId: string): void {
  try {
    mkdirSync(channelStateDir(), { recursive: true });
    const started = startTimeOf(process.pid);
    writeFileSync(markerPath(sessionId), started ? `${process.pid} ${started}` : String(process.pid));
  } catch { /* the waiter keeps delivering; a duplicate beats a silence */ }
}

/** Remove the claim, so the waiter takes over again on the next turn. */
export function clearChannelAlive(sessionId: string): void {
  try {
    // Only our own claim: a session restarted since may have a newer channel,
    // and removing its marker would hand a live session back to a waiter.
    if (readMarker(sessionId)?.pid !== process.pid) return;
    unlinkSync(markerPath(sessionId));
  } catch { /* already gone */ }
}

function readMarker(sessionId: string): { pid: number; started?: string; mtime: number } | null {
  try {
    const path = markerPath(sessionId);
    const [pidText, started] = readFileSync(path, 'utf-8').trim().split(' ');
    const pid = Number(pidText);
    if (!Number.isInteger(pid) || pid <= 1) return null;
    return { pid, started, mtime: statSync(path).mtimeMs };
  } catch { return null; }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Whether a live channel is delivering for this session right now. */
export function channelOwnsSession(sessionId: string, now = Date.now()): boolean {
  const marker = readMarker(sessionId);
  if (!marker) return false;
  if (now - marker.mtime > CHANNEL_GONE_MS) return false;
  if (!alive(marker.pid)) return false;
  // The pid alone is not enough for a marker that lives for a week: the kernel
  // reuses pids, and a reused one would hold a waiter off a session that has no
  // channel — the silence this file exists to prevent.
  return marker.started === undefined || marker.started === startTimeOf(marker.pid);
}
