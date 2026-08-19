/**
 * GET /api/audit — the write-ahead audit log, for Enterprise.
 *
 * Every MCP write (index, kg_add, kg_invalidate, diary_write) is appended to
 * `wal_log` before it executes, with a timestamp and a redacted payload. The table
 * has existed for a while; nothing ever exposed it, so 'audit' was a feature the
 * pricing page advertised and the product could not deliver. This is the surface
 * that makes the claim true.
 *
 * Read-only by design. An audit trail that its subject can edit is not an audit
 * trail, so there is deliberately no delete or update route — retention is the
 * retention sweep's job, not a caller's.
 */
import express from 'express';
import { createControlPlane } from '../imports.js';
import { requireFeature } from '../util/billing.js';

const router = express.Router();

// Gated for every route in this router: the whole surface is the licensed feature.
router.use(requireFeature('audit'));

/**
 * GET /api/audit?limit=&before=&operation=
 *
 * Newest first, keyset-paginated on the BIGSERIAL id rather than an offset: an
 * append-only log grows while you page it, and OFFSET would silently skip or repeat
 * rows as new writes land.
 */
router.get('/', async (req, res) => {
  const tenant = req.tenant;
  if (!tenant) return res.status(401).json({ error: 'no tenant resolved' });

  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);
  const before = Number(req.query.before) || null;      // exclusive upper bound on id
  const operation = typeof req.query.operation === 'string' ? req.query.operation : null;

  const cp = await createControlPlane();
  try {
    const rows = await cp.readAuditLog({ tenant, limit, before, operation });
    res.json({
      entries: rows,
      // The cursor for the next page, or null at the end. Returned explicitly so a
      // caller never has to know the keyset rule.
      nextBefore: rows.length === limit ? rows[rows.length - 1]?.id ?? null : null,
      limit,
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'audit read failed' });
  } finally {
    await cp.close();
  }
});

export default router;
