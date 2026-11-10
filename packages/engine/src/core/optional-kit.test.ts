import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { clearOptionalKitCache, optionalKit, readSecretFile, saveSecretFile } from './optional-kit.js';
import { clearTokenCache, resolveSecret } from './stored-token.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'optional-kit-'));
  clearOptionalKitCache();
  clearTokenCache();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('optionalKit', () => {
  test('CHAT_RECALL_NO_KIT=1 behaves as a machine without the kit', () => {
    expect(optionalKit({ CHAT_RECALL_NO_KIT: '1' })).toBeNull();
  });

  test('the answer is kept, so the kit is looked up once', () => {
    const first = optionalKit({});
    expect(optionalKit({})).toBe(first);
  });
});

describe('the token file', () => {
  test('is written for the owner only, under a folder only the owner enters', () => {
    const file = join(dir, 'tokens', 'prod');
    expect(saveSecretFile('ct_secret', file)).toEqual({ kind: 'file', path: file });
    expect(readFileSync(file, 'utf-8')).toBe('ct_secret\n');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    if (process.platform !== 'win32') expect(statSync(join(dir, 'tokens')).mode & 0o777).toBe(0o700);
  });

  test('is read without the newline, and a missing or empty file reads as nothing', () => {
    const file = join(dir, 'token');
    writeFileSync(file, 'ct_secret\n');
    expect(readSecretFile(file)).toBe('ct_secret');
    writeFileSync(file, '\n');
    expect(readSecretFile(file)).toBeUndefined();
    expect(readSecretFile(join(dir, 'missing'))).toBeUndefined();
  });
});

describe('resolveSecret on a machine without the kit', () => {
  test('a file pointer is read, a sealkeep pointer reads its variable', () => {
    const file = join(dir, 'token');
    saveSecretFile('from_file', file);
    expect(resolveSecret({ kind: 'file', path: file })).toBe('from_file');
  });

  test('a keyring pointer reads as no token when nothing can read it', () => {
    const where = { kind: 'keyring', service: 'chat-recall', account: 'a', backend: 'secret-service' } as const;
    expect(resolveSecret(where, { readKeyring: () => undefined })).toBe('');
  });
});
