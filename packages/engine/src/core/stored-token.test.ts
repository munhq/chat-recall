import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  RELAUNCH_GUARD,
  adoptSealkeepSecrets,
  clearTokenCache,
  resolveSecret,
  sealkeepCommand,
  sealkeepEnvName,
  sealkeepNamesOnDisk,
  targetToken,
} from './stored-token.js';

const NAME = 'personal/example-app/prod/DEVICE_TOKEN';
let dir: string;

const writeTargets = (targets: unknown[]) => writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ targets }));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stored-token-'));
  clearTokenCache();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('resolveSecret', () => {
  test('a file pointer reads the file', () => {
    const file = join(dir, 'token');
    writeFileSync(file, 'ct_from_file\n');
    expect(resolveSecret({ kind: 'file', path: file })).toBe('ct_from_file');
  });

  test('a missing file gives an empty token', () => {
    expect(resolveSecret({ kind: 'file', path: join(dir, 'none') })).toBe('');
  });

  test('a sealkeep pointer reads only the variable that sealkeep run set', () => {
    const where = { kind: 'sealkeep', name: NAME } as const;
    expect(resolveSecret(where, { env: {} })).toBe('');
    expect(resolveSecret(where, { env: { [sealkeepEnvName(NAME)]: 'ct_from_env' } })).toBe('ct_from_env');
  });

  test('a keyring pointer is read once in the keeping time', () => {
    const where = { kind: 'keyring', service: 'example-app', account: NAME, backend: 'secret-service' } as const;
    let reads = 0;
    let clock = 1_000;
    const deps = { now: () => clock, readKeyring: () => { reads++; return `ct_${reads}`; } };
    expect(resolveSecret(where, deps)).toBe('ct_1');
    clock += 10_000;
    expect(resolveSecret(where, deps)).toBe('ct_1');
    clock += 31_000;
    expect(resolveSecret(where, deps)).toBe('ct_2');
  });

  test('targetToken prefers the token of the target', () => {
    expect(targetToken({ token: 'ct_own', secret: { kind: 'sealkeep', name: NAME } }, { env: { [sealkeepEnvName(NAME)]: 'other' } })).toBe('ct_own');
  });
});

describe('sealkeepNamesOnDisk', () => {
  test('lists each sealkeep name once and skips other pointers', () => {
    writeTargets([
      { serverUrl: 'https://a.example', token: '', secret: { kind: 'sealkeep', name: NAME } },
      { serverUrl: 'https://b.example', token: '', secret: { kind: 'sealkeep', name: NAME } },
      { serverUrl: 'https://c.example', token: '', secret: { kind: 'file', path: '/x' } },
      { serverUrl: 'https://d.example', token: 'ct_plain' },
    ]);
    expect(sealkeepNamesOnDisk(dir)).toEqual([NAME]);
  });

  test('a missing or broken file gives no name', () => {
    expect(sealkeepNamesOnDisk(dir)).toEqual([]);
    writeFileSync(join(dir, 'credentials.json'), '{not json');
    expect(sealkeepNamesOnDisk(dir)).toEqual([]);
  });
});

describe('sealkeepCommand', () => {
  test('names one variable for each secret and keeps the program after --', () => {
    expect(sealkeepCommand([NAME], ['node', 'watch.js'])).toEqual([
      'sealkeep', 'run', '-e', `${sealkeepEnvName(NAME)}=${NAME}`, '--', 'node', 'watch.js',
    ]);
  });
});

describe('adoptSealkeepSecrets', () => {
  const pointer = [{ serverUrl: 'https://a.example', token: '', secret: { kind: 'sealkeep', name: NAME } }];
  const never = (): never => { throw new Error('exit'); };

  test('does nothing when no target points to sealkeep', async () => {
    writeTargets([{ serverUrl: 'https://a.example', token: 'ct_plain' }]);
    let called = false;
    await adoptSealkeepSecrets({ env: {}, dataDir: dir, relaunch: async () => { called = true; return 0; } });
    expect(called).toBe(false);
  });

  test('does nothing when the variable is set, the guard is set, or the environment holds the login', async () => {
    writeTargets(pointer);
    let called = false;
    const relaunch = async () => { called = true; return 0; };
    await adoptSealkeepSecrets({ env: { [sealkeepEnvName(NAME)]: 'ct' }, dataDir: dir, relaunch });
    await adoptSealkeepSecrets({ env: { [RELAUNCH_GUARD]: '1' }, dataDir: dir, relaunch });
    await adoptSealkeepSecrets({ env: { CHAT_RECALL_TOKEN: 'ct', CHAT_RECALL_SERVER: 'https://a.example' }, dataDir: dir, relaunch });
    expect(called).toBe(false);
  });

  test('starts the program again under sealkeep and exits with its code', async () => {
    writeTargets(pointer);
    const seen: { command: string[]; env: NodeJS.ProcessEnv }[] = [];
    await expect(adoptSealkeepSecrets({
      env: {},
      dataDir: dir,
      argv: ['node', 'watch.js', '--daemon'],
      probe: () => ({ code: 0, stderr: '' }),
      relaunch: async (command, env) => { seen.push({ command, env }); return 7; },
      exit: ((code: number) => { throw new Error(`exit ${code}`); }) as (code: number) => never,
    })).rejects.toThrow('exit 7');
    expect(seen[0].command).toEqual(sealkeepCommand([NAME], ['node', 'watch.js', '--daemon']));
    expect(seen[0].env[RELAUNCH_GUARD]).toBe('1');
  });

  test('goes on with no token and says why when sealkeep does not give the secret', async () => {
    writeTargets(pointer);
    const said: string[] = [];
    let relaunched = false;
    await adoptSealkeepSecrets({
      env: {},
      dataDir: dir,
      probe: () => ({ code: 1, stderr: 'the keyring is locked\n' }),
      relaunch: async () => { relaunched = true; return 0; },
      say: (l) => said.push(l),
      exit: never,
    });
    expect(relaunched).toBe(false);
    expect(said.join('\n')).toContain('the keyring is locked');
    expect(said.join('\n')).toContain('sealkeep unlock');
  });
});
