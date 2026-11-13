/**
 * The vault derives its key with the production Argon2 parameters unless the caller passes a `kdf` option.
 *
 * The tests of the vault pass ARGON2_TEST, because the orchestration does not depend on the cost parameters and the
 * production parameters cost about 5 s of CPU for each derivation. This file proves the default: it records the
 * parameters that each call reaches the KDF with, and lets the cheap parameters do the work.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ARGON2_PROD, ARGON2_TEST } from './vault-crypto.js';

const seen: unknown[] = [];

vi.mock('./vault-crypto.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./vault-crypto.js')>();
  return {
    ...actual,
    deriveMasterKey: (passphrase: string, salt: Uint8Array, params?: unknown) => {
      seen.push(params);
      return actual.deriveMasterKey(passphrase, salt, actual.ARGON2_TEST);
    },
  };
});

let dir: string;
let prev: string | undefined;

beforeEach(() => {
  prev = process.env.CHAT_RECALL_DATA_DIR;
  dir = mkdtempSync(join(tmpdir(), 'cr-vault-kdf-'));
  process.env.CHAT_RECALL_DATA_DIR = dir;
  seen.length = 0;
});
afterEach(() => {
  if (prev === undefined) delete process.env.CHAT_RECALL_DATA_DIR; else process.env.CHAT_RECALL_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe('the KDF parameters of the vault', () => {
  test('a call without the kdf option derives with the production parameters', async () => {
    const { vaultEnable } = await import('./vault-client.js');
    vaultEnable('correct-horse-battery', { existingSaltHex: '55'.repeat(32) });
    expect(seen).toEqual([ARGON2_PROD]);
  });

  test('the kdf option replaces them', async () => {
    const { vaultEnable } = await import('./vault-client.js');
    vaultEnable('correct-horse-battery', { existingSaltHex: '66'.repeat(32), kdf: ARGON2_TEST });
    expect(seen).toEqual([ARGON2_TEST]);
  });
});
