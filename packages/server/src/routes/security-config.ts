/**
 * Tenant security configuration endpoint.
 *
 * Mounted AFTER tenantAuth so req.tenant is already resolved. The sync client
 * fetches this at the start of every sync to know whether live secret
 * verification is enabled and which tenant rules to apply locally.
 */

import express from 'express';
import { createControlPlane } from '../imports.js';

const router = express.Router();
const VERIFY_SECRETS_KEY = 'verify_secrets';

router.get('/', async (req, res) => {
  const tenant = (req as any).tenant;
  if (!tenant) return res.status(401).json({ error: 'tenant required' });
  const cp = await createControlPlane();
  try {
    const raw = await cp.getTenantSetting(tenant, VERIFY_SECRETS_KEY);
    // Default ON — this is the product default.
    const verifySecrets = raw === null ? true : raw === '1' || raw === 'true';
    res.json({ verifySecrets });
  } finally { await cp.close(); }
});

router.post('/', express.json(), async (req, res) => {
  const tenant = (req as any).tenant;
  if (!tenant) return res.status(401).json({ error: 'tenant required' });
  const verifySecrets = req.body?.verifySecrets === true;
  const cp = await createControlPlane();
  try {
    await cp.setTenantSetting(tenant, VERIFY_SECRETS_KEY, verifySecrets ? '1' : '0');
    res.json({ verifySecrets });
  } finally { await cp.close(); }
});

export default router;
