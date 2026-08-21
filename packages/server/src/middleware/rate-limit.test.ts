/**
 * Plan multiplier on tenant-keyed rate budgets.
 *
 * The free tier gets 0.2× of every tenant-keyed budget; entitled tenants get
 * the full budget; a resolver failure fails OPEN to the full budget (a limiter
 * must never turn an entitlement hiccup into a 429 storm). Asserted rather than
 * assumed because both failure directions are silent: too tight and free users
 * hit 429s the plan never priced in; too loose and free is unmetered.
 */
import { describe, test, expect, vi, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// tenantLimits is the only billing import the limiter uses; drive it directly
// so the test exercises the middleware, not the entitlement stack behind it.
const billing = vi.hoisted(() => ({
  mults: new Map<string, number | 'boom'>(),
  calls: [] as string[],
}));
vi.mock('../util/billing.js', () => ({
  tenantLimits: vi.fn(async (tenant: string) => {
    billing.calls.push(tenant);
    const m = billing.mults.get(tenant) ?? 1;
    if (m === 'boom') throw new Error('control plane down');
    return { rateMultiplier: m };
  }),
}));

type RlModule = typeof import('./rate-limit.js');

const saved: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined): void {
  if (!(k in saved)) saved[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(saved)) delete saved[k];
  billing.mults.clear();
  billing.calls.length = 0;
});

/** ENFORCE, STORE_KIND and CLASSES are read at import time — load fresh per env. */
async function loadRl(env: Record<string, string | undefined> = {}): Promise<RlModule> {
  setEnv('RATE_LIMIT_STORE', 'memory');
  setEnv('RATE_LIMIT_ENFORCE', '1');
  // Small burst, negligible refill: token counts are deterministic in-test.
  setEnv('RL_READHEAVY_BURST', '10');
  setEnv('RL_READHEAVY_RPS', '0.001');
  setEnv('RL_INGEST_BURST', '100');
  setEnv('RL_INGEST_RPS', '0.001');
  for (const [k, v] of Object.entries(env)) setEnv(k, v);
  vi.resetModules();
  return await import('./rate-limit.js');
}

function fakeReq(tenant?: string): Request {
  return { tenant, ip: '203.0.113.9', originalUrl: '/api/x' } as unknown as Request;
}

interface Run { status: number; body: unknown; headers: Record<string, string>; nexted: boolean }

/** Drive one request through the middleware; fires 'finish' so concurrency
 *  slots release like a completed response would. */
async function run(mw: (req: Request, res: Response, next: NextFunction) => Promise<void>, req: Request): Promise<Run> {
  const headers: Record<string, string> = {};
  const finish: Array<() => void> = [];
  const out: Run = { status: 200, body: undefined, headers, nexted: false };
  const res = {
    setHeader: (k: string, v: string) => { headers[k] = v; },
    status: (c: number) => { out.status = c; return res; },
    json: (b: unknown) => { out.body = b; return res; },
    on: (ev: string, fn: () => void) => { if (ev === 'finish') finish.push(fn); },
  } as unknown as Response;
  await mw(req, res, () => { out.nexted = true; });
  for (const fn of finish) fn();
  return out;
}

describe('plan multiplier on tenant budgets', () => {
  test('free tenant gets the scaled budget (burst 10 × 0.2 = 2)', async () => {
    const { rl } = await loadRl();
    billing.mults.set('free-t', 0.2);
    const mw = rl('read-heavy');
    const first = await run(mw, fakeReq('free-t'));
    expect(first.nexted).toBe(true);
    expect(first.headers['RateLimit-Limit']).toBe('2');
    expect((await run(mw, fakeReq('free-t'))).nexted).toBe(true);
    const third = await run(mw, fakeReq('free-t'));
    expect(third.nexted).toBe(false);
    expect(third.status).toBe(429);
  });

  test('entitled tenant keeps the full budget', async () => {
    const { rl } = await loadRl();
    billing.mults.set('paid-t', 1);
    const mw = rl('read-heavy');
    for (let i = 0; i < 10; i++) {
      expect((await run(mw, fakeReq('paid-t'))).nexted).toBe(true);
    }
    const over = await run(mw, fakeReq('paid-t'));
    expect(over.status).toBe(429);
    expect(over.headers['RateLimit-Limit']).toBe('10');
  });

  test('resolver error fails OPEN to the full budget, resolved once per TTL', async () => {
    const { rl } = await loadRl();
    billing.mults.set('boom-t', 'boom');
    const mw = rl('read-heavy');
    for (let i = 0; i < 10; i++) {
      expect((await run(mw, fakeReq('boom-t'))).nexted).toBe(true);
    }
    expect((await run(mw, fakeReq('boom-t'))).status).toBe(429);
    // The fallback is cached for the TTL — one control-plane attempt (and so
    // one warn), not one per request.
    expect(billing.calls.filter((t) => t === 'boom-t')).toHaveLength(1);
  });

  test('a mid-window downgrade clamps the EXISTING bucket — no key change', async () => {
    const { rl, clearRateMultiplierCache } = await loadRl();
    billing.mults.set('down-t', 1);
    const mw = rl('read-heavy');
    for (let i = 0; i < 3; i++) await run(mw, fakeReq('down-t'));   // 7 of 10 left
    billing.mults.set('down-t', 0.2);          // plan change lands…
    clearRateMultiplierCache();                // …and the TTL expires
    // Same bucket, budget re-derived at read time: fill clamps to the new
    // capacity of 2, so exactly 2 more pass.
    expect((await run(mw, fakeReq('down-t'))).nexted).toBe(true);
    expect((await run(mw, fakeReq('down-t'))).nexted).toBe(true);
    expect((await run(mw, fakeReq('down-t'))).status).toBe(429);
  });

  test('report-only mode logs the scaled decision but never blocks', async () => {
    const { rl } = await loadRl({ RATE_LIMIT_ENFORCE: undefined });
    billing.mults.set('free-ro', 0.2);
    const mw = rl('read-heavy');
    for (let i = 0; i < 5; i++) {
      const r = await run(mw, fakeReq('free-ro'));
      expect(r.nexted).toBe(true);            // over budget from the 3rd on, still passes
      expect(r.headers['RateLimit-Limit']).toBe('2');   // scaled budget is observable
    }
  });

  test('ingest concurrency for a free tenant floors at 1 slot', async () => {
    const { ingestGate } = await loadRl({ RL_INGEST_CONC_TENANT: '2' });
    billing.mults.set('free-i', 0.2);          // floor(2 × 0.2) → max(1, 0) = 1
    const a = await ingestGate('free-i', 1);
    expect(a.ok).toBe(true);
    const b = await ingestGate('free-i', 1);   // second in-flight batch is shed
    expect(b.ok).toBe(false);
    a.release();
    const c = await ingestGate('free-i', 1);   // slot freed → admitted again
    expect(c.ok).toBe(true);
    c.release();
  });

  test('ingest concurrency for an entitled tenant is unchanged', async () => {
    const { ingestGate } = await loadRl({ RL_INGEST_CONC_TENANT: '2' });
    billing.mults.set('paid-i', 1);
    const a = await ingestGate('paid-i', 1);
    const b = await ingestGate('paid-i', 1);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const c = await ingestGate('paid-i', 1);
    expect(c.ok).toBe(false);
    a.release(); b.release();
  });
});
