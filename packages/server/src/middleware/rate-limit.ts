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

/**
 * Per-IP ceiling for /api/sync. The general apiLimiter deliberately SKIPS
 * /api/sync, which left that surface with no per-IP bound at all: an anonymous
 * flood of `Bearer ct_<random>` forced an uncached control-plane token lookup
 * AND a 32mb JSON parse on every request, before any tenant existed to key the
 * in-route ingestGate on. (ingestGate is per-tenant and runs only for VALID
 * tokens, so it can't shed an unauthenticated flood.) Mounted BEFORE the body
 * parser and token resolution so a flood is dropped at the edge, cheaply.
 * Generous by default — real collectors sync chunked multi-session batches and
 * honor 429 + Retry-After — but bounds the pre-auth work one IP can trigger.
 */
export const syncLimiter = rateLimit({
  windowMs: minutes(5),
  max: Number(process.env.RATE_LIMIT_SYNC_MAX) || 600, // ~2 req/s sustained per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate limit exceeded — slow down' },
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
import { createLogger } from '@chat-recall/engine/core/logger.js';
import { tenantLimits } from '../util/billing.js';
import { TenantTtlCache } from '../util/tenant-cache.js';

const log = createLogger('rate-limit');

/**
 * Plan multiplier on tenant-keyed budgets (PlanLimits.rateMultiplier: 1 for
 * entitled/self-host, 0.2 for the free tier). Cached 30s like billing's own
 * entitlement caches, so the limiter adds no control-plane query per request
 * beyond what those caches already pay.
 *
 * The multiplier scales the BUDGET passed to the store, never the bucket key:
 * both stores clamp fill to the capacity of the CURRENT call, so a plan change
 * applies to the existing bucket within one TTL instead of orphaning its fill
 * state under a new key.
 */
const multiplierCache = new TenantTtlCache<number>(30_000);

/** For tests. */
export function clearRateMultiplierCache(): void {
  multiplierCache.clear();
}

/** In-flight resolutions, so a burst on a cold cache spawns ONE lookup. */
const multiplierPending = new Map<string, Promise<void>>();

export async function tenantMultiplier(tenant: string): Promise<number> {
  const cached = multiplierCache.get(tenant);
  if (cached !== undefined) return cached;
  // STALE-WHILE-REVALIDATE, never block: the limiter sits in front of every
  // request, and tenantLimits ultimately reaches the control plane (and can
  // even provision a trial row via ensureTrial). A rate limiter that blocks
  // each tenant's first request per TTL on a Postgres round trip — or worse,
  // inherits a slow control plane — protects nothing. Resolve in the
  // background; until it lands, the full budget applies (fail open).
  if (!multiplierPending.has(tenant)) {
    const p = (async () => {
      let mult = 1;
      try {
        const m = (await tenantLimits(tenant)).rateMultiplier;
        if (Number.isFinite(m) && m > 0) mult = m;
      } catch (err) {
        // Fail OPEN to the full budget — an entitlement hiccup must never become
        // a 429 storm. Caching the fallback bounds the warn to once per TTL.
        log.warn({ tenant, err: err instanceof Error ? err.message : String(err) },
          'rate multiplier resolve failed — using full budget');
      }
      multiplierCache.set(tenant, mult);
    })().finally(() => multiplierPending.delete(tenant));
    multiplierPending.set(tenant, p);
  }
  return 1;
}

/** Test seam: wait for a pending multiplier resolution to land. */
export async function awaitRateMultiplier(tenant: string): Promise<void> {
  await multiplierPending.get(tenant);
}

/** A free tenant always keeps at least 1 concurrency slot. */
const scaleConcurrency = (cap: number, mult: number): number => Math.max(1, Math.floor(cap * mult));

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
  /** A plan change must apply to a live semaphore, not wait for it to idle out. */
  setMax(max: number): void { this.max = max; }
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
    log.warn({ className, kind, id, retryAfterMs }, 'report-only would-shed');
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
function acquireConcurrency(className: RlClass, id: string, cfg: ClassConfig, multiplier = 1): { ok: boolean; release: () => void } {
  if (!cfg.concurrency) return { ok: true, release: () => {} };
  // The global cap is class-wide load protection, not a tenant budget — only
  // the per-tenant cap scales with the plan multiplier.
  let g = globalSem.get(className);
  if (!g) { g = new Semaphore(cfg.concurrency); globalSem.set(className, g); }
  const tKey = `${className}:${id}`;
  let t = tenantSem.get(tKey);
  if (cfg.concurrencyPerTenant) {
    const capT = scaleConcurrency(cfg.concurrencyPerTenant, multiplier);
    if (!t) { t = new Semaphore(capT); tenantSem.set(tKey, t); }
    else t.setMax(capT);
  }

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

      // Plan multiplier applies only to tenant-keyed budgets — the per-IP
      // classes are anti-abuse ceilings, not entitlements.
      const tenant = cfg.identity === 'tenant' ? (req as any).tenant as string | undefined : undefined;
      const mult = tenant ? await tenantMultiplier(tenant) : 1;
      const capacity = cfg.capacity * mult;
      const refillPerSec = cfg.refillPerSec * mult;

      // Concurrency gate (heavy classes). Release on response completion.
      const conc = acquireConcurrency(className, id, cfg, mult);
      if (conc.ok) { res.on('finish', conc.release); res.on('close', conc.release); }
      if (!conc.ok && shed(res, className, id, 'concurrency', 1000)) return;

      const r = await store().consume(`${className}:${id}`, cost, capacity, refillPerSec);
      setHeaders(res, capacity, r.remaining, refillPerSec);
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
/**
 * Ingest concurrency THIS TENANT may actually use, right now.
 *
 * `CLASSES.ingest.concurrencyPerTenant` is the class ceiling; the gate scales it
 * by the tenant's plan multiplier and floors at 1. Advertising the unscaled
 * ceiling was worse than advertising nothing: a free tenant was told 6, asked for
 * 6, and had 5 of them shed — which is precisely the 429 storm the advertisement
 * was added to stop, aimed at the users who most need a fast first sync.
 */
export async function tenantIngestConcurrency(tenant: string): Promise<number> {
  const cap = CLASSES.ingest.concurrencyPerTenant ?? 1;
  try {
    const mult = await tenantMultiplier(tenant || 'default');
    return Math.max(1, Math.floor(cap * mult));
  } catch {
    return 1;   // unknown plan → the pessimistic answer, never the generous one
  }
}

export async function ingestGate(tenant: string, rowCount: number): Promise<{ ok: boolean; release: () => void; retryAfterMs: number }> {
  const cfg = CLASSES.ingest;
  const id = `t:${tenant || 'default'}`;
  try {
    // Free tier: 0.2× tokens, and concurrencyPerTenant floors at 1 slot.
    const mult = await tenantMultiplier(tenant || 'default');
    const conc = acquireConcurrency('ingest', id, cfg, mult);
    if (!conc.ok) {
      log.warn({ decision: ENFORCE ? 'BLOCK' : 'report-only would-shed', id, rowCount }, 'ingest/concurrency');
      return { ok: ENFORCE ? false : true, release: conc.release, retryAfterMs: 2000 };
    }
    // Cost is clamped to the SCALED capacity: a bucket can never satisfy a
    // cost above its capacity, so an unclamped giant batch under a small
    // multiplier would 429 forever with a retryAfter that never comes true —
    // and the CLI would loop on rate-limit errors instead of ever reaching
    // the meters' actionable 402. Charging at most one full bucket keeps the
    // limiter a limiter.
    const cap = cfg.capacity * mult;
    const r = await store().consume(`ingest:${id}`, Math.min(Math.max(1, rowCount), Math.max(1, Math.floor(cap))), cap, cfg.refillPerSec * mult);
    if (!r.allowed) {
      log.warn({ decision: ENFORCE ? 'BLOCK' : 'report-only would-shed', id, rowCount, retryAfterMs: r.retryAfterMs }, 'ingest/rate');
      if (ENFORCE) { conc.release(); return { ok: false, release: () => {}, retryAfterMs: r.retryAfterMs }; }
    }
    return { ok: true, release: conc.release, retryAfterMs: 0 };
  } catch {
    return { ok: true, release: () => {}, retryAfterMs: 0 };   // fail open
  }
}

export { ENFORCE as RATE_LIMIT_ENFORCE };
