/**
 * Auto-tasks — findings file their own cards, agents close them with proof.
 *
 * The loop this completes: the code indexer writes actions with DETERMINISTIC
 * ids (hash of project|category|title|loc, stable across re-index), this
 * service materializes the urgent ones onto the shared board, an agent picks a
 * card up (linking its session, so the shipped-badge can verify the fix), and
 * when a re-index no longer reports the action, the card closes itself.
 *
 * Deliberate boundaries:
 *   - OPT-IN per tenant. The board is team-visible and has no delete; nothing
 *     writes to it unless the tenant turned the policy on. Stored in
 *     tenant_settings under AUTO_TASKS_KEY.
 *   - CODE ACTIONS ONLY. They are the one findings source with stable ids
 *     (dedup and auto-close are impossible without identity). Live secrets
 *     already page through the alert webhook — a second card would double-alert.
 *   - Priority floor, not everything: pri 0 ≈ critical, pri 1 ≈ high. The rest
 *     stay in the ranked view (recall_improvements) for a human to promote.
 *   - Gated on the 'tasks' feature via the caller (the routes that invoke this
 *     are behind requireFeature('tasks') mounts or check the plan themselves);
 *     the run also re-checks, because a policy left on by a lapsed tenant must
 *     not keep writing to a board their plan no longer includes.
 */
import { createStore, createControlPlane, runWithTenant, runWithAuthor, runUnrestricted } from '../imports.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';
import { allows } from '../util/entitlements.js';
import { effectivePlan, billingEnabled } from '../util/billing.js';

const log = createLogger('auto-tasks');

export const AUTO_TASKS_KEY = 'auto_tasks';
/** Two runs per tenant closer together than this are one run. */
const MIN_INTERVAL_MS = 10 * 60 * 1000;
const LAST_RUN_KEY = 'auto_tasks_last_run';
/** The outcome of the most recent run, so the UI can state what the policy
 *  actually DID instead of only what it is set to. A switch with no readback is
 *  indistinguishable from a switch that does nothing — which is exactly how this
 *  looked to the first person who ticked it. */
const LAST_RESULT_KEY = 'auto_tasks_last_result';
/** One run never files more than this many new cards — a first index of a
 *  messy repo must not bury the board. The rest surface on later runs. */
const MAX_NEW_CARDS_PER_RUN = 10;

export interface AutoTasksPolicy {
  enabled: boolean;
  /** Highest pri value that materializes: 0 = critical only, 1 = critical+high. */
  maxPri: 0 | 1;
}

export function parsePolicy(raw: string | null): AutoTasksPolicy {
  // Fail to DISABLED on anything unreadable: a corrupt setting must not start
  // writing to the board.
  try {
    const o = JSON.parse(raw ?? '');
    return {
      enabled: o?.enabled === true,
      maxPri: o?.maxPri === 0 ? 0 : 1,
    };
  } catch {
    return { enabled: false, maxPri: 1 };
  }
}

/**
 * Materialize + close, for one tenant. Fire-and-forget from ingest paths:
 * errors are logged, never thrown — a board hiccup must not fail a sync.
 */
export async function runAutoTasks(
  tenant: string,
  opts: { force?: boolean } = {},
): Promise<{ created: number; closed: number } | null> {
  try {
    return await run(tenant, opts.force === true);
  } catch (err) {
    log.warn({ tenant, err: err instanceof Error ? err.message : String(err) }, 'auto-tasks run failed');
    return null;
  }
}

async function run(tenant: string, force = false): Promise<{ created: number; closed: number } | null> {
  const cp = await createControlPlane();
  let policy: AutoTasksPolicy;
  try {
    policy = parsePolicy(await cp.getTenantSetting(tenant, AUTO_TASKS_KEY));
    if (!policy.enabled) return null;
    // The plan gate, re-checked here: a lapsed tenant's stale policy must not
    // keep writing to a board the free plan does not include.
    if (billingEnabled() && !allows(await effectivePlan(tenant), 'tasks')) return null;
    // Debounce. Best-effort (two pods can race past it) — createTeamTask dedup
    // below is what actually prevents duplicates; this only bounds the cost.
    // `force` is the "Run now" button: a person who just turned the policy on
    // must not be told to wait ten minutes to see whether it works.
    const last = Number(await cp.getTenantSetting(tenant, LAST_RUN_KEY));
    if (!force && Number.isFinite(last) && Date.now() - last < MIN_INTERVAL_MS) return null;
    await cp.setTenantSetting(tenant, LAST_RUN_KEY, String(Date.now()));
  } finally {
    await cp.close();
  }

  return runWithTenant(tenant, async () => {
    const store = await createStore();
    try {
      // The READS run UNRESTRICTED, and that is load-bearing.
      //
      // 'auto-tasks' is not a real user. Passed as the author it becomes the RLS
      // viewer, and currentViewer()'s contract is explicit: a string viewer sees
      // "own + shared + legacy(NULL-author)" rows only. This service owns
      // nothing, so on the hosted service the read returned ZERO findings and
      // the whole feature filed nothing, ever -- while self-host looked perfect,
      // because there every row is NULL-author and matches.
      //
      // Reproduced on prod: the panel said "4 findings ready to file" (read as
      // the signed-in user) and Run now said "nothing qualified" (read as
      // auto-tasks) in the same session, against the same table.
      const { open, existing } = await runUnrestricted(async () => ({
        open: await store.listCodeActions(undefined, { status: 'suggested', limit: 500 }),
        existing: await store.teamTasksByFindingIds(),
      }));
      const urgent = open.filter((a) => a.pri <= policy.maxPri);
      const byFinding = new Map(existing.map((t) => [t.linkedFindingId as string, t]));

      let created = 0;
      let closed = 0;
      // WRITES keep the author stamp, so a card records who filed it.
      await runWithAuthor({ sub: 'auto-tasks', device: null }, async () => {
      for (const a of urgent) {
        if (byFinding.has(a.id)) continue;           // card exists, any status
        if (created >= MAX_NEW_CARDS_PER_RUN) break;
        await store.createTeamTask({
          title: `[${a.pri === 0 ? 'critical' : 'high'}] ${a.title}`.slice(0, 500),
          description: [
            a.fix,
            a.loc?.length ? `Where: ${a.loc.slice(0, 6).map((l) => l.line ? `${l.file}:${l.line}` : l.file).join('; ')}` : '',
            a.agentPrompt ? 'Agent prompt:\n```\n' + a.agentPrompt + '\n```' : '',
            '_Filed automatically from a code finding. It closes itself when a re-index no longer reports the finding._',
          ].filter(Boolean).join('\n\n'),
          projectId: a.projectId,
          createdBy: 'auto-tasks',
          linkedFindingId: a.id,
        });
        created++;
      }

      // CLOSE sweep: a card whose finding is gone (fixed and re-indexed, or
      // dismissed) has served its purpose. Only cards this service created
      // (createdBy check) and only open ones — a human's manual state wins.
      const stillOpen = new Set(open.map((a) => a.id));
      for (const t of existing) {
        if (t.createdBy !== 'auto-tasks' || t.status === 'done') continue;
        if (t.linkedFindingId && !stillOpen.has(t.linkedFindingId)) {
          await store.updateTeamTask(t.id, { status: 'done' });
          await store.addTeamTaskComment(t.id, 'auto-tasks', 'Closed automatically: the finding is no longer reported.');
          closed++;
        }
      }

      });

      if (created || closed) log.info({ tenant, created, closed }, 'auto-tasks run');
      // Recorded even when both counts are zero: "it ran and found nothing" and
      // "it never ran" are different answers to "is anything happening?", and
      // the UI can only tell them apart if the zero is written down.
      const cp2 = await createControlPlane();
      try {
        await cp2.setTenantSetting(tenant, LAST_RESULT_KEY,
          JSON.stringify({ at: Date.now(), created, closed }));
      } finally { await cp2.close(); }
      return { created, closed };
    } finally {
      await store.close();
    }
  });
}

/** What the last run did, if there has been one. */
export interface AutoTasksLastRun { at: number; created: number; closed: number }

/**
 * The state a person needs to trust the switch: what it is set to, what it did
 * last time, and how much work is waiting for it right now — broken down by
 * project, because "12 findings" is a number and "8 in chat-recall, 4 in munbot"
 * is an answer.
 *
 * `eligible` counts findings that WOULD file under the current maxPri and have
 * no card yet, so the panel can promise a specific number before you press
 * anything. `filed` is how many already became cards.
 */
export async function autoTasksStatus(tenant: string): Promise<{
  policy: AutoTasksPolicy;
  lastRun: AutoTasksLastRun | null;
  eligible: number;
  filed: number;
  byProject: Array<{ projectId: string; critical: number; high: number; eligible: number }>;
}> {
  const cp = await createControlPlane();
  let policy: AutoTasksPolicy;
  let lastRun: AutoTasksLastRun | null = null;
  try {
    policy = parsePolicy(await cp.getTenantSetting(tenant, AUTO_TASKS_KEY));
    try {
      const raw = await cp.getTenantSetting(tenant, LAST_RESULT_KEY);
      const o = JSON.parse(raw ?? '');
      if (o && Number.isFinite(o.at)) {
        lastRun = { at: Number(o.at), created: Number(o.created) || 0, closed: Number(o.closed) || 0 };
      }
    } catch { /* never recorded, or unreadable — same answer: no last run */ }
  } finally {
    await cp.close();
  }

  return runWithTenant(tenant, async () => {
    const store = await createStore();
    try {
      const open = await store.listCodeActions(undefined, { status: 'suggested', limit: 500 });
      const existing = await store.teamTasksByFindingIds();
      const carded = new Set(existing.map((t) => t.linkedFindingId).filter(Boolean) as string[]);

      const rows = new Map<string, { projectId: string; critical: number; high: number; eligible: number }>();
      let eligible = 0;
      let filed = 0;
      for (const a of open) {
        if (a.pri > 1) continue;                       // below the floor either way
        const key = a.projectId || 'unknown';
        const row = rows.get(key) ?? { projectId: key, critical: 0, high: 0, eligible: 0 };
        if (a.pri === 0) row.critical++; else row.high++;
        if (carded.has(a.id)) { filed++; }
        else if (a.pri <= policy.maxPri) { row.eligible++; eligible++; }
        rows.set(key, row);
      }
      const byProject = [...rows.values()]
        .sort((x, y) => (y.critical - x.critical) || (y.high - x.high) || x.projectId.localeCompare(y.projectId));
      return { policy, lastRun, eligible, filed, byProject };
    } finally {
      await store.close();
    }
  });
}
