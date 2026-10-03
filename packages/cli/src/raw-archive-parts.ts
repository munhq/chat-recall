/**
 * A raw archive too large to send inline, built as a stream into a temp file
 * and uploaded in parts straight to object storage.
 *
 * The inline archive goes in the sync request, so it is dropped above 8 MB
 * gzipped, and a session over the full-build ceiling never builds one: the
 * export would hold the whole transcript in memory. Here the archive is written
 * line by line (each line redacted, then JSON-escaped) through gzip into a file,
 * so memory holds one line at a time. The server hands back presigned part
 * URLs (packages/server/src/services/raw-upload.ts), and the parts go to S3
 * without passing through the server.
 */
import { createReadStream, createWriteStream, openSync, readSync, closeSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createGzip } from 'node:zlib';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { redactJsonLine } from '@chat-recall/engine/transcript/index.js';

export type ArchiveSource =
  | { kind: 'memory'; files: Array<{ name: string; text: string }> }
  | { kind: 'disk'; files: Array<{ name: string; path: string }> };

export interface ArchiveFile {
  path: string;
  /** Bytes of the gzipped file. */
  gzSize: number;
  /** Bytes of the container JSON before gzip, the unit the server's shrink rule uses. */
  size: number;
}

/** A JSON string literal's body, without its quotes. */
const escapeJson = (s: string) => JSON.stringify(s).slice(1, -1);

/** Lines of a file, each with its newline; the last one without, when the file has none. */
async function* fileLines(path: string): AsyncGenerator<string> {
  let rest = '';
  const decoder = new TextDecoder('utf-8');
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    rest += decoder.decode(chunk as Buffer, { stream: true });
    let nl = rest.indexOf('\n');
    while (nl >= 0) {
      yield rest.slice(0, nl + 1);
      rest = rest.slice(nl + 1);
      nl = rest.indexOf('\n');
    }
  }
  rest += decoder.decode();
  if (rest) yield rest;
}

function* textLines(text: string): Generator<string> {
  let at = 0;
  while (at < text.length) {
    const nl = text.indexOf('\n', at);
    const end = nl < 0 ? text.length : nl + 1;
    yield text.slice(at, end);
    at = end;
  }
}

/**
 * Write the container `{ v: 1, tool, mtime, files: [{ name, text }] }` gzipped
 * to a temp file, redacted the way redactContainer redacts the inline archive:
 * a .jsonl file line by line through redactJsonLine, which also reaches a
 * secret inside a JSON-escaped string, and any other file as one text. A JSONL
 * file streams, because each record and each secret in it is on one line.
 */
export async function writeArchiveFile(
  source: ArchiveSource,
  meta: { tool: string; mtime: number },
  redact: (line: string) => string,
  dir = tmpdir(),
): Promise<ArchiveFile> {
  const path = join(dir, `cr-archive-${randomBytes(8).toString('hex')}.json.gz`);
  const gzip = createGzip({ level: 6 });
  const out = createWriteStream(path, { mode: 0o600 });
  const done = once(out, 'finish');
  gzip.pipe(out);
  let size = 0;
  const write = async (s: string) => {
    size += Buffer.byteLength(s);
    if (!gzip.write(s)) await once(gzip, 'drain');
  };
  try {
    await write(`{"v":1,"tool":${JSON.stringify(meta.tool)},"mtime":${Math.floor(meta.mtime)},"files":[`);
    for (const [i, f] of source.files.entries()) {
      await write(`${i ? ',' : ''}{"name":${JSON.stringify(f.name)},"text":"`);
      const whole = () => (source.kind === 'memory' ? (f as { text: string }).text : readFileSync((f as { path: string }).path, 'utf-8'));
      if (!f.name.endsWith('.jsonl')) {
        await write(escapeJson(redact(whole())));
      } else {
        const lines = source.kind === 'memory' ? textLines((f as { text: string }).text) : fileLines((f as { path: string }).path);
        for await (const line of lines) {
          const nl = line.endsWith('\n');
          const body = nl ? line.slice(0, -1) : line;
          await write(escapeJson((body ? redactJsonLine(body, redact) : body) + (nl ? '\n' : '')));
        }
      }
      await write('"}');
    }
    await write(']}');
    gzip.end();
    await done;
  } catch (err) {
    gzip.destroy();
    out.destroy();
    rmSync(path, { force: true });
    throw err;
  }
  return { path, gzSize: statSync(path).size, size };
}

export type UploadOutcome = 'stored' | 'unchanged' | 'shrink-protected' | 'unsupported';

const PART_TIMEOUT_MS = 120_000;
const PART_ATTEMPTS = 3;

async function putPart(url: string, body: Buffer): Promise<string> {
  let last: unknown;
  for (let attempt = 1; attempt <= PART_ATTEMPTS; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), PART_TIMEOUT_MS);
    try {
      const r = await fetch(url, { method: 'PUT', body, signal: ac.signal });
      const etag = r.headers.get('etag');
      if (r.ok && etag) return etag;
      last = new Error(`part PUT answered ${r.status}`);
      // A refused signature or an expired URL does not improve on a retry.
      if (r.status === 403 || r.status === 404) break;
    } catch (err) {
      last = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/**
 * Upload `file` as the raw archive of `sessionId`. 'unsupported' means the
 * server has no object storage, which the caller treats as "keep the inline
 * behaviour". Any other failure throws.
 */
export async function uploadArchiveFile(
  base: string,
  token: string | undefined,
  args: { sessionId: string; tool: string; mtime: number; projectId?: string; projectPath?: string; file: ArchiveFile },
): Promise<UploadOutcome> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const post = async (path: string, body: object) => {
    const r = await fetch(`${base}/api/sync/raw-upload/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const json = await r.json().catch(() => ({})) as Record<string, any>;
    return { status: r.status, json };
  };

  const start = await post('start', {
    session_id: args.sessionId, tool: args.tool, mtime: Math.floor(args.mtime),
    size: args.file.size, gz_size: args.file.gzSize,
    project_id: args.projectId, project_path: args.projectPath,
  });
  if (start.status === 501 || start.status === 404) return 'unsupported';
  if (start.status !== 200) throw new Error(`raw upload start answered ${start.status}: ${start.json.error ?? ''}`);
  if (start.json.result === 'unchanged' || start.json.result === 'shrink-protected') return start.json.result;

  const urls = start.json.urls as string[];
  const partBytes = Number(start.json.part_bytes);
  const parts: Array<{ part_number: number; etag: string }> = [];
  const fd = openSync(args.file.path, 'r');
  try {
    for (const [i, url] of urls.entries()) {
      const len = Math.min(partBytes, args.file.gzSize - i * partBytes);
      const buf = Buffer.allocUnsafe(len);
      let got = 0;
      while (got < len) {
        const n = readSync(fd, buf, got, len - got, i * partBytes + got);
        if (n <= 0) break;
        got += n;
      }
      parts.push({ part_number: i + 1, etag: await putPart(url, buf.subarray(0, got)) });
    }
  } finally {
    closeSync(fd);
  }

  const done = await post('complete', { session_id: args.sessionId, upload_id: start.json.upload_id, parts });
  if (done.status !== 200) throw new Error(`raw upload complete answered ${done.status}: ${done.json.error ?? ''}`);
  return done.json.result as UploadOutcome;
}
