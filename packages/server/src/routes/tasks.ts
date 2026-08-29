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
 *   PATCH  /api/tasks/:id {status?, assigneeSub?, title?, description?, due?,
 *                           linkedSessionId?, closedReason?}
 *     status 'done'   → needs the session that did the work AND the change:
 *                       doneEvidence.diff (the unified diff) and/or .commits
 *     status 'closed' → needs closedReason (shut without the work being done)
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
const STATUSES = new Set(['todo', 'in_progress', 'done', 'rejected', 'closed']);

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
 *   GET  /api/tasks/policy      → { enabled, maxPri, lastRun, eligible, filed,
 *                                 openCards, ceiling, byProject }
 *                                 maxPri: 0 critical, 1 high, 2 medium, 3 low
 *   PUT  /api/tasks/policy {enabled, maxPri?, ceiling?, maxPerRun?, categories?,
 *                            excludedProjects?}
 *   POST /api/tasks/policy/run  → run it NOW, returns
 *                                 { created, closed, repointed, backfilled, reopened }
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
    res.json({
      ...st.policy, lastRun: st.lastRun, eligible: st.eligible, filed: st.filed,
      openCards: st.openCards, ceiling: st.ceiling, byProject: st.byProject,
      availableCategories: st.availableCategories,
    });
  } catch (e) {
    log.error({ err: e }, 'auto-tasks status failed');
    // Degrade to the bare setting rather than 500: the switch must stay usable
    // even when the findings tables cannot be read.
    const cp = await createControlPlane();
    try {
      const policy = parsePolicy(await cp.getTenantSetting(req.tenant as string, AUTO_TASKS_KEY));
      // The COUNTS are unknown here, not zero — but the POLICY is known, and
      // `ceiling: 0` was a lie a client could write straight back: read, change
      // one field, PUT, and the board's ceiling silently became 1 (the clamp
      // floor) because the read had reported zero.
      res.json({
        ...policy, lastRun: null, eligible: 0, filed: 0, openCards: 0,
        byProject: [], availableCategories: [], degraded: true,
      });
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
    // The knobs that decide what gets filed were a constant and a UI-only
    // select. Whoever owns the board decides how big it may get, how fast it
    // fills and which categories are worth carding — from either surface.
    const current = parsePolicy(await cp.getTenantSetting(req.tenant as string, AUTO_TASKS_KEY));
    const next = {
      enabled,
      maxPri,
      ceiling: req.body?.ceiling === undefined ? current.ceiling : req.body.ceiling,
      maxPerRun: req.body?.maxPerRun === undefined ? current.maxPerRun : req.body.maxPerRun,
      categories: req.body?.categories === undefined ? current.categories : req.body.categories,
      excludedProjects: req.body?.excludedProjects === undefined
        ? current.excludedProjects : req.body.excludedProjects,
    };
    // Round-trip through the parser so the same clamping applies to every writer.
    const saved = parsePolicy(JSON.stringify(next));
    await cp.setTenantSetting(req.tenant as string, AUTO_TASKS_KEY, JSON.stringify(saved));
    res.json(saved);
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
    // Read the card once: every ending below asks what it already carries, and
    // three separate lookups would be three round trips for one decision.
    // Best-effort: this read only ever RELAXES a check (it is what lets a card
    // that already carries a session or a reason be re-set without repeating
    // them). If it fails, the strict path still applies, so a broken read cannot
    // let an unevidenced close through — and cannot 500 a legal patch either.
    const existingTask = await (async () => {
      try {
        const store = await createStore();
        try { return (await store.getTeamTask(req.params.id))?.task ?? null; } finally { await store.close(); }
      } catch { return null; }
    })();
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
      const willHaveSession = req.body?.linkedSessionId ?? existingTask?.linkedSessionId ?? null;
      if (!willHaveSession) {
        return res.status(409).json({
          error: 'a task is marked done by the work, not by hand',
          detail: 'Attach the session that did the work (linkedSessionId) and set done from there, '
            + 'or reject the task if it should not be worked at all. Auto-filed cards also close '
            + 'themselves once a re-index stops reporting their finding.',
          reject: `PATCH /api/tasks/${req.params.id} {"status":"rejected"}`,
        });
      }
      // AND SHOW WHAT CHANGED.
      //
      // The session link alone proved the wrong thing. A card closed with a real
      // session attached rendered "74 commits" belonging to a DIFFERENT
      // repository: the session's entire footprint, unscoped. Right session,
      // wrong evidence, and nothing on the card said which was which.
      //
      // The DIFF is the evidence, and the closer is the only party that always
      // has it: a session's Edit/Write records miss every shell-driven edit, and
      // the commit scan only searches repositories a session tool-touched. Both
      // came back empty on the first real card worked this way. Commits are
      // welcome — they make the claim checkable — but they are not the change.
      const ev = req.body?.doneEvidence;
      // A sha SHAPE, not free text. The point of naming commits is that a reader
      // can open them; "fixed it" in the commits array would defeat that while
      // still passing the check.
      const isSha = (c: string) => /^[0-9a-f]{7,40}$/i.test(c);
      // Blank entries are NOTHING OFFERED, not something malformed: they fall
      // through to the "needs commits" refusal below, which says what to do.
      const offered: string[] = Array.isArray(ev?.commits)
        ? ev.commits.filter((c: unknown): c is string => typeof c === 'string')
            .map((c: string) => c.trim()).filter(Boolean)
        : [];
      const commits = offered.filter(isSha);
      if (offered.length && !commits.length) {
        return res.status(400).json({
          error: 'those do not look like commit shas',
          detail: `Expected hex sha(s), 7-40 characters. Got: ${offered.slice(0, 3).join(', ')}. `
            + 'If the change is not committed, send doneEvidence.diff instead.',
        });
      }
      const diff = typeof ev?.diff === 'string' ? ev.diff.trim() : '';
      const prev = existingTask?.doneEvidence;
      const hadEvidence = (prev?.commits?.length ?? 0) > 0 || !!prev?.diff;
      if (!commits.length && !diff && !hadEvidence) {
        return res.status(409).json({
          error: 'closing a task needs the change that fixed it',
          detail: 'Pass doneEvidence.diff — the unified diff of what you changed for THIS card — '
            + 'and doneEvidence.commits if you committed it. You are the only one who knows: a '
            + 'session\'s edit history misses shell-driven edits, and the commit scan only sees '
            + 'repositories the session tool-touched. If the card no longer applies use status '
            + '"closed" with a reason; if it was never a real problem, reject it.',
          example: `PATCH /api/tasks/${req.params.id} {"status":"done","linkedSessionId":"…","doneEvidence":{"diff":"--- a/x\n+++ b/x\n@@ …","commits":["a1b2c3d"]}}`,
        });
      }
      if (commits.length || diff) {
        patch.doneEvidence = {
          // A patch, not a repository. 200 KB is far past any single card's
          // change and far short of a row nobody can read back.
          diff: diff ? diff.slice(0, 200_000) : prev?.diff,
          commits: commits.length ? commits.slice(0, 50) : prev?.commits,
          files: Array.isArray(ev?.files)
            ? ev.files.filter((f: unknown): f is string => typeof f === 'string').slice(0, 100)
            : prev?.files,
          summary: typeof ev?.summary === 'string' ? ev.summary.slice(0, 2000) : prev?.summary,
        };
      }
    }
    // CLAIMING NEEDS A CLAIMANT. `in_progress` asserted that work was under way
    // and required nothing at all, so a card could sit "in progress" for days
    // with nothing behind it and no way to ask what was happening. The session id
    // is the answer to "by what?", and it is what lets the card show the changes
    // as they land rather than only after the commit.
    if (req.body.status === 'in_progress') {
      const willHaveSession = req.body?.linkedSessionId ?? existingTask?.linkedSessionId ?? null;
      if (!willHaveSession) {
        return res.status(409).json({
          error: 'claiming a task needs the session doing the work',
          detail: 'Pass linkedSessionId — your own session id. The board shows that session\'s '
            + 'changes on the card while the work is happening, which is the point of claiming it.',
        });
      }
    }
    // REJECTING NEEDS A REASON TOO. It was enforced in the dashboard and nowhere
    // else, so any other client could retire advice silently — and a rejection
    // also stops the finding being re-filed, which makes it the most consequential
    // of the three endings.
    if (req.body.status === 'rejected') {
      const reason = typeof req.body.closedReason === 'string' ? req.body.closedReason.trim() : '';
      const had = (existingTask?.closedReason ?? '').trim();
      if (!reason && !had) {
        return res.status(400).json({
          error: 'rejecting a task needs a reason',
          detail: 'Say why this is not a real problem (closedReason). It also stops the finding '
            + 'being filed again, so the reason is what makes that reviewable later.',
        });
      }
      if (reason) patch.closedReason = reason.slice(0, 2000);
    }
    // CLOSED NEEDS A REASON, for the same reason `done` needs a session: a card
    // shut without the work being done has to say why, or in six weeks it is
    // indistinguishable from a card someone tidied away. The machine paths that
    // write this always supply one; a person or an agent must too.
    if (req.body.status === 'closed') {
      const reason = typeof req.body.closedReason === 'string' ? req.body.closedReason.trim() : '';
      if (!reason) {
        return res.status(400).json({
          error: 'closing a task needs a reason',
          detail: 'Say why the card no longer applies (closedReason). Use "done" with the session '
            + 'that did the work if it was actually fixed, or "rejected" if it was never a real problem.',
        });
      }
      patch.closedReason = reason.slice(0, 2000);
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
