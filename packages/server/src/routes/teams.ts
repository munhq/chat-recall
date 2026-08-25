/**
 * Self-serve teams + admin tenant bootstrap (ported from cloud/server.mjs).
 *
 * Human-facing routes authenticate a Keycloak user directly (requireUser) —
 * they map identity → team, so they run BEFORE any tenant is established
 * and are mounted outside the tenantAuth middleware.
 *
 *   GET  /api/me                       → user + memberships
 *   POST /api/teams                    → create team (caller becomes owner; team = tenant)
 *   POST /api/teams/:slug/tokens       → mint a device sync token (members)
 *
 * Join and invite live on the `/api/team*` router (routes/team-artifacts.ts) —
 * that is what `engine/core/team-client.ts` calls. The duplicates that used to
 * sit here had no callers and were removed; see the note above the tokens route.
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
import { isOperatorRequest, requireUser } from '../middleware/auth.js';
import { loadMemberships, createTeamFor } from '../util/memberships.js';
import { firstTouchFromCookieHeader } from '@chat-recall/engine/core/attribution.js';
import { sensitiveLimiter } from '../middleware/rate-limit.js';
import { featureRequired, allows } from '../util/entitlements.js';
import { tenantPlan } from '../util/billing.js';

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

// Raw-row shape; /api/team/me renames the same rows. See util/memberships.ts.
router.get('/me', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  // `isOperator` so the client can HIDE the admin console rather than render it
  // and let the server refuse. Computed here, never trusted from the client:
  // every admin route still calls requireAdmin(), so flipping this in devtools
  // reveals an empty panel and nothing else.
  res.json({ user, isOperator: await isOperatorRequest(req), teams: await loadMemberships(user.sub) });
});

router.post('/teams', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });

  const t = await createTeamFor(
    user.sub, user.email, name,
    firstTouchFromCookieHeader(req.headers.cookie ?? null),
  );
  res.json({ slug: t.slug, name: t.name, role: 'owner' });
});

// REMOVED (no callers anywhere — client, CLI, engine or tests):
//   POST /api/teams/join          → the live redeemer is POST /api/team/join
//   GET  /api/teams/:slug/members
//   POST /api/teams/:slug/invites → the live minter is POST /api/team/:teamId/invite
// The `/api/team*` router (routes/team-artifacts.ts) owns join + invite because
// `engine/core/team-client.ts:120,130` is what actually calls them, via the
// `chat-recall team` CLI (cli.ts:1418). Removing the duplicates here loses only
// the ability to mint an OWNER invite, which nothing used. Same de-dup as the
// JWT-only `/api/teams/:slug/shares` removal recorded below.

router.post('/teams/:slug/tokens', sensitiveLimiter, async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const cp = await createControlPlane();
  try {
    if (!(await cp.roleOf(user.sub, req.params.slug))) {
      return res.status(403).json({ error: 'not a member' });
    }
    const deviceId = (req.body?.device_id || 'default').slice(0, 64);

    // MACHINE CEILING — a boundary marker, not enforcement.
    //
    // /api/sync itself is deliberately NOT gated: a solo self-hoster pushing their
    // laptop to their own VM is the whole free story, and gating the route would
    // delete the free tier.
    //
    // Nor can this stop account sharing. One device token works from any number of
    // machines concurrently, so five people can share a single token and pass any
    // count we impose. That is unpreventable on hardware we do not control, and it
    // is a licence violation rather than a bug — the same legal-not-technical
    // boundary the anti-circumvention clause rests on.
    //
    // What the ceiling does is make crossing the line a CONSCIOUS act. TWO is the
    // number because the complaint it must not provoke is "I have a laptop and a
    // desktop" — that is exactly two, and the VM being self-hosted onto is a server,
    // not a client, so it needs no token. Three would start covering a team-shaped
    // pattern, which is precisely what should hit the wall.
    //
    // Re-minting an existing device id is a rotation, not a new machine. Revoked
    // tokens do not count, so retiring a machine frees its slot.
    const FREE_DEVICES = 2;
    if (!allows(await tenantPlan(req.params.slug), 'sync')) {
      const existing = (await cp.listAgentTokens(req.params.slug))
        .filter((t) => !t.revoked)
        .map((t) => t.deviceId);
      if (!existing.includes(deviceId) && existing.length >= FREE_DEVICES) {
        return res.status(402).json({
          ...featureRequired('sync'),
          error: `syncing more than ${FREE_DEVICES} machines needs a paid plan or a licence`,
          devices: existing.length,
          limit: FREE_DEVICES,
          hint: `${FREE_DEVICES} machines are free. Revoke a device token to move machines, or upgrade to sync more.`,
        });
      }
    }

    const token = await cp.mintAgentToken(req.params.slug, deviceId, user.sub);
    res.json({ token, tenant_slug: req.params.slug, device_id: deviceId, note: 'shown once' });
  } finally { await cp.close(); }
});

// List the team's devices (metadata only — token hashes never leave the
// store). Powers the Account page "Connected devices" card in onboarding.
router.get('/teams/:slug/tokens', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const cp = await createControlPlane();
  try {
    if (!(await cp.roleOf(user.sub, req.params.slug))) {
      return res.status(403).json({ error: 'not a member' });
    }
    res.json({ devices: await cp.listAgentTokens(req.params.slug) });
  } finally { await cp.close(); }
});

// Revoke a device's sync token. The device keeps its local transcripts; it
// just can't push to / read from this team until a new token is minted.
router.delete('/teams/:slug/tokens/:deviceId', sensitiveLimiter, async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const cp = await createControlPlane();
  try {
    if (!(await cp.roleOf(user.sub, req.params.slug))) {
      return res.status(403).json({ error: 'not a member' });
    }
    const ok = await cp.revokeAgentToken(req.params.slug, req.params.deviceId);
    if (!ok) return res.status(404).json({ error: 'no active token for that device' });
    res.json({ revoked: req.params.deviceId });
  } finally { await cp.close(); }
});

// ── Per-project sharing (team collaboration) ────────────────────────────
// A member opts THEIR OWN work on a project into team visibility. Default is
// private — nothing is visible to teammates until shared.
//
// NOTE: per-project share management lives on the DATA-PLANE router
// `/api/shares` (routes/shares.ts), which runs after tenantAuth and therefore
// works for BOTH the web (JWT) and the CLI (ct_ device token). The earlier
// JWT-only /api/teams/:slug/shares routes were removed to avoid two surfaces
// (and their inverted GET defaults) for one feature.

// ── Admin bootstrap (self-host without Keycloak) ────────────────────────

router.post('/tenants', sensitiveLimiter, async (req, res) => {
  if (!adminOk(req, res)) return;
  const { slug, display_name } = req.body || {};
  if (!slug || !display_name) return res.status(400).json({ error: 'slug + display_name required' });
  const cp = await createControlPlane();
  try {
    await cp.ensureTenant(slug, display_name);
    res.json({ ok: true, slug });
  } finally { await cp.close(); }
});

router.post('/tenants/:slug/tokens', sensitiveLimiter, async (req, res) => {
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
