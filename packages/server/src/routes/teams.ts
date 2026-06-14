/**
 * Self-serve teams + admin tenant bootstrap (ported from cloud/server.mjs).
 *
 * Human-facing routes authenticate a Keycloak user directly (requireUser) —
 * they map identity → team, so they run BEFORE any tenant is established
 * and are mounted outside the tenantAuth middleware.
 *
 *   GET  /api/me                       → user + memberships
 *   POST /api/teams                    → create team (caller becomes owner; team = tenant)
 *   POST /api/teams/join               → redeem invite
 *   GET  /api/teams/:slug/members      → list members (members only)
 *   POST /api/teams/:slug/invites      → mint single-use invite (owner only)
 *   POST /api/teams/:slug/tokens       → mint a device sync token (members)
 *
 * Admin bootstrap (x-admin-key === ADMIN_KEY env) for self-host where no
 * Keycloak exists:
 *   POST /api/tenants                  → create tenant
 *   POST /api/tenants/:slug/tokens     → mint device token for tenant
 *
 * ADMIN_KEY has no default: unset ⇒ the admin endpoints are disabled
 * (fail-closed) instead of guarded by a guessable 'dev-admin'.
 */

import express from 'express';
import { createControlPlane } from '../imports.js';
import { requireUser } from '../middleware/auth.js';
import { entitledOr402 } from '../util/billing.js';

const router = express.Router();

function adminOk(req: express.Request, res: express.Response): boolean {
  const key = process.env.ADMIN_KEY;
  if (!key) {
    res.status(403).json({ error: 'admin endpoints disabled (ADMIN_KEY not set)' });
    return false;
  }
  if ((req.get('x-admin-key') || '') !== key) {
    res.status(401).json({ error: 'admin key required' });
    return false;
  }
  return true;
}

router.get('/me', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const cp = await createControlPlane();
  try {
    const teams = await cp.listMemberships(user.sub);
    res.json({ user, teams });
  } finally { await cp.close(); }
});

router.post('/teams', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const cp = await createControlPlane();
  try {
    const t = await cp.createTeam(name, user.sub, user.email);
    res.json({ slug: t.slug, name: t.name, role: 'owner' });
  } finally { await cp.close(); }
});

router.post('/teams/join', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const invite = req.body?.invite || '';
  const cp = await createControlPlane();
  try {
    const m = await cp.redeemInvite(user.sub, user.email, invite);
    if (!m) return res.status(400).json({ error: 'invalid or expired invite' });
    res.json({ team_slug: m.team_slug, name: m.name, role: m.role });
  } finally { await cp.close(); }
});

router.get('/teams/:slug/members', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const cp = await createControlPlane();
  try {
    if (!(await cp.roleOf(user.sub, req.params.slug))) {
      return res.status(403).json({ error: 'not a member' });
    }
    res.json({ team_slug: req.params.slug, members: await cp.listMembers(req.params.slug) });
  } finally { await cp.close(); }
});

router.post('/teams/:slug/invites', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const cp = await createControlPlane();
  try {
    if ((await cp.roleOf(user.sub, req.params.slug)) !== 'owner') {
      return res.status(403).json({ error: 'owner only' });
    }
    // Inviting teammates grants paid value — gate on the team's subscription.
    if (!(await entitledOr402(res, req.params.slug))) return;
    const role = req.body?.role === 'owner' ? 'owner' as const : 'member' as const;
    const r = await cp.createInvite(req.params.slug, role, req.body?.email || null, user.sub);
    res.json({
      invite: r.invite,
      team_slug: req.params.slug,
      expires_at: new Date(r.expiresAt).toISOString(),
      note: 'shown once',
    });
  } finally { await cp.close(); }
});

router.post('/teams/:slug/tokens', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const cp = await createControlPlane();
  try {
    if (!(await cp.roleOf(user.sub, req.params.slug))) {
      return res.status(403).json({ error: 'not a member' });
    }
    const deviceId = (req.body?.device_id || 'default').slice(0, 64);
    const token = await cp.mintAgentToken(req.params.slug, deviceId, user.sub);
    res.json({ token, tenant_slug: req.params.slug, device_id: deviceId, note: 'shown once' });
  } finally { await cp.close(); }
});

// ── Admin bootstrap (self-host without Keycloak) ────────────────────────

router.post('/tenants', async (req, res) => {
  if (!adminOk(req, res)) return;
  const { slug, display_name } = req.body || {};
  if (!slug || !display_name) return res.status(400).json({ error: 'slug + display_name required' });
  const cp = await createControlPlane();
  try {
    await cp.ensureTenant(slug, display_name);
    res.json({ ok: true, slug });
  } finally { await cp.close(); }
});

router.post('/tenants/:slug/tokens', async (req, res) => {
  if (!adminOk(req, res)) return;
  const deviceId = (req.body?.device_id || 'default').slice(0, 64);
  const cp = await createControlPlane();
  try {
    const token = await cp.mintAgentToken(req.params.slug, deviceId);
    res.json({ token, tenant_slug: req.params.slug, device_id: deviceId, note: 'shown once — store it' });
  } finally { await cp.close(); }
});

// Purge a tenant and ALL of its data (control plane + tenant-scoped rows).
// Irreversible; admin-key only. Exists to clean up test tenants.
router.delete('/tenants/:slug', async (req, res) => {
  if (!adminOk(req, res)) return;
  const cp = await createControlPlane();
  try {
    const deleted = await cp.deleteTenant(req.params.slug);
    if (!deleted) return res.status(404).json({ error: 'tenant not found' });
    res.json({ ok: true, deleted: req.params.slug });
  } finally { await cp.close(); }
});

export default router;
