/**
 * Online licence activation, for self-hosted deployments.
 *
 * ── The problem with offline keys ──────────────────────────────────────────
 *
 * A signed key that CARRIES its grant cannot be revoked and cannot be counted.
 * It also cannot be billed monthly: `exp` is checked against wall-clock, which the
 * operator controls, and re-minting twelve keys a year is friction for both sides.
 *
 * ── The shape ─────────────────────────────────────────────────────────────
 *
 * The customer holds a SERIAL, not a grant. On boot and periodically after, the
 * instance exchanges it for a SHORT-LIVED entitlement:
 *
 *   POST {server}/api/licence/activate  { serial, instanceId }
 *     -> { token: "CR1.<payload>.<sig>" }   payload.exp ≈ 14 days out
 *
 * The token is an ordinary licence key with a near expiry, so it verifies through
 * the SAME verifyLicense() and the same issuer public key. No second format, no
 * second verifier — the one thing this codebase keeps being bitten by is a second
 * copy of a decision.
 *
 * Revocation is "stop issuing tokens". Seat and device counts arrive as a side
 * effect of activation. Monthly billing works because the server can consult the
 * subscription before issuing.
 *
 * ── Why the token's own expiry IS the grace window ────────────────────────
 *
 * There is no separate grace timer, deliberately. The server chooses how long each
 * token lives, and that single number is simultaneously:
 *
 *   - how long a customer keeps working if OUR licence server is unreachable, and
 *   - how long a revoked licence keeps working.
 *
 * One dial, no second mechanism to disagree with the first. Shorten it for tighter
 * enforcement, lengthen it for more resilience.
 *
 * ── The failure mode that must never happen ───────────────────────────────
 *
 * A paying customer's instance must NEVER stop working because we are unreachable.
 * Every function here is non-throwing, and an unreachable server means "keep using
 * the cached token"; only once that token has genuinely expired does the deployment
 * fall back to the FREE tier — never to broken, never to an error at boot.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { verifyLicense, type LicensePayload } from './license.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';

const log = createLogger('licence');

/** Where the exchanged token is cached, so a restart does not lose the window. */
function cachePath(): string {
  const dir = process.env.CHAT_RECALL_DATA_DIR || '/data';
  return join(dir, 'licence-entitlement.json');
}

/** The licence service. Points at the hosted deployment by default. */
function serviceUrl(): string {
  return (process.env.CHAT_RECALL_LICENCE_SERVER || 'https://chatrecall.dev').replace(/\/+$/, '');
}

/** The customer's serial, if they have one. */
export function serial(): string | null {
  const s = (process.env.CHAT_RECALL_LICENSE_SERIAL || '').trim();
  return s || null;
}

/**
 * A stable, non-identifying id for this deployment, so the service can count
 * instances per licence without being told anything about the customer's network.
 * Hashed rather than raw: a hostname can be sensitive, and the service only needs
 * to know that two reports came from the same place.
 */
export function instanceId(): string {
  const seed = process.env.CHAT_RECALL_INSTANCE_ID || `${hostname()}:${process.env.DATABASE_URL || ''}`;
  return createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

interface Cached { token: string; fetchedAt: number }

function readCache(): Cached | null {
  try {
    const raw = readFileSync(cachePath(), 'utf8');
    const c = JSON.parse(raw) as Cached;
    return typeof c?.token === 'string' ? c : null;
  } catch {
    return null;   // absent or unreadable is simply "not activated yet"
  }
}

function writeCache(token: string): void {
  try {
    const p = cachePath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ token, fetchedAt: Date.now() }, null, 2));
  } catch (e) {
    // A read-only or full disk must not break activation for THIS process — it
    // only means the window is not carried across a restart.
    log.warn({ err: (e as Error).message }, 'could not cache the licence entitlement');
  }
}

/** Test seam: forget the in-process view of the cache. */
export function _resetActivationForTests(): void {
  memo = undefined;
}

let memo: { payload: LicensePayload | null; at: number } | undefined;

/**
 * The entitlement currently in force from online activation, or null.
 *
 * Reads only the cache — never the network — so it is safe to call on any request
 * path. Refreshing is the sweep's job (refreshEntitlement below).
 */
export function activatedEntitlement(): LicensePayload | null {
  // 60s memo: this is consulted by the feature resolver, and re-reading and
  // re-verifying a file per request is wasteful for a value that changes daily.
  if (memo && Date.now() - memo.at < 60_000) return memo.payload;

  const cached = readCache();
  let payload: LicensePayload | null = null;
  if (cached) {
    const st = verifyLicense(cached.token, process.env.CHAT_RECALL_LICENSE_PUBKEY || '');
    if (st.valid) {
      payload = st.payload;
    } else if (st.reason === 'expired') {
      // The window closed and we could not reach the service inside it. Degrade to
      // the free tier — the deployment keeps working, minus the paid features.
      log.warn('licence entitlement expired and could not be renewed — running as the free tier');
    } else {
      log.warn({ reason: st.reason }, 'cached licence entitlement rejected');
    }
  }
  memo = { payload, at: Date.now() };
  return payload;
}

/**
 * Exchange the serial for a fresh entitlement. Never throws.
 *
 * Returns what happened, so the sweep can log it and a test can assert on it
 * without inspecting the filesystem.
 */
export async function refreshEntitlement(
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; reason?: string }> {
  const s = serial();
  if (!s) return { ok: false, reason: 'no-serial' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await fetch(`${serviceUrl()}/api/licence/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serial: s, instanceId: instanceId() }),
      signal: controller.signal,
    });
    if (!res.ok) {
      // A 4xx here is meaningful — revoked, unknown serial, lapsed subscription —
      // but it must NOT clear a still-valid cached token. The window is what
      // protects a customer against our mistakes as well as our downtime.
      return { ok: false, reason: `http-${res.status}` };
    }
    const body = (await res.json()) as { token?: string };
    if (!body?.token) return { ok: false, reason: 'no-token' };

    // Verify BEFORE caching. An unverifiable token is not merely useless, it would
    // sit in the cache masking the last good one.
    const st = verifyLicense(body.token, process.env.CHAT_RECALL_LICENSE_PUBKEY || '');
    if (!st.valid) return { ok: false, reason: `rejected-${st.reason}` };

    writeCache(body.token);
    memo = undefined;
    return { ok: true };
  } catch (e) {
    // Unreachable, DNS failure, timeout, abort. The cached token keeps working.
    return { ok: false, reason: (e as Error).name === 'AbortError' ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether a refresh is worth attempting: no entitlement at all, or the one we have
 * is past the halfway point of its life. Refreshing early is what turns a brief
 * outage into a non-event — waiting until expiry would mean a single failed call
 * costs the customer their features.
 */
export function refreshDue(now = Date.now()): boolean {
  if (!serial()) return false;
  const cached = readCache();
  if (!cached) return true;
  const st = verifyLicense(cached.token, process.env.CHAT_RECALL_LICENSE_PUBKEY || '');
  if (!st.valid) return true;
  const exp = st.payload.exp;
  if (typeof exp !== 'number') return false;      // perpetual: nothing to renew
  const halfway = cached.fetchedAt + (exp * 1000 - cached.fetchedAt) / 2;
  return now >= halfway;
}
