/**
 * Verified-live secret alerts — the painkiller. When a tenant's own sessions
 * contain a secret the verifier confirmed is LIVE, we ping that tenant at a
 * webhook URL they configured (Account page → tenant_settings 'alert_webhook_url')
 * so they can rotate it. This is a CUSTOMER feature, not operator ops.
 *
 * Constraints:
 *   - Paid feature: only entitled tenants (active|trialing) get alerts.
 *   - Fire ONCE per (tenant, preview): the sync route DELETE/re-INSERTs findings
 *     on every sync, so we dedup against the `alerted_secrets` ledger.
 *   - Never send the raw secret — only the masked preview (last 4 chars).
 *   - Suppress previews the user already dismissed (rotated/false_positive).
 *   - One payload carries both `content` (Discord) and `text` (Slack) so a single
 *     POST works for either webhook flavor (and generic receivers get both).
 *   - Non-blocking: webhook failures are logged, never thrown into the sync path.
 */
import { openPgPool, tenantQuery } from '@chat-recall/engine/core/store/pg-pool.js';
import { createControlPlane } from '../imports.js';
import { isEntitled } from '../util/billing.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';

const log = createLogger('notify');

export interface VerifiedHit {
  sessionId: string;
  detector: string;
  rule: string;
  preview: string;
  projectPath?: string | null;
  /** Why this is being alerted. 'verified-live' = the client confirmed the key
   *  is live with its issuer. 'server-rescan' = the server's own pass over
   *  ALREADY-STORED redacted text found a secret the client's rules missed,
   *  which means it is sitting in our database in cleartext. Both are
   *  actionable; the wording differs so the operator knows which happened. */
  reason?: 'verified-live' | 'server-rescan';
}

/** Fire alerts for newly-seen secrets. Returns how many were sent. */
export async function notifyVerifiedSecrets(tenant: string, hits: VerifiedHit[]): Promise<number> {
  const candidates = hits.filter((h) => h.preview);
  if (candidates.length === 0) return 0;

  // Paid feature — detection is free (local), alerting is the subscriber gate.
  if (!(await isEntitled(tenant))) return 0;

  // Per-tenant destination; no webhook configured ⇒ nothing to do.
  const cp = await createControlPlane();
  let webhook: string | null = null;
  try {
    webhook = (await cp.getTenantSetting(tenant, 'alert_webhook_url')) || null;
  } finally {
    await cp.close();
  }
  if (!webhook) return 0;

  const pool = await openPgPool(process.env.DATABASE_URL || '');

  // Previews the user already triaged away.
  const dismissed = new Set<string>(
    (await tenantQuery(pool, tenant, `SELECT preview FROM secret_dismissals WHERE tenant=$1`, [tenant]))
      .rows.map((r: { preview: string }) => r.preview),
  );

  let sent = 0;
  const now = Date.now();
  for (const h of candidates) {
    if (dismissed.has(h.preview)) continue;
    // Fire-once: only a genuinely new (tenant,preview) inserts a row.
    const ins = await tenantQuery(
      pool, tenant,
      `INSERT INTO alerted_secrets (tenant, preview, alerted_at) VALUES ($1,$2,$3)
       ON CONFLICT (tenant, preview) DO NOTHING RETURNING preview`,
      [tenant, h.preview, now],
    );
    if (ins.rows.length === 0) continue; // already alerted before
    if (await postWebhook(webhook, h)) sent++;
  }
  return sent;
}

async function postWebhook(url: string, h: VerifiedHit): Promise<boolean> {
  const tail = h.preview.slice(-4);
  const where = h.projectPath ? ` (project ${h.projectPath})` : '';
  const msg = h.reason === 'server-rescan'
    ? `⚠️ chat-recall: a \`${h.rule}\` secret slipped past this device's redactor and is stored ` +
      `in cleartext for session \`${h.sessionId}\`${where} — preview \`****${tail}\`. Rotate it, and ` +
      `update the CLI on that machine.`
    : `⚠️ chat-recall: a LIVE \`${h.detector}/${h.rule}\` secret was detected in session ` +
      `\`${h.sessionId}\`${where} — preview \`****${tail}\`. Rotate it now.`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: msg, text: msg }),
      signal: ctrl.signal,
    });
    if (!res.ok) log.error({ status: res.status }, 'webhook failed for tenant alert');
    return res.ok;
  } catch (e) {
    log.error({ err: e }, 'webhook post failed');
    return false;
  } finally {
    clearTimeout(timer);
  }
}
