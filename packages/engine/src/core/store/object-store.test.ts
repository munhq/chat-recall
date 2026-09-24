/**
 * Proves the hand-written SigV4 signer against a real S3 implementation.
 *
 * A signature that is wrong fails closed — the server answers 403 — so the risk
 * this test covers is a signer that rejects every upload, not one that leaks.
 * It runs against MinIO because that is an independent implementation of the
 * same specification: a signer that satisfies it agrees with the spec rather
 * than with itself.
 *
 * Gated on RAW_ARCHIVE_S3_ENDPOINT so it skips where no store is configured.
 * Start one with:
 *   docker run -d -p 9000:9000 -e MINIO_ROOT_USER=testkey \
 *     -e MINIO_ROOT_PASSWORD=testsecret123 minio/minio server /data
 */
import { describe, test, expect } from 'vitest';
import { ObjectStore, ObjectNotFound, objectStoreFromEnv, rawObjectKey, signRequest } from './object-store.js';

const CONFIGURED = !!process.env.RAW_ARCHIVE_S3_ENDPOINT && !!process.env.RAW_ARCHIVE_S3_BUCKET;

describe('rawObjectKey', () => {
  test('scopes the key to the tenant', () => {
    expect(rawObjectKey('acme', 'abc-123')).toBe('raw/acme/abc-123.gz');
  });

  test('a session id carrying a slash cannot escape its tenant prefix', () => {
    const key = rawObjectKey('acme', '../other-tenant/steal');
    expect(key.startsWith('raw/acme/')).toBe(true);
    expect(key).not.toContain('/../');
    expect(key.split('/')).toHaveLength(3);
  });

  test('a tenant carrying a slash cannot open a second level', () => {
    expect(rawObjectKey('a/b', 'x').split('/')).toHaveLength(3);
  });

  test('a version names its own object inside the session\'s prefix', () => {
    expect(rawObjectKey('acme', 'abc-123', '0f1e2d3c4b5a6978')).toBe('raw/acme/abc-123.0f1e2d3c4b5a6978.gz');
    expect(rawObjectKey('acme', 'abc-123', 'a/b').split('/')).toHaveLength(3);
  });
});

describe('signRequest', () => {
  const cfg = {
    endpoint: 'https://s3.example.invalid',
    region: 'gra',
    bucket: 'archive',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  };

  test('signs the body, so an altered archive invalidates the signature', () => {
    const at = new Date('2013-05-24T00:00:00Z');
    const a = signRequest(cfg, 'PUT', 'raw/t/one.gz', new TextEncoder().encode('one'), at);
    const b = signRequest(cfg, 'PUT', 'raw/t/one.gz', new TextEncoder().encode('two'), at);
    expect(a.headers.authorization).not.toBe(b.headers.authorization);
  });

  test('carries the payload hash rather than UNSIGNED-PAYLOAD', () => {
    const { headers } = signRequest(cfg, 'GET', 'raw/t/one.gz', new Uint8Array(), new Date('2013-05-24T00:00:00Z'));
    // sha256 of the empty string, which is what a GET signs.
    expect(headers['x-amz-content-sha256']).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  test('is deterministic for a fixed instant', () => {
    const at = new Date('2013-05-24T00:00:00Z');
    const body = new TextEncoder().encode('same');
    expect(signRequest(cfg, 'PUT', 'raw/t/k.gz', body, at).headers.authorization)
      .toBe(signRequest(cfg, 'PUT', 'raw/t/k.gz', body, at).headers.authorization);
  });
});

(CONFIGURED ? describe : describe.skip)('ObjectStore against a real S3 server', () => {
  const store = new ObjectStore(objectStoreFromEnv()!);
  const key = rawObjectKey('test-tenant', `sess-${Date.now()}`);
  const payload = Buffer.from('gzipped-transcript-bytes\u0000ÿ binary safe');

  test('put then get returns the same bytes', async () => {
    await store.put(key, payload);
    expect(Buffer.compare(await store.get(key), payload)).toBe(0);
  });

  test('a missing key raises ObjectNotFound', async () => {
    await expect(store.get(rawObjectKey('test-tenant', 'never-written'))).rejects.toBeInstanceOf(ObjectNotFound);
  });

  test('put overwrites in place, so a re-synced session keeps one object', async () => {
    const grown = Buffer.concat([payload, Buffer.from(' and more')]);
    await store.put(key, grown);
    expect((await store.get(key)).length).toBe(grown.length);
  });

  test('delete removes it, and deleting twice succeeds', async () => {
    await store.delete(key);
    await expect(store.get(key)).rejects.toBeInstanceOf(ObjectNotFound);
    await store.delete(key);
  });
});
