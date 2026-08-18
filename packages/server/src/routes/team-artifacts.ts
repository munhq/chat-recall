/**
 * /api/team — the team toolkit library (the team-tier product surface).
 *
 * Serves the contract in engine/core/team-client.ts verbatim: members
 * publish skills/commands/agents/MCPs/plans/plugins/instructions/hooks;
 * everyone on the team pulls them down into their local AI-tool dirs
 * (`chat-recall team pull` + team-merge.ts).
 *
 *   GET    /api/team/me                       → user + memberships
 *   POST   /api/team {name}                   → create team (owner)
 *   POST   /api/team/join {inviteToken}       → redeem invite
 *   POST   /api/team/:teamId/invite           → mint invite (owner)
 *   GET    /api/team/:teamId/list             → artifact metadata
 *   GET    /api/team/:teamId/pull?since=&limit= → changed artifacts + revoked ids
 *   POST   /api/team/:teamId/publish          → publish/version-bump an artifact
 *   DELETE /api/team/:teamId/artifacts/:id    → revoke (owner)
 *
 * Auth is the Keycloak user JWT (requireUser) — these endpoints map
 * identity → team, so they mount BEFORE tenantAuth. A team IS a tenant
 * (team slug = tenant id), same as routes/teams.ts.
 *
 * Hooks are owner-only to publish (they execute code on every member's
 * machine — see settings.ts TeamSettings.publishAllowed rationale).
 */

import express from 'express';
import { createControlPlane } from '../imports.js';
import { requireUser } from '../middleware/auth.js';
import { loadMemberships, createTeamFor } from '../util/memberships.js';
import { entitledOr402, collaborationOr402 } from '../util/billing.js';
import { seatCheck } from '../util/license.js';

const router = express.Router();

const VALID_TYPES = ['skill', 'command', 'agent', 'mcp', 'plan', 'plugin', 'instructions', 'hook'] as const;
const VALID_TOOLS = ['claude', 'agy', 'gemini', 'opencode', 'codex', 'cross_tool'] as const;
/** Artifacts are config-sized files; a quarter MB is generous. */
const MAX_BODY_BYTES = 256 * 1024;

// Same rows as /api/me, renamed for the team-client contract (`TeamMe`).
router.get('/me', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const memberships = (await loadMemberships(user.sub)).map((m) => ({
    teamId: m.team_slug,
    teamName: m.name,
    role: m.role,
    plan: 'team',
  }));
  res.json({ user: { id: user.sub, email: user.email ?? '' }, memberships });
});

router.post('/', async (req, res) => {
  // Not entitlement-gated — see createTeamFor for why (creation is the on-ramp
  // to subscribing; PUBLISH and INVITE below carry the entitledOr402 gate).
  const user = await requireUser(req, res);
  if (!user) return;
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const t = await createTeamFor(user.sub, user.email, name);
  res.json({ team: { id: t.slug, name: t.name } });
});

router.post('/join', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const inviteToken = req.body?.inviteToken || '';
  const cp = await createControlPlane();
  try {
    const m = await cp.redeemInvite(user.sub, user.email, inviteToken);
    if (!m) return res.status(400).json({ error: 'invalid or expired invite' });
    res.json({ team: { id: m.team_slug, name: m.name } });
  } finally { await cp.close(); }
});

router.post('/:teamId/invite', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const cp = await createControlPlane();
  try {
    if ((await cp.roleOf(user.sub, req.params.teamId)) !== 'owner') {
      return res.status(403).json({ error: 'owner only' });
    }
    // Inviting teammates is paid value (grows the team) — gate on entitlement.
    if (!(await entitledOr402(res, req.params.teamId))) return;
    // And on the TEAM LICENCE for self-host. This is the single chokepoint for a
    // second member, so gating it gates collaboration itself; a solo self-hoster
    // never reaches this route.
    if (!(await collaborationOr402(res, req.params.teamId))) return;
    // Seat ceiling. Checked here because this is the only path that grows a
    // team, so it is the only place the count can change.
    const members = await cp.listMembers(req.params.teamId);
    const seat = seatCheck(Array.isArray(members) ? members.length : 0);
    if (!seat.ok) {
      return res.status(402).json({
        error: `licence covers ${seat.seats} seat(s), all in use`,
        used: seat.used, seats: seat.seats,
        hint: 'Add seats: https://chatrecall.dev/pricing',
      });
    }
    const r = await cp.createInvite(req.params.teamId, 'member', req.body?.emailHint || null, user.sub);
    res.json({ inviteToken: r.invite, expiresAt: new Date(r.expiresAt).toISOString() });
  } finally { await cp.close(); }
});

router.get('/:teamId/list', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const cp = await createControlPlane();
  try {
    if (!(await cp.roleOf(user.sub, req.params.teamId))) {
      return res.status(403).json({ error: 'not a member' });
    }
    res.json({ artifacts: await cp.listArtifacts(req.params.teamId) });
  } finally { await cp.close(); }
});

router.get('/:teamId/pull', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const since = Math.max(0, Number(req.query.since) || 0);
  const limit = Math.min(Math.max(1, Number(req.query.limit) || 500), 1000);
  const cp = await createControlPlane();
  try {
    if (!(await cp.roleOf(user.sub, req.params.teamId))) {
      return res.status(403).json({ error: 'not a member' });
    }
    const { pulled, removed } = await cp.pullArtifacts(req.params.teamId, since, limit);
    res.json({ pulled, removed, serverNow: Date.now() });
  } finally { await cp.close(); }
});

router.post('/:teamId/publish', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const { type, tool, name, bodyB64, pinnedTo } = req.body || {};
  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
  }
  if (!VALID_TOOLS.includes(tool)) {
    return res.status(400).json({ error: `tool must be one of: ${VALID_TOOLS.join(', ')}` });
  }
  if (!name || typeof name !== 'string' || name.length > 128) {
    return res.status(400).json({ error: 'name required (≤128 chars)' });
  }
  if (!bodyB64 || typeof bodyB64 !== 'string') {
    return res.status(400).json({ error: 'bodyB64 required' });
  }
  let decodedLen: number;
  try { decodedLen = Buffer.from(bodyB64, 'base64').length; } catch { return res.status(400).json({ error: 'bodyB64 is not valid base64' }); }
  if (decodedLen === 0) return res.status(400).json({ error: 'body is empty' });
  if (decodedLen > MAX_BODY_BYTES) {
    return res.status(413).json({ error: `body too large (${decodedLen} bytes > ${MAX_BODY_BYTES})` });
  }

  const cp = await createControlPlane();
  try {
    const role = await cp.roleOf(user.sub, req.params.teamId);
    if (!role) return res.status(403).json({ error: 'not a member' });
    // Publishing to the shared library is the core paid action — gate it on the
    // team's subscription (self-host: always entitled).
    if (!(await entitledOr402(res, req.params.teamId))) return;
    // Hooks execute code on every member's machine on pull — owner-only.
    if (type === 'hook' && role !== 'owner') {
      return res.status(403).json({ error: 'publishing hooks is owner-only' });
    }
    const meta = await cp.publishArtifact(req.params.teamId, {
      type, tool, name, bodyB64, pinnedTo: pinnedTo || null, authorSub: user.sub,
    });
    res.json({
      artifact: {
        id: meta.id,
        version: meta.version,
        sha256: meta.sha256,
        updated_at: new Date(meta.updatedAt).toISOString(),
      },
    });
  } finally { await cp.close(); }
});

router.delete('/:teamId/artifacts/:artifactId', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const cp = await createControlPlane();
  try {
    if ((await cp.roleOf(user.sub, req.params.teamId)) !== 'owner') {
      return res.status(403).json({ error: 'owner only' });
    }
    const revoked = await cp.revokeArtifact(req.params.teamId, req.params.artifactId);
    if (!revoked) return res.status(404).json({ error: 'artifact not found' });
    res.json({ revoked });
  } finally { await cp.close(); }
});

export default router;
