/**
 * Rate-limit policy: traffic classes, their budgets, and global mode flags.
 *
 * Classes map endpoint COST and IDENTITY to a token-bucket budget. The unit
 * for authenticated traffic is the TENANT (fair-use across a tenant's devices
 * and users); only the unauthenticated surface falls back to per-IP.
 *
 * Budgets are deliberately generous — the goal is to stop pathological floods
 * and noisy-neighbor starvation, not to nickel-and-dime normal use. Tune via
 * env without a redeploy. Everything is enforced only when RATE_LIMIT_ENFORCE
 * is set; otherwise the limiter runs in REPORT-ONLY mode (logs would-be-429s,
 * lets the request through) so real tenant traffic shapes can be observed
 * before any user is ever blocked.
 */

export type RlClass =
  | 'public'       // unauthenticated bootstrap surface (capabilities, login probes)
  | 'sensitive'    // credential mint, team join/invite, admin, billing
  | 'read-light'   // status, lists, metadata, recent
  | 'read-heavy'   // search, analytics, per-session compute (diff/commits/outcome/dossier)
  | 'write-light'  // kv, diary, kg add/invalidate, settings
  | 'ingest';      // /api/sync — bounded by CONCURRENCY, not req/s

export interface ClassConfig {
  /** Bucket depth = max burst. */
  capacity: number;
  /** Sustained tokens/sec. */
  refillPerSec: number;
  /** What the bucket is keyed on. */
  identity: 'ip' | 'tenant';
  /** Optional concurrency cap (in-flight requests) for this class — the real
   *  protection for expensive work. Acquired alongside the token bucket. */
  concurrency?: number;
  /** Per-tenant concurrency cap (only meaningful with `concurrency`). */
  concurrencyPerTenant?: number;
}

const num = (env: string, dflt: number): number => {
  const v = Number(process.env[env]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

/**
 * Defaults. refillPerSec is the sustained ceiling; capacity the burst on top.
 * read-light is effectively unmetered for humans; read-heavy and write-light
 * are generous-but-bounded; ingest leans on concurrency (set in CLASSES) plus
 * a high token ceiling so legit backfills run free but a runaway can't loop.
 */
export const CLASSES: Record<RlClass, ClassConfig> = {
  public:      { capacity: num('RL_PUBLIC_BURST', 60),     refillPerSec: num('RL_PUBLIC_RPS', 2),    identity: 'ip' },
  sensitive:   { capacity: num('RL_SENSITIVE_BURST', 15),  refillPerSec: num('RL_SENSITIVE_RPS', 0.2), identity: 'ip' },
  'read-light':{ capacity: num('RL_READLIGHT_BURST', 300), refillPerSec: num('RL_READLIGHT_RPS', 50), identity: 'tenant' },
  'read-heavy':{ capacity: num('RL_READHEAVY_BURST', 60),  refillPerSec: num('RL_READHEAVY_RPS', 5),  identity: 'tenant', concurrency: num('RL_READHEAVY_CONC', 8) },
  'write-light':{capacity: num('RL_WRITELIGHT_BURST', 120),refillPerSec: num('RL_WRITELIGHT_RPS', 20), identity: 'tenant' },
  // INGEST CONCURRENCY, and why these numbers moved.
  //
  // They were 4 global / 2 per tenant. The collector ships with an in-flight
  // budget of 4, so every walk generated 429s BY CONSTRUCTION: the client asked
  // for exactly twice what a tenant was allowed. Measured on one machine's log:
  // 3,526 × HTTP 429 plus 1,772 `fetch failed`, still arriving at 26–38/hour.
  // Nothing was overloaded — two numbers disagreed.
  //
  // The global cap was worse than the per-tenant one. These semaphores are
  // PER PROCESS (see globalSem in rate-limit.ts), so with 2 replicas the whole
  // service could serve 8 concurrent ingests across ALL customers. Three
  // tenants backfilling at once starved each other. That is a ceiling on paying
  // customers, not a safety valve.
  //
  // The real ceiling is CPU, not this counter: each API pod is limited to 1
  // core, and ingest does chunking + FTS insert per row. Raising the cap lets a
  // tenant keep the pipe full and lets the queue form in one place instead of
  // bouncing off a 429; it does NOT create throughput that the pod does not
  // have. Give the pod more CPU to go faster.
  //
  // The client no longer hardcodes its side: /api/capabilities advertises
  // `limits.ingestConcurrencyPerTenant` and the collector clamps to it, so
  // these stay tunable from the server without shipping a CLI release.
  ingest:      { capacity: num('RL_INGEST_BURST', 100000), refillPerSec: num('RL_INGEST_RPS', 5000),  identity: 'tenant',
                 concurrency: num('RL_INGEST_CONC', 32), concurrencyPerTenant: num('RL_INGEST_CONC_TENANT', 6) },
};

/**
 * What a client may safely run in parallel against /api/sync.
 *
 * Advertised on /api/capabilities so the collector's in-flight budget tracks
 * the server instead of a constant compiled into whatever CLI version the user
 * happens to have. A free tenant's slots are scaled down at request time
 * (scaleConcurrency, floor 1), so this is the ceiling, not a promise.
 */
export function advertisedLimits(): { ingestConcurrencyPerTenant: number; enforced: boolean } {
  return {
    ingestConcurrencyPerTenant: CLASSES.ingest.concurrencyPerTenant ?? 1,
    enforced: ENFORCE,
  };
}

/** Enforce (return 429) vs report-only (log + allow). Default: report-only. */
export const ENFORCE = process.env.RATE_LIMIT_ENFORCE === '1' || process.env.RATE_LIMIT_ENFORCE === 'true';

/** Store backend: 'pg' (shared, scale-safe) | 'memory' | 'off'. Default pg. */
export const STORE_KIND = (process.env.RATE_LIMIT_STORE || 'pg').toLowerCase();
