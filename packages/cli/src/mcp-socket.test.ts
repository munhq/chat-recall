import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  daemonEnabled, ensureSocketDir, socketDirCandidates, socketPath, socketPathFromArgv,
  socketSlug, usableDir,
} from './mcp-socket.js';

const KEYS = [
  'CHAT_RECALL_MCP_PROFILE', 'CHAT_RECALL_SERVER', 'CHAT_RECALL_NO_DAEMON',
  'XDG_RUNTIME_DIR', 'TMPDIR',
] as const;

const posix = process.platform !== 'win32';

describe('mcp daemon address', () => {
  let saved: Record<string, string | undefined>;
  let scratch: string;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    scratch = mkdtempSync(join(tmpdir(), 'cr-sock-'));
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(scratch, { recursive: true, force: true });
  });

  it('sends every session with the same inputs to one daemon', () => {
    // If two sessions on a machine derived different names, each would start a
    // daemon of its own and the split would buy nothing.
    process.env.CHAT_RECALL_MCP_PROFILE = 'lean';
    expect(socketSlug('1.2.3')).toBe(socketSlug('1.2.3'));
    expect(socketSlug('1.2.3')).toHaveLength(16);
  });

  it('gives lean and full their own daemon', () => {
    // The profile decides which tools a server registers, and that list is
    // fixed when the server is built. A session that asked for all 61 tools
    // must not be answered by a daemon that registered 27.
    process.env.CHAT_RECALL_MCP_PROFILE = 'lean';
    const lean = socketSlug('1.2.3');
    process.env.CHAT_RECALL_MCP_PROFILE = 'full';
    expect(socketSlug('1.2.3')).not.toBe(lean);
  });

  it('gives each backend its own daemon', () => {
    process.env.CHAT_RECALL_SERVER = 'https://chatrecall.dev';
    const hosted = socketSlug('1.2.3');
    process.env.CHAT_RECALL_SERVER = 'http://localhost:5000';
    expect(socketSlug('1.2.3')).not.toBe(hosted);
  });

  it('does not let an upgraded package attach to the old daemon', () => {
    // The upgrade bug this guards against is the invisible one: the handshake
    // succeeds and every answer comes from the version the user believes they
    // replaced.
    expect(socketSlug('1.2.3')).not.toBe(socketSlug('1.2.4'));
  });

  it('keeps every candidate socket path inside the POSIX sun_path limit', () => {
    // POSIX allows 108 bytes and macOS 104. Over the limit nothing fails
    // loudly: the session cannot connect, waits out its timeout, and quietly
    // loads the whole server itself — the cost the daemon exists to remove.
    if (!posix) return;
    // A TMPDIR shaped like macOS's: long, per-user, and no XDG_RUNTIME_DIR.
    process.env.TMPDIR = '/var/folders/qz/8xk3j2_d1n94k7pz0abcdefgh0000gn/T';
    const candidates = socketDirCandidates();
    expect(candidates.length).toBeGreaterThan(0);
    for (const dir of candidates) {
      expect(socketPath(dir, '1.2.3').length).toBeLessThanOrEqual(104);
    }
  });

  it('prefers XDG_RUNTIME_DIR when it can be used, and makes it private', () => {
    if (!posix) return;
    process.env.XDG_RUNTIME_DIR = scratch;
    const dir = ensureSocketDir();
    expect(dir).toBe(join(scratch, 'chat-recall'));
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('falls back when XDG_RUNTIME_DIR points somewhere unusable', () => {
    // Both variables come from the environment, so a stale or sandboxed value
    // must cost a session nothing: the next candidate is tried. `/proc/x` is
    // the nastiest shape — mkdir reports ENOENT rather than EACCES, so the
    // parent exists and the child never can.
    if (!posix) return;
    process.env.XDG_RUNTIME_DIR = '/proc/no-such-place';
    process.env.TMPDIR = scratch;
    const dir = ensureSocketDir();
    expect(dir.startsWith('/proc/')).toBe(false);
    expect(dir).toBe(join(scratch, `chat-recall-${process.getuid!()}`));
    expect(usableDir(dir)).toBe(true);
  });

  it('always ends the candidate list with a plain /tmp directory', () => {
    // A TMPDIR long enough to break the path limit, or one that cannot be
    // written, still leaves /tmp — which is what the last candidate is for.
    if (!posix) return;
    process.env.XDG_RUNTIME_DIR = '/proc/no-such-place';
    process.env.TMPDIR = '/proc/also-no-such-place';
    expect(socketDirCandidates().at(-1)).toBe(`/tmp/chat-recall-${process.getuid!()}`);
    expect(usableDir('/proc/no-such-place/chat-recall')).toBe(false);
    expect(usableDir('/proc/one/two/three/four/five/six/seven/eight')).toBe(false);
  });

  it('reports a directory it cannot create as unusable instead of throwing', () => {
    expect(usableDir(join(scratch, 'fresh', 'deeper'))).toBe(true);
    if (posix) expect(usableDir('/proc/no-such-place/x')).toBe(false);
  });

  it('lets the relay dictate the socket path to the daemon it starts', () => {
    // The relay resolved a directory and waits on that exact path. A daemon
    // that resolved again could land elsewhere, and the relay would wait out
    // its whole timeout on a socket that never appears.
    expect(socketPathFromArgv(['node', 'mcp.js', '--daemon', '--socket', '/run/x.sock'])).toBe('/run/x.sock');
    expect(socketPathFromArgv(['node', 'mcp.js', '--daemon'])).toBeUndefined();
    // A flag with no value must not swallow the next flag as its path.
    expect(socketPathFromArgv(['node', 'mcp.js', '--socket', '--daemon'])).toBeUndefined();
  });

  it('is on by default and off only when asked', () => {
    expect(daemonEnabled()).toBe(true);
    process.env.CHAT_RECALL_NO_DAEMON = '1';
    expect(daemonEnabled()).toBe(false);
    process.env.CHAT_RECALL_NO_DAEMON = 'true';
    expect(daemonEnabled()).toBe(false);
    // An empty or explicitly false value repeats the default rather than
    // turning the daemon off, so an exported-but-blank variable is harmless.
    process.env.CHAT_RECALL_NO_DAEMON = '0';
    expect(daemonEnabled()).toBe(true);
    process.env.CHAT_RECALL_NO_DAEMON = '';
    expect(daemonEnabled()).toBe(true);
  });
});
