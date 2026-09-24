import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { isAutoUpdateEnabled, planAutoUpdate, executeAutoUpdate, sweepStaleStaging } from './auto-update.js';

describe('auto-update default', () => {
  test('default ON for every edition (cloud included)', () => {
    expect(isAutoUpdateEnabled('cloud', undefined)).toBe(true);
    expect(isAutoUpdateEnabled('selfhost', undefined)).toBe(true);
  });

  test('explicit opt-out wins', () => {
    expect(isAutoUpdateEnabled('cloud', '0')).toBe(false);
    expect(isAutoUpdateEnabled('selfhost', 'off')).toBe(false);
  });

  test('a cloud device updates when the server advertises a newer CLI', () => {
    const plan = planAutoUpdate(
      'https://chatrecall.dev',
      { edition: 'cloud', cli: { version: '0.3.3', sha256: 'a'.repeat(64) } },
      '0.3.2',
      undefined,
    );
    expect(plan.update).toBe(true);
    expect(plan.to).toBe('0.3.3');
  });
});

// ── staging cleanup ──────────────────────────────────────────────
//
// The updater wrote its download into a fresh mkdtemp dir and never removed
// it, on any exit path. Because it runs on every sync, one machine accumulated
// 5,889 directories and 5.1 GB of tarballs in /tmp before anyone noticed. A
// leak that only shows up as disk pressure weeks later needs a test.
describe('staging directory is not leaked', () => {
  // Checks the one directory THIS update staged. Counting cr-update-* in the
  // shared tmpdir failed about 1 run in 4, because other test files create
  // and remove directories of that shape in parallel.
  const plan = { update: true, url: 'https://x/pkg.tgz', sha256: '', from: '1.0.0', to: '2.0.0' };
  const bytes = Buffer.from('tarball');
  const sha = createHash('sha256').update(bytes).digest('hex');

  test('removes it after a successful install', async () => {
    let staged = '';
    const r = await executeAutoUpdate({ ...plan, sha256: sha } as never, {
      download: async () => bytes,
      install: (tgz: string) => { staged = tgz; expect(existsSync(tgz)).toBe(true); },
      restart: () => {},
      verify: () => '2.0.0',
      platform: 'linux',
    } as never);
    expect(r.updated).toBe(true);
    expect(staged).not.toBe('');
    expect(existsSync(dirname(staged))).toBe(false);
  });

  test('removes it when the install throws', async () => {
    let staged = '';
    const r = await executeAutoUpdate({ ...plan, sha256: sha } as never, {
      download: async () => bytes,
      install: (tgz: string) => { staged = tgz; throw new Error('npm exploded'); },
      restart: () => {},
      verify: () => '1.0.0',
      platform: 'linux',
    } as never);
    expect(r.updated).toBe(false);
    expect(staged).not.toBe('');
    expect(existsSync(dirname(staged))).toBe(false);
  });
});

// ── sweeping the backlog left by older versions ──────────────────
describe('sweepStaleStaging', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'sweep-test-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const OLD = Date.now();
  const cold = (name: string, files: Record<string, string> = { 'chat-recall.tgz': 'x' }) => {
    const d = join(root, name);
    mkdirSync(d, { recursive: true });
    for (const [f, body] of Object.entries(files)) writeFileSync(join(d, f), body);
    utimesSync(d, new Date(OLD - 86_400_000), new Date(OLD - 86_400_000));
    return d;
  };

  test('removes a cold staging dir holding only our tarball', () => {
    cold('cr-update-AbC123');
    expect(sweepStaleStaging(root, OLD)).toBe(1);
    expect(existsSync(join(root, 'cr-update-AbC123'))).toBe(false);
  });

  test('an empty cold staging dir also goes', () => {
    cold('cr-update-ZZZ999', {});
    expect(sweepStaleStaging(root, OLD)).toBe(1);
  });

  test('LEAVES a dir younger than an hour — a live update may be using it', () => {
    const d = join(root, 'cr-update-Fresh1');
    mkdirSync(d); writeFileSync(join(d, 'chat-recall.tgz'), 'x');
    expect(sweepStaleStaging(root, OLD)).toBe(0);
    expect(existsSync(d)).toBe(true);
  });

  test('LEAVES anything that is not ours, however similar the name', () => {
    cold('cr-update-notes');            // 5 chars, not mkdtemp's 6
    cold('cr-updates-AbC123');          // different prefix
    cold('cr-act-AbC123');              // another tool's temp dir
    cold('cr-update-AbC124', { 'secrets.env': 'x' });  // right name, foreign contents
    expect(sweepStaleStaging(root, OLD)).toBe(0);
    expect(existsSync(join(root, 'cr-update-AbC124'))).toBe(true);
    expect(existsSync(join(root, 'cr-act-AbC123'))).toBe(true);
  });

  test('clears a real backlog and is safe to run twice', () => {
    for (let i = 0; i < 50; i++) cold(`cr-update-b${String(i).padStart(5, '0')}`);
    expect(sweepStaleStaging(root, OLD)).toBe(50);
    expect(sweepStaleStaging(root, OLD)).toBe(0);
  });

  test('a missing root is not an error', () => {
    expect(sweepStaleStaging(join(root, 'nope'), OLD)).toBe(0);
  });
});

// The sweeper must follow TMPDIR, not assume /tmp: on macOS mkdtemp writes to
// $TMPDIR (/var/folders/…/T) and on Windows to %TEMP%. Both the leak and the
// sweep read tmpdir(), so they cannot diverge — this pins that they agree.
test('sweeps whatever root mkdtemp actually uses, not a hardcoded /tmp', () => {
  const staging = mkdtempSync(join(tmpdir(), 'cr-update-'));
  writeFileSync(join(staging, 'chat-recall.tgz'), 'x');
  const past = new Date(Date.now() - 86_400_000);
  utimesSync(staging, past, past);
  expect(basename(staging)).toMatch(/^cr-update-.{6}$/);
  expect(sweepStaleStaging()).toBeGreaterThanOrEqual(1);
  expect(existsSync(staging)).toBe(false);
});

// ── the versioned tarball URL ─────────────────────────────────────
// A rollout served one pod's tarball against another pod's checksum. The
// update asks for the version it was told about; only a server without that
// route falls back to the unversioned URL.
describe('versioned tarball download', () => {
  const bytes = Buffer.from('tarball');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const planFor = () => planAutoUpdate('https://srv.example.com/', { cli: { version: '2.0.0', sha256: sha } } as never, '1.0.0', undefined);

  test('the plan names the version, with the unversioned URL as the fallback', () => {
    const p = planFor();
    expect(p.url).toBe('https://srv.example.com/install/chat-recall-2.0.0.tgz');
    expect(p.fallbackUrl).toBe('https://srv.example.com/install/chat-recall.tgz');
  });

  const deps = (answers: Record<string, Buffer | string>, seen: string[]) => ({
    download: async (url: string) => {
      seen.push(url);
      const a = answers[url];
      if (typeof a === 'string') throw new Error(a);
      return a;
    },
    install: () => {},
    restart: () => {},
    verify: () => '2.0.0',
    platform: 'linux',
  }) as never;

  test('a server without the versioned route (404) gets the unversioned URL', async () => {
    const p = planFor(); const seen: string[] = [];
    const r = await executeAutoUpdate(p, deps({ [p.url!]: 'HTTP 404', [p.fallbackUrl!]: bytes }, seen));
    expect(r.updated).toBe(true);
    expect(seen).toEqual([p.url, p.fallbackUrl]);
  });

  test('a pod that holds another version (409) is not asked again this sync', async () => {
    const p = planFor(); const seen: string[] = [];
    const r = await executeAutoUpdate(p, deps({ [p.url!]: 'HTTP 409', [p.fallbackUrl!]: bytes }, seen));
    expect(r.updated).toBe(false);
    expect(r.reason).toContain('HTTP 409');
    expect(seen).toEqual([p.url]);
  });
});
