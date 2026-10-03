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
import { ObjectStore, ObjectNotFound, objectStoreFromEnv, rawObjectKey, signRequest, presignUrl } from './object-store.js';

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

  test('query parameters are signed sorted, and land in the URL', () => {
    const at = new Date('2013-05-24T00:00:00Z');
    const a = signRequest(cfg, 'DELETE', 'raw/t/k.gz', new Uint8Array(), at, { uploadId: 'u 1', partNumber: '2' });
    expect(a.url).toBe('https://s3.example.invalid/archive/raw/t/k.gz?partNumber=2&uploadId=u%201');
    const b = signRequest(cfg, 'DELETE', 'raw/t/k.gz', new Uint8Array(), at, { uploadId: 'u 2', partNumber: '2' });
    expect(a.headers.authorization).not.toBe(b.headers.authorization);
  });

  test('a presigned URL carries its signature, expiry and only the host header', () => {
    const url = new URL(presignUrl(cfg, 'PUT', 'raw/t/k.gz', 3600, new Date('2013-05-24T00:00:00Z'), { partNumber: '1', uploadId: 'u' }));
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(url.searchParams.get('X-Amz-Credential')).toBe('AKIAIOSFODNN7EXAMPLE/20130524/gra/s3/aws4_request');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get('partNumber')).toBe('1');
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

  test('a multipart upload through presigned part URLs joins into one object', async () => {
    // S3 requires every part but the last to be at least 5 MiB.
    const big = Buffer.alloc(5 * 1024 * 1024, 7);
    const tail = Buffer.from('the last part may be small');
    const mkey = rawObjectKey('test-tenant', `multi-${Date.now()}`);
    const id = await store.createMultipart(mkey);
    const parts: Array<{ partNumber: number; etag: string }> = [];
    for (const [i, body] of [big, tail].entries()) {
      // No credentials here: the URL alone authorizes the PUT.
      const r = await fetch(store.presignPart(mkey, id, i + 1, 600), { method: 'PUT', body });
      expect(r.status).toBe(200);
      parts.push({ partNumber: i + 1, etag: r.headers.get('etag')! });
    }
    await store.completeMultipart(mkey, id, parts);
    expect(await store.size(mkey)).toBe(big.length + tail.length);
    const got = await store.get(mkey);
    expect(Buffer.compare(got, Buffer.concat([big, tail]))).toBe(0);
    await store.delete(mkey);
    expect(await store.size(mkey)).toBeNull();
  }, 60_000);

  test('an aborted upload leaves nothing, and its URLs stop working', async () => {
    const mkey = rawObjectKey('test-tenant', `abort-${Date.now()}`);
    const id = await store.createMultipart(mkey);
    const url = store.presignPart(mkey, id, 1, 600);
    await store.abortMultipart(mkey, id);
    const r = await fetch(url, { method: 'PUT', body: Buffer.from('late') });
    expect(r.status).toBe(404);
    expect(await store.size(mkey)).toBeNull();
    await store.abortMultipart(mkey, id);
  });

  test('a presigned URL with a changed query is refused', async () => {
    const mkey = rawObjectKey('test-tenant', `tamper-${Date.now()}`);
    const id = await store.createMultipart(mkey);
    const url = new URL(store.presignPart(mkey, id, 1, 600));
    url.searchParams.set('partNumber', '2');
    const r = await fetch(url, { method: 'PUT', body: Buffer.from('x') });
    expect(r.status).toBe(403);
    await store.abortMultipart(mkey, id);
  });
});
