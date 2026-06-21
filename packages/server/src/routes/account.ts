/**
 * /api/account — cloud account configuration. Mounted AFTER tenantAuth so
 * req.tenant is resolved. Today it owns the secret-alert webhook (Discord/Slack);
 * subscription lives under /api/billing, identity/teams under /api/teams.
 */
import express from 'express';
import { createControlPlane } from '../imports.js';

const router = express.Router();
const ALERT_WEBHOOK_KEY = 'alert_webhook_url';

function tenantOf(req: express.Request, res: express.Response): string | null {
  const tenant = (req as express.Request & { tenant?: string }).tenant;
  if (!tenant) { res.status(401).json({ error: 'tenant required' }); return null; }
  return tenant;
}

// GET /api/account/alerts — current webhook destination for verified-secret alerts.
router.get('/alerts', async (req, res) => {
  const tenant = tenantOf(req, res); if (!tenant) return;
  const cp = await createControlPlane();
  try {
    res.json({ webhookUrl: (await cp.getTenantSetting(tenant, ALERT_WEBHOOK_KEY)) || '' });
  } finally { await cp.close(); }
});

// POST /api/account/alerts — set (or clear, with '') the webhook. https-only.
router.post('/alerts', express.json(), async (req, res) => {
  const tenant = tenantOf(req, res); if (!tenant) return;
  const url = typeof req.body?.webhookUrl === 'string' ? req.body.webhookUrl.trim() : '';
  if (url && !/^https:\/\//i.test(url)) {
    return res.status(400).json({ error: 'webhook URL must be https' });
  }
  const cp = await createControlPlane();
  try {
    await cp.setTenantSetting(tenant, ALERT_WEBHOOK_KEY, url);
    res.json({ webhookUrl: url });
  } finally { await cp.close(); }
});

// POST /api/account/alerts/test — send a probe to confirm the webhook works.
router.post('/alerts/test', express.json(), async (req, res) => {
  const tenant = tenantOf(req, res); if (!tenant) return;
  const cp = await createControlPlane();
  let url: string;
  try {
    const provided = typeof req.body?.webhookUrl === 'string' ? req.body.webhookUrl.trim() : '';
    url = provided || (await cp.getTenantSetting(tenant, ALERT_WEBHOOK_KEY)) || '';
  } finally { await cp.close(); }
  if (!url) return res.status(400).json({ error: 'no webhook configured' });
  if (!/^https:\/\//i.test(url)) return res.status(400).json({ error: 'webhook URL must be https' });

  const msg = '✅ chat-recall test alert — your secret-leak alerts are wired up correctly.';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: msg, text: msg }),
      signal: ctrl.signal,
    });
    res.json({ ok: r.ok, status: r.status });
  } catch (e) {
    res.status(502).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  } finally {
    clearTimeout(timer);
  }
});

export default router;
