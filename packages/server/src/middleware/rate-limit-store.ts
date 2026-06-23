/**
 * Token-bucket store for rate limiting.
 *
 * A bucket holds up to `capacity` tokens and refills at `refillPerSec`. Each
 * request `consume(cost)`s tokens; if the bucket can't cover the cost the
 * request is denied with a `retryAfterMs` telling the caller when enough will
 * have refilled. This shapes bursty traffic (burst = capacity) around a
 * sustained rate (= refillPerSec) instead of a crude fixed window.
 *
 * Two backends:
 *  - `MemoryStore`  — per-process Map. Exact at one replica; at N replicas the
 *    effective limit is N× (each replica has its own buckets). Fine for the
 *    coarse caps and single-replica deploys.
 *  - `PgStore`      — shared via a `rl_buckets` table + atomic `rl_consume`
 *    SQL function (row-locked refill+decrement). Correct across replicas, so
 *    per-tenant fairness holds when the server scales out. This is the one to
 *    use the moment replicaCount > 1.
 *
 * Both fail OPEN: any backend error resolves to "allowed" — a rate limiter
 * must never be the thing that takes the API down.
 */

export interface ConsumeResult {
  allowed: boolean;
  /** Tokens left after this call (>= 0). */
  remaining: number;
  /** When denied, ms until `cost` tokens will have refilled. 0 when allowed. */
  retryAfterMs: number;
}

export interface RateLimitStore {
  consume(key: string, cost: number, capacity: number, refillPerSec: number): Promise<ConsumeResult>;
}

/** Pure token-bucket math, shared by both backends. */
function refill(tokens: number, lastMs: number, nowMs: number, capacity: number, refillPerSec: number): number {
  const elapsedSec = Math.max(0, (nowMs - lastMs) / 1000);
  return Math.min(capacity, tokens + elapsedSec * refillPerSec);
}

// ─────────────────────────────────────────────────────────────────────────
// In-memory backend
// ─────────────────────────────────────────────────────────────────────────

export class MemoryStore implements RateLimitStore {
  private buckets = new Map<string, { tokens: number; ts: number }>();
  private lastSweep = 0;

  async consume(key: string, cost: number, capacity: number, refillPerSec: number): Promise<ConsumeResult> {
    const now = Date.now();
    this.sweep(now, refillPerSec, capacity);
    const b = this.buckets.get(key);
    const tokens = b ? refill(b.tokens, b.ts, now, capacity, refillPerSec) : capacity;
    if (tokens >= cost) {
      this.buckets.set(key, { tokens: tokens - cost, ts: now });
      return { allowed: true, remaining: tokens - cost, retryAfterMs: 0 };
    }
    this.buckets.set(key, { tokens, ts: now });
    return { allowed: false, remaining: tokens, retryAfterMs: Math.ceil(((cost - tokens) / refillPerSec) * 1000) };
  }

  /** Drop buckets that have been idle long enough to be full again — bounds
   *  memory without a timer. Runs at most once a minute. */
  private sweep(now: number, refillPerSec: number, capacity: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    const fullAfterMs = (capacity / Math.max(refillPerSec, 1e-6)) * 1000;
    for (const [k, v] of this.buckets) {
      if (now - v.ts > fullAfterMs) this.buckets.delete(k);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Postgres backend (shared across replicas)
// ─────────────────────────────────────────────────────────────────────────

const RL_SCHEMA = `
CREATE TABLE IF NOT EXISTS rl_buckets (
  k       text PRIMARY KEY,
  tokens  double precision NOT NULL,
  ts      timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION rl_consume(p_key text, p_cap double precision, p_refill double precision, p_cost double precision)
RETURNS TABLE(allowed boolean, remaining double precision) AS $$
DECLARE
  cur_tokens double precision;
  cur_ts     timestamptz;
  refilled   double precision;
BEGIN
  SELECT tokens, ts INTO cur_tokens, cur_ts FROM rl_buckets WHERE k = p_key FOR UPDATE;
  IF NOT FOUND THEN
    refilled := p_cap;                                   -- new key starts full
  ELSE
    refilled := LEAST(p_cap, cur_tokens + EXTRACT(EPOCH FROM (now() - cur_ts)) * p_refill);
  END IF;
  IF refilled >= p_cost THEN
    refilled := refilled - p_cost;
    allowed  := true;
  ELSE
    allowed  := false;                                   -- denied: do NOT consume
  END IF;
  INSERT INTO rl_buckets(k, tokens, ts) VALUES (p_key, refilled, now())
    ON CONFLICT (k) DO UPDATE SET tokens = EXCLUDED.tokens, ts = EXCLUDED.ts;
  remaining := refilled;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql;
`;

export class PgStore implements RateLimitStore {
  private ready: Promise<void> | null = null;
  constructor(private getPool: () => Promise<any>) {}

  private ensure(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        const pool = await this.getPool();
        await pool.query(RL_SCHEMA);
      })();
      // A failed bootstrap must not poison forever — retry next call.
      this.ready.catch(() => { this.ready = null; });
    }
    return this.ready;
  }

  async consume(key: string, cost: number, capacity: number, refillPerSec: number): Promise<ConsumeResult> {
    await this.ensure();
    const pool = await this.getPool();
    const r = await pool.query('SELECT allowed, remaining FROM rl_consume($1,$2,$3,$4)', [key, capacity, refillPerSec, cost]);
    const row = r.rows[0] as { allowed: boolean; remaining: number };
    if (row.allowed) return { allowed: true, remaining: row.remaining, retryAfterMs: 0 };
    return { allowed: false, remaining: row.remaining, retryAfterMs: Math.ceil(((cost - row.remaining) / refillPerSec) * 1000) };
  }
}

/** A store that never blocks — used as the fail-open fallback. */
export class NoopStore implements RateLimitStore {
  async consume(_k: string, _c: number, capacity: number): Promise<ConsumeResult> {
    return { allowed: true, remaining: capacity, retryAfterMs: 0 };
  }
}
