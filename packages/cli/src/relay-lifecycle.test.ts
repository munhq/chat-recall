import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough, Writable } from 'node:stream';
import { bridge, parentGone, pidAlive, watchParent, type ParentProbe } from './relay-lifecycle.js';

const posix = process.platform !== 'win32';

/** A daemon stand-in: counts live connections the way runDaemon() does. */
async function fakeDaemon(opts: { allowHalfOpen?: boolean; greet?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'relay-life-'));
  const path = join(dir, 'd.sock');
  const state = { live: 0, received: '' };
  const conns: Socket[] = [];
  const server: Server = createServer({ allowHalfOpen: opts.allowHalfOpen ?? false }, (s) => {
    state.live += 1;
    conns.push(s);
    s.on('data', (d) => { state.received += d.toString(); });
    s.on('close', () => { state.live -= 1; });
    s.on('error', () => {});
    if (opts.greet) s.write(opts.greet);
  });
  await new Promise<void>((r) => server.listen(path, () => r()));
  const connect = async (): Promise<Socket> => {
    const { connect: c } = await import('node:net');
    return new Promise((resolve, reject) => {
      const sock = c(path);
      sock.once('connect', () => resolve(sock));
      sock.once('error', reject);
    });
  };
  const close = async () => {
    for (const s of conns) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  };
  return { state, connect, close };
}

const until = async (cond: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const probe = (ppid: () => number, alive: (pid: number) => boolean = () => true): ParentProbe => ({ ppid, alive });

describe('parent death detection', () => {
  it('sees an orphan by its changed ppid', () => {
    expect(parentGone(4242, probe(() => 1))).toBe(true);
  });

  it('sees a parent that is gone while the ppid still reads the same (Windows)', () => {
    expect(parentGone(4242, probe(() => 4242, () => false))).toBe(true);
  });

  it('keeps a relay whose parent is alive', () => {
    expect(parentGone(4242, probe(() => 4242, () => true))).toBe(false);
  });

  it.runIf(posix)('probes a live pid as alive and an exited one as gone', () => {
    expect(pidAlive(process.pid)).toBe(true);
    const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    expect(pidAlive(child.pid!)).toBe(false);
  });

  it('calls onGone once when the parent goes, and never before', () => {
    vi.useFakeTimers();
    try {
      let ppid = 4242;
      const onGone = vi.fn();
      watchParent(onGone, { probe: probe(() => ppid), intervalMs: 1_000 });
      vi.advanceTimersByTime(5_000);
      expect(onGone).not.toHaveBeenCalled();
      ppid = 1;
      vi.advanceTimersByTime(1_000);
      vi.advanceTimersByTime(5_000);
      expect(onGone).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sets no watch on a process that init started', () => {
    vi.useFakeTimers();
    try {
      const onGone = vi.fn();
      watchParent(onGone, { probe: probe(() => 1, () => false), intervalMs: 1_000 });
      vi.advanceTimersByTime(10_000);
      expect(onGone).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe.runIf(posix)('relay bridge', () => {
  let daemon: Awaited<ReturnType<typeof fakeDaemon>> | null = null;
  afterEach(async () => {
    await daemon?.close();
    daemon = null;
  });

  it('moves bytes both ways', async () => {
    daemon = await fakeDaemon({ greet: 'hello-client' });
    const input = new PassThrough();
    const output = new PassThrough();
    let seen = '';
    output.on('data', (d) => { seen += d.toString(); });
    bridge(input, output, await daemon.connect(), () => {}, { probe: probe(() => 4242) });
    input.write('hello-daemon');
    await until(() => daemon!.state.received === 'hello-daemon' && seen === 'hello-client');
  });

  it('exits and frees its daemon connection when the client closes stdin', async () => {
    daemon = await fakeDaemon();
    const input = new PassThrough();
    const exit = vi.fn();
    bridge(input, new PassThrough(), await daemon.connect(), exit, { probe: probe(() => 4242) });
    await until(() => daemon!.state.live === 1);
    input.end();
    await until(() => exit.mock.calls.length === 1);
    expect(exit).toHaveBeenCalledWith(0);
    await until(() => daemon!.state.live === 0);
  });

  it('exits when stdin breaks without a clean EOF', async () => {
    daemon = await fakeDaemon();
    const input = new PassThrough();
    const exit = vi.fn();
    bridge(input, new PassThrough(), await daemon.connect(), exit, { probe: probe(() => 4242) });
    input.destroy();
    await until(() => exit.mock.calls.length === 1);
    await until(() => daemon!.state.live === 0);
  });

  it('exits when the parent is gone even though stdin never ends', async () => {
    daemon = await fakeDaemon();
    let ppid = 4242;
    const exit = vi.fn();
    bridge(new PassThrough(), new PassThrough(), await daemon.connect(), exit, {
      probe: probe(() => ppid),
      parentPollMs: 20,
    });
    await until(() => daemon!.state.live === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(exit).not.toHaveBeenCalled();
    ppid = 1;
    await until(() => exit.mock.calls.length === 1);
    await until(() => daemon!.state.live === 0);
  });

  it('stops waiting on a daemon that keeps its side open after EOF', async () => {
    daemon = await fakeDaemon({ allowHalfOpen: true });
    const input = new PassThrough();
    const exit = vi.fn();
    bridge(input, new PassThrough(), await daemon.connect(), exit, { probe: probe(() => 4242), drainMs: 50 });
    input.end();
    await until(() => exit.mock.calls.length === 1);
  });

  it('exits when the client can no longer read stdout', async () => {
    daemon = await fakeDaemon({ greet: 'x' });
    const broken = new Writable({ write: (_c, _e, cb) => cb(Object.assign(new Error('EPIPE'), { code: 'EPIPE' })) });
    const exit = vi.fn();
    bridge(new PassThrough(), broken, await daemon.connect(), exit, { probe: probe(() => 4242) });
    await until(() => exit.mock.calls.length === 1);
  });

  it('exits once, however many ways the session ends at the same time', async () => {
    daemon = await fakeDaemon();
    const input = new PassThrough();
    const exit = vi.fn();
    const sock = await daemon.connect();
    bridge(input, new PassThrough(), sock, exit, { probe: probe(() => 4242) });
    input.end();
    sock.destroy();
    await until(() => daemon!.state.live === 0);
    await new Promise((r) => setTimeout(r, 50));
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

describe.runIf(posix)('a real orphaned stdio process', () => {
  it('exits after its parent dies, while another process still holds its stdin open', async () => {
    const lifecycle = fileURLToPath(new URL('./relay-lifecycle.ts', import.meta.url));
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    // The session's MCP process: waits on stdin forever, and can leave only
    // through the parent watch.
    const childSrc = [
      `import { watchParent } from ${JSON.stringify(lifecycle)};`,
      `watchParent(() => process.exit(0), { intervalMs: 50 });`,
      `process.stdin.resume();`,
      `process.stdin.on('end', () => process.stderr.write('child-saw-eof\\n'));`,
      `process.stderr.write('watching\\n');`,
    ].join('\n');
    // The AI tool: starts that process on a pipe, hands a copy of the pipe's
    // write end to a long-lived holder, then dies. The child's stdin never
    // reaches EOF, because the holder still has it open.
    const parentSrc = [
      `const { spawn } = require('node:child_process');`,
      `const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', ${JSON.stringify(childSrc)}],`,
      `  { stdio: ['pipe', 'ignore', 'pipe'], cwd: ${JSON.stringify(repoRoot)} });`,
      `const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'],`,
      `  { stdio: ['ignore', 'ignore', 'ignore', child.stdin], detached: true });`,
      `process.stderr.write('pids:' + child.pid + ':' + holder.pid + '\\n');`,
      // Die only once the child has read its parent pid, so the test is about
      // losing a parent and never about starting without one.
      `child.stderr.on('data', (d) => { process.stderr.write(d); if (String(d).includes('watching')) process.exit(0); });`,
    ].join('\n');
    const parent = spawn(process.execPath, ['-e', parentSrc], { stdio: ['ignore', 'ignore', 'pipe'], cwd: repoRoot });
    let err = '';
    parent.stderr.on('data', (d) => { err += d.toString(); });
    await until(() => /pids:\d+:\d+/.test(err) && err.includes('watching'), 15_000);
    const [, childPid, holderPid] = /pids:(\d+):(\d+)/.exec(err)!.map(Number);
    try {
      if (parent.exitCode === null && parent.signalCode === null) {
        await new Promise<void>((r) => parent.once('exit', () => r()));
      }
      expect(pidAlive(holderPid)).toBe(true);
      await until(() => !pidAlive(childPid), 5_000);
      expect(err).not.toContain('child-saw-eof');
    } finally {
      try { process.kill(holderPid); } catch { /* already gone */ }
    }
  }, 30_000);
});
