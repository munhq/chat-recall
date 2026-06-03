/**
 * Client-side E2EE primitives for the Vault.
 *
 * Threat model: server is honest-but-curious. It stores ciphertext and
 * may be compromised; the bytes must remain useless without the user's
 * passphrase. Server NEVER sees plaintext, never sees the master key,
 * never sees the passphrase.
 *
 * Construction (boring is good):
 *   master_key = Argon2id(passphrase, salt, m=64MB, t=3, p=1) → 32 bytes
 *   per-blob   = XChaCha20-Poly1305 AEAD with random 24-byte nonce
 *   wire frame = [v=1][nonce(24)][ct||tag]
 *   key_id     = sha256(master_key).slice(0, 12)  — public stable id
 *
 * Why XChaCha20-Poly1305: 24-byte nonce makes random nonce safe (no
 * counter sync needed). Authenticated. libsodium parity.
 *
 * Why Argon2id at m=64MB: standard OWASP recommendation. ~1s on a laptop,
 * acceptable once-per-CLI-startup. Cached in-memory after first derive.
 */

import { argon2id } from '@noble/hashes/argon2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes as nobleRandomBytes } from '@noble/ciphers/utils.js';

export const VAULT_FRAME_VERSION = 1;
export const NONCE_BYTES = 24;
export const KEY_BYTES = 32;
export const SALT_BYTES = 32;
export const TAG_BYTES = 16;

/** Argon2id parameter shape — see ARGON2_PROD / ARGON2_TEST below. */
export interface Argon2Params {
  /** Memory cost in KiB. Default prod = 65536 (64 MiB). */
  m: number;
  /** Iterations. Default prod = 3. */
  t: number;
  /** Parallelism. Always 1 for cross-machine determinism. */
  p: number;
  /** Output length in bytes. Always KEY_BYTES (32). */
  dkLen: number;
}

/** Production-grade Argon2id parameters. ~1s on a laptop. */
export const ARGON2_PROD: Argon2Params = { m: 64 * 1024, t: 3, p: 1, dkLen: KEY_BYTES };

/**
 * Reduced parameters for tests. NOT for production. Same KDF, same
 * algorithm — just a smaller working set so the test suite doesn't
 * spend 30s on key derivation. Cryptographic properties (deterministic,
 * passphrase + salt → key) are identical; resistance to brute force is
 * weaker (which is the whole point in a test).
 */
export const ARGON2_TEST: Argon2Params = { m: 256, t: 1, p: 1, dkLen: KEY_BYTES };

/**
 * Derive the 32-byte master key from a passphrase + per-user salt.
 *
 * The salt is NOT secret — store it on the server alongside the user
 * profile. What's secret is the passphrase. Two devices with the same
 * passphrase + same salt yield the same master_key, which is exactly
 * what enables multi-device decryption.
 */
export function deriveMasterKey(passphrase: string, salt: Uint8Array, params: Argon2Params = ARGON2_PROD): Uint8Array {
  if (salt.length !== SALT_BYTES) throw new Error(`salt must be ${SALT_BYTES} bytes, got ${salt.length}`);
  if (!passphrase || passphrase.length < 8) throw new Error('passphrase must be at least 8 characters');
  return argon2id(new TextEncoder().encode(passphrase), salt, params);
}

/**
 * Generate a fresh per-user salt. Call once per user, persist to settings,
 * and reuse across devices.
 */
export function generateSalt(): Uint8Array {
  return nobleRandomBytes(SALT_BYTES);
}

/**
 * Public, stable identifier for the master key. Used in wire frames and
 * blob refs so the server can route the right ciphertext to the right
 * key without ever seeing the key itself. sha256 of the key, truncated;
 * 12 bytes (96 bits) is overkill for collision resistance per-user.
 */
export function keyIdFor(masterKey: Uint8Array): string {
  if (masterKey.length !== KEY_BYTES) throw new Error('master key must be 32 bytes');
  return Buffer.from(sha256(masterKey)).subarray(0, 12).toString('hex');
}

/**
 * Encrypt a payload with a fresh random nonce. Returns the wire frame:
 *   [version:1][nonce:24][ciphertext+tag:N+16]
 *
 * Never call with a deterministic nonce — XChaCha20's 24-byte random
 * nonce is collision-safe up to 2^96 messages per key, which is fine
 * for this use case. For the same reason we don't need a counter.
 */
export function encryptBlob(masterKey: Uint8Array, plaintext: Uint8Array): Uint8Array {
  if (masterKey.length !== KEY_BYTES) throw new Error('master key must be 32 bytes');
  const nonce = nobleRandomBytes(NONCE_BYTES);
  const cipher = xchacha20poly1305(masterKey, nonce);
  const ct = cipher.encrypt(plaintext);
  const out = new Uint8Array(1 + NONCE_BYTES + ct.length);
  out[0] = VAULT_FRAME_VERSION;
  out.set(nonce, 1);
  out.set(ct, 1 + NONCE_BYTES);
  return out;
}

/**
 * Decrypt a wire frame. Throws if the version byte is unknown, the
 * frame is truncated, or the AEAD tag fails (wrong key OR tampered
 * ciphertext — indistinguishable, by design).
 */
export function decryptBlob(masterKey: Uint8Array, frame: Uint8Array): Uint8Array {
  if (masterKey.length !== KEY_BYTES) throw new Error('master key must be 32 bytes');
  if (frame.length < 1 + NONCE_BYTES + TAG_BYTES) throw new Error('frame too short');
  const version = frame[0];
  if (version !== VAULT_FRAME_VERSION) throw new Error(`unknown vault frame version: ${version}`);
  const nonce = frame.subarray(1, 1 + NONCE_BYTES);
  const ct = frame.subarray(1 + NONCE_BYTES);
  const cipher = xchacha20poly1305(masterKey, nonce);
  return cipher.decrypt(ct);
}

/** sha256 of a byte buffer as lowercase hex — used for blob integrity refs. */
export function sha256Hex(bytes: Uint8Array): string {
  return Buffer.from(sha256(bytes)).toString('hex');
}
