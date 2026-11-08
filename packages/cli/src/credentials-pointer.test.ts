/**
 * `credentials.json` holds the server and a pointer to the kit store, and no token, for a login of the kit.
 * Both readers (the sync client and the message hook) give the token that the pointer names.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { recallTarget } from '@chat-recall/engine/core/remote-target.js';
import { clearTokenCache, sealkeepEnvName } from '@chat-recall/engine/core/stored-token.js';
import { loadAllCredentials, removeCredentials, saveCredentials } from './sync-client.js';

let dir: string;
const NAME = 'personal/example-app/prod/DEVICE_TOKEN';
const onDisk = () => JSON.parse(readFileSync(join(dir, 'credentials.json'), 'utf-8')) as { targets: Array<Record<string, unknown>> };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cred-pointer-'));
  vi.stubEnv('CHAT_RECALL_DATA_DIR', dir);
  vi.stubEnv('CHAT_RECALL_TOKEN', '');
  vi.stubEnv('CHAT_RECALL_SERVER', '');
  clearTokenCache();
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

describe('a login with a pointer', () => {
  test('the file holds the pointer and no token, and the readers give the token of the file pointer', () => {
    const tokenFile = join(dir, 'tokens-prod');
    writeFileSync(tokenFile, 'ct_kept\n');
    saveCredentials({ serverUrl: 'https://a.example', token: 'ct_kept', secret: { kind: 'file', path: tokenFile } });

    const written = onDisk().targets[0];
    expect(written.token).toBe('');
    expect(written.secret).toEqual({ kind: 'file', path: tokenFile });
    expect(readFileSync(join(dir, 'credentials.json'), 'utf-8')).not.toContain('ct_kept');

    expect(loadAllCredentials()[0].token).toBe('ct_kept');
    expect(recallTarget()).toEqual({ base: 'https://a.example', token: 'ct_kept' });
  });

  test('a sealkeep pointer gives the token only in a process that sealkeep started', () => {
    saveCredentials({ serverUrl: 'https://a.example', token: 'ct_kept', secret: { kind: 'sealkeep', name: NAME } });
    expect(loadAllCredentials()[0].token).toBe('');
    vi.stubEnv(sealkeepEnvName(NAME), 'ct_from_sealkeep');
    expect(loadAllCredentials()[0].token).toBe('ct_from_sealkeep');
    expect(recallTarget()?.token).toBe('ct_from_sealkeep');
  });

  test('a later login of another server keeps the pointer of the first and puts no token in the file', () => {
    saveCredentials({ serverUrl: 'https://a.example', token: 'ct_a', secret: { kind: 'sealkeep', name: NAME } });
    vi.stubEnv(sealkeepEnvName(NAME), 'ct_a');
    saveCredentials({ serverUrl: 'http://localhost:3000', token: 'ct_self_host' });

    const targets = onDisk().targets;
    expect(targets.map((t) => t.serverUrl)).toEqual(['http://localhost:3000', 'https://a.example']);
    const a = targets.find((t) => t.serverUrl === 'https://a.example')!;
    expect(a.token).toBe('');
    expect(a.secret).toEqual({ kind: 'sealkeep', name: NAME });
    expect(readFileSync(join(dir, 'credentials.json'), 'utf-8')).not.toContain('ct_a"');
  });

  test('removing a target keeps the pointer of the others', () => {
    saveCredentials({ serverUrl: 'https://a.example', token: 'ct_a', secret: { kind: 'sealkeep', name: NAME } });
    saveCredentials({ serverUrl: 'http://localhost:3000', token: 'ct_b' });
    expect(removeCredentials('http://localhost:3000')).toBe(true);
    expect(onDisk().targets).toEqual([{ serverUrl: 'https://a.example', token: '', secret: { kind: 'sealkeep', name: NAME } }]);
  });

  test('a login with a plain token works as before', () => {
    saveCredentials({ serverUrl: 'https://a.example', token: 'ct_plain' });
    expect(onDisk().targets[0]).toEqual({ serverUrl: 'https://a.example', token: 'ct_plain' });
    expect(loadAllCredentials()[0].token).toBe('ct_plain');
  });
});
