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
import {
  getRetentionDays, setRetentionDays, parseRetentionDays, countOlderThan,
  MIN_RETENTION_DAYS, MAX_RETENTION_DAYS, RETENTION_WARNING,
} from '../services/retention.js';
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
    // COLLECT the whole matching set first, then delete it.
    //
    // The previous shape re-read page 0 and stopped as soon as that page held no
    // row for the project. listItems is paged and ordered by mtime DESC, so page
    // 0 is only the 200 NEWEST sessions: a tenant with more than 200 sessions
    // whose project was not among them got `200 {deleted: 0}` — a delete that
    // reported success and removed nothing, on the one endpoint where that is
    // least acceptable. Walking every page before touching anything also keeps
    // the read stable, instead of mutating the list being iterated.
    const PAGE = 200;
    const doomed: string[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await store.listItems('session', PAGE, offset);
      if (!page.length) break;
      for (const row of page) {
        if (row.project_id === project) doomed.push(row.id);
      }
      if (page.length < PAGE) break;
    }

    let deleted = 0;
    for (const id of doomed) {
      await store.purgeSession(id);
      await store.addTombstone(id);   // or the next sync restores it
      deleted++;
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
 * What has been deleted — the tombstone list.
 *
 * Restoring is impossible without this. A purged session leaves no row to find
 * it by: the metadata, chunks and archive are gone, and all that survives is an
 * id in `session_tombstones`. Without a way to READ that list, "undo my delete"
 * requires the user to already know the uuid of something they deleted, which
 * nobody does.
 */
router.get('/tombstones', async (req, res) => {
  const limit = Math.max(1, Math.min(parseInt(String(req.query.limit)) || 500, 5000));
  const store = await createStore();
  try {
    const all = await store.listTombstones();
    // Newest deletions first — the ones a person is most likely undoing.
    const sorted = [...all].sort((a, b) => b.deleted_at - a.deleted_at);
    res.json({ total: all.length, tombstones: sorted.slice(0, limit) });
  } catch (e) {
    log.error({ err: (e as Error).message }, 'tombstone list failed');
    res.status(500).json({ error: 'list failed' });
  } finally {
    await store.close();
  }
});

/**
 * Lift tombstones so a later sync may re-upload those sessions.
 *
 * This restores NOTHING on its own, and the response says so: the content is
 * gone from the server and comes back only if a device still holds the
 * transcript and re-ships it (`chat-recall index --force`). What this undoes is
 * the REFUSAL — the `deadSet` check in /api/sync that makes a deletion stick.
 *
 * It exists because bulk deletion does. One-at-a-time deletion is self-limiting;
 * a command that removes hundreds of sessions in a single call needs a way back,
 * or a mis-aimed selector is unrecoverable. Deliberately id-scoped: there is no
 * "restore everything", because that would re-open every deliberate deletion the
 * tenant ever made, including the ones made for privacy.
 */
router.post('/restore', express.json({ limit: '256kb' }), async (req, res) => {
  const raw = req.body?.session_ids;
  const ids = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && !!x.trim()) : [];
  if (ids.length === 0) return res.status(400).json({ error: 'session_ids (non-empty array) is required' });

  const store = await createStore();
  try {
    const known = new Set((await store.listTombstones()).map((t) => t.session_id));
    let restored = 0;
    const notDeleted: string[] = [];
    for (const id of ids) {
      if (!known.has(id)) { notDeleted.push(id); continue; }
      await store.removeTombstone(id);
      restored++;
    }
    log.warn({ restored, requested: ids.length }, 'user lifted tombstones');
    // `notDeleted` is not an error — it is the honest answer to "was this one
    // of mine?". Silently counting them as restored would report success for
    // ids that were never deleted here.
    res.json({
      restored,
      notDeleted,
      note: 'Tombstones lifted. Content returns only when a device still holding the transcript re-ships it — run `chat-recall index --force` there.',
    });
  } catch (e) {
    log.error({ err: (e as Error).message }, 'restore failed');
    res.status(500).json({ error: 'restore failed' });
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
/**
 * The tenant's retention window — read and set.
 *
 * Lives under /api/data with export and delete because it is the same category
 * of thing: a control over your own data that must not sit behind a plan. It is
 * also the only one of the three that PREVENTS accumulation rather than reacting
 * to it, which is what makes it worth having.
 *
 * 0 clears the window (keep everything) and is the default for every workspace,
 * so shipping this deletes nothing until somebody asks for it.
 */
router.get('/retention', async (req, res) => {
  const tenant = req.tenant;
  if (!tenant) return res.status(401).json({ error: 'no tenant' });
  try {
    const days = await getRetentionDays(tenant);
    // ?days=N previews a CANDIDATE window without arming it, so a UI can show
    // "this would delete 412 sessions" while the user is still deciding. Without
    // it the only way to learn the number is to set the window and find out.
    const candidate = parseRetentionDays(req.query.days);
    const previewDays = req.query.days !== undefined && candidate !== null ? candidate : days;
    res.json({
      days,
      previewDays,
      wouldDelete: await countOlderThan(tenant, previewDays),
      min: MIN_RETENTION_DAYS,
      max: MAX_RETENTION_DAYS,
      warning: RETENTION_WARNING,
    });
  } catch (e) {
    log.error({ err: (e as Error).message }, 'retention read failed');
    res.status(500).json({ error: 'could not read the retention window' });
  }
});

router.post('/retention', express.json({ limit: '1kb' }), async (req, res) => {
  const tenant = req.tenant;
  if (!tenant) return res.status(401).json({ error: 'no tenant' });
  const days = parseRetentionDays(req.body?.days);
  if (days === null) {
    return res.status(400).json({
      error: `days must be 0 (keep everything) or between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS}`,
    });
  }
  try {
    // A DESTRUCTIVE change needs an explicit acknowledgement, and only a
    // destructive one does.
    //
    // Destructive = this window would delete sessions we currently hold. Setting
    // 90 days on a workspace three weeks old deletes nothing, and demanding a
    // ceremony there trains people to click through the ceremony that matters.
    // Clearing the window (0) is never destructive.
    //
    // The refusal carries the COUNT and the warning, so a client that did not
    // preview still cannot arm this without being told what it costs.
    const wouldDelete = await countOlderThan(tenant, days);
    if (wouldDelete > 0 && req.body?.acknowledge !== true) {
      return res.status(409).json({
        error: 'acknowledgement required',
        wouldDelete,
        days,
        warning: RETENTION_WARNING,
        detail: `A ${days}-day window deletes ${wouldDelete} session(s) we currently hold. `
          + 'Re-send with { "acknowledge": true } to confirm.',
      });
    }

    await setRetentionDays(tenant, days);
    // WARN, not info: this is the one setting that starts deleting a customer's
    // data on a timer, so it belongs in the same log band as a manual delete.
    log.warn({ tenant, days, wouldDelete }, days > 0 ? 'retention window set' : 'retention window cleared');
    res.json({ days, wouldDelete, warning: days > 0 ? RETENTION_WARNING : undefined });
  } catch (e) {
    log.error({ err: (e as Error).message }, 'retention write failed');
    res.status(500).json({ error: 'could not set the retention window' });
  }
});

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
