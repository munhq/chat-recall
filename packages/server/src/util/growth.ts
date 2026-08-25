/**
 * Growth events — install / activate / convert into the shared `metrics` database.
 *
 * THE CONTRACT IS ONE INSERT, NOT AN SDK. The services writing to this table are
 * not all written in the same language, so there is deliberately no shared
 * library to depend on — each one writes a single row with its own Postgres
 * client, and none of them needs another's release cycle to record a number.
 * This file is the reference implementation.
 *
 * THREE EVENTS, AND ONLY THREE. A CHECK constraint on the table enforces it.
 *   install   it exists   — the tenant was created
 *   activate  it worked   — the first successful sync. THE ONLY ONE THAT
 *                           PREDICTS RETENTION; install without activate is a
 *                           number that flatters you.
 *   convert   it earned   — the Stripe webhook said paid
 *
 * FIRE AND FORGET, ALWAYS. Measurement must never be able to fail a user's
 * request, so every call here returns immediately, swallows every error, and is
 * never awaited on a request path. A growth table that is down has to be
 * invisible; the alternative is a metrics outage becoming a product outage.
 *
 * THE CREDENTIAL CAN ONLY INSERT. metrics_writer has INSERT on one table and no
 * SELECT — verified in-cluster. So this module cannot read anything back, which
 * is why de-duplication happens at READ time (see below) rather than here.
 *
 * DUPLICATES ARE EXPECTED AND FINE. `activate` may fire more than once if a
 * process restarts, and there is no unique constraint to stop it. Funnel queries
 * therefore take the FIRST occurrence per tenant:
 *
 *   SELECT product, event, count(DISTINCT tenant)
 *   FROM events GROUP BY 1, 2;
 *
 *   -- or, for a time-ordered funnel:
 *   SELECT tenant, event, min(ts) FROM events GROUP BY 1, 2;
 *
 * Guarding here would need a SELECT this role does not have, and a local cache
 * would be wrong across replicas. Counting distinct tenants is correct, cheap,
 * and immune to a restart.
 */
import { Pool } from 'pg';
import { createLogger } from '@chat-recall/engine/core/logger.js';

const log = createLogger('growth');

export type GrowthEvent = 'install' | 'activate' | 'convert';

export interface GrowthProps {
  /** The tenant this is about. Always set it — it is the funnel's join key. */
  tenant?: string | null;
  /** Normalised channel, from tenants.signup_source. */
  source?: string | null;
  campaign?: string | null;
  /** Pre-signup identity, for stitching a web session to an activation. */
  anonId?: string | null;
  /** Anything else. Keep it small; this is not a log. */
  extra?: Record<string, unknown>;
}

const PRODUCT = process.env.METRICS_PRODUCT ?? '';
const ENABLED = process.env.METRICS_ENABLED === 'true' && !!process.env.METRICS_DSN && !!PRODUCT;

/**
 * Its own pool, small on purpose: this is a different database from the app's,
 * and growth events must never contend for a connection the product needs to
 * serve a request. Two connections is plenty for three events per tenant
 * lifetime.
 */
let pool: Pool | null = null;
function getPool(): Pool | null {
  if (!ENABLED) return null;
  if (pool) return pool;
  try {
    pool = new Pool({
      connectionString: process.env.METRICS_DSN,
      max: 2,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 3_000,
      // A growth insert that cannot connect in 3s is not worth retrying — the
      // event is already lost and holding the pool open helps nobody.
      allowExitOnIdle: true,
    });
    // An error on an idle client must not become an unhandled rejection that
    // takes the process down. This is the whole reason the pool is separate.
    pool.on('error', (err) => log.debug({ err }, 'growth pool idle error (ignored)'));
  } catch (err) {
    log.debug({ err }, 'growth pool could not be created (measurement disabled)');
    pool = null;
  }
  return pool;
}

/**
 * Record one event. Returns immediately; never throws; never rejects.
 *
 * Do NOT await this on a request path. It is `void` by design — an await would
 * put a growth database on the critical path of a user's request, which is
 * exactly the coupling this whole design avoids.
 */
export function growth(event: GrowthEvent, props: GrowthProps = {}): void {
  if (!ENABLED) return;
  const p = getPool();
  if (!p) return;

  // Detached on purpose. queueMicrotask rather than awaiting, so the caller's
  // request finishes regardless of what Postgres does.
  queueMicrotask(() => {
    p.query(
      `INSERT INTO events (product, event, tenant, source, campaign, anon_id, props)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        PRODUCT,
        event,
        props.tenant ?? null,
        props.source ?? null,
        props.campaign ?? null,
        props.anonId ?? null,
        JSON.stringify(props.extra ?? {}),
      ],
    ).catch((err) => {
      // debug, not warn: a growth event that fails is worth nothing and must not
      // page anybody or fill a log. If the table is down it is down.
      log.debug({ err, event, product: PRODUCT }, 'growth event dropped');
    });
  });
}

/** For tests and for `chat-recall doctor` — is measurement actually on? */
export function growthEnabled(): boolean {
  return ENABLED;
}

/** Close the pool on shutdown so a drain does not hang on an idle client. */
export async function closeGrowth(): Promise<void> {
  const p = pool;
  pool = null;
  if (p) { try { await p.end(); } catch { /* shutting down anyway */ } }
}
