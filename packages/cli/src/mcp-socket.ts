/**
 * Where a chat-recall MCP daemon listens, and how a session reaches it.
 *
 * One daemon per (profile, server, version) — not one per session. Every MCP
 * session on a machine used to be a full copy of this package: the whole bundle
 * loaded, its own background sync loop, its own skills check. They now share
 * one, and each session is a thin relay onto it.
 *
 * Imported by BOTH the relay and the server, so it may use Node builtins only.
 * Anything heavier here lands in the relay bundle and undoes the point of it.
 */
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accessSync, chmodSync, constants, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/** POSIX allows 108 bytes for a socket path, macOS 104. Stay well inside. */
const MAX_PATH = 100;

/** Room a candidate directory must leave for `/<16-hex slug>.sock`. */
const fits = (dir: string): boolean => dir.length + 1 + 16 + 5 <= MAX_PATH;

/**
 * Every directory the socket and the daemon log may live in, best first.
 *
 * XDG_RUNTIME_DIR first: it is per-user, mode 0700, and cleared on logout, so a
 * socket never outlives the login session that made it. macOS never sets it,
 * hence the per-uid directory under TMPDIR — which is also what keeps one
 * user's socket out of another's reach on a shared /tmp. `/tmp` itself is the
 * last resort: a TMPDIR long enough to break the path limit still leaves it.
 *
 * This is a LIST, not one answer, because every entry but the last comes from
 * the environment. A sandbox, a read-only mount or a stale variable pointing at
 * a directory this user cannot write makes the first choice fail, and one
 * failed candidate must cost a session nothing: the next one is tried.
 */
export function socketDirCandidates(): string[] {
  if (process.platform === 'win32') {
    const out: string[] = [];
    if (process.env.LOCALAPPDATA) out.push(join(process.env.LOCALAPPDATA, 'chat-recall', 'run'));
    if (process.env.TEMP) out.push(join(process.env.TEMP, 'chat-recall-run'));
    out.push(join(tmpdir(), 'chat-recall-run'));
    return out;
  }
  const out: string[] = [];
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg && xdg.length > 0) {
    const p = join(xdg, 'chat-recall');
    if (fits(p)) out.push(p);
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const named = join(tmpdir(), `chat-recall-${uid}`);
  if (fits(named)) out.push(named);
  const last = `/tmp/chat-recall-${uid}`;
  if (!out.includes(last)) out.push(last);
  return out;
}

/** How many missing levels this will build before giving up. A runtime
 *  directory is one or two below something that already exists; deeper than
 *  this means the path is wrong, not a tree worth creating. */
const MAX_MISSING_LEVELS = 8;

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Create `dir` if it is missing, and report whether it is a directory this
 * process can write afterwards. Never throws: a candidate that cannot be used
 * is a reason to try the next one, not a failure.
 *
 * Deliberately NOT `mkdirSync(dir, { recursive: true })`. Node 23's recursive
 * mkdir walks BACK to the parent whenever a component reports ENOENT and
 * forward again when one exists — and a path whose parent exists while the
 * child still reports ENOENT makes it oscillate between the two forever, at
 * 100% of a core. `/proc/anything` does exactly that on Linux: `mkdir
 * /proc/x` returns ENOENT, not EACCES. This path comes from XDG_RUNTIME_DIR or
 * TMPDIR — the values this program does not control — so it must never be
 * handed to that loop. (Verified on Node v23.9.0: the recursive call never
 * returns; a single-level `mkdirSync` on the same path throws ENOENT at once.)
 *
 * This walks up to the deepest ancestor that already exists, bounded, then
 * creates forward from there ONE level at a time. It never revisits a level,
 * so it cannot spin.
 */
export function usableDir(dir: string): boolean {
  if (!isDir(dir)) {
    // Collect missing components up to the first existing ancestor.
    const missing: string[] = [];
    let cur = dir;
    let base = false;
    while (missing.length < MAX_MISSING_LEVELS) {
      const parent = dirname(cur);
      if (parent === cur) break; // reached the root
      missing.push(cur);
      if (isDir(parent)) {
        base = true;
        break;
      }
      cur = parent;
    }
    // No existing directory within the bound: the path is not somewhere this
    // program should be building a tree.
    if (!base) return false;

    for (let i = missing.length - 1; i >= 0; i--) {
      try {
        mkdirSync(missing[i]); // single level — throws ENOENT rather than spins
      } catch {
        /* judged by what exists, not by what mkdir said (EEXIST is fine) */
      }
      if (!isDir(missing[i])) return false;
    }
  }
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The runtime directory for this user: the first candidate that can be used,
 * created and made private on the way. Throws only when NO candidate works,
 * which the relay turns into serving the session in-process.
 */
export function ensureSocketDir(): string {
  const candidates = socketDirCandidates();
  for (const dir of candidates) {
    if (!usableDir(dir)) continue;
    if (process.platform !== 'win32') {
      try {
        chmodSync(dir, 0o700);
      } catch {
        /* a filesystem with no POSIX modes; the path is still per-user */
      }
    }
    return dir;
  }
  throw new Error(`no writable runtime directory for the MCP daemon (tried ${candidates.join(', ')})`);
}

/**
 * What makes two sessions share a daemon.
 *
 * The profile decides WHICH TOOLS a server registers — "lean" is 27, "full" is
 * all 61 — and that list is fixed when the server object is built. Two sessions
 * that asked for different lists therefore cannot share one daemon; keying on it
 * gives them one each. The server URL is in the key for the same reason: a
 * daemon holds a connection to one backend.
 *
 * The version is in it because without it an upgraded package would attach to a
 * daemon still running the old code — the handshake would succeed and every
 * answer would come from the version the user believes they replaced.
 */
export function socketSlug(version: string): string {
  const key = [
    process.env.CHAT_RECALL_MCP_PROFILE ?? '',
    process.env.CHAT_RECALL_SERVER ?? '',
    version,
  ].join(' ');
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * The address the daemon listens on, inside the runtime directory the caller
 * resolved with `ensureSocketDir()`.
 *
 * Windows gets a named pipe rather than a file. Node's local-domain sockets ARE
 * named pipes there, and a path outside the pipe namespace is not a valid one —
 * so this is the native equivalent, not a workaround. It also needs no
 * directory and leaves nothing behind when the daemon dies.
 */
export function socketPath(dir: string, version: string): string {
  const slug = socketSlug(version);
  if (process.platform === 'win32') return '\\\\.\\pipe\\chat-recall-' + slug;
  return join(dir, `${slug}.sock`);
}

/** Where a daemon's diagnostics go. Never a session's stderr: it outlives it. */
export function logPath(dir: string, version: string): string {
  return join(dir, `${socketSlug(version)}.log`);
}

/**
 * The flag the relay hands the daemon it starts. The relay already resolved a
 * directory and is waiting on that exact path, so the daemon binds there rather
 * than resolving again — a second resolution could land somewhere else if the
 * environment shifted between the two processes.
 */
export const SOCKET_FLAG = '--socket';

/** The path given with `--socket`, if the process was started with one. */
export function socketPathFromArgv(argv: readonly string[]): string | undefined {
  const i = argv.indexOf(SOCKET_FLAG);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : undefined;
}

/** True unless the user asked to keep everything inside their own session. */
export function daemonEnabled(): boolean {
  const v = process.env.CHAT_RECALL_NO_DAEMON;
  if (v === undefined) return true;
  const t = v.trim();
  return t === '' || t === '0' || t === 'false';
}
