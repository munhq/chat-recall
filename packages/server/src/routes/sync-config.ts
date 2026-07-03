/**
 * Tenant sync configuration — the server-side half of sync exclusions.
 *
 * The dashboard edits this; every device's sync client pulls it at the start
 * of each sync and UNIONS it with the machine's local exclusions. Union is
 * the fail-safe direction: server config can only ADD protection — it can
 * never silently re-enable syncing of something a machine excluded locally.
 *
 * Mounted AFTER tenantAuth so req.tenant is resolved (dashboard JWTs and
 * ct_ device tokens both land here).
 */

import express from 'express';
import { createControlPlane } from '../imports.js';

const router = express.Router();
const SYNC_CONFIG_KEY = 'sync_config';

const VALID_TOOLS = ['claude', 'gemini', 'codex', 'opencode', 'agy'] as const;

export interface TenantSyncConfig {
  excludeTools: string[];
  excludeProjects: string[];
}

function sanitize(body: unknown): TenantSyncConfig | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const tools = Array.isArray(b.excludeTools) ? b.excludeTools : [];
  const projects = Array.isArray(b.excludeProjects) ? b.excludeProjects : [];
  if (tools.some((t) => typeof t !== 'string' || !VALID_TOOLS.includes(t as never))) return null;
  if (projects.some((p) => typeof p !== 'string')) return null;
  return {
    excludeTools: [...new Set(tools as string[])],
    // Substring patterns matched against project paths on the device. Cap
    // count + length so a bad dashboard call can't grow the setting unbounded.
    excludeProjects: [...new Set((projects as string[]).map((p) => p.trim()).filter(Boolean))].slice(0, 200).map((p) => p.slice(0, 512)),
  };
}

router.get('/', async (req, res) => {
  const tenant = (req as any).tenant;
  if (!tenant) return res.status(401).json({ error: 'tenant required' });
  const cp = await createControlPlane();
  try {
    const raw = await cp.getTenantSetting(tenant, SYNC_CONFIG_KEY);
    let cfg: TenantSyncConfig = { excludeTools: [], excludeProjects: [] };
    if (raw) {
      try { cfg = sanitize(JSON.parse(raw)) ?? cfg; } catch { /* corrupt setting → defaults */ }
    }
    res.json(cfg);
  } finally { await cp.close(); }
});

router.post('/', express.json(), async (req, res) => {
  const tenant = (req as any).tenant;
  if (!tenant) return res.status(401).json({ error: 'tenant required' });
  const cfg = sanitize(req.body);
  if (!cfg) return res.status(400).json({ error: `invalid sync config (tools must be one of: ${VALID_TOOLS.join(', ')})` });
  const cp = await createControlPlane();
  try {
    await cp.setTenantSetting(tenant, SYNC_CONFIG_KEY, JSON.stringify(cfg));
    res.json(cfg);
  } finally { await cp.close(); }
});

export default router;
