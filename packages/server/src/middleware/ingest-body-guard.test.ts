/**
 * The ingest guard bounds the MEMORY of the append route, not its row cost.
 *
 * Asserted rather than assumed because both failure directions are silent: one
 * limit too loose and a single append still kills a 512 MiB pod with no error
 * in the log (the collector only reports "append sync failed: HTTP 502"), one
 * limit too tight and every collector is refused with 413 forever.
 */
import { describe, test, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Request, Response, NextFunction } from 'express';
import {
  ingestBodyGuard,
  ingestInFlight,
  resetIngestGuard,
  DEFAULT_INGEST_MAX_BODY_BYTES,
  INGEST_BUSY_RETRY_AFTER_MS,
} from './ingest-body-guard.js';

interface Reply {
  status?: number;
  body?: any;
  headers: Record<string, string>;
  finished: () => void;
}

/** Minimal express Response: enough for status/json/setHeader and its events. */
function fakeRes(): { res: Response; reply: Reply } {
  const emitter = new EventEmitter();
  const reply: Reply = {
    headers: {},
    finished: () => emitter.emit('finish'),
  };
  const res = {
    status(code: number) { reply.status = code; return res; },
    json(body: unknown) { reply.body = body; return res; },
    setHeader(name: string, value: string) { reply.headers[name.toLowerCase()] = value; return res; },
    on(event: string, fn: () => void) { emitter.on(event, fn); return res; },
    // The guard listens on `finish`/`close`; the test fires them like the
    // socket would, so the release latch is exercised, not bypassed.
    emit(event: string) { return emitter.emit(event); },
  } as unknown as Response;
  return { res, reply };
}

function fakeReq(contentLength?: number | string, ip = '203.0.113.7'): Request {
  const headers: Record<string, string> = {};
  if (contentLength !== undefined) headers['content-length'] = String(contentLength);
  return { headers, ip, originalUrl: '/api/sync', path: '/api/sync' } as unknown as Request;
}

beforeEach(() => resetIngestGuard());

describe('ingestBodyGuard — the body size', () => {
  test('a body above the cap is refused with 413 and never reaches the parser', () => {
    const guard = ingestBodyGuard({ maxBodyBytes: 1024, maxInflight: 2 });
    const { res, reply } = fakeRes();
    let parsed = false;
    guard(fakeReq(2048), res, (() => { parsed = true; }) as NextFunction);

    expect(parsed).toBe(false);
    expect(reply.status).toBe(413);
    expect(reply.body.code).toBe('body_too_large');
    expect(reply.body.max_bytes).toBe(1024);
    // A refused request must not hold a slot.
    expect(ingestInFlight()).toBe(0);
  });

  test('a body at the cap is accepted', () => {
    const guard = ingestBodyGuard({ maxBodyBytes: 1024, maxInflight: 2 });
    const { res } = fakeRes();
    let parsed = false;
    guard(fakeReq(1024), res, (() => { parsed = true; }) as NextFunction);
    expect(parsed).toBe(true);
    expect(ingestInFlight()).toBe(1);
  });

  test('a chunked body has no declared size and passes the byte check', () => {
    const guard = ingestBodyGuard({ maxBodyBytes: 1024, maxInflight: 2 });
    const { res } = fakeRes();
    let parsed = false;
    guard(fakeReq(undefined), res, (() => { parsed = true; }) as NextFunction);
    expect(parsed).toBe(true);
  });

  test('the default cap is the documented 8 MiB', () => {
    expect(DEFAULT_INGEST_MAX_BODY_BYTES).toBe(8 * 1024 * 1024);
  });
});

describe('ingestBodyGuard — the bodies in flight', () => {
  test('at the cap the next append gets 429 with Retry-After and no parse', () => {
    const guard = ingestBodyGuard({ maxBodyBytes: 1024, maxInflight: 2 });
    const first = fakeRes();
    const second = fakeRes();
    const third = fakeRes();
    guard(fakeReq(10), first.res, (() => {}) as NextFunction);
    guard(fakeReq(10), second.res, (() => {}) as NextFunction);

    let parsed = false;
    guard(fakeReq(10), third.res, (() => { parsed = true; }) as NextFunction);

    expect(parsed).toBe(false);
    expect(third.reply.status).toBe(429);
    expect(third.reply.body.code).toBe('ingest_busy');
    expect(third.reply.headers['retry-after']).toBe(String(Math.ceil(INGEST_BUSY_RETRY_AFTER_MS / 1000)));
    expect(ingestInFlight()).toBe(2);
  });

  test('a finished append frees its slot for the next one', () => {
    const guard = ingestBodyGuard({ maxBodyBytes: 1024, maxInflight: 1 });
    const first = fakeRes();
    guard(fakeReq(10), first.res, (() => {}) as NextFunction);
    expect(ingestInFlight()).toBe(1);

    const refused = fakeRes();
    guard(fakeReq(10), refused.res, (() => {}) as NextFunction);
    expect(refused.reply.status).toBe(429);

    first.reply.finished();
    expect(ingestInFlight()).toBe(0);

    const next = fakeRes();
    let parsed = false;
    guard(fakeReq(10), next.res, (() => { parsed = true; }) as NextFunction);
    expect(parsed).toBe(true);
    expect(ingestInFlight()).toBe(1);
  });

  test('a dropped connection releases the slot exactly once', () => {
    const guard = ingestBodyGuard({ maxBodyBytes: 1024, maxInflight: 1 });
    const { res } = fakeRes();
    guard(fakeReq(10), res, (() => {}) as NextFunction);
    // Both events fire on a normal end; the counter must return to 0, not -1.
    (res as unknown as { emit: (e: string) => void }).emit('finish');
    (res as unknown as { emit: (e: string) => void }).emit('close');
    expect(ingestInFlight()).toBe(0);
  });

  test('the parser limit and the guard are different bounds: many small bodies still trip', () => {
    const guard = ingestBodyGuard({ maxBodyBytes: 4096, maxInflight: 1 });
    const held = fakeRes();
    guard(fakeReq(4096), held.res, (() => {}) as NextFunction);
    const refused = fakeRes();
    guard(fakeReq(4096), refused.res, (() => {}) as NextFunction);
    expect(refused.reply.status).toBe(429);
  });
});
