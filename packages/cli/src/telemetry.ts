/**
 * Report how the COLLECTOR is doing, to the user's own server.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * Every performance fact known about this product came from one developer
 * machine. "How long does a first sync take for a customer with 5,000 sessions?"
 * had no answer, because nothing measured a customer. The collector already
 * computes everything needed — walk duration, sessions considered, bytes shipped,
 * 429 counts, breaker trips, RSS peak — and then throws it away.
 *
 * ── What it is not ───────────────────────────────────────────────────────
 * Not analytics, not usage tracking, not anything about what the user is doing.
 * `assertNoSensitiveKeys` refuses a payload carrying a path, project, session id,
 * prompt or content key, so the promise is enforced by the type of failure a
 * developer cannot ignore rather than by review.
 *
 * ── Gates ────────────────────────────────────────────────────────────────
 * Both must open (see telemetry-consent.ts): the user has not opted out, AND the
 * server says this tenant's plan includes it. The server checks the plan again at
 * ingest, so this gate exists to stop the data LEAVING a machine that should not
 * send it — the client is never the boundary.
 *
 * ── Failure policy ───────────────────────────────────────────────────────
 * Fire-and-forget, and silent. Telemetry that logs its own failures produces
 * noise about the thing that was supposed to reduce noise, and a collector must
 * never fail a sync because it could not report on the sync.
 */
import { hostname, platform } from 'os';
import { mayReport, assertNoSensitiveKeys } from './telemetry-consent.js';
import { fetchWithTimeout } from './http.js';
import { loadAllCredentials } from './sync-client.js';

declare const __CLI_VERSION__: string;
const cliVersion = (): string => {
  try { return typeof __CLI_VERSION__ === 'string' ? __CLI_VERSION__ : 'dev'; } catch { return 'dev'; }
};

/** One reportable fact about a collector run. `kind` is the event class. */
export interface TelemetryEvent {
  kind: string;
  /** Numbers only, plus the few enumerated strings below. No free text. */
  [k: string]: string | number | boolean | undefined;
}

const MAX_QUEUE = 50;
const queue: TelemetryEvent[] = [];

/**
 * Record an event. Cheap and synchronous — it never blocks the caller and never
 * throws, because a measurement must not be able to break the thing it measures.
 */
export function record(event: TelemetryEvent): void {
  try {
    assertNoSensitiveKeys(event);
  } catch (err) {
    // A forbidden key is a developer error, not a runtime condition. Loud in
    // development, dropped in production — never sent either way.
    if (process.env.NODE_ENV !== 'production') throw err;
    return;
  }
  if (queue.length >= MAX_QUEUE) queue.shift();   // newest matter most
  queue.push(event);
}

/** Pending events, for tests and `doctor`. */
export function pending(): readonly TelemetryEvent[] { return queue; }
export function _clearForTests(): void { queue.length = 0; }

/**
 * Ship whatever is queued to every eligible target, then clear.
 *
 * Called after a sync completes — the connection is warm, the numbers are final,
 * and there is no separate schedule to get wrong.
 */
export async function flush(): Promise<void> {
  if (queue.length === 0) return;
  let targets: Array<{ serverUrl: string; token: string }> = [];
  try { targets = loadAllCredentials(); } catch { return; }

  const eligible = targets.filter((t) => mayReport(t.serverUrl));
  if (eligible.length === 0) {
    // Nothing may receive these. Drop them rather than growing a queue that will
    // never drain — a user who opted out must not accumulate a backlog either.
    queue.length = 0;
    return;
  }

  const events = queue.map((e) => ({
    ...e,
    ts: Date.now(),
    cliVersion: cliVersion(),
    os: platform(),
    // A STABLE, NON-IDENTIFYING machine marker. The server overwrites device_id
    // from the authenticated token anyway (it is the only side that can resolve
    // it), so this is a fallback for older servers and is deliberately a hash,
    // never the hostname itself.
    deviceId: hashHost(),
  }));
  queue.length = 0;

  await Promise.allSettled(eligible.map(async (t) => {
    try {
      await fetchWithTimeout(`${t.serverUrl.replace(/\/+$/, '')}/api/client-events`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(t.token ? { authorization: `Bearer ${t.token}` } : {}),
        },
        body: JSON.stringify({ events }),
      }, 10_000);
    } catch { /* fire and forget — see the header */ }
  }));
}

/** sha256 of the hostname, first 12 — stable per machine, not reversible. */
function hashHost(): string {
  try {
    // Lazy so the crypto import is not paid by callers that never report.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    return createHash('sha256').update(hostname()).digest('hex').slice(0, 12);
  } catch { return ''; }
}
