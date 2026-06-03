/**
 * Secret-finding endpoints. Reads from the `secret_findings` table
 * populated by the secret scanner. Findings carry only redacted
 * previews — the raw secret is NEVER stored or returned, so these
 * endpoints are safe to surface across tenant boundaries.
 *
 *   GET /api/secrets/summary
 *     Per-detector totals + top rules. Drives the Security view.
 *
 *   GET /api/secrets/sessions
 *     One row per session with finding counts by detector.
 *     Use `?min=2` to require at least N detectors agreeing (signal vs noise).
 *
 *   GET /api/secrets/session/:id
 *     Full findings for one session, grouped by detector.
 *     Used by the per-conversation Security tab.
 *
 * Storage goes through the async StorageDriver (sqlite | postgres) — every
 * handler is async and awaits a freshly-created store.
 */

import express from 'express';
import { createStore } from '../imports.js';

const router = express.Router();

router.get('/summary', async (_req, res) => {
  const store = await createStore();
  try {
    res.json(await store.secretFindingsSummary());
  } finally { await store.close(); }
});

router.get('/by-rule', async (_req, res) => {
  const store = await createStore();
  try {
    res.json({ rules: await store.secretFindingsByRule() });
  } finally { await store.close(); }
});

// Per-repo rollup: which projects leaked the most, and how many are live.
router.get('/by-project', async (_req, res) => {
  const store = await createStore();
  try {
    res.json({ projects: await store.secretFindingsByProject() });
  } finally { await store.close(); }
});

// Daily trend (distinct secrets + verified-live) over ?days=N (default 30).
router.get('/trend', async (req, res) => {
  const days = Math.max(1, Math.min(parseInt(req.query.days as string) || 30, 365));
  const store = await createStore();
  try {
    res.json({ days, trend: await store.secretFindingsTrend(days) });
  } finally { await store.close(); }
});

router.get('/distinct', async (req, res) => {
  // ?include_dismissed=true to show items the user already actioned;
  // default hides them so the Action Required list stays focused on
  // unresolved leaks.
  const includeDismissed = req.query.include_dismissed === 'true';
  const store = await createStore();
  try {
    const all = await store.secretFindingsByDistinctSecret();
    const dismissals = await store.getSecretDismissals();
    const enriched = all.map(s => ({
      ...s,
      dismissal: dismissals.get(s.preview) || null,
    }));
    const filtered = includeDismissed ? enriched : enriched.filter(s => !s.dismissal);
    res.json({ secrets: filtered, dismissedCount: enriched.length - filtered.length });
  } finally { await store.close(); }
});

// Mark a finding as rotated / false_positive / dismissed.
router.post('/dismiss', express.json(), async (req, res) => {
  const { preview, status, reason } = req.body as { preview?: string; status?: string; reason?: string };
  if (!preview || typeof preview !== 'string') {
    return res.status(400).json({ error: 'preview required' });
  }
  if (!['rotated', 'false_positive', 'dismissed'].includes(status || '')) {
    return res.status(400).json({ error: 'status must be rotated|false_positive|dismissed' });
  }
  const store = await createStore();
  try {
    await store.setSecretDismissal(preview, status as 'rotated' | 'false_positive' | 'dismissed', reason);
    res.json({ ok: true });
  } finally { await store.close(); }
});

// Reverse a dismissal — bring the finding back into the Action list.
router.post('/undismiss', express.json(), async (req, res) => {
  const { preview } = req.body as { preview?: string };
  if (!preview) return res.status(400).json({ error: 'preview required' });
  const store = await createStore();
  try {
    await store.clearSecretDismissal(preview);
    res.json({ ok: true });
  } finally { await store.close(); }
});

/* ── Tenant-configurable rules CRUD ──────────────────────────── */

router.get('/rules', async (_req, res) => {
  const store = await createStore();
  try {
    res.json({ rules: await store.listSecretRules() });
  } finally { await store.close(); }
});

router.post('/rules', express.json(), async (req, res) => {
  const { id, name, regex, severity, description, enabled } = req.body || {};
  if (!name || !regex || !severity) {
    return res.status(400).json({ error: 'name, regex, severity required' });
  }
  if (!['critical', 'high', 'medium', 'low'].includes(severity)) {
    return res.status(400).json({ error: 'severity must be one of critical|high|medium|low' });
  }
  // Validate the regex compiles BEFORE we persist it — a broken
  // pattern would silently break every future scan.
  try { new RegExp(regex); }
  catch (e) { return res.status(400).json({ error: 'invalid regex: ' + (e as Error).message }); }

  const store = await createStore();
  try {
    const r = await store.upsertSecretRule({ id, name, regex, severity, description, enabled });
    res.json(r);
  } finally { await store.close(); }
});

router.delete('/rules/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id must be a number' });
  const store = await createStore();
  try {
    await store.deleteSecretRule(id);
    res.json({ ok: true });
  } finally { await store.close(); }
});

/**
 * Test-sandbox: post a sample text + (optional) regex-overrides to
 * see what would match, without persisting anything. Used by the
 * Settings UI's live-preview field. Catches backwards regexes
 * before they go into production scans.
 */
router.post('/rules/test', express.json(), (req, res) => {
  const { sample, regex } = req.body || {};
  if (typeof sample !== 'string' || typeof regex !== 'string') {
    return res.status(400).json({ error: 'sample and regex required' });
  }
  try {
    const re = new RegExp(regex, 'g');
    const matches = [...sample.matchAll(re)].slice(0, 20).map(m => ({
      match: m[0].length > 80 ? m[0].slice(0, 76) + '…' : m[0],
      index: m.index,
    }));
    res.json({ count: matches.length, matches });
  } catch (e) {
    res.status(400).json({ error: 'invalid regex: ' + (e as Error).message });
  }
});

router.get('/sessions', async (req, res) => {
  const min = Math.max(1, Number(req.query.min) || 1);
  const store = await createStore();
  try {
    // One row per (session, detector). Pivot client-side; the SQL stays
    // boring and adapts to whatever set of detectors we end up running.
    const rows = await store.secretFindingsBySession();

    const bySession = new Map<string, {
      sessionId: string; project: string; title: string; mtime: number;
      detectors: Record<string, number>; total: number; agreement: number;
    }>();
    for (const r of rows) {
      let entry = bySession.get(r.session_id);
      if (!entry) {
        entry = {
          sessionId: r.session_id,
          project: r.project_path || '',
          title: r.title || '',
          mtime: r.mtime || 0,
          detectors: {},
          total: 0,
          agreement: 0,
        };
        bySession.set(r.session_id, entry);
      }
      entry.detectors[r.detector] = r.n;
      entry.total += r.n;
      entry.agreement = Object.keys(entry.detectors).length;
    }
    const filtered = [...bySession.values()]
      .filter(s => s.agreement >= min)
      .sort((a, b) => b.agreement - a.agreement || b.total - a.total);
    res.json({ sessions: filtered, count: filtered.length });
  } finally { await store.close(); }
});

router.get('/session/:id', async (req, res) => {
  const { id } = req.params;
  const store = await createStore();
  try {
    const findings = await store.secretFindingsForSession(id);
    // Memoize cross-session counts per unique preview so we don't
    // run the same query N times for repeated findings on the same key.
    const xCount = new Map<string, number>();
    const enriched: Array<typeof findings[number] & { crossSessionCount: number }> = [];
    for (const f of findings) {
      let cross = xCount.get(f.preview);
      if (cross === undefined) {
        cross = await store.secretCrossSessionCount(f.preview, id);
        xCount.set(f.preview, cross);
      }
      enriched.push({ ...f, crossSessionCount: cross });
    }
    const byDetector: Record<string, typeof enriched> = {};
    for (const f of enriched) (byDetector[f.detector] ||= []).push(f);
    res.json({ sessionId: id, total: enriched.length, byDetector });
  } finally { await store.close(); }
});

export default router;
