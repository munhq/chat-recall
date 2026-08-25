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
  /**
   * Collapse repeats: at most one row per tenant per UTC day, per process.
   *
   * REQUIRED for anything fired from a hot path. `activate` on every successful
   * sync measured at ~1,200 rows per day for ONE tenant in production — for a
   * fact that only ever needs to be "did this tenant ever activate". At a
   * hundred tenants that is tens of millions of identical rows a year, held for
   * the full retention window.
   *
   * Per-process, so N replicas can emit up to N rows a day rather than one.
   * That is deliberate: a shared counter would need either a read this
   * credential does not have or a round trip on a hot path, and N rows a day
   * instead of 1,200 is the entire win. Funnel queries count DISTINCT tenant,
   * so the exact number of duplicates never mattered — only the volume did.
   */
  oncePerDay?: boolean;
}

const PRODUCT = process.env.METRICS_PRODUCT ?? '';

/**
 * Analytics ingest. Optional and independent of the table: a product with no
 * marketing site sets no website id and simply does not send.
 *
 * WHY SEND TO BOTH. The table is the record — ours, durable, cross-product, and
 * it outlives the analytics instance. The dashboard is the view: the analytics
 * tool already has Funnel, Goal, Attribution and Revenue reports, and nobody
 * should run psql to read their own funnel.
 */
const UMAMI_URL = process.env.UMAMI_INGEST_URL ?? '';
const UMAMI_SITE = process.env.UMAMI_WEBSITE_ID ?? '';
const UMAMI_ON = !!UMAMI_URL && !!UMAMI_SITE;

/**
 * Umami DROPS any request whose User-Agent does not look like a browser — its
 * bot filter, and it fails silently with a 200. A server-side event therefore
 * has to present a browser-shaped agent or it is discarded with no error
 * anywhere. Found the hard way: the first server event returned 200 and was
 * never stored.
 */
const UMAMI_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Send one named event to analytics, bound to the visitor who caused it.
 *
 * `id` is the anonymous id the marketing page minted and passed to
 * umami.identify(<string>). Umami stores it as session.distinct_id, so an event
 * carrying the same id is attributed to THAT visitor — the one who arrived from
 * a particular Reddit thread — even though this request comes from the cluster
 * with a different address. Verified in production.
 *
 * With no anon id the event still records, it just cannot be tied to a referrer.
 */
function sendToAnalytics(event: GrowthEvent, props: GrowthProps): void {
  if (!UMAMI_ON) return;
  const body = JSON.stringify({
    type: 'event',
    payload: {
      website: UMAMI_SITE,
      hostname: process.env.PUBLIC_HOSTNAME || 'server',
      url: '/',
      name: event,
      ...(props.anonId ? { id: props.anonId } : {}),
      data: {
        ...(props.tenant ? { tenant: props.tenant } : {}),
        ...(props.source ? { source: props.source } : {}),
        ...(props.extra ?? {}),
      },
    },
  });
  // AbortSignal.timeout, so a slow analytics endpoint cannot hold a socket open
  // behind a request that has already been answered.
  fetch(UMAMI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UMAMI_UA },
    body,
    signal: AbortSignal.timeout(3000),
  }).catch((err) => log.debug({ err, event }, 'analytics event dropped'));
}
const ENABLED = process.env.METRICS_ENABLED === 'true' && !!process.env.METRICS_DSN && !!PRODUCT;

/**
 * Its own pool, small on purpose: this is a different database from the app's,
 * and growth events must never contend for a connection the product needs to
 * serve a request. Two connections is plenty for three events per tenant
 * lifetime.
 */
/**
 * Seen-today set for `oncePerDay`. Bounded so a long-lived process with many
 * tenants cannot grow it without limit — at the cap it is cleared wholesale,
 * which costs at most one extra row per tenant and never leaks.
 */
const seen = new Map<string, number>();
const SEEN_MAX = 20_000;
function alreadySentToday(event: GrowthEvent, tenant: string | null | undefined): boolean {
  if (!tenant) return false;               // no key to throttle on; let it through
  const key = `${event}:${tenant}`;
  const day = Math.floor(Date.now() / 86_400_000);
  if (seen.get(key) === day) return true;
  if (seen.size >= SEEN_MAX) seen.clear();
  seen.set(key, day);
  return false;
}

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
  if (!ENABLED && !UMAMI_ON) return;
  if (props.oncePerDay && alreadySentToday(event, props.tenant)) return;
  if (!ENABLED) { sendToAnalytics(event, props); return; }
  const p = getPool();
  if (!p) { sendToAnalytics(event, props); return; }

  // Analytics first and separately: the two destinations must not be able to
  // fail together. A Postgres outage must not cost the dashboard event, and a
  // dead analytics endpoint must not cost the durable row.
  sendToAnalytics(event, props);

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

/** Test-only: forget the oncePerDay state. */
export function __resetGrowthThrottle(): void { seen.clear(); }

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
