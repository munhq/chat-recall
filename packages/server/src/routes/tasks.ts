/**
 * /api/tasks — collaborative team tasks.
 *
 * Server-authoritative task board. Mounted AFTER tenantAuth, so req.tenant is
 * the team and every row is RLS-walled to it. Tasks are team-visible within the
 * tenant (they ARE the collaboration surface) — independent of the per-project
 * content boundary, so you can coordinate a task on a project whose transcripts
 * aren't shared.
 *
 *   GET    /api/tasks?project=&assignee=&status=   → list
 *   POST   /api/tasks {title, description?, projectId?, assigneeSub?, due?, linkedSessionId?}
 *   GET    /api/tasks/:id                          → { task, comments }
 *   PATCH  /api/tasks/:id {status?, assigneeSub?, title?, description?, due?, blocks?, blockedBy?, linkedSessionId?}
 *   POST   /api/tasks/:id/comments {body}
 */
import express from 'express';
import { createStore } from '../imports.js';
import { tenantFeatures } from '../util/billing.js';
import { featureRequired } from '../util/entitlements.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';

const log = createLogger('tasks');
const router = express.Router();

const STATUSES = new Set(['todo', 'in_progress', 'blocked', 'done']);

/**
 * Assigning work to SOMEONE ELSE is the collaboration boundary — the mount is
 * only 'tasks', so a Solo tenant reaches this router and must be stopped here
 * rather than at the door.
 *
 * Assigning to yourself is not collaboration and stays free of the gate: a
 * one-person board where you cannot put your own name on a card would be a
 * strange thing to ship.
 */
async function refuseForeignAssignee(
  req: express.Request, res: express.Response, assignee: unknown,
): Promise<boolean> {
  if (typeof assignee !== 'string' || !assignee) return false;
  if (assignee === actor(req)) return false;           // your own name: always fine
  const features = await tenantFeatures(req.tenant as string);
  if (features.includes('team')) return false;
  res.status(402).json(featureRequired('team'));
  return true;
}
/** The actor for created_by / comment author: the real user sub, else the userId. */
function actor(req: express.Request): string { return (req.authorSub || req.userId || 'unknown') as string; }

router.get('/', async (req, res) => {
  const store = await createStore();
  try {
    const status = typeof req.query.status === 'string' && STATUSES.has(req.query.status) ? req.query.status as any : undefined;
    // `@me` resolves server-side to the caller — lets a client ask for "my
    // tasks" without knowing its own user id.
    let assignee = typeof req.query.assignee === 'string' && req.query.assignee ? req.query.assignee : undefined;
    if (assignee === '@me') assignee = actor(req);
    const tasks = await store.listTeamTasks({
      projectId: typeof req.query.project === 'string' && req.query.project ? req.query.project : undefined,
      assigneeSub: assignee,
      status,
    });
    res.json({ tasks });
  } catch (e) { log.error({ err: e }, 'list tasks failed'); res.status(500).json({ error: e instanceof Error ? e.message : 'list failed' }); }
  finally { await store.close(); }
});

router.post('/', async (req, res) => {
  const title = (req.body?.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title required' });
  if (await refuseForeignAssignee(req, res, req.body?.assigneeSub)) return;
  const store = await createStore();
  try {
    const task = await store.createTeamTask({
      title: title.slice(0, 500),
      createdBy: actor(req),
      projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
      description: typeof req.body?.description === 'string' ? req.body.description.slice(0, 20000) : undefined,
      assigneeSub: req.body?.assigneeSub ?? null,
      due: typeof req.body?.due === 'number' ? req.body.due : null,
      linkedSessionId: typeof req.body?.linkedSessionId === 'string' ? req.body.linkedSessionId : null,
    });
    res.json({ task });
  } catch (e) { log.error({ err: e }, 'create task failed'); res.status(500).json({ error: e instanceof Error ? e.message : 'create failed' }); }
  finally { await store.close(); }
});

router.get('/:id', async (req, res) => {
  const store = await createStore();
  try {
    const found = await store.getTeamTask(req.params.id);
    if (!found) return res.status(404).json({ error: 'not found' });
    res.json(found);
  } catch (e) { log.error({ err: e }, 'get task failed'); res.status(500).json({ error: e instanceof Error ? e.message : 'get failed' }); }
  finally { await store.close(); }
});

router.patch('/:id', async (req, res) => {
  const patch: Record<string, unknown> = {};
  if (typeof req.body?.title === 'string') patch.title = req.body.title.slice(0, 500);
  if (typeof req.body?.description === 'string') patch.description = req.body.description.slice(0, 20000);
  if (typeof req.body?.status === 'string') {
    if (!STATUSES.has(req.body.status)) return res.status(400).json({ error: `status must be one of ${[...STATUSES].join(', ')}` });
    patch.status = req.body.status;
  }
  if (req.body?.assigneeSub !== undefined) {
    // Re-checked on update, not just on create: otherwise a Solo tenant creates
    // an unassigned card and then PATCHes a teammate onto it.
    if (await refuseForeignAssignee(req, res, req.body.assigneeSub)) return;
    patch.assigneeSub = req.body.assigneeSub;
  }
  if (req.body?.due !== undefined) patch.due = typeof req.body.due === 'number' ? req.body.due : null;
  // Same validation as the POST path: a string links, anything else clears.
  // This is what lets an agent attach the session that did the work to a card
  // that existed before the work started — the shipped badge needs the link.
  if (req.body?.linkedSessionId !== undefined) {
    patch.linkedSessionId = typeof req.body.linkedSessionId === 'string' ? req.body.linkedSessionId : null;
  }
  if (Array.isArray(req.body?.blocks)) patch.blocks = req.body.blocks.map(String);
  if (Array.isArray(req.body?.blockedBy)) patch.blockedBy = req.body.blockedBy.map(String);
  const store = await createStore();
  try {
    const task = await store.updateTeamTask(req.params.id, patch);
    if (!task) return res.status(404).json({ error: 'not found' });
    res.json({ task });
  } catch (e) { log.error({ err: e }, 'update task failed'); res.status(500).json({ error: e instanceof Error ? e.message : 'update failed' }); }
  finally { await store.close(); }
});

router.post('/:id/comments', async (req, res) => {
  const body = (req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'body required' });
  const store = await createStore();
  try {
    const comment = await store.addTeamTaskComment(req.params.id, actor(req), body.slice(0, 20000));
    if (!comment) return res.status(404).json({ error: 'task not found' });
    res.json({ comment });
  } catch (e) { log.error({ err: e }, 'comment failed'); res.status(500).json({ error: e instanceof Error ? e.message : 'comment failed' }); }
  finally { await store.close(); }
});

export default router;
