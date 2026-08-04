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
  /** Transcript SOURCES (per-machine home dirs) switched off for this tenant,
   *  by client-reported source id. Exclusion-only on purpose: the dashboard can
   *  turn a discovered source OFF, but nothing here can name a filesystem path
   *  for a collector to start reading. See engine core/source-discovery.ts. */
  excludeSources: string[];
  /** Homes the operator APPROVED in the dashboard. Ids only — the client maps
   *  each back to a home IT discovered, so this can answer the pending question
   *  without ever letting the server name a filesystem path. */
  approveSources: string[];
}

/** Sources the collectors have reported seeing, so the dashboard can render a
 *  toggle for something it never gets to name itself. Written by the sync
 *  client, read by the UI; advisory only — the client re-derives the real list
 *  from disk on every run. */
export interface ReportedSource {
  id: string;
  tool: string;
  path: string;
  sessions: number;
  newestMtime: number;
  isPrimary: boolean;
  /** The client's own decision: primary | approved | declined | pending. The UI
   *  turns `pending` into a prompt — that is the whole point of reporting it. */
  decision?: string;
  /** How the client found it: declared | signature | running-process. */
  via?: string;
  device?: string;
  reportedAt: number;
}
const SOURCES_KEY = 'sync_sources';

function sanitize(body: unknown): TenantSyncConfig | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const tools = Array.isArray(b.excludeTools) ? b.excludeTools : [];
  const projects = Array.isArray(b.excludeProjects) ? b.excludeProjects : [];
  const sources = Array.isArray(b.excludeSources) ? b.excludeSources : [];
  const approve = Array.isArray(b.approveSources) ? b.approveSources : [];
  if (tools.some((t) => typeof t !== 'string' || !VALID_TOOLS.includes(t as never))) return null;
  if (projects.some((p) => typeof p !== 'string')) return null;
  // Ids only. Rejecting anything path-shaped here is the server-side half of
  // the guarantee that this endpoint can never widen what a collector reads.
  if (sources.some((x) => typeof x !== 'string' || !/^src_[0-9a-f]{12}$/.test(x))) return null;
  if (approve.some((x) => typeof x !== 'string' || !/^src_[0-9a-f]{12}$/.test(x))) return null;
  return {
    approveSources: [...new Set(approve as string[])].slice(0, 100),
    excludeSources: [...new Set(sources as string[])].slice(0, 100),
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
    let cfg: TenantSyncConfig = { excludeTools: [], excludeProjects: [], excludeSources: [], approveSources: [] };
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

/**
 * Collector → server: "here is what this machine actually has."
 *
 * The ONLY direction a filesystem path travels. The dashboard renders these so
 * an operator can switch one off; the collector re-discovers the real list from
 * disk every run and never trusts this back.
 */
router.post('/sources', express.json(), async (req, res) => {
  const tenant = (req as any).tenant;
  if (!tenant) return res.status(401).json({ error: 'tenant required' });
  const incoming = Array.isArray(req.body?.sources) ? req.body.sources : null;
  if (!incoming) return res.status(400).json({ error: 'sources[] required' });
  const device = typeof req.body?.device === 'string' ? req.body.device.slice(0, 128) : '';

  const clean: ReportedSource[] = [];
  for (const s of incoming.slice(0, 50)) {
    if (!s || typeof s.id !== 'string' || !/^src_[0-9a-f]{12}$/.test(s.id)) continue;
    if (typeof s.path !== 'string') continue;
    clean.push({
      id: s.id,
      tool: typeof s.tool === 'string' ? s.tool.slice(0, 32) : 'claude',
      path: s.path.slice(0, 512),
      sessions: Number.isFinite(s.sessions) ? Math.max(0, Math.trunc(s.sessions)) : 0,
      newestMtime: Number.isFinite(s.newestMtime) ? Math.trunc(s.newestMtime) : 0,
      isPrimary: !!s.isPrimary,
      decision: typeof s.decision === 'string' ? s.decision.slice(0, 16) : undefined,
      via: typeof s.via === 'string' ? s.via.slice(0, 24) : undefined,
      device,
      reportedAt: Date.now(),
    });
  }

  const cp = await createControlPlane();
  try {
    // Merge by (device, id) so several machines each keep their own entry.
    let existing: ReportedSource[] = [];
    const raw = await cp.getTenantSetting(tenant, SOURCES_KEY);
    if (raw) { try { existing = JSON.parse(raw); } catch { /* corrupt → replace */ } }
    if (!Array.isArray(existing)) existing = [];
    const byKey = new Map(existing.map((s) => [`${s.device || ''}|${s.id}`, s]));
    for (const s of clean) byKey.set(`${s.device || ''}|${s.id}`, s);
    const merged = [...byKey.values()].slice(-200);
    await cp.setTenantSetting(tenant, SOURCES_KEY, JSON.stringify(merged));
    res.json({ ok: true, count: clean.length });
  } finally { await cp.close(); }
});

router.get('/sources', async (req, res) => {
  const tenant = (req as any).tenant;
  if (!tenant) return res.status(401).json({ error: 'tenant required' });
  const cp = await createControlPlane();
  try {
    const raw = await cp.getTenantSetting(tenant, SOURCES_KEY);
    let sources: ReportedSource[] = [];
    if (raw) { try { sources = JSON.parse(raw) || []; } catch { /* corrupt → empty */ } }
    const cfgRaw = await cp.getTenantSetting(tenant, SYNC_CONFIG_KEY);
    let excluded: string[] = [];
    let approved: string[] = [];
    if (cfgRaw) {
      try {
        const parsed = JSON.parse(cfgRaw);
        excluded = parsed?.excludeSources ?? [];
        approved = parsed?.approveSources ?? [];
      } catch { /* ignore */ }
    }
    res.json({
      sources: Array.isArray(sources) ? sources : [],
      excludeSources: excluded,
      approveSources: approved,
    });
  } finally { await cp.close(); }
});

export default router;
