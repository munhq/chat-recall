import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
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
  const stagingDirs = () => readdirSync(tmpdir()).filter((d) => d.startsWith('cr-update-'));

  const plan = { update: true, url: 'https://x/pkg.tgz', sha256: '', from: '1.0.0', to: '2.0.0' };
  const bytes = Buffer.from('tarball');
  const sha = createHash('sha256').update(bytes).digest('hex');

  test('removes it after a successful install', async () => {
    const before = stagingDirs().length;
    const r = await executeAutoUpdate({ ...plan, sha256: sha } as never, {
      download: async () => bytes,
      install: () => {},
      restart: () => {},
      verify: () => '2.0.0',
      platform: 'linux',
    } as never);
    expect(r.updated).toBe(true);
    expect(stagingDirs().length).toBe(before);
  });

  test('removes it when the install throws', async () => {
    const before = stagingDirs().length;
    const r = await executeAutoUpdate({ ...plan, sha256: sha } as never, {
      download: async () => bytes,
      install: () => { throw new Error('npm exploded'); },
      restart: () => {},
      verify: () => '1.0.0',
      platform: 'linux',
    } as never);
    expect(r.updated).toBe(false);
    expect(stagingDirs().length).toBe(before);
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
