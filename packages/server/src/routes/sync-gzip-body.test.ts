/**
 * The collector gzips its request body. This proves the server end of that deal.
 *
 * Nothing compressed the sync payload before: every walk shipped raw JSON.
 * Measured over five real sessions, 11.47 MB of envelope becomes 6.69 MB gzipped
 * — 42% off the wire for one header. The reason it is only a header is that
 * body-parser inflates a `Content-Encoding: gzip` body, and its size limit
 * applies to the DECOMPRESSED body, so the 32 MB ceiling on /api/sync means the
 * same thing before and after.
 *
 * That claim deserves a test rather than a comment: if it were wrong, the
 * failure mode is every upload failing the moment a server advertises support.
 *
 * NOTE ON THE HARNESS: these tests drive a real listener with `fetch`, not
 * supertest. Supertest re-serializes a Buffer passed to `.send()`, so the server
 * never sees the gzip bytes and every case 400s — which looks exactly like
 * "express cannot do this" and is really "the test client cannot do this".
 */
import { describe, test, expect } from 'vitest';
import express from 'express';
import { gzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';

/** The same parser configuration /api/sync runs behind in server.ts. */
async function withServer<T>(
  limit: string,
  fn: (post: (body: string | Buffer, headers: Record<string, string>) => Promise<{ status: number; json: any }>) => Promise<T>,
): Promise<T> {
  const app = express();
  app.use(express.json({ limit }));
  app.post('/echo', (req, res) => { res.json({ got: req.body }); });
  // Body-parser rejections surface as errors; report the status it chose.
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status || 500).json({ error: err.type || err.message });
  });
  const srv = app.listen(0);
  try {
    await new Promise<void>((r) => srv.once('listening', () => r()));
    const port = (srv.address() as AddressInfo).port;
    const post = async (body: string | Buffer, headers: Record<string, string>) => {
      const res = await fetch(`http://127.0.0.1:${port}/echo`, { method: 'POST', headers, body });
      return { status: res.status, json: await res.json().catch(() => null) };
    };
    return await fn(post);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
}

const JSON_H = { 'content-type': 'application/json' };
const GZIP_H = { ...JSON_H, 'content-encoding': 'gzip' };

describe('gzipped request bodies', () => {
  test('a gzipped body parses to exactly what a plain body would', async () => {
    await withServer('32mb', async (post) => {
      const payload = { conversations: [{ session_id: 'abc', envelope: 'x'.repeat(4096) }] };
      const raw = JSON.stringify(payload);

      const plain = await post(raw, JSON_H);
      const gz = await post(gzipSync(Buffer.from(raw)), GZIP_H);

      expect(plain.status).toBe(200);
      expect(gz.status).toBe(200);
      expect(gz.json.got).toEqual(payload);
      expect(gz.json.got).toEqual(plain.json.got);
    });
  });

  // The point of compressing: repetitive transcript JSON shrinks a lot, so what
  // crosses the wire is far smaller than what the server parses.
  test('the wire body is much smaller than the parsed body', () => {
    const payload = JSON.stringify({ conversations: [{ envelope: 'ab'.repeat(200_000) }] });
    const wire = gzipSync(Buffer.from(payload), { level: 6 });
    expect(wire.length).toBeLessThan(Buffer.byteLength(payload) / 4);
  });

  // THE CEILING STILL MEANS THE SAME THING. The limit is applied to the INFLATED
  // body, so a small gzip that expands past it is refused — compression cannot
  // be used to smuggle an oversized payload past the /api/sync 32 MB cap.
  test('the size limit applies to the DECOMPRESSED body, not the wire bytes', async () => {
    await withServer('64kb', async (post) => {
      const big = JSON.stringify({ envelope: 'a'.repeat(512 * 1024) });   // 512 KB inflated
      const wire = gzipSync(Buffer.from(big), { level: 9 });
      expect(wire.length).toBeLessThan(64 * 1024);                        // fits on the wire

      const res = await post(wire, GZIP_H);
      expect(res.status).toBe(413);                                       // judged on inflated size
    });
  });

  test('a body that claims gzip but is not is rejected, never silently accepted', async () => {
    await withServer('32mb', async (post) => {
      const res = await post(Buffer.from('{"not":"gzipped"}'), GZIP_H);
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });

  test('an uncompressed body still works — the encoding is opt-in per request', async () => {
    await withServer('32mb', async (post) => {
      const res = await post(JSON.stringify({ ok: true }), JSON_H);
      expect(res.status).toBe(200);
      expect(res.json.got).toEqual({ ok: true });
    });
  });
});

describe('advertised limits', () => {
  test('the server publishes the ingest concurrency it actually enforces', async () => {
    const { advertisedLimits, CLASSES } = await import('../middleware/rate-limit-config.js');
    const limits = advertisedLimits();
    // The number the collector clamps its in-flight budget to MUST be the one
    // the limiter enforces — the 429 storm was these two disagreeing (client 4,
    // server 2).
    expect(limits.ingestConcurrencyPerTenant).toBe(CLASSES.ingest.concurrencyPerTenant);
    expect(limits.ingestConcurrencyPerTenant).toBeGreaterThanOrEqual(1);
    expect(limits.acceptsGzipBody).toBe(true);
  });
});
