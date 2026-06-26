/**
 * Account-level recommendations — the "same actionable approach" applied to
 * chat-recall's OWN data (not a code project): leaked secrets from the scanner
 * + session behaviour (unresolved sessions). Same Recommendation shape, same
 * apply rail (a code_apply intent the local agent drains), so the UI and MCP
 * treat account recs identically to code recs.
 *
 * Tenant comes from tenantAuth (runWithTenant); every store call is RLS-scoped.
 */

import express from 'express';
import { createStore, createOutcomeCache, buildAccountRecommendations, type BehaviorSignal } from '../imports.js';

const router = express.Router();

async function loadAccountRecs(store: any) {
  const sum = await store.secretFindingsSummary();
  const leakedSecrets = (sum.totals as Array<{ findings: number }>).reduce((a, t) => a + (t.findings || 0), 0);
  const distinctSecretRules = [...new Set((sum.topRules as Array<{ rule: string }>).map((r) => r.rule))];
  let behavior: BehaviorSignal | undefined;
  try {
    const sessions = await store.listItems('session', 500, 0);
    const ids = sessions.map((s: any) => s.id);
    if (ids.length) {
      const oc = await createOutcomeCache();
      try {
        const rows = await oc.getMany(ids);
        let failed = 0;
        for (const [, r] of rows) if (r && r.status === 'interrupted') failed++;
        behavior = { failedOrAbandoned: failed, totalSessions: ids.length };
      } finally { await oc.close(); }
    }
  } catch { /* behavioral signal optional */ }
  const recommendations = buildAccountRecommendations({ leakedSecrets, distinctSecretRules, behavior });
  return { recommendations, behavior };
}

// GET /api/recommendations — tenant-wide (security + behaviour) recommendations.
router.get('/', async (_req, res) => {
  const store = await createStore();
  try {
    const { recommendations, behavior } = await loadAccountRecs(store);
    res.json({ recommendations, behavior: behavior ?? null });
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'failed' }); }
  finally { await store.close(); }
});

// POST /api/recommendations/:id/apply — append the rule to the global CLAUDE.md
// via the local agent (code_apply intent, global flag).
router.post('/:id/apply', async (req, res) => {
  const store = await createStore();
  try {
    const { recommendations } = await loadAccountRecs(store);
    const rec = recommendations.find((r) => r.id === req.params.id);
    if (!rec) return res.status(404).json({ error: 'recommendation not found (re-fetch; it may have changed)' });
    if (rec.action.type !== 'append_claude_md') {
      return res.status(400).json({ ok: false, message: 'No automatic apply for this recommendation.' });
    }
    const intentId = await store.enqueueSyncIntent({
      kind: 'code_apply', artifactType: 'append_claude_md',
      name: JSON.stringify({ global: true, payload: rec.action.payload }),
      createdBy: 'account-recommendation',
    });
    res.json({ ok: true, queued: true, intentId, message: 'Queued — the local agent appends this rule to your global ~/.claude/CLAUDE.md on next drain (≤45s).' });
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'failed' }); }
  finally { await store.close(); }
});

export default router;
