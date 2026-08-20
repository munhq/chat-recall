/**
 * /api/activity — the team activity view.
 *
 * "What did each teammate do, per project." A per-(member × project) rollup of
 * session activity. Mounted AFTER tenantAuth, so req.tenant is the team and the
 * request's `app.viewer` GUC is set — meaning the underlying store query is
 * RLS-scoped to what THIS member may see: their own work plus teammates' work on
 * projects shared into the team. A private (unshared) project never appears.
 *
 *   GET /api/activity?project=<project_id>&member=<sub>&since=<ms>
 *     → { tenant, members[], activity: [{ authorSub, memberEmail, projectId, sessions, lastMtime }] }
 */
import express from 'express';
import { createStore, createControlPlane } from '../imports.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';

const log = createLogger('activity');
const router = express.Router();

router.get('/', async (req, res) => {
  const projectId = typeof req.query.project === 'string' && req.query.project ? req.query.project : undefined;
  const member = typeof req.query.member === 'string' && req.query.member ? req.query.member : undefined;
  const since = req.query.since ? Number(req.query.since) : undefined;
  const sinceMs = since && Number.isFinite(since) ? since : undefined;

  const store = await createStore();
  try {
    const rows = await store.teamActivity({ projectId, author: member, sinceMs, limit: 1000 });

    // Map author_sub → member email for display. Membership is control-plane
    // (keyed by team slug = tenant); best-effort — an author with no membership
    // row (a departed member, or a device-only token) just shows no email.
    const emailBySub: Record<string, string> = {};
    const members: Array<{ sub: string; email: string | null; role: string }> = [];
    const cp = await createControlPlane();
    try {
      for (const m of await cp.listMembers(req.tenant!)) {
        if (m.email) emailBySub[m.user_sub] = m.email;
        members.push({ sub: m.user_sub, email: m.email, role: m.role });
      }
    } finally { await cp.close(); }

    res.json({
      tenant: req.tenant,
      members,
      activity: rows.map((r) => ({
        authorSub: r.authorSub,
        memberEmail: r.authorSub ? (emailBySub[r.authorSub] ?? null) : null,
        projectId: r.projectId,
        sessions: r.sessions,
        lastMtime: r.lastMtime,
      })),
    });
  } catch (e) {
    log.error({ err: e }, 'activity rollup failed');
    res.status(500).json({ error: e instanceof Error ? e.message : 'activity failed' });
  } finally {
    await store.close();
  }
});

export default router;
