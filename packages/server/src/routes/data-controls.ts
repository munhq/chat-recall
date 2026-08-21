/**
 * /api/data — the user's own delete and export controls.
 *
 * Everything here is a thing a customer is entitled to do with their own data,
 * and none of it existed. Deletion was one session at a time (DELETE
 * /api/conversations/:id), so clearing a project meant N calls, and there was no
 * way at all to remove everything or take a copy out. `deleteTenant` exists in
 * the control plane but is described there as an admin surface for purging test
 * tenants — not something a customer can reach.
 *
 * That gap matters more now that lapsed tenants get purged on a timer: the two
 * things a person must be able to do before that happens are take their history
 * with them and delete it themselves.
 *
 * Deliberate shape:
 *
 *   GET    /api/data/export?project=      NDJSON, streamed
 *   POST   /api/data/delete { project }   everything under one project
 *   POST   /api/data/delete-all { confirm } everything, with a typed confirmation
 *
 * Deletes are POST rather than DELETE so they carry a body: a confirmation
 * phrase, and a scope that a URL would have to encode. Every delete writes a
 * tombstone, so the next CLI sync does not helpfully restore what was just
 * removed — without that, "delete" means "delete until the daemon notices".
 */
import express from 'express';
import { createStore } from '../imports.js';
import { noteStorageWiped } from '../util/billing.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';

const log = createLogger('data-controls');
const router = express.Router();

/** Typed by the user, exactly, before anything is destroyed. */
const DELETE_ALL_PHRASE = 'delete everything';

/**
 * Stream the caller's sessions as NDJSON — one JSON object per line.
 *
 * NDJSON rather than one big array because a large history should not have to
 * fit in memory at either end, and a truncated download is still parseable up to
 * the last complete line. Chunked as it goes for the same reason.
 */
router.get('/export', async (req, res) => {
  const project = typeof req.query.project === 'string' && req.query.project ? req.query.project : null;
  const store = await createStore();
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="chat-recall-export-${stamp}.ndjson"`);
  let written = 0;
  try {
    const PAGE = 200;
    let offset = 0;
    for (;;) {
      const page = await store.listItems('session', PAGE, offset);
      if (!page.length) break;
      for (const row of page) {
        if (project && row.project_id !== project) continue;
        res.write(JSON.stringify(row) + '\n');
        written++;
      }
      if (page.length < PAGE) break;
      offset += page.length;
    }
    res.end();
    log.info({ written, project }, 'data export');
  } catch (e) {
    // Headers are already sent, so an error cannot become a JSON 500. End the
    // stream with a marker line instead: a partial export that SAYS it is
    // partial is recoverable, and a silent truncation is not.
    log.error({ err: (e as Error).message, written }, 'export failed mid-stream');
    res.write(JSON.stringify({ _error: 'export truncated', written }) + '\n');
    res.end();
  } finally {
    await store.close();
  }
});

/** Sessions belonging to one project, deleted with tombstones. */
router.post('/delete', express.json({ limit: '4kb' }), async (req, res) => {
  const project = typeof req.body?.project === 'string' ? req.body.project.trim() : '';
  if (!project) return res.status(400).json({ error: 'project is required' });

  const store = await createStore();
  try {
    let deleted = 0;
    // Re-read page 0 each time: a purge removes the row from the listing, so the
    // remainder slides up to the same offset. The guard is there because a purge
    // that ever failed to remove its metadata row would otherwise spin.
    let guard = 500;
    for (;;) {
      if (guard-- <= 0) break;
      const page = await store.listItems('session', 200, 0);
      const mine = page.filter((r) => r.project_id === project);
      if (!mine.length) break;
      for (const row of mine) {
        await store.purgeSession(row.id);
        await store.addTombstone(row.id);   // or the next sync restores it
        deleted++;
      }
    }
    log.warn({ project, deleted }, 'user deleted a project');
    res.json({ deleted, project });
  } catch (e) {
    log.error({ err: (e as Error).message }, 'project delete failed');
    res.status(500).json({ error: 'delete failed' });
  } finally {
    await store.close();
  }
});

/**
 * Everything. Requires the confirmation phrase typed exactly.
 *
 * A checkbox is not enough for an action with no undo, and a phrase the UI cannot
 * pre-fill is the difference between a decision and a misclick.
 */
router.post('/delete-all', express.json({ limit: '4kb' }), async (req, res) => {
  const confirm = typeof req.body?.confirm === 'string' ? req.body.confirm.trim().toLowerCase() : '';
  if (confirm !== DELETE_ALL_PHRASE) {
    return res.status(400).json({
      error: 'confirmation required',
      detail: `Send { "confirm": "${DELETE_ALL_PHRASE}" } to delete everything. This cannot be undone.`,
    });
  }

  const store = await createStore();
  try {
    let deleted = 0;
    let guard = 5000;
    for (;;) {
      if (guard-- <= 0) break;
      const page = await store.listItems('session', 200, 0);
      if (!page.length) break;
      for (const row of page) {
        await store.purgeSession(row.id);
        await store.addTombstone(row.id);
        deleted++;
      }
    }
    // The STORAGE meter measures reality, so the wipe corrects it by itself —
    // this only busts the 10-minute cache, or an empty account keeps being
    // refused for bytes that no longer exist until the TTL rolls. The monthly
    // QUOTA is deliberately untouched: it meters traffic, and wipe + re-sync
    // must not be an infinite month.
    if (req.tenant) noteStorageWiped(req.tenant);
    log.warn({ deleted }, 'user deleted ALL their data');
    res.json({ deleted });
  } catch (e) {
    log.error({ err: (e as Error).message }, 'delete-all failed');
    res.status(500).json({ error: 'delete failed' });
  } finally {
    await store.close();
  }
});

export default router;
