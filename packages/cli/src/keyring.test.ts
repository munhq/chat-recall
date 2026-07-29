/**
 * Keyring backends: right tool per platform, and — the property that matters —
 * THE SECRET NEVER APPEARS IN ARGV.
 *
 * /proc/<pid>/cmdline is world-readable on Linux and `ps` shows arguments to
 * every local user, so a passphrase passed as a command-line flag leaks to any
 * process on the machine. Each backend must hand it over on stdin instead. The
 * fake runner below records both, so the assertion is direct rather than
 * aspirational.
 */
import { describe, test, expect } from 'vitest';
import {
  probeKeyring, keyringSet, keyringGet, keyringDelete,
  KeyringUnavailableError, shQuote, psQuote, type Runner,
} from './keyring.js';

interface Call { file: string; args: string[]; input?: string }

/**
 * Runner that records calls and replays canned stdout / failures.
 *
 * `failFrom` exists because every operation runs the PROBE first: to model "the
 * tool is installed but the entry is missing" the probe must succeed and only
 * the following call fail. `fail` (by name) models the tool being absent
 * entirely, which fails at the probe — a different scenario.
 */
function fake(platform: NodeJS.Platform, opts: { fail?: RegExp; out?: string; failFrom?: number } = {}) {
  const calls: Call[] = [];
  const r: Runner = {
    platform,
    run(file, args, input) {
      calls.push({ file, args, input });
      if (opts.fail && opts.fail.test(file)) throw new Error(`ENOENT ${file}`);
      if (opts.failFrom && calls.length >= opts.failFrom) throw new Error('no such item');
      return opts.out ?? '';
    },
  };
  return { r, calls };
}

const SECRET = "correct horse battery staple's";

describe('probeKeyring', () => {
  test('picks the platform tool when present', () => {
    expect(probeKeyring(fake('darwin').r)).toMatchObject({ backend: 'macos-keychain', available: true });
    expect(probeKeyring(fake('linux').r)).toMatchObject({ backend: 'libsecret', available: true });
    expect(probeKeyring(fake('win32').r)).toMatchObject({ backend: 'windows-dpapi', available: true });
  });

  test('linux without secret-tool is unavailable, with an actionable hint', () => {
    const p = probeKeyring(fake('linux', { fail: /secret-tool/ }).r);
    expect(p.available).toBe(false);
    // The exact case seen in the wild: keyring daemon running, CLI not installed.
    expect(p.hint).toContain('libsecret-tools');
    expect(p.hint).toContain('Headless');
  });

  test('an unsupported platform is unavailable, never silently "fine"', () => {
    expect(probeKeyring(fake('aix').r)).toMatchObject({ backend: 'none', available: false });
  });
});

describe('secret handling', () => {
  test('macOS: secret goes over stdin, not argv', () => {
    const { r, calls } = fake('darwin');
    keyringSet(SECRET, r);
    const store = calls.at(-1)!;
    expect(store.file).toBe('security');
    expect(store.args).toEqual(['-i']);                       // batch mode
    expect(store.input).toContain('add-generic-password');
    // Quoted, not raw: `security -i` re-tokenizes the line, so quoting is
    // load-bearing — an unescaped apostrophe would store a truncated password.
    expect(store.input).toContain(shQuote(SECRET));
    expect(store.args.join(' ')).not.toContain('correct');    // ← the point
  });

  test('linux: secret goes over stdin, not argv', () => {
    const { r, calls } = fake('linux');
    keyringSet(SECRET, r);
    const store = calls.at(-1)!;
    expect(store.file).toBe('secret-tool');
    expect(store.args[0]).toBe('store');
    expect(store.input).toBe(SECRET);
    expect(store.args.join(' ')).not.toContain('correct');
  });

  test('windows: secret goes into the piped script, not argv', () => {
    const { r, calls } = fake('win32');
    keyringSet(SECRET, r);
    const store = calls.at(-1)!;
    expect(store.file).toBe('powershell');
    expect(store.args).toEqual(['-NoProfile', '-Command', '-']);
    expect(store.input).toContain('ConvertFrom-SecureString');
    expect(store.args.join(' ')).not.toContain('correct');
  });

  test('no keyring → throws with the hint, and never stores anywhere', () => {
    const { r, calls } = fake('linux', { fail: /secret-tool/ });
    expect(() => keyringSet(SECRET, r)).toThrow(KeyringUnavailableError);
    expect(() => keyringSet(SECRET, r)).toThrow(/libsecret-tools/);
    // Only the probe ran; nothing tried to persist the secret elsewhere.
    expect(calls.every((c) => c.input === undefined)).toBe(true);
  });
});

describe('keyringGet', () => {
  test('returns the stored secret, trimmed of a trailing newline', () => {
    expect(keyringGet(fake('darwin', { out: `${SECRET}\n` }).r)).toBe(SECRET);
    expect(keyringGet(fake('linux', { out: SECRET }).r)).toBe(SECRET);
  });

  test('absent entry is null, not a throw — every backend exits non-zero for it', () => {
    // Tool present (probe = call 1 succeeds), lookup (call 2) exits non-zero.
    expect(keyringGet(fake('darwin', { failFrom: 2 }).r)).toBeNull();
    expect(keyringGet(fake('linux', { failFrom: 2 }).r)).toBeNull();
    expect(keyringGet(fake('win32', { failFrom: 2 }).r)).toBeNull();
  });

  test('a missing tool is NOT reported as "no entry" — that would hide the real cause', () => {
    expect(() => keyringGet(fake('linux', { fail: /secret-tool/ }).r)).toThrow(/libsecret-tools/);
  });

  test('empty output is null, not an empty passphrase', () => {
    expect(keyringGet(fake('linux', { out: '' }).r)).toBeNull();
  });
});

describe('keyringDelete', () => {
  test('true when the backend removes it, false when there was nothing', () => {
    expect(keyringDelete(fake('linux').r)).toBe(true);
    // Probe succeeds, the clear itself fails → nothing was there to remove.
    expect(keyringDelete(fake('linux', { failFrom: 2 }).r)).toBe(false);
  });
});

describe('quoting', () => {
  test('shQuote survives embedded single quotes', () => {
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
  });
  test('psQuote doubles single quotes, per PowerShell', () => {
    expect(psQuote("it's")).toBe("'it''s'");
  });
});
