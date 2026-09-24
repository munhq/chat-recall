/**
 * The self-updater must find npm without the login shell's PATH.
 *
 * A macOS collector failed `npm install -g --prefix "/opt/homebrew" …` 5,769
 * times. launchd gives an agent PATH=/usr/bin:/bin:/usr/sbin:/sbin, and Homebrew
 * keeps npm in /opt/homebrew/bin, so `/bin/sh` found no npm. These tests pin
 * that npm comes from the running node and the install prefix.
 */
import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { resolveNpm, type NpmLocation } from './auto-update.js';

const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

const loc = (over: Partial<NpmLocation> & { files: string[] }): NpmLocation => ({
  execPath: '/opt/homebrew/Cellar/node/24.1.0/bin/node',
  prefix: '/opt/homebrew',
  platform: 'darwin',
  env: { PATH: LAUNCHD_PATH, HOME: '/Users/alice' },
  exists: (p) => over.files.includes(p),
  ...over,
});

describe('resolveNpm', () => {
  test('Homebrew: npm under the install prefix runs through the running node', () => {
    const npm = resolveNpm(loc({ files: ['/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js'] }));
    expect(npm.file).toBe('/opt/homebrew/Cellar/node/24.1.0/bin/node');
    expect(npm.args).toEqual(['/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js']);
    expect(npm.shell).toBe(false);
  });

  test('npm next to the node binary wins (official installer, nvm)', () => {
    const npm = resolveNpm(loc({
      execPath: '/Users/alice/.nvm/versions/node/v22.3.0/bin/node',
      prefix: '/Users/alice/.local',
      files: [
        '/Users/alice/.nvm/versions/node/v22.3.0/lib/node_modules/npm/bin/npm-cli.js',
        '/Users/alice/.local/lib/node_modules/npm/bin/npm-cli.js',
      ],
    }));
    expect(npm.args).toEqual(['/Users/alice/.nvm/versions/node/v22.3.0/lib/node_modules/npm/bin/npm-cli.js']);
  });

  test('the child PATH starts with the node directory and the prefix bin', () => {
    const npm = resolveNpm(loc({ files: [] }));
    expect(npm.env.PATH).toBe(`/opt/homebrew/Cellar/node/24.1.0/bin:/opt/homebrew/bin:${LAUNCHD_PATH}`);
    expect(npm.env.HOME).toBe('/Users/alice');
  });

  test('with no npm-cli.js found, a bare npm runs with the extended PATH', () => {
    const npm = resolveNpm(loc({ files: [] }));
    expect(npm).toMatchObject({ file: 'npm', args: [], shell: true });
    expect(npm.env.PATH?.split(':')).toContain('/opt/homebrew/bin');
  });

  test('Windows: npm-cli.js beside node.exe, and the Path key is kept', () => {
    const npm = resolveNpm({
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      prefix: 'C:\\Users\\user\\AppData\\Roaming\\npm',
      platform: 'win32',
      env: { Path: 'C:\\Windows\\system32' },
      exists: (p) => p === 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
    });
    expect(npm.file).toBe('C:\\Program Files\\nodejs\\node.exe');
    expect(npm.args).toEqual(['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js']);
    expect(npm.env.Path).toBe('C:\\Program Files\\nodejs;C:\\Users\\user\\AppData\\Roaming\\npm;C:\\Windows\\system32');
    expect(npm.env.PATH).toBeUndefined();
  });
});

// The real node on this machine, with the PATH a launchd agent gets. Before
// the fix this was `/bin/sh -c "npm …"`, which exits 127 wherever npm is not in
// /usr/bin or /bin.
test.skipIf(process.platform === 'win32')('the resolved npm runs under the launchd PATH', () => {
  const npm = resolveNpm({
    execPath: process.execPath, prefix: null, platform: process.platform,
    env: { PATH: LAUNCHD_PATH }, exists: existsSync,
  });
  expect(npm.shell).toBe(false);
  const out = execFileSync(npm.file, [...npm.args, '--version'], { env: npm.env, encoding: 'utf8' });
  expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/);
});
