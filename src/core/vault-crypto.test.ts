/**
 * Crypto correctness + safety tests for the Vault.
 *
 * Property focus over example focus: round-trip arbitrary payloads,
 * tampering must always be detected, wrong key must always fail, two
 * encrypts of the same plaintext must produce different ciphertexts
 * (random nonce).
 */
import { describe, test, expect } from 'vitest';
import {
  deriveMasterKey, generateSalt, keyIdFor,
  encryptBlob, decryptBlob, sha256Hex,
  VAULT_FRAME_VERSION, NONCE_BYTES, KEY_BYTES, SALT_BYTES,
  ARGON2_TEST, ARGON2_PROD,
} from './vault-crypto.js';

/** Test helper — production-grade Argon2 takes ~1s; tests use weak params. */
const dk = (pp: string, salt: Uint8Array) => deriveMasterKey(pp, salt, ARGON2_TEST);

describe('vault-crypto', () => {
  test('deriveMasterKey is deterministic for (passphrase, salt)', () => {
    const salt = generateSalt();
    const k1 = dk('correct horse battery staple', salt);
    const k2 = dk('correct horse battery staple', salt);
    expect(k1).toEqual(k2);
    expect(k1.length).toBe(KEY_BYTES);
  });

  test('different salt with same passphrase yields different key', () => {
    const k1 = dk('pw-pw-pw', generateSalt());
    const k2 = dk('pw-pw-pw', generateSalt());
    expect(k1).not.toEqual(k2);
  });

  test('different passphrase with same salt yields different key', () => {
    const salt = generateSalt();
    const k1 = dk('pw-pw-pw', salt);
    const k2 = dk('different-passphrase', salt);
    expect(k1).not.toEqual(k2);
  });

  test('rejects short passphrase', () => {
    expect(() => deriveMasterKey('short', generateSalt())).toThrow(/8 characters/);
  });

  test('rejects wrong-length salt', () => {
    expect(() => deriveMasterKey('passphrase', new Uint8Array(16))).toThrow(/salt must be/);
  });

  test('generateSalt is fresh and right-sized', () => {
    const a = generateSalt();
    const b = generateSalt();
    expect(a.length).toBe(SALT_BYTES);
    expect(a).not.toEqual(b);
  });

  test('keyIdFor is stable + 24 hex chars (12 bytes)', () => {
    const k = dk('passphrase', generateSalt());
    const id1 = keyIdFor(k);
    const id2 = keyIdFor(k);
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{24}$/);
  });

  test('encryptBlob → decryptBlob round-trips arbitrary bytes', () => {
    const k = dk('passphrase', generateSalt());
    const cases = [
      Buffer.from(''),
      Buffer.from('hello world'),
      Buffer.from(JSON.stringify({ session: 'abc', messages: [{ role: 'user', text: 'hi' }] })),
      Buffer.alloc(64 * 1024, 0xab),                       // 64KB binary
      Buffer.from('multi\nline\nwithééé utf-8'),
    ];
    for (const pt of cases) {
      const frame = encryptBlob(k, pt);
      expect(frame[0]).toBe(VAULT_FRAME_VERSION);
      expect(frame.length).toBe(1 + NONCE_BYTES + pt.length + 16);  // +16 = poly1305 tag
      const dt = decryptBlob(k, frame);
      expect(Buffer.from(dt).equals(pt)).toBe(true);
    }
  });

  test('two encrypts of same plaintext yield different ciphertexts (random nonce)', () => {
    const k = dk('passphrase', generateSalt());
    const pt = Buffer.from('same message');
    const a = encryptBlob(k, pt);
    const b = encryptBlob(k, pt);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    // Both must still decrypt to the same plaintext
    expect(Buffer.from(decryptBlob(k, a)).equals(pt)).toBe(true);
    expect(Buffer.from(decryptBlob(k, b)).equals(pt)).toBe(true);
  });

  test('decrypt with wrong key throws (AEAD authentication)', () => {
    const k = dk('passphrase', generateSalt());
    const wrong = dk('different-passphrase', generateSalt());
    const frame = encryptBlob(k, Buffer.from('secret'));
    expect(() => decryptBlob(wrong, frame)).toThrow();
  });

  test('decrypt detects tampering (single-bit flip in ciphertext)', () => {
    const k = dk('passphrase', generateSalt());
    const frame = encryptBlob(k, Buffer.from('integrity matters'));
    const tampered = new Uint8Array(frame);
    // Flip a bit in the middle of the ciphertext (after version+nonce).
    const target = 1 + NONCE_BYTES + 2;
    tampered[target] ^= 0x01;
    expect(() => decryptBlob(k, tampered)).toThrow();
  });

  test('decrypt detects truncation', () => {
    const k = dk('passphrase', generateSalt());
    const frame = encryptBlob(k, Buffer.from('integrity matters'));
    expect(() => decryptBlob(k, frame.subarray(0, frame.length - 1))).toThrow();
    expect(() => decryptBlob(k, new Uint8Array(0))).toThrow(/too short/);
  });

  test('decrypt rejects unknown frame version', () => {
    const k = dk('passphrase', generateSalt());
    const frame = encryptBlob(k, Buffer.from('hello'));
    const tampered = new Uint8Array(frame);
    tampered[0] = 99;
    expect(() => decryptBlob(k, tampered)).toThrow(/version/);
  });

  test('cross-device parity: same passphrase + same salt on a fresh derive decrypts a peer\'s frame', () => {
    // Simulate: device A derives a key, encrypts a blob, ships frame +
    // salt to device B. Device B re-derives from the same passphrase +
    // salt and decrypts. This is the multi-device guarantee.
    const passphrase = 'shared-by-both-devices';
    const salt = generateSalt();
    const keyA = dk(passphrase, salt);
    const frame = encryptBlob(keyA, Buffer.from('chat history from PC'));

    const keyB = dk(passphrase, salt);
    expect(keyIdFor(keyA)).toBe(keyIdFor(keyB));
    const dt = decryptBlob(keyB, frame);
    expect(Buffer.from(dt).toString()).toBe('chat history from PC');
  });

  /**
   * Slow canary — exercises the real production Argon2 parameters once.
   * Skipped by default; opt in with VAULT_CRYPTO_FULL=1 for release-prep
   * runs. Asserts the prod KDF still produces a 32-byte key and is
   * deterministic — guards against accidental param drift.
   */
  test.skipIf(process.env.VAULT_CRYPTO_FULL !== '1')(
    'production-strength Argon2 derives a stable 32-byte key (~1s, opt-in)',
    () => {
      const salt = generateSalt();
      const k1 = deriveMasterKey('canary-passphrase', salt, ARGON2_PROD);
      const k2 = deriveMasterKey('canary-passphrase', salt, ARGON2_PROD);
      expect(k1).toEqual(k2);
      expect(k1.length).toBe(KEY_BYTES);
    },
    20_000,  // generous timeout for slow CI
  );

  test('sha256Hex is 64 chars and stable', () => {
    const a = sha256Hex(Buffer.from('hello'));
    const b = sha256Hex(Buffer.from('hello'));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
