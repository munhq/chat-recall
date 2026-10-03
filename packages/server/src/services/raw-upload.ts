/**
 * Raw archives too large for one sync request, uploaded in parts straight to
 * object storage.
 *
 * The client sent an archive inline only when it gzipped to 8 MB or less, so a
 * larger session kept the archive of the last time it was small enough: one
 * held 6.6 MB of a 54 MB transcript. Here the server opens an S3 multipart
 * upload under a key it derives from the tenant, hands the client presigned
 * part URLs, and on completion checks the object's size and records it with
 * the same shrink rule as an inline archive. The bytes never pass through the
 * server.
 *
 * The open upload lives in kv_store (tenant-scoped by RLS) until it completes.
 * One left open for a day is aborted, so S3 does not keep its parts.
 */
import { randomBytes } from 'node:crypto';
import type { StorageDriver } from '@chat-recall/engine/core/store/driver.js';
import { rawObjectKey, type RawObjectStore } from '@chat-recall/engine/core/store/object-store.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';

const log = createLogger('raw-upload');

/** Every part but the last. S3 requires at least 5 MiB. */
export const RAW_PART_BYTES = 8 * 1024 * 1024;
/** 1 GiB gzipped. */
export const RAW_UPLOAD_MAX_PARTS = 128;
const URL_EXPIRES_SEC = 3600;
const STALE_MS = 24 * 60 * 60 * 1000;
const KV_SCOPE = 'raw_upload';

interface OpenUpload {
  sessionId: string;
  objectKey: string;
  tool: string;
  mtime: number;
  size: number;
  gzSize: number;
  parts: number;
  projectId: string;
  projectPath: string;
}

export type UploadReply = { status: number; body: Record<string, unknown> };

type MultipartStore = Required<Pick<RawObjectStore, 'createMultipart' | 'presignPart' | 'completeMultipart' | 'abortMultipart' | 'size' | 'delete'>>;

/** The object store when it supports multipart uploads, else null. */
export function multipartStore(objects: RawObjectStore | null): MultipartStore | null {
  if (!objects?.createMultipart || !objects.presignPart || !objects.completeMultipart || !objects.abortMultipart || !objects.size) return null;
  return objects as MultipartStore;
}

const str = (v: unknown, max: number) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
const posInt = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null);

/** Abort this tenant's uploads that were opened a day ago or more. */
async function abortStale(store: StorageDriver, objects: MultipartStore): Promise<void> {
  const rows = await store.kvList(KV_SCOPE, 500);
  for (const r of rows) {
    if (Date.now() - Number(r.updated_at) < STALE_MS) continue;
    try {
      const up = JSON.parse(r.value) as OpenUpload;
      await objects.abortMultipart(up.objectKey, r.key);
    } catch (err) {
      log.warn({ err, uploadId: r.key }, 'could not abort a stale upload');
      continue;
    }
    await store.kvDelete(KV_SCOPE, r.key);
  }
}

export async function startRawUpload(store: StorageDriver, objects: MultipartStore, tenant: string, body: Record<string, unknown>): Promise<UploadReply> {
  const sessionId = str(body.session_id, 256);
  const tool = str(body.tool, 32);
  const mtime = posInt(body.mtime);
  const size = posInt(body.size);
  const gzSize = posInt(body.gz_size);
  if (!sessionId || !tool || !mtime || !size || !gzSize) {
    return { status: 400, body: { error: 'session_id, tool, mtime, size and gz_size are required' } };
  }
  const parts = Math.ceil(gzSize / RAW_PART_BYTES);
  if (parts > RAW_UPLOAD_MAX_PARTS) {
    return { status: 413, body: { error: `the archive is ${gzSize} bytes gzipped, more than the ${RAW_UPLOAD_MAX_PARTS * RAW_PART_BYTES} an upload takes` } };
  }
  // The shrink rule, checked before any byte moves.
  const prior = (await store.rawSessionMetaMany([sessionId])).get(sessionId);
  if (prior && Number(prior.size) === size && Number(prior.mtime) >= mtime) return { status: 200, body: { result: 'unchanged' } };
  if (prior && size < Number(prior.size)) return { status: 200, body: { result: 'shrink-protected' } };

  await abortStale(store, objects);
  const objectKey = rawObjectKey(tenant, sessionId, randomBytes(8).toString('hex'));
  const uploadId = await objects.createMultipart(objectKey);
  const record: OpenUpload = {
    sessionId, objectKey, tool, mtime, size, gzSize, parts,
    projectId: str(body.project_id, 512) ?? '', projectPath: str(body.project_path, 4096) ?? '',
  };
  await store.kvSet(KV_SCOPE, uploadId, JSON.stringify(record));
  const urls = Array.from({ length: parts }, (_, i) => objects.presignPart(objectKey, uploadId, i + 1, URL_EXPIRES_SEC));
  return { status: 200, body: { upload_id: uploadId, part_bytes: RAW_PART_BYTES, urls } };
}

export async function completeRawUpload(store: StorageDriver, objects: MultipartStore, body: Record<string, unknown>): Promise<UploadReply> {
  const sessionId = str(body.session_id, 256);
  const uploadId = str(body.upload_id, 1024);
  const parts = Array.isArray(body.parts) ? body.parts as Array<{ part_number?: unknown; etag?: unknown }> : null;
  if (!sessionId || !uploadId || !parts) return { status: 400, body: { error: 'session_id, upload_id and parts are required' } };
  // kv_store is tenant-scoped, so an id from another tenant is not found.
  const row = await store.kvGet(KV_SCOPE, uploadId);
  if (!row) return { status: 404, body: { error: 'no open upload with that id' } };
  const up = JSON.parse(row.value) as OpenUpload;
  if (up.sessionId !== sessionId) return { status: 400, body: { error: 'that upload belongs to another session' } };
  const list = parts.map((p) => ({ partNumber: posInt(p.part_number) ?? 0, etag: str(p.etag, 256) ?? '' }));
  const numbers = list.map((p) => p.partNumber).sort((a, b) => a - b);
  if (list.length !== up.parts || numbers.some((n, i) => n !== i + 1) || list.some((p) => !p.etag)) {
    return { status: 400, body: { error: `expected parts 1 to ${up.parts}, each with its etag` } };
  }

  await objects.completeMultipart(up.objectKey, uploadId, list);
  await store.kvDelete(KV_SCOPE, uploadId);
  const stored = await objects.size(up.objectKey);
  if (stored !== up.gzSize) {
    await objects.delete(up.objectKey);
    return { status: 400, body: { error: `the uploaded archive is ${stored} bytes, not the ${up.gzSize} announced` } };
  }
  if (!store.putRawSessionObject) {
    await objects.delete(up.objectKey);
    return { status: 501, body: { error: 'this server stores raw archives without object storage' } };
  }
  const result = await store.putRawSessionObject(sessionId, up.tool, up.mtime, up.objectKey, up.size, up.projectId, up.projectPath);
  // Only a stored row names the object; otherwise nothing ever reads it.
  if (result !== 'stored') await objects.delete(up.objectKey);
  log.info({ session: sessionId, gzSize: up.gzSize, size: up.size, result }, 'raw archive uploaded in parts');
  return { status: 200, body: { result, gz_size: up.gzSize } };
}
