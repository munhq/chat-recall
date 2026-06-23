/**
 * Rate limiting for the public API surface.
 *
 * The server is internet-facing in SaaS and self-host-behind-ingress
 * deployments, so unauthenticated abuse — device-token brute-force, tenant
 * enumeration, search floods — needs a backstop. Two tiers:
 *
 *  - `apiLimiter`: a generous per-IP ceiling on `/api/*` to blunt floods.
 *    Skips `/api/sync` (large, device-token-authenticated batches) and
 *    `/api/capabilities` (the unauthenticated bootstrap probe the UI polls).
 *  - `sensitiveLimiter`: a tight per-IP ceiling for credential-minting and
 *    tenant-admin endpoints, where a brute-force actually matters.
 *
 * Behind an ingress/Traefik the real client IP lives in `X-Forwarded-For`, so
 * the server enables `trust proxy` (see server.ts) — without it every request
 * would share the proxy's single IP and trip the limit as one client.
 *
 * Both ceilings are env-overridable for operators with unusual fan-in.
 */
import rateLimit from 'express-rate-limit';

const minutes = (n: number) => n * 60 * 1000;

export const apiLimiter = rateLimit({
  windowMs: minutes(5),
  max: Number(process.env.RATE_LIMIT_API_MAX) || 600, // ~2 req/s sustained per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate limit exceeded — slow down' },
  // req.url is mount-relative inside an app.use('/api', …) middleware, so match
  // on originalUrl to reliably see the full path.
  skip: (req) =>
    req.originalUrl.startsWith('/api/sync') ||
    req.originalUrl.startsWith('/api/capabilities'),
});

export const sensitiveLimiter = rateLimit({
  windowMs: minutes(15),
  max: Number(process.env.RATE_LIMIT_AUTH_MAX) || 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many attempts — try again later' },
});

// ─────────────────────────────────────────────────────────────────────────
// Tenant-aware, class-based limiting (token buckets + concurrency).
// The per-IP limiters above are the coarse anti-abuse net; the layer below
// adds per-tenant fairness, cost-weighting, and concurrency-based load
// shedding — emitting 429 + Retry-After so well-behaved clients self-pace.
// ─────────────────────────────────────────────────────────────────────────
import type { Request, Response, NextFunction } from 'express';
import { CLASSES, ENFORCE, STORE_KIND, type RlClass, type ClassConfig } from './rate-limit-config.js';
import { MemoryStore, PgStore, NoopStore, type RateLimitStore } from './rate-limit-store.js';
import { openPgPool } from '@chat-recall/engine/core/store/pg-pool.js';

let _store: RateLimitStore | null = null;
function store(): RateLimitStore {
  if (_store) return _store;
  _store = STORE_KIND === 'off' ? new NoopStore()
    : STORE_KIND === 'memory' ? new MemoryStore()
    : new PgStore(() => openPgPool());
  return _store;
}

/** Non-blocking counting semaphore: acquire fails (rather than queues) when
 *  full, so an over-capacity request is shed with 429 instead of made to wait. */
class Semaphore {
  private active = 0;
  constructor(private max: number) {}
  tryAcquire(): boolean { if (this.active < this.max) { this.active++; return true; } return false; }
  release(): void { if (this.active > 0) this.active--; }
  get idle(): boolean { return this.active === 0; }
}
const globalSem = new Map<RlClass, Semaphore>();
const tenantSem = new Map<string, Semaphore>();

function identityOf(req: Request, cfg: { identity: 'ip' | 'tenant' }): string {
  if (cfg.identity === 'tenant' && (req as any).tenant) return `t:${(req as any).tenant}`;
  return `ip:${req.ip || 'anon'}`;
}

function setHeaders(res: Response, capacity: number, remaining: number, refillPerSec: number): void {
  res.setHeader('RateLimit-Limit', String(Math.round(capacity)));
  res.setHeader('RateLimit-Remaining', String(Math.max(0, Math.floor(remaining))));
  // Seconds until the bucket is full again (informational).
  res.setHeader('RateLimit-Reset', String(Math.ceil((capacity - remaining) / Math.max(refillPerSec, 1e-6))));
}

/** Decide + (in enforce mode) emit 429. Returns true when the request should
 *  be blocked (caller must stop). In report-only mode, logs and returns false. */
function shed(res: Response, className: RlClass, id: string, kind: string, retryAfterMs: number): boolean {
  if (!ENFORCE) {
    console.warn(`[ratelimit] report-only would-shed ${className}/${kind} id=${id} retryAfter=${retryAfterMs}ms`);
    return false;
  }
  const retrySec = Math.max(1, Math.ceil(retryAfterMs / 1000));
  res.setHeader('Retry-After', String(retrySec));
  res.status(429).json({ error: 'rate limit exceeded — slow down', class: className, retry_after_ms: retryAfterMs });
  return true;
}

/**
 * Acquire global + per-tenant concurrency slots for a class. Returns a release
 * fn (idempotent) and whether it succeeded. When report-only, never actually
 * blocks: it still tracks slots it could take, but a miss just logs.
 */
function acquireConcurrency(className: RlClass, id: string, cfg: ClassConfig): { ok: boolean; release: () => void } {
  if (!cfg.concurrency) return { ok: true, release: () => {} };
  let g = globalSem.get(className);
  if (!g) { g = new Semaphore(cfg.concurrency); globalSem.set(className, g); }
  const tKey = `${className}:${id}`;
  let t = tenantSem.get(tKey);
  if (!t && cfg.concurrencyPerTenant) { t = new Semaphore(cfg.concurrencyPerTenant); tenantSem.set(tKey, t); }

  const gotG = g.tryAcquire();
  const gotT = t ? t.tryAcquire() : true;
  const ok = gotG && gotT;
  let released = false;
  const release = () => {
    if (released) return; released = true;
    if (gotG) g!.release();
    if (gotT && t) t.release();
    if (t && t.idle) tenantSem.delete(tKey);   // bound the per-tenant map
  };
  if (!ok) release();   // give back any partial acquisition immediately
  return { ok, release };
}

/**
 * Class-based limiter middleware. Composes a token bucket (rate/burst) with an
 * optional concurrency cap (in-flight load shed). `cost(req)` weights a request
 * (default 1) — e.g. a search by result count. Fails OPEN on any error.
 */
export function rl(className: RlClass, opts: { cost?: (req: Request) => number } = {}) {
  const cfg = CLASSES[className];
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    (req as any).rlClass = className;   // tag for cost telemetry
    try {
      const id = identityOf(req, cfg);
      const cost = Math.max(1, Math.floor(opts.cost ? opts.cost(req) : 1));

      // Concurrency gate (heavy classes). Release on response completion.
      const conc = acquireConcurrency(className, id, cfg);
      if (conc.ok) { res.on('finish', conc.release); res.on('close', conc.release); }
      if (!conc.ok && shed(res, className, id, 'concurrency', 1000)) return;

      const r = await store().consume(`${className}:${id}`, cost, cfg.capacity, cfg.refillPerSec);
      setHeaders(res, cfg.capacity, r.remaining, cfg.refillPerSec);
      if (!r.allowed && shed(res, className, id, 'rate', r.retryAfterMs)) { conc.release(); return; }
      next();
    } catch {
      next();   // fail open — the limiter must never break the API
    }
  };
}

/**
 * Ingest gate for /api/sync. Called from inside the route AFTER it resolves the
 * device token → tenant, so it keys on the real tenant. Cost = row count of the
 * batch. Returns whether to proceed and a release fn for the concurrency slot.
 * Always fail-open on error.
 */
export async function ingestGate(tenant: string, rowCount: number): Promise<{ ok: boolean; release: () => void; retryAfterMs: number }> {
  const cfg = CLASSES.ingest;
  const id = `t:${tenant || 'default'}`;
  try {
    const conc = acquireConcurrency('ingest', id, cfg);
    if (!conc.ok) {
      console.warn(`[ratelimit] ${ENFORCE ? 'BLOCK' : 'report-only would-shed'} ingest/concurrency id=${id} rows=${rowCount}`);
      return { ok: ENFORCE ? false : true, release: conc.release, retryAfterMs: 2000 };
    }
    const r = await store().consume(`ingest:${id}`, Math.max(1, rowCount), cfg.capacity, cfg.refillPerSec);
    if (!r.allowed) {
      console.warn(`[ratelimit] ${ENFORCE ? 'BLOCK' : 'report-only would-shed'} ingest/rate id=${id} rows=${rowCount} retryAfter=${r.retryAfterMs}ms`);
      if (ENFORCE) { conc.release(); return { ok: false, release: () => {}, retryAfterMs: r.retryAfterMs }; }
    }
    return { ok: true, release: conc.release, retryAfterMs: 0 };
  } catch {
    return { ok: true, release: () => {}, retryAfterMs: 0 };   // fail open
  }
}

export { ENFORCE as RATE_LIMIT_ENFORCE };
