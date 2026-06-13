/**
 * Knowledge-graph routes — the server-side surface for the MCP `recall_kg_*`
 * tools once the CLI becomes a thin collector. Every handler opens a
 * tenant-scoped KG via `createKnowledgeGraph()` (the tenant is ambient,
 * resolved by `tenantAuth` → `runWithTenant`, exactly as `routes/sync.ts`
 * does on ingest). Reads are GET; writes (add/invalidate) are POST and are
 * tenant-walled by the same middleware.
 */

import express from 'express';
import { createKnowledgeGraph } from '../imports.js';

const router = express.Router();

// POST /api/kg/query — { entity, as_of?, direction? } → current/historical facts.
// POST (not GET) because the agent passes structured filters.
router.post('/query', async (req, res) => {
  const { entity, as_of, direction } = req.body ?? {};
  if (!entity || typeof entity !== 'string') {
    return res.status(400).json({ error: 'entity (string) is required' });
  }
  const kg = await createKnowledgeGraph();
  try {
    const facts = await kg.queryEntity(entity, as_of || undefined, direction || 'both');
    res.json({ entity, facts });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'kg query failed' });
  } finally {
    await kg.close();
  }
});

// GET /api/kg/timeline?entity=&limit= — chronological facts (entity optional).
router.get('/timeline', async (req, res) => {
  const entity = typeof req.query.entity === 'string' ? req.query.entity : undefined;
  const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 100;
  const kg = await createKnowledgeGraph();
  try {
    const entries = await kg.timeline(entity, Number.isFinite(limit) ? limit : 100);
    res.json({ entity: entity ?? null, entries });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'kg timeline failed' });
  } finally {
    await kg.close();
  }
});

// GET /api/kg/stats — entity/triple/relationship counts.
router.get('/stats', async (_req, res) => {
  const kg = await createKnowledgeGraph();
  try {
    res.json(await kg.stats());
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'kg stats failed' });
  } finally {
    await kg.close();
  }
});

// POST /api/kg/add — { subject, predicate, object, valid_from?, valid_to?,
// confidence?, source_session? } → triple id. Upserts entities implicitly.
router.post('/add', async (req, res) => {
  const { subject, predicate, object, valid_from, valid_to, confidence, source_session } = req.body ?? {};
  if (!subject || !predicate || !object) {
    return res.status(400).json({ error: 'subject, predicate, and object are required' });
  }
  const kg = await createKnowledgeGraph();
  try {
    const id = await kg.addTriple(subject, predicate, object, {
      validFrom: valid_from || undefined,
      validTo: valid_to || undefined,
      confidence: typeof confidence === 'number' ? confidence : undefined,
      sourceSession: source_session || undefined,
    });
    res.json({ id });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'kg add failed' });
  } finally {
    await kg.close();
  }
});

// POST /api/kg/invalidate — { subject, predicate, object, ended? } → count.
router.post('/invalidate', async (req, res) => {
  const { subject, predicate, object, ended } = req.body ?? {};
  if (!subject || !predicate || !object) {
    return res.status(400).json({ error: 'subject, predicate, and object are required' });
  }
  const kg = await createKnowledgeGraph();
  try {
    const count = await kg.invalidate(subject, predicate, object, ended || undefined);
    res.json({ invalidated: count });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'kg invalidate failed' });
  } finally {
    await kg.close();
  }
});

export default router;
