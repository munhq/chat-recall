/**
 * A long-running MCP daemon syncs with the installed CLI when that is newer.
 * One daemon synced with 0.6.1 code for 19 days while 0.6.5 was on disk.
 */
import { describe, test, expect } from 'vitest';

import { installedIsNewer, runInstalledSync } from './sync-delegate.js';

describe('installedIsNewer', () => {
  test('a newer version on disk takes over the sync', () => {
    expect(installedIsNewer('0.6.1', '0.6.5')).toBe(true);
    expect(installedIsNewer('0.7.4', '0.7.10')).toBe(true);
  });
  test('the same or an older version, or none, does not', () => {
    expect(installedIsNewer('0.7.4', '0.7.4')).toBe(false);
    expect(installedIsNewer('0.7.4', '0.7.3')).toBe(false);
    expect(installedIsNewer('0.7.4', null)).toBe(false);
  });
});

describe('runInstalledSync', () => {
  test('resolves with the child exit code', async () => {
    // A script that stands in for cli.js: it exits 3 when asked to sync.
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'cr-delegate-'));
    try {
      const cli = join(dir, 'cli.js');
      writeFileSync(cli, "process.exit(process.argv[2] === 'sync' ? 3 : 1);\n");
      expect(await runInstalledSync(cli)).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('a child that does not finish in time resolves null', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'cr-delegate-'));
    try {
      const cli = join(dir, 'cli.js');
      writeFileSync(cli, 'setInterval(() => {}, 1000);\n');
      expect(await runInstalledSync(cli, 300)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
