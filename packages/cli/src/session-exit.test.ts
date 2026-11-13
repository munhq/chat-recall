import { describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parentGone, pidAlive, watchParent, type ParentProbe } from './session-exit.js';

const posix = process.platform !== 'win32';

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

  it('keeps the server whose parent is alive', () => {
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

  it('sets no watch on a process that a service manager started', () => {
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

describe.runIf(posix)('a real orphaned stdio process', () => {
  it('exits after its parent dies, while another process still holds its stdin open', async () => {
    const exitPath = fileURLToPath(new URL('./session-exit.ts', import.meta.url));
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const goneFile = join(tmpdir(), `chat-recall-orphan-${process.pid}-${Date.now()}.gone`);
    // The MCP server of the machine: waits on stdin forever, and can leave only
    // through the parent watch.
    const childSrc = [
      `import { writeFileSync } from 'node:fs';`,
      `import { watchParent } from ${JSON.stringify(exitPath)};`,
      // The parent holds the only pipe to this process, so the child reports
      // the loss of its parent in a file that outlives the pipe.
      `watchParent(() => { writeFileSync(${JSON.stringify(goneFile)}, 'gone'); process.exit(0); }, { intervalMs: 50 });`,
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
    await until(() => /pids:\d+:\d+/.test(err) && err.includes('watching'), 90_000).catch((e: Error) => {
      // The wait fails on a slow machine and on a child that died at start. Show
      // what the parent wrote, so the log names which one it was.
      throw new Error(`${e.message}; parent stderr: ${JSON.stringify(err)}`);
    });
    const [, childPid, holderPid] = /pids:(\d+):(\d+)/.exec(err)!.map(Number);
    try {
      if (parent.exitCode === null && parent.signalCode === null) {
        await new Promise<void>((r) => parent.once('exit', () => r()));
      }
      expect(pidAlive(holderPid)).toBe(true);
      await until(() => existsSync(goneFile) || !pidAlive(childPid), 30_000);
      // The child leaves the watch and then exits. A machine whose init does
      // not reap an orphan keeps it as a zombie, and kill(pid, 0) answers for
      // a zombie, so the file says the child left and the pid does not.
      expect(existsSync(goneFile)).toBe(true);
      if (pidAlive(childPid)) {
        let state = 'unknown';
        try { state = readFileSync(`/proc/${childPid}/stat`, 'utf8').split(') ')[1][0]; } catch { /* no /proc */ }
        console.error(`orphan ${childPid} left the watch and still answers kill(0); /proc state ${state}`);
      }
      expect(err).not.toContain('child-saw-eof');
    } finally {
      try { process.kill(holderPid); } catch { /* already gone */ }
      try { rmSync(goneFile, { force: true }); } catch { /* not written */ }
    }
  }, 180_000);
});
