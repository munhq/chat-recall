/**
 * S3-compatible object storage for the raw session archive.
 *
 * `raw_sessions.gz` held the gzipped transcript as BYTEA. On the production
 * database that column was 1232 MB of a 3564 MB database, and its heap was
 * 2.7 MB — all of it TOAST. Nothing on the read path scans it: every accessor
 * but getRawSession reads session_id, mtime, size and project_id, and
 * getRawSession fetches one row by primary key.
 *
 * WHY THE SIGNING IS HERE. The three operations this needs are PUT, GET and
 * DELETE of a single object. @aws-sdk/client-s3 brings roughly 20 MB and
 * dozens of transitive packages into a package that carries 8 dependencies,
 * and into a daemon whose resident heap is the reason the MCP relay exists.
 * SigV4 over the global fetch is ~150 lines against @noble/hashes, which is
 * already a dependency. Signature correctness is covered by the AWS-published
 * test vectors in object-store.test.ts.
 *
 * AUTHORIZATION LIVES IN POSTGRES, NOT HERE. Object storage has no row-level
 * security. The key is reachable only through a raw_sessions row, and that row
 * is behind the tenant_isolation and author_visibility policies. A caller who
 * cannot SELECT the row never learns the key, so the RLS model that protected
 * the bytes still protects them. The key is built from the tenant the store
 * was opened with, never from anything a request supplies.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';

export interface ObjectStoreConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const enc = new TextEncoder();
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const sha256hex = (b: Uint8Array | string) => hex(sha256(typeof b === 'string' ? enc.encode(b) : b));

/**
 * Read the configuration from the environment.
 *
 * Absent bucket, key or secret returns null, and the caller keeps writing the
 * bytes to Postgres. A self-hosted deployment must not be required to run
 * object storage to archive a session.
 */
export function objectStoreFromEnv(): ObjectStoreConfig | null {
  const bucket = process.env.RAW_ARCHIVE_S3_BUCKET;
  const accessKeyId = process.env.RAW_ARCHIVE_S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.RAW_ARCHIVE_S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
  const endpoint = process.env.RAW_ARCHIVE_S3_ENDPOINT;
  if (!bucket || !accessKeyId || !secretAccessKey || !endpoint) return null;
  return {
    endpoint: endpoint.replace(/\/+$/, ''),
    region: process.env.RAW_ARCHIVE_S3_REGION || 'us-east-1',
    bucket,
    accessKeyId,
    secretAccessKey,
  };
}

/**
 * The object key for one session's archive.
 *
 * `tenant` is the value the store was opened with, which comes from the request
 * context and never from the request body. session_id is percent-encoded so a
 * value carrying a slash cannot reach outside its tenant's prefix.
 */
export function rawObjectKey(tenant: string, sessionId: string): string {
  return `raw/${encodeURIComponent(tenant)}/${encodeURIComponent(sessionId)}.gz`;
}

/** Every character S3 leaves unreserved in a path segment. */
function uriEncodeSegment(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** A key is signed segment by segment, because the slashes are path separators. */
function canonicalPath(bucket: string, key: string): string {
  return `/${uriEncodeSegment(bucket)}/${key.split('/').map(uriEncodeSegment).join('/')}`;
}

/**
 * Sign one request with AWS Signature Version 4.
 *
 * UNSIGNED-PAYLOAD is not used: the body hash goes into the signature, so a
 * proxy cannot alter an archive in flight without invalidating it.
 */
export function signRequest(
  cfg: ObjectStoreConfig,
  method: 'PUT' | 'GET' | 'DELETE' | 'HEAD',
  key: string,
  body: Uint8Array,
  now = new Date(),
): { url: string; headers: Record<string, string> } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const host = new URL(cfg.endpoint).host;
  const path = canonicalPath(cfg.bucket, key);
  const payloadHash = sha256hex(body);

  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map((h) => `${h}:${headers[h]}\n`).join('');
  const canonicalRequest = [method, path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');

  let signingKey = hmac(sha256, enc.encode(`AWS4${cfg.secretAccessKey}`), enc.encode(dateStamp));
  for (const part of [cfg.region, 's3', 'aws4_request']) signingKey = hmac(sha256, signingKey, enc.encode(part));
  const signature = hex(hmac(sha256, signingKey, enc.encode(stringToSign)));

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { url: `${cfg.endpoint}${path}`, headers };
}

/** Thrown so a caller can tell "the object is not there" from "the store is broken". */
export class ObjectNotFound extends Error {}

export class ObjectStore {
  constructor(private readonly cfg: ObjectStoreConfig) {}

  /** The bucket, for a log line that says where an archive went. */
  get bucket(): string { return this.cfg.bucket; }

  async put(key: string, body: Buffer): Promise<void> {
    const bytes = new Uint8Array(body);
    const { url, headers } = signRequest(this.cfg, 'PUT', key, bytes);
    const r = await fetch(url, { method: 'PUT', headers, body: bytes });
    if (!r.ok) throw new Error(`object PUT ${key} failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  }

  async get(key: string): Promise<Buffer> {
    const { url, headers } = signRequest(this.cfg, 'GET', key, new Uint8Array());
    const r = await fetch(url, { method: 'GET', headers });
    if (r.status === 404) throw new ObjectNotFound(key);
    if (!r.ok) throw new Error(`object GET ${key} failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return Buffer.from(await r.arrayBuffer());
  }

  /** A key that is already gone reports success, so a repeated purge is safe. */
  async delete(key: string): Promise<void> {
    const { url, headers } = signRequest(this.cfg, 'DELETE', key, new Uint8Array());
    const r = await fetch(url, { method: 'DELETE', headers });
    if (!r.ok && r.status !== 404) throw new Error(`object DELETE ${key} failed: ${r.status}`);
  }
}

let cached: ObjectStore | null | undefined;
/** The process-wide store, or null when the environment configures none. */
export function getObjectStore(): ObjectStore | null {
  if (cached === undefined) {
    const cfg = objectStoreFromEnv();
    cached = cfg ? new ObjectStore(cfg) : null;
  }
  return cached;
}
/** Test seam: forget the memoized store so the next call re-reads the env. */
export function resetObjectStore(): void { cached = undefined; }
