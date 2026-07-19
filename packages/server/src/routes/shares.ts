/**
 * /api/shares — per-project sharing, DATA-PLANE edition (Phase 4).
 *
 * The Phase-1 /api/teams/:slug/shares routes authenticate a Keycloak USER
 * (requireUser) and are used by the web app. But the CLI authenticates with a
 * `ct_` device token, which resolves through tenantAuth (NOT requireUser) —
 * so it needs a data-plane surface. This router mounts AFTER tenantAuth, so
 * req.tenant (the team) and req.authorSub (the token's owning user) are already
 * resolved, and it manages shares for exactly that owner. Works for both the
 * CLI (device token) and the web (JWT → tenantAuth also sets authorSub).
 *
 *   GET    /api/shares            → the caller's own shares (what YOU expose)
 *   GET    /api/shares/all        → every share in the team (overview)
 *   POST   /api/shares {project_id, scope?}
 *   DELETE /api/shares {project_id}
 *
 * owner_sub is ALWAYS the caller — you can only share your own work.
 */
import express from 'express';
import { createControlPlane } from '../imports.js';
import { entitledOr402 } from '../util/billing.js';

const router = express.Router();

/** The sharing owner: the token's user, or the JWT user. Sharing needs a real
 *  user identity — self-host `none`/admin tokens have none (everything is
 *  already NULL-author / team-visible there), so we reject with a clear 400. */
function ownerOr400(req: express.Request, res: express.Response): string | null {
  const sub = req.authorSub || null;
  if (!sub) { res.status(400).json({ error: 'sharing requires a team account (no user identity on this token)' }); return null; }
  return sub;
}

router.get('/', async (req, res) => {
  const owner = ownerOr400(req, res); if (!owner) return;
  const cp = await createControlPlane();
  try { res.json({ shares: await cp.listSharesForUser(req.tenant!, owner) }); }
  finally { await cp.close(); }
});

router.get('/all', async (req, res) => {
  const cp = await createControlPlane();
  try { res.json({ shares: await cp.listShares(req.tenant!) }); }
  finally { await cp.close(); }
});

router.post('/', async (req, res) => {
  const owner = ownerOr400(req, res); if (!owner) return;
  const projectId = (req.body?.project_id || '').trim();
  if (!projectId) return res.status(400).json({ error: 'project_id required' });
  // v1: sharing is FULL (redacted content). The scope column exists for a
  // future 'activity'-only (metadata-only) tier, but that isn't enforced yet —
  // the RLS policies don't gate on scope — so we must NOT offer a control that
  // silently over-shares. Always 'full' until the policy tier lands.
  if (!(await entitledOr402(res, req.tenant!))) return;
  const cp = await createControlPlane();
  try { await cp.setShare(req.tenant!, owner, projectId, 'full'); res.json({ ok: true, project_id: projectId, scope: 'full' }); }
  finally { await cp.close(); }
});

router.delete('/', async (req, res) => {
  const owner = ownerOr400(req, res); if (!owner) return;
  const projectId = (req.body?.project_id || '').trim();
  if (!projectId) return res.status(400).json({ error: 'project_id required' });
  const cp = await createControlPlane();
  try { const removed = await cp.removeShare(req.tenant!, owner, projectId); res.json({ ok: true, removed, project_id: projectId }); }
  finally { await cp.close(); }
});

export default router;
