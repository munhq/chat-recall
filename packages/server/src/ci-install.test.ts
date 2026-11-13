/**
 * scripts/ci-install.sh installs the dependencies of a check, or restores them from the archive of an earlier run.
 *
 * A fake `npm` in the PATH stands for the install: it records each call and writes a node_modules folder. The tests
 * prove the three paths that decide whether a check reads stale files: the first run installs and saves, the second
 * run with the same lock files restores and does not install, and a changed lock file installs again.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts/ci-install.sh');

let root: string;
let work: string;
let cache: string;
let log: string;

function install(): string {
  return execFileSync('sh', [SCRIPT, '-w', 'packages/a'], {
    cwd: work,
    encoding: 'utf8',
    env: { PATH: `${join(root, 'bin')}:${process.env.PATH}`, npm_config_cache: cache, HOME: root },
  });
}

const npmCalls = (): string[] => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cr-ci-install-'));
  work = join(root, 'work');
  cache = join(root, 'cache');
  log = join(root, 'npm.log');
  mkdirSync(join(work, 'packages', 'a'), { recursive: true });
  writeFileSync(join(work, 'package.json'), '{"name":"root","private":true}\n');
  writeFileSync(join(work, 'package-lock.json'), '{"lockfileVersion":3,"v":1}\n');
  writeFileSync(join(work, 'packages', 'a', 'package.json'), '{"name":"a"}\n');
  mkdirSync(join(root, 'bin'));
  const npm = join(root, 'bin', 'npm');
  writeFileSync(
    npm,
    '#!/bin/sh\n'
      + `echo "$*" >> "${log}"\n`
      + 'mkdir -p node_modules/dep packages/a/node_modules/inner\n'
      + 'echo "{}" > node_modules/dep/package.json\n'
      + 'echo "{}" > packages/a/node_modules/inner/package.json\n',
  );
  chmodSync(npm, 0o755);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('ci-install.sh', () => {
  test('the first run installs with the given arguments and saves an archive', () => {
    install();
    expect(npmCalls()).toEqual(['ci --no-audit --no-fund -w packages/a']);
    const archives = readdirSync(join(cache, 'node-modules-by-lock')).filter((f) => f.endsWith('.tar'));
    expect(archives).toHaveLength(1);
  });

  test('a second run with the same lock files restores the folders and does not install', () => {
    install();
    rmSync(join(work, 'node_modules'), { recursive: true });
    rmSync(join(work, 'packages', 'a', 'node_modules'), { recursive: true });
    const out = install();
    expect(out).toContain('restored the dependencies');
    expect(npmCalls()).toHaveLength(1);
    expect(existsSync(join(work, 'node_modules', 'dep', 'package.json'))).toBe(true);
    expect(existsSync(join(work, 'packages', 'a', 'node_modules', 'inner', 'package.json'))).toBe(true);
  });

  test('a changed lock file installs again and saves a second archive', () => {
    install();
    writeFileSync(join(work, 'package-lock.json'), '{"lockfileVersion":3,"v":2}\n');
    install();
    expect(npmCalls()).toHaveLength(2);
    expect(readdirSync(join(cache, 'node-modules-by-lock')).filter((f) => f.endsWith('.tar'))).toHaveLength(2);
  });

  test('a broken archive installs again', () => {
    install();
    const dir = join(cache, 'node-modules-by-lock');
    const [archive] = readdirSync(dir).filter((f) => f.endsWith('.tar'));
    writeFileSync(join(dir, archive), 'not a tar file');
    install();
    expect(npmCalls()).toHaveLength(2);
  });
});
