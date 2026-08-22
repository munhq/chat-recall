/**
 * Coming back correctly is the hard part, and it differs per platform:
 *
 *   systemd   Restart=on-failure  → a CLEAN exit stays down; must exit non-zero
 *   launchd   KeepAlive=true      → restarts on any exit
 *   schtasks  /sc onlogon         → NEVER restarts; exiting means down until the
 *                                   next logon, which is worse than stale code
 *   foreground                    → exiting kills the user's own process
 *
 * Get that wrong and a staleness fix becomes an outage on one of the three
 * supported platforms. These tests pin each decision, since only the Linux path
 * can be exercised for real on this machine.
 */
import { describe, test, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codeFingerprint, sameFingerprint, detectSupervisor, restartActionFor,
  checkSelfRestart, EXIT_CODE_CODE_CHANGED,
} from './self-restart.js';

describe('supervisor detection', () => {
  test('systemd is recognised by INVOCATION_ID', () => {
    expect(detectSupervisor({ INVOCATION_ID: 'abc' }, 'linux')).toBe('systemd');
    expect(detectSupervisor({ JOURNAL_STREAM: '9:12345' }, 'linux')).toBe('systemd');
  });

  test('launchd is recognised by XPC_SERVICE_NAME', () => {
    expect(detectSupervisor({ XPC_SERVICE_NAME: 'com.chat-recall.watch' }, 'darwin')).toBe('launchd');
    // launchd sets it to "0" for a plain interactive shell — not supervised.
    expect(detectSupervisor({ XPC_SERVICE_NAME: '0' }, 'darwin')).toBe('none');
  });

  test('windows falls through to the scheduled task', () => {
    expect(detectSupervisor({}, 'win32')).toBe('windows-task');
  });

  test('a plain shell on linux/mac is unsupervised', () => {
    expect(detectSupervisor({}, 'linux')).toBe('none');
    expect(detectSupervisor({}, 'darwin')).toBe('none');
  });
});

describe('per-platform restart action', () => {
  test('systemd exits NON-ZERO — a clean exit would stay down under on-failure', () => {
    const a = restartActionFor('systemd');
    expect(a).toEqual({ kind: 'exit', code: EXIT_CODE_CODE_CHANGED });
    expect(EXIT_CODE_CODE_CHANGED).not.toBe(0);
  });

  test('launchd exits (KeepAlive restarts on any code)', () => {
    expect(restartActionFor('launchd')).toEqual({ kind: 'exit', code: EXIT_CODE_CODE_CHANGED });
  });

  test('windows RE-EXECS rather than exiting — nothing would restart it', () => {
    // schtasks /sc onlogon runs once at logon. Exiting there means the daemon is
    // gone until the user logs in again.
    expect(restartActionFor('windows-task')).toEqual({ kind: 'reexec' });
  });

  test('unsupervised only warns — never kills the user\'s foreground process', () => {
    expect(restartActionFor('none')).toEqual({ kind: 'warn' });
  });
});

describe('change detection', () => {
  test('an unchanged bundle is not a change', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cr-selfrestart-'));
    try {
      const f = join(dir, 'watch.js');
      writeFileSync(f, 'console.log(1)');
      const a = codeFingerprint(f);
      expect(sameFingerprint(a, codeFingerprint(f))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a rebuilt bundle (different size) is a change', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cr-selfrestart-'));
    try {
      const f = join(dir, 'watch.js');
      writeFileSync(f, 'console.log(1)');
      const boot = codeFingerprint(f);
      writeFileSync(f, 'console.log(1);console.log(2)');
      expect(sameFingerprint(boot, codeFingerprint(f))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a same-size rebuild is still caught, via the content hash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cr-selfrestart-'));
    try {
      const f = join(dir, 'watch.js');
      writeFileSync(f, 'AAAA');
      const boot = codeFingerprint(f);
      writeFileSync(f, 'BBBB');                       // identical length
      expect(sameFingerprint(boot, codeFingerprint(f))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // THE REGRESSION. `npm i -g` of the same version rewrites the bundle byte for
  // byte and moves its mtime. The old mtime-based fingerprint called that a code
  // change and exited the process — 90 times in one day, on a daemon that was
  // already crash-looping, each restart picking up nothing new.
  test('an IDENTICAL rebuild is NOT a change, however far the mtime moves', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cr-selfrestart-'));
    try {
      const f = join(dir, 'watch.js');
      writeFileSync(f, 'console.log("same bytes")');
      const boot = codeFingerprint(f);
      writeFileSync(f, 'console.log("same bytes")');   // reinstall: same content
      utimesSync(f, new Date(), new Date(Date.now() + 5000));
      expect(sameFingerprint(boot, codeFingerprint(f))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('an unreadable entry is treated as "no change", never as a restart trigger', () => {
    expect(codeFingerprint('/does/not/exist')).toBeNull();
    expect(sameFingerprint(null, null)).toBe(true);
    expect(sameFingerprint({ path: 'x', size: 1, hash: 'a' }, null)).toBe(true);
  });
});

describe('checkSelfRestart', () => {
  const boot = { path: '/x/watch.js', size: 100, hash: 'aaaa' };
  const changed = { path: '/x/watch.js', size: 200, hash: 'bbbb' };

  test('exits non-zero under systemd', () => {
    const codes: number[] = [];
    const restarted = checkSelfRestart({
      boot, now: () => changed, supervisor: 'systemd',
      exit: (c) => codes.push(c), log: () => {},
    });
    expect(restarted).toBe(true);
    expect(codes).toEqual([EXIT_CODE_CODE_CHANGED]);
  });

  test('does NOT exit when unsupervised — it warns and keeps running', () => {
    const codes: number[] = [];
    const logs: string[] = [];
    const restarted = checkSelfRestart({
      boot, now: () => changed, supervisor: 'none',
      exit: (c) => codes.push(c), log: (m) => logs.push(m),
    });
    expect(restarted).toBe(false);
    expect(codes).toEqual([]);
    expect(logs.join(' ')).toMatch(/STAYING UP/);
  });

  test('does nothing when the bundle is unchanged', () => {
    const codes: number[] = [];
    expect(checkSelfRestart({
      boot, now: () => boot, supervisor: 'systemd',
      exit: (c) => codes.push(c), log: () => {},
    })).toBe(false);
    expect(codes).toEqual([]);
  });

  test('CHAT_RECALL_SELF_RESTART=0 disables it entirely', () => {
    const prev = process.env.CHAT_RECALL_SELF_RESTART;
    process.env.CHAT_RECALL_SELF_RESTART = '0';
    try {
      const codes: number[] = [];
      expect(checkSelfRestart({
        boot, now: () => changed, supervisor: 'systemd',
        exit: (c) => codes.push(c), log: () => {},
      })).toBe(false);
      expect(codes).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.CHAT_RECALL_SELF_RESTART;
      else process.env.CHAT_RECALL_SELF_RESTART = prev;
    }
  });

  test('the log names the supervisor and the action, so a stale daemon is diagnosable', () => {
    const logs: string[] = [];
    checkSelfRestart({
      boot, now: () => changed, supervisor: 'systemd',
      exit: () => {}, log: (m) => logs.push(m),
    });
    const line = logs.join(' ');
    expect(line).toMatch(/bundle changed/);
    expect(line).toMatch(/supervisor=systemd/);
    expect(line).toMatch(/action=exit/);
  });
});

describe('the installed unit actually supports this', () => {
  test('the systemd unit restarts on failure, which is what exit 75 relies on', async () => {
    const { renderSystemdUnit } = await import('./service-installer.js');
    const unit = renderSystemdUnit('/x/watch.js', '/usr/bin/node', '/tmp/log');
    // If this ever becomes Restart=no, exit 75 silently stops the daemon.
    expect(unit).toMatch(/Restart=(on-failure|always)/);
  });

  test('the launchd plist keeps the job alive, which is what exiting relies on', async () => {
    const { renderLaunchdPlist } = await import('./service-installer.js');
    expect(renderLaunchdPlist('/x/watch.js', '/usr/bin/node', '/tmp/log')).toMatch(/<key>KeepAlive<\/key><true\/>/);
  });

  test('the windows task is onlogon — which is WHY windows re-execs', async () => {
    const { renderWindowsTaskCommand } = await import('./service-installer.js');
    const cmd = renderWindowsTaskCommand('C:\\x\\watch.js', 'C:\\node.exe');
    expect(cmd).toMatch(/\/sc onlogon/);
    // Documents the coupling: no restart policy here, so exiting is not an option.
    expect(restartActionFor('windows-task')).toEqual({ kind: 'reexec' });
  });
});
