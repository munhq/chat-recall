/**
 * Key-value routes — server-side surface for the MCP `recall_set` / `recall_get`
 * / `recall_kv_list` tools. Backed by the tenant-scoped store's kv* methods
 * (`createStore()` resolves the ambient tenant via `tenantAuth` →
 * `runWithTenant`). Scope namespaces keys so per-project state doesn't collide.
 */

import express from 'express';
import { createStore } from '../imports.js';

const router = express.Router();

// POST /api/kv/set — { scope, key, value }
router.post('/set', async (req, res) => {
  const { scope, key, value } = req.body ?? {};
  if (!scope || !key || typeof value !== 'string') {
    return res.status(400).json({ error: 'scope, key, and value (string) are required' });
  }
  const store = await createStore();
  try {
    await store.kvSet(scope, key, value);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'kv set failed' });
  } finally {
    await store.close();
  }
});

// GET /api/kv/get?scope=&key=
router.get('/get', async (req, res) => {
  const scope = typeof req.query.scope === 'string' ? req.query.scope : '';
  const key = typeof req.query.key === 'string' ? req.query.key : '';
  if (!scope || !key) return res.status(400).json({ error: 'scope and key are required' });
  const store = await createStore();
  try {
    res.json({ scope, key, entry: await store.kvGet(scope, key) });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'kv get failed' });
  } finally {
    await store.close();
  }
});

// GET /api/kv/list?scope=&limit=
router.get('/list', async (req, res) => {
  const scope = typeof req.query.scope === 'string' ? req.query.scope : undefined;
  const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 200;
  const store = await createStore();
  try {
    res.json({ entries: await store.kvList(scope, Number.isFinite(limit) ? limit : 200) });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'kv list failed' });
  } finally {
    await store.close();
  }
});

export default router;
