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
  ingest:      { capacity: num('RL_INGEST_BURST', 100000), refillPerSec: num('RL_INGEST_RPS', 5000),  identity: 'tenant',
                 concurrency: num('RL_INGEST_CONC', 4), concurrencyPerTenant: num('RL_INGEST_CONC_TENANT', 2) },
};

/** Enforce (return 429) vs report-only (log + allow). Default: report-only. */
export const ENFORCE = process.env.RATE_LIMIT_ENFORCE === '1' || process.env.RATE_LIMIT_ENFORCE === 'true';

/** Store backend: 'pg' (shared, scale-safe) | 'memory' | 'off'. Default pg. */
export const STORE_KIND = (process.env.RATE_LIMIT_STORE || 'pg').toLowerCase();
