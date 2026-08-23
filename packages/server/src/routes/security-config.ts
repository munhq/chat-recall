/**
 * Tenant security configuration endpoint.
 *
 * Mounted AFTER tenantAuth so req.tenant is already resolved. The sync client
 * fetches this at the start of every sync to know whether live secret
 * verification is enabled and which tenant rules to apply locally.
 */

import express from 'express';
import { createControlPlane } from '../imports.js';
import { isEntitled } from '../util/billing.js';

const router = express.Router();
const VERIFY_SECRETS_KEY = 'verify_secrets';
/**
 * Org-wide telemetry opt-out.
 *
 * A machine's own `privacy.telemetry` already lets its owner refuse, but that is
 * a file on that machine — so an admin who wants "collect nothing from our
 * devices" had to visit every one of them. This is the org's answer, editable
 * from the dashboard, and it is a VETO: the device setting and this one are both
 * honoured, so either side can say no and neither can force a yes.
 */
const TELEMETRY_KEY = 'collect_telemetry';

router.get('/', async (req, res) => {
  const tenant = (req as any).tenant;
  if (!tenant) return res.status(401).json({ error: 'tenant required' });
  const cp = await createControlPlane();
  try {
    const raw = await cp.getTenantSetting(tenant, VERIFY_SECRETS_KEY);
    // Default ON — this is the product default.
    const verifySecrets = raw === null ? true : raw === '1' || raw === 'true';
    // TELEMETRY ELIGIBILITY BELONGS ON A REQUEST THAT ALWAYS HAPPENS.
    //
    // It was first answered on the /api/sync RESPONSE, which is only sent when
    // there is something to upload. A fully-synced machine pushes nothing, so it
    // never got a response, so it never learned its own eligibility — and
    // `doctor` correctly reported "no server has answered yet" forever. The
    // effect was that the machines with the least to say were the ones that could
    // never report anything at all.
    //
    // This endpoint is fetched at the start of EVERY sync and is authenticated,
    // so it can answer per-tenant and cannot be skipped.
    // Eligible only when the plan allows it AND the org has not opted out.
    let telemetry = false;
    try {
      const optOut = await cp.getTenantSetting(tenant, TELEMETRY_KEY);
      const orgAllows = optOut === null ? true : !(optOut === '0' || optOut === 'false');
      telemetry = orgAllows && await isEntitled(tenant);
    } catch { telemetry = false; }
    res.json({ verifySecrets, telemetry });
  } finally { await cp.close(); }
});

router.post('/', express.json(), async (req, res) => {
  const tenant = (req as any).tenant;
  if (!tenant) return res.status(401).json({ error: 'tenant required' });
  const verifySecrets = req.body?.verifySecrets === true;
  const collectTelemetry = req.body?.collectTelemetry;
  const cp = await createControlPlane();
  try {
    await cp.setTenantSetting(tenant, VERIFY_SECRETS_KEY, verifySecrets ? '1' : '0');
    // Only written when explicitly present, so a POST that only means to change
    // verifySecrets cannot silently re-enable telemetry an admin turned off.
    if (typeof collectTelemetry === 'boolean') {
      await cp.setTenantSetting(tenant, TELEMETRY_KEY, collectTelemetry ? '1' : '0');
    }
    res.json({ verifySecrets });
  } finally { await cp.close(); }
});

export default router;
