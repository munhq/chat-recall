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
 *   PATCH  /api/tasks/:id {status?, assigneeSub?, title?, description?, due?, linkedSessionId?}
 *   POST   /api/tasks/:id/comments {body}
 */
import express from 'express';
import { createStore } from '../imports.js';
import { tenantFeatures } from '../util/billing.js';
import { featureRequired } from '../util/entitlements.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';
import { createControlPlane } from '../imports.js';
import { parsePolicy, autoTasksStatus, runAutoTasks, AUTO_TASKS_KEY } from '../services/auto-tasks.js';

const log = createLogger('tasks');
const router = express.Router();

// What a caller may SET. 'blocked' is absent on purpose: nothing has ever
// written it, and the board has no column for it since the reject work, so a
// card set to 'blocked' would simply disappear from the UI. The DB constraint
// still accepts it, because rows written before it was retired keep the value.
const STATUSES = new Set(['todo', 'in_progress', 'done', 'rejected']);

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

/**
 * The auto-tasks policy: whether urgent code findings file their own cards.
 * OPT-IN, stored per tenant, read by services/auto-tasks.ts after every code
 * index. Behind this router's 'tasks' mount, so the free plan cannot set it.
 *
 *   GET  /api/tasks/policy      → { enabled, maxPri, lastRun, eligible, filed, byProject }
 *                                 maxPri: 0 critical, 1 high, 2 medium, 3 low
 *   PUT  /api/tasks/policy {enabled, maxPri?}
 *   POST /api/tasks/policy/run  → run it NOW, returns { created, closed }
 *
 * GET returns the RUN STATE, not only the setting. The switch used to report
 * nothing back, so turning it on and turning it on-but-broken looked identical:
 * cards only ever appear on the next `chat-recall code index`, and nothing said
 * so. Now the panel can state what is waiting, per project, and what the last
 * run did.
 */
router.get('/policy', async (req, res) => {
  try {
    const st = await autoTasksStatus(req.tenant as string);
    res.json({ ...st.policy, lastRun: st.lastRun, eligible: st.eligible, filed: st.filed, byProject: st.byProject });
  } catch (e) {
    log.error({ err: e }, 'auto-tasks status failed');
    // Degrade to the bare setting rather than 500: the switch must stay usable
    // even when the findings tables cannot be read.
    const cp = await createControlPlane();
    try {
      const policy = parsePolicy(await cp.getTenantSetting(req.tenant as string, AUTO_TASKS_KEY));
      res.json({ ...policy, lastRun: null, eligible: 0, filed: 0, byProject: [] });
    } finally { await cp.close(); }
  }
});

/**
 * Run the policy now. This is the "Run now" button: without it, the only
 * producer is a code-index sync, so a person who just enabled the policy has no
 * way to see it work and no way to tell a working switch from a dead one.
 * Bypasses the 10-minute debounce; still refuses when the policy is off.
 */
router.post('/policy/run', async (req, res) => {
  const cp = await createControlPlane();
  let enabled = false;
  try {
    enabled = parsePolicy(await cp.getTenantSetting(req.tenant as string, AUTO_TASKS_KEY)).enabled;
  } finally { await cp.close(); }
  if (!enabled) return res.status(409).json({ error: 'auto-filing is off — turn it on first' });
  const r = await runAutoTasks(req.tenant as string, { force: true });
  if (!r) return res.status(500).json({ error: 'the run did not complete — see server logs' });
  res.json(r);
});

router.put('/policy', async (req, res) => {
  const enabled = req.body?.enabled === true;
  // 0 critical … 3 low, inclusive. Clamped rather than rejected: an out-of-range
  // number from an old client should degrade, not 400.
  const n = Math.floor(Number(req.body?.maxPri));
  const maxPri = Number.isFinite(n) ? Math.min(Math.max(n, 0), 3) : 1;
  const cp = await createControlPlane();
  try {
    await cp.setTenantSetting(req.tenant as string, AUTO_TASKS_KEY, JSON.stringify({ enabled, maxPri }));
    res.json({ enabled, maxPri });
  } finally { await cp.close(); }
});

router.get('/', async (req, res) => {
  const store = await createStore();
  try {
    const status = typeof req.query.status === 'string' && STATUSES.has(req.query.status) ? req.query.status as any : undefined;
    // `@me` resolves server-side to the caller — lets a client ask for "my
    // tasks" without knowing its own user id.
    let assignee = typeof req.query.assignee === 'string' && req.query.assignee ? req.query.assignee : undefined;
    if (assignee === '@me') assignee = actor(req);
    // Project scoping is a SUBSTRING match, applied here rather than in the
    // store's exact-equality filter.
    //
    // A caller passes a loose name — an agent knows it is "in chat-recall", not
    // "git:github.com/munhq/chat-recall" — while the stored id is fully
    // qualified. With exact equality `recall_tasks project:"chat-recall"`
    // returned nothing at all, on a board that had the cards, which is how the
    // whole MCP handover looked broken end to end. The wake-up
    // (routes/memory.ts scopeOpenTasks) and the board already matched this way;
    // this was the third copy of the rule and the only one still wrong.
    //
    // Unscoped cards stay visible for the same reason they do there: a card
    // with no project is not some other project's card.
    const project = typeof req.query.project === 'string' && req.query.project ? req.query.project.toLowerCase() : undefined;
    const all = await store.listTeamTasks({ assigneeSub: assignee, status });
    const tasks = project
      ? all.filter((t) => {
        const pid = (t.projectId || '').toLowerCase();
        return pid === '' || pid.includes(project);
      })
      : all;
    res.json({ tasks });
  } catch (e) { log.error({ err: e }, 'list tasks failed'); res.status(500).json({ error: e instanceof Error ? e.message : 'list failed' }); }
  finally { await store.close(); }
});

router.post('/', async (req, res) => {
  const title = (req.body?.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title required' });
  if (await refuseForeignAssignee(req, res, req.body?.assigneeSub)) return;
  const linkedFindingId = typeof req.body?.linkedFindingId === 'string' ? req.body.linkedFindingId : null;
  const store = await createStore();
  try {
    // A card that names the finding it came from can close itself when the
    // finding stops being reported, and can dismiss that finding when the user
    // rejects it. Without the link a card is inert: recall_improvements opened
    // one per ranked suggestion with no link at all, so none of them could ever
    // auto-close, and every call re-created the same cards from scratch.
    // Dedupe on the link for exactly that reason — one finding, one card.
    if (linkedFindingId) {
      const existing = await store.teamTasksByFindingIds([linkedFindingId]);
      if (existing.length > 0) return res.json({ task: existing[0], deduped: true });
    }
    const task = await store.createTeamTask({
      title: title.slice(0, 500),
      createdBy: actor(req),
      projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
      description: typeof req.body?.description === 'string' ? req.body.description.slice(0, 20000) : undefined,
      assigneeSub: req.body?.assigneeSub ?? null,
      due: typeof req.body?.due === 'number' ? req.body.due : null,
      linkedSessionId: typeof req.body?.linkedSessionId === 'string' ? req.body.linkedSessionId : null,
      linkedFindingId,
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
    // DONE MUST BE EARNED.
    //
    // A card says a problem exists in the code. Moving it to done asserts that
    // the code changed, so it needs something that can be checked: a session to
    // attach it to. The agent that does the work passes its own session id and
    // the board can then show the files, lines and commits behind the claim.
    // A person dragging a card across a column proves nothing, and the board
    // already carries 93 "done" cards that nobody ever worked.
    //
    // If you disagree with a card, REJECT it — that is the human verdict, and it
    // stops the finding coming back (below).
    if (req.body.status === 'done') {
      const existing = await (async () => {
        const store = await createStore();
        try { return await store.getTeamTask(req.params.id); } finally { await store.close(); }
      })();
      const willHaveSession = req.body?.linkedSessionId ?? existing?.task.linkedSessionId ?? null;
      if (!willHaveSession) {
        return res.status(409).json({
          error: 'a task is marked done by the work, not by hand',
          detail: 'Attach the session that did the work (linkedSessionId) and set done from there, '
            + 'or reject the task if it should not be worked at all. Auto-filed cards also close '
            + 'themselves once a re-index stops reporting their finding.',
          reject: `PATCH /api/tasks/${req.params.id} {"status":"rejected"}`,
        });
      }
    }
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
  // blocks / blockedBy are NOT accepted. They were persisted and rendered as a
  // "blocked by N" chip, and nothing in the product has ever written them — not
  // the client (its updateTask signature has no such field), not the MCP, not
  // the auto-filer. Both columns are permanently '[]', so the chip could never
  // render. Accepting a write for a feature that does not exist invites a
  // caller to depend on it. The columns stay in the schema for old rows.
  const store = await createStore();
  try {
    const task = await store.updateTeamTask(req.params.id, patch);

    // A rejection has to reach the FINDING, not just the card. The auto-filer
    // materialises every 'suggested' action above the floor, so a card rejected
    // here and nowhere else is simply filed again on the next code index — the
    // user says "no" and the board says it anyway. Dismissing the action is what
    // makes "no" stick: listCodeActions({status:'suggested'}) stops returning it.
    if (patch.status === 'rejected' && task?.linkedFindingId) {
      try {
        await store.setCodeActionStatus(task.linkedFindingId, 'dismissed');
      } catch (e) {
        // The card is already rejected; failing to dismiss the finding means it
        // may re-file, which is worth a log and not worth failing the request.
        log.warn({ err: e, id: task.linkedFindingId }, 'rejected card: could not dismiss the finding');
      }
    }
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
