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
import { createStore, createControlPlane, runWithTenant, runWithAuthor } from '../imports.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';
import { allows } from '../util/entitlements.js';
import { effectivePlan, billingEnabled } from '../util/billing.js';

const log = createLogger('auto-tasks');

export const AUTO_TASKS_KEY = 'auto_tasks';
/** Two runs per tenant closer together than this are one run. */
const MIN_INTERVAL_MS = 10 * 60 * 1000;
const LAST_RUN_KEY = 'auto_tasks_last_run';
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
export async function runAutoTasks(tenant: string): Promise<{ created: number; closed: number } | null> {
  try {
    return await run(tenant);
  } catch (err) {
    log.warn({ tenant, err: err instanceof Error ? err.message : String(err) }, 'auto-tasks run failed');
    return null;
  }
}

async function run(tenant: string): Promise<{ created: number; closed: number } | null> {
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
    const last = Number(await cp.getTenantSetting(tenant, LAST_RUN_KEY));
    if (Number.isFinite(last) && Date.now() - last < MIN_INTERVAL_MS) return null;
    await cp.setTenantSetting(tenant, LAST_RUN_KEY, String(Date.now()));
  } finally {
    await cp.close();
  }

  return runWithTenant(tenant, () => runWithAuthor({ sub: 'auto-tasks', device: null }, async () => {
    const store = await createStore();
    try {
      const open = await store.listCodeActions(undefined, { status: 'suggested', limit: 500 });
      const urgent = open.filter((a) => a.pri <= policy.maxPri);

      // One lookup for the whole dedup set AND the close sweep.
      const existing = await store.teamTasksByFindingIds();
      const byFinding = new Map(existing.map((t) => [t.linkedFindingId as string, t]));

      let created = 0;
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
      let closed = 0;
      for (const t of existing) {
        if (t.createdBy !== 'auto-tasks' || t.status === 'done') continue;
        if (t.linkedFindingId && !stillOpen.has(t.linkedFindingId)) {
          await store.updateTeamTask(t.id, { status: 'done' });
          await store.addTeamTaskComment(t.id, 'auto-tasks', 'Closed automatically: the finding is no longer reported.');
          closed++;
        }
      }

      if (created || closed) log.info({ tenant, created, closed }, 'auto-tasks run');
      return { created, closed };
    } finally {
      await store.close();
    }
  }));
}
