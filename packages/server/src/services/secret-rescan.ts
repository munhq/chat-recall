/**
 * Server-side secret re-scan — defence in depth for the one gap the client-side
 * model necessarily leaves.
 *
 * Detection has to happen on the client: the server never receives unredacted
 * text, so it cannot find what the client's redactor didn't. The corollary is
 * that a device running an OLD CLI — or one whose rules simply missed a shape —
 * ships us text with a live credential still in it. That text then sits in
 * Postgres in cleartext, and nothing else in the system would ever notice.
 *
 * So the server re-runs TODAY's builtin rules over text it ALREADY holds (the
 * stored, supposedly-redacted envelope). Anything it finds is by definition a
 * client-side miss. That is worth three things:
 *   1. a finding, so it shows in the Security view (detector = SERVER_DETECTOR,
 *      insert-only, never retracted by that same client's next sync);
 *   2. an alert, because the secret is in our database and needs rotating;
 *   3. a signal that the device should upgrade.
 *
 * What this is NOT: a replacement for client-side scanning, and not a way to
 * find secrets in raw transcripts. It sees only post-redaction text, so it can
 * only catch what leaked THROUGH redaction — which is exactly the failure mode
 * that would otherwise be invisible.
 *
 * The scan writes no raw secret anywhere: findings carry the same last-4 mask
 * as every other detector.
 */
import { createStore, createControlPlane, runWithTenant } from '../imports.js';
import { scanTextForFindings } from '@chat-recall/engine/core/secret-redactor.js';
import { SERVER_DETECTOR } from '@chat-recall/engine/core/secret-detectors.js';
import { dropFuzzyFindings } from '@chat-recall/engine/core/secret-precision.js';
import { notifyVerifiedSecrets, type VerifiedHit } from './notify.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';

const log = createLogger('secret-rescan');

type Store = Awaited<ReturnType<typeof createStore>>;

/** Bytes of stored text scanned per session. The regex pass is linear, but a
 *  sweep runs across every session of every tenant, so bound the tail. */
const MAX_TEXT_BYTES = 4 * 1024 * 1024;

export interface RescanSessionResult {
  sessionId: string;
  /** Findings the client never reported — i.e. redaction misses. */
  missed: number;
  written: number;
  /** The masked misses themselves, so the caller can alert without re-querying. */
  hits: Array<{ rule: string; preview: string }>;
}

export interface RescanResult {
  scanned: number;
  sessionsWithMisses: number;
  written: number;
  alerted: number;
  tenants: number;
}

/** Concatenated text of a session as the SERVER stores it (already redacted). */
async function storedText(store: Store, sessionId: string): Promise<string> {
  const stored = await store.getCachedContentStale(sessionId, 'session');
  if (!stored?.content) return '';
  try {
    const env = JSON.parse(stored.content) as { messages?: Array<{ content?: string }> };
    const text = (env.messages || []).map((m) => m.content || '').join('\n');
    return text.length > MAX_TEXT_BYTES ? text.slice(-MAX_TEXT_BYTES) : text;
  } catch {
    return ''; // corrupt envelope — self-heal's problem, not ours
  }
}

/**
 * Re-scan ONE session's stored text. Records only findings the client did not
 * already report for that session (matched on masked preview, so the comparison
 * never needs the raw value). Returns what was missed and written.
 */
export async function rescanSession(store: Store, sessionId: string): Promise<RescanSessionResult> {
  const text = await storedText(store, sessionId);
  if (!text) return { sessionId, missed: 0, written: 0, hits: [] };

  // Today's builtin rules + any installed server rule pack.
  const hits = dropFuzzyFindings(
    scanTextForFindings(text).map((f) => ({ detector: SERVER_DETECTOR, rule: f.rule, line: f.line, preview: f.preview })),
    (f) => ({ detector: f.detector, rule: f.rule }),
  );
  if (hits.length === 0) return { sessionId, missed: 0, written: 0, hits: [] };

  // A finding the client already reported is not a miss — the client saw the
  // secret pre-redaction and told us about it. Compare on the masked preview:
  // same secret ⇒ same mask, whichever detector found it.
  const known = new Set((await store.secretFindingsForSession(sessionId)).map((f) => f.preview));
  const missed = hits.filter((h) => !known.has(h.preview));
  if (missed.length === 0) return { sessionId, missed: 0, written: 0, hits: [] };

  const { written } = await store.addSecretFindings(sessionId, missed);
  return {
    sessionId, missed: missed.length, written,
    hits: missed.map((m) => ({ rule: m.rule, preview: m.preview })),
  };
}

/** Re-scan a tenant's sessions. `sinceMs` bounds to recently-captured sessions
 *  (0 = full backlog); `limit` caps sessions per run. */
export async function rescanTenant(
  store: Store,
  tenant: string,
  opts: { sinceMs?: number; limit?: number } = {},
): Promise<Omit<RescanResult, 'tenants'>> {
  const sinceMs = opts.sinceMs ?? 0;
  let rows = await store.listRawSessionVersions();
  if (sinceMs > 0) rows = rows.filter((r) => (r.mtime || 0) >= sinceMs);
  rows.sort((a, b) => (b.mtime || 0) - (a.mtime || 0)); // freshest first
  if (opts.limit && opts.limit > 0) rows = rows.slice(0, opts.limit);

  let scanned = 0, sessionsWithMisses = 0, written = 0;
  const hits: VerifiedHit[] = [];
  for (const r of rows) {
    scanned++;
    try {
      const res = await rescanSession(store, r.session_id);
      if (res.missed > 0) {
        sessionsWithMisses++;
        written += res.written;
        // One alert per session is enough to prompt action, and notify.ts's
        // ledger dedupes by preview across runs anyway.
        const first = res.hits[0];
        if (first) {
          hits.push({
            sessionId: r.session_id, detector: SERVER_DETECTOR, rule: first.rule,
            preview: first.preview, reason: 'server-rescan',
          });
        }
      }
    } catch (err) {
      log.error({ err, session: r.session_id }, 'session re-scan failed');
    }
  }

  let alerted = 0;
  if (hits.length > 0) {
    // Never let a webhook problem fail the sweep.
    try { alerted = await notifyVerifiedSecrets(tenant, hits); }
    catch (err) { log.error({ err, tenant }, 're-scan alert failed'); }
  }
  return { scanned, sessionsWithMisses, written, alerted };
}

/**
 * Sweep every tenant, same enumeration as the self-heal / vector workers.
 * Excluded tenants via SECRET_RESCAN_EXCLUDE_TENANTS (defaults to the
 * synthetic 'synccheck' tenant, as elsewhere).
 */
export async function rescanAllTenants(opts: { sinceMs?: number; limit?: number } = {}): Promise<RescanResult> {
  const cp = await createControlPlane();
  let tenants: string[] = [];
  try { tenants = await cp.listTenants(); } catch { /* fall through to default */ }
  finally { await cp.close?.(); }
  if (tenants.length === 0) tenants = [process.env.CHAT_RECALL_TENANT || 'default'];
  const excluded = new Set(
    (process.env.SECRET_RESCAN_EXCLUDE_TENANTS ?? 'synccheck').split(',').map((s) => s.trim()).filter(Boolean),
  );
  tenants = tenants.filter((t) => !excluded.has(t));

  const total: RescanResult = { scanned: 0, sessionsWithMisses: 0, written: 0, alerted: 0, tenants: tenants.length };
  for (const tenant of tenants) {
    await runWithTenant(tenant, async () => {
      const store = await createStore();
      try {
        const r = await rescanTenant(store, tenant, opts);
        total.scanned += r.scanned;
        total.sessionsWithMisses += r.sessionsWithMisses;
        total.written += r.written;
        total.alerted += r.alerted;
        if (r.sessionsWithMisses > 0) {
          log.warn({ tenant, ...r }, 'server re-scan found secrets that got past a client redactor');
        }
      } finally {
        await store.close();
      }
    });
  }
  return total;
}
