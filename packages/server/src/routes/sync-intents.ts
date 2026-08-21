/**
 * Cross-tool sync intents — the Model-B queue surface.
 *
 * The web UI (on any server, including the hosted SaaS) can't touch the user's
 * local `~/.claude` / `~/.config/opencode` dirs, so it never copies directly.
 * Instead it POSTs an **intent** here ("copy skill foo: claude→opencode", or
 * "sync_all"). The local CLI agent — which runs on the user's machine and is
 * already authenticated with its device token — drains pending intents, does
 * the actual filesystem copy via the engine executor, and acks status back.
 *
 * Tenant-scoped automatically (createStore resolves the ambient tenant). The
 * originating identity is req.userId (e.g. `device:<id>` for agent tokens).
 */

import express from 'express';
import { createStore } from '../imports.js';
import type { SyncIntentInput } from '../imports.js';
import { ALL_SYNC_TYPES } from '@chat-recall/engine/core/toolkit-sync.js';
import { requireFeature } from '../util/billing.js';

const router = express.Router();

// Derive the accepted artifact types from the engine's canonical list rather
// than hardcoding — a hardcoded {skill,mcp,command,agent} silently 400'd every
// `instructions` (Rules/MD) copy intent after that type was added to the client
// + engine but not here. Single source of truth = no drift.
const VALID_TYPES = new Set<string>(ALL_SYNC_TYPES);
const VALID_TOOLS = new Set(['claude', 'agy', 'gemini', 'opencode', 'codex']);

/** Agent tokens resolve to userId `device:<id>`; pull the bare device id out. */
function deviceIdFromUserId(userId?: string): string | null {
  if (userId && userId.startsWith('device:')) return userId.slice('device:'.length);
  return null;
}

// POST /api/sync-intents — enqueue. Body:
//   { kind: 'sync_all' }
//   { kind: 'copy', artifactType, name, fromTool, toTool, deviceId? }
//
// ENQUEUE is 'toolkit': both kinds execute the cross-tool toolkit sync, which
// the free plan excludes. The gate sits on this route, not the mount — the
// drain (/pending) and ack below must keep working for a lapsed tenant whose
// CLI still holds intents enqueued while they were entitled. Before this gate,
// the only thing stopping a lapsed tenant was requireEntitlement's blanket
// write-402, which the free tier removed.
router.post('/', requireFeature('toolkit'), express.json(), async (req, res) => {
  const b = req.body ?? {};
  const kind = b.kind;
  if (kind !== 'copy' && kind !== 'sync_all') {
    return res.status(400).json({ error: "kind must be 'copy' or 'sync_all'" });
  }
  const input: SyncIntentInput = { kind, createdBy: req.userId ?? null, deviceId: b.deviceId ?? null };

  if (kind === 'copy') {
    if (!VALID_TYPES.has(b.artifactType)) return res.status(400).json({ error: `artifactType must be one of ${[...VALID_TYPES].join(', ')}` });
    if (typeof b.name !== 'string' || !b.name) return res.status(400).json({ error: 'name required' });
    if (!VALID_TOOLS.has(b.fromTool) || !VALID_TOOLS.has(b.toTool)) return res.status(400).json({ error: 'fromTool/toTool must be valid tools' });
    if (b.fromTool === b.toTool) return res.status(400).json({ error: 'fromTool and toTool are the same' });
    input.artifactType = b.artifactType;
    input.name = b.name;
    input.fromTool = b.fromTool;
    input.toTool = b.toTool;
  }

  const store = await createStore();
  try {
    const id = await store.enqueueSyncIntent(input);
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'enqueue failed' });
  } finally {
    await store.close();
  }
});

// GET /api/sync-intents/pending?deviceId=&limit=  — drained by the local agent.
// deviceId defaults to the caller's own device (from its token).
router.get('/pending', async (req, res) => {
  const deviceId = (typeof req.query.deviceId === 'string' && req.query.deviceId)
    ? req.query.deviceId
    : deviceIdFromUserId(req.userId);
  const limit = req.query.limit ? Math.min(parseInt(String(req.query.limit), 10) || 50, 500) : 50;
  const store = await createStore();
  try {
    const { cliRelease } = await import('../util/cli-release.js');
    res.json({ intents: await store.listPendingSyncIntents(deviceId, limit), cli: cliRelease() });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'list failed' });
  } finally {
    await store.close();
  }
});

// POST /api/sync-intents/:id/ack — { status: 'done'|'error', result?: string }
router.post('/:id/ack', express.json(), async (req, res) => {
  const { id } = req.params;
  const status = req.body?.status;
  if (status !== 'done' && status !== 'error') return res.status(400).json({ error: "status must be 'done' or 'error'" });
  const result = typeof req.body?.result === 'string' ? req.body.result : null;
  const store = await createStore();
  try {
    const ok = await store.ackSyncIntent(id, status, result);
    if (!ok) return res.status(404).json({ error: 'intent not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'ack failed' });
  } finally {
    await store.close();
  }
});

// GET /api/sync-intents?limit=  — recent intents for the UI to show progress.
router.get('/', async (req, res) => {
  const limit = req.query.limit ? Math.min(parseInt(String(req.query.limit), 10) || 50, 500) : 50;
  const store = await createStore();
  try {
    res.json({ intents: await store.listSyncIntents(limit) });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'list failed' });
  } finally {
    await store.close();
  }
});

export default router;
