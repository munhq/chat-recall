import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { readdirSync } from 'node:fs';
import { describe, test, expect } from 'vitest';
import { isAutoUpdateEnabled, planAutoUpdate, executeAutoUpdate } from './auto-update.js';

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
