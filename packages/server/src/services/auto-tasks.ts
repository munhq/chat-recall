/**
 * Auto-tasks — findings file their own cards, agents close them with proof.
 *
 * The loop this completes: the code indexer writes actions with deterministic
 * ids (hash of project|category|identityTitle|sorted-files), this
 * service materializes the urgent ones onto the shared board, an agent picks a
 * card up (linking its session, so the shipped-badge can verify the fix), and
 * when a re-index no longer reports the action, the card closes itself.
 *
 * "No longer reports" is checked by IDENTITY, not by id. Those ids were once
 * derived from data that moved — a title carrying its own occurrence counts, a
 * location key taking whichever copy the analyzer listed first — so the same
 * finding reappeared under a new id, its card closed itself as fixed, and a
 * duplicate was filed. 93 of 97 cards on one board were closed that way while
 * all 313 findings were still open. The id inputs are fixed; the close sweep no
 * longer trusts them alone.
 *
 * Deliberate boundaries:
 *   - OPT-IN per tenant. The board is team-visible and has no delete; nothing
 *     writes to it unless the tenant turned the policy on. Stored in
 *     tenant_settings under AUTO_TASKS_KEY.
 *   - CODE ACTIONS ONLY. They are the one findings source with stable ids
 *     (dedup and auto-close are impossible without identity). Live secrets
 *     already page through the alert webhook — a second card would double-alert.
 *   - A priority FLOOR the tenant picks: critical, high, medium or low (pri 0-3,
 *     see severityOfPri). Anything below it stays in the ranked view for a human
 *     to promote. Worth knowing when picking: this collector only emits pri 0 for
 *     critical SECURITY findings, so a 'critical' floor files nothing on a repo
 *     whose worst problem is structural.
 *   - Gated on the 'tasks' feature via the caller (the routes that invoke this
 *     are behind requireFeature('tasks') mounts or check the plan themselves);
 *     the run also re-checks, because a policy left on by a lapsed tenant must
 *     not keep writing to a board their plan no longer includes.
 */
import { createStore, createControlPlane, runWithTenant, runWithAuthor, runUnrestricted } from '../imports.js';
import {
  severityOfPri, PRI_SEVERITY, actionIdentityKey, priOfSeverity,
} from '@chat-recall/engine/types/code-intel.js';
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
  /** Highest pri that materializes. 0 critical, 1 high, 2 medium, 3 low —
   *  inclusive, so 2 files critical + high + medium. */
  maxPri: 0 | 1 | 2 | 3;
}

/** Clamp anything into the pri range the policy understands. */
function asMaxPri(v: unknown): 0 | 1 | 2 | 3 {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 0) return 1;
  return Math.min(n, PRI_SEVERITY.length - 1) as 0 | 1 | 2 | 3;
}

export function parsePolicy(raw: string | null): AutoTasksPolicy {
  // Fail to DISABLED on anything unreadable: a corrupt setting must not start
  // writing to the board.
  try {
    const o = JSON.parse(raw ?? '');
    return {
      enabled: o?.enabled === true,
      maxPri: o?.maxPri === undefined ? 1 : asMaxPri(o.maxPri),
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
): Promise<{ created: number; closed: number; repointed: number; backfilled: number } | null> {
  try {
    return await run(tenant, opts.force === true);
  } catch (err) {
    log.warn({ tenant, err: err instanceof Error ? err.message : String(err) }, 'auto-tasks run failed');
    return null;
  }
}

async function run(tenant: string, force = false): Promise<{ created: number; closed: number; repointed: number; backfilled: number } | null> {
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
      // A CAPPED LIST CANNOT ANSWER "IS THIS STILL OPEN".
      //
      // This read was listCodeFindings(limit: 500) over EVERY project, and the
      // close sweep then treated that page as the whole set of open findings.
      // With 8,096 findings and 500 slots, everything past the cap looks deleted,
      // so a card pointing at it closes itself as fixed — the exact bug this
      // service was just repaired for, reintroduced by a LIMIT.
      //
      // It happened to be harmless while the policy floor was 1: the ordering is
      // severity-first and only 31 findings are critical-or-high, so every
      // fileable one fell inside the page. It would have become live the moment
      // the floor moved to 2. A correctness that depends on a setting nobody
      // connected to it is not correctness.
      //
      // So: fetch what is needed, not a page of everything.
      //   - FILING wants findings at or under the floor → query per severity,
      //     which is bounded by the policy rather than by an arbitrary number.
      //   - THE CLOSE SWEEP wants the truth about the specific findings the
      //     existing cards name → look those up by exact id.
      const wantedSeverities = PRI_SEVERITY.filter((sv) => priOfSeverity(sv) <= policy.maxPri);
      const { openActions, fileable, existing } = await runUnrestricted(async () => {
        const tasks = await store.teamTasksByFindingIds();
        const perSeverity = await Promise.all(
          wantedSeverities.map((severity) => store.listCodeFindings(undefined, { severity, limit: 2000 })),
        );
        return {
          openActions: await store.listCodeActions(undefined, { status: 'suggested', limit: 500 }),
          fileable: perSeverity.flat(),
          existing: tasks,
        };
      });

      // The findings the cards point at, resolved exactly. A card whose finding
      // is absent HERE is genuinely gone, not merely past a page boundary.
      const cardFindingIds = existing
        .map((t) => t.linkedFindingId)
        .filter((id): id is string => !!id && id.startsWith('cf_'));
      const referenced = await runUnrestricted(() => store.codeFindingsByIds(cardFindingIds));
      // Union, deduped: everything fileable plus everything a card still names.
      const byId = new Map<string, (typeof fileable)[number]>();
      for (const f of [...fileable, ...referenced]) byId.set(f.id, f);
      const openFindings = [...byId.values()];

      // FINDINGS ARE FILEABLE TOO, and until now they were not — runAutoTasks
      // read code_actions and nothing else. A finding carries a severity string
      // where an action carries a numeric pri, and the policy is written in pri,
      // so a CRITICAL finding could not become a card whatever its severity
      // while a pri-2 "God module" action could. On one account that left 34
      // criticals — unchecked `unwrap`, and a manifest rule — permanently
      // unreachable from the board.
      //
      // Both are reduced to one shape so the dedup, the cap, the re-point and
      // the close sweep below need no second copy of themselves.
      //
      // A finding's id IS its identity: it hashes content plus an ordinal among
      // identical siblings, with no volatile part, unlike an action's whose title
      // counts and location order used to move. Actions still need the separate
      // identity key.
      const open = [
        ...openActions.map((a) => ({
          id: a.id, pri: a.pri, title: a.title, fix: a.fix, agentPrompt: a.agentPrompt,
          projectId: a.projectId, loc: a.loc ?? [],
          identity: actionIdentityKey(a.projectId, a),
        })),
        ...openFindings
          .filter((f) => f.status === 'open')
          .map((f) => ({
            id: f.id, pri: priOfSeverity(f.severity), title: f.title,
            fix: f.why ?? '', agentPrompt: f.agentPrompt ?? '',
            projectId: f.projectId,
            loc: [{ file: f.file, line: f.line ?? null }],
            identity: f.id,
          })),
      ];
      const urgent = open.filter((a) => a.pri <= policy.maxPri);
      const byFinding = new Map(existing.map((t) => [t.linkedFindingId as string, t]));

      // IDENTITY, not id. An action's id is a hash, and when the hash inputs
      // changed under it the same finding arrived wearing a new id. Keyed by
      // identity, the two are the same row — which is what lets the close sweep
      // below tell "fixed" from "renamed", and stops a duplicate being filed for
      // a finding that already has a card.
      const openByIdentity = new Map(open.map((a) => [a.identity, a] as const));
      // Cards keyed by the identity THE FILER STORED. Not recomputed from the
      // card: a card holds a severity-prefixed title and no category or loc, so
      // any reconstruction would differ from the filer's key and match nothing —
      // silently, which is the failure mode this whole change exists to remove.
      // Cards filed before the column existed have null and are skipped here;
      // they fall through to the old id-only behaviour.
      const cardIdentities = new Map(
        existing.filter((t) => t.linkedFindingIdentity)
          .map((t) => [t.linkedFindingIdentity as string, t] as const),
      );

      let created = 0;
      let closed = 0;
      /** Cards whose finding id moved under them. Reported because a run that
       *  re-points twenty cards did real work and used to look idle. */
      let repointed = 0;
      /** Pre-identity cards given one. Reported so a run that only repairs
       *  bookkeeping is distinguishable from a run that did nothing. */
      let backfilled = 0;
      // WRITES keep the author stamp, so a card records who filed it.
      await runWithAuthor({ sub: 'auto-tasks', device: null }, async () => {
      for (const a of urgent) {
        const byId = byFinding.get(a.id);
        if (byId) {
          // BACKFILL. A card that predates linked_finding_identity matches by id
          // and would `continue` here forever, so it never gains an identity —
          // and the first time its id shifted it would close itself as fixed,
          // which is the entire bug this column exists to prevent. Cards left
          // after the 0009 repair are exactly these, so without this they stay
          // vulnerable indefinitely.
          if (!byId.linkedFindingIdentity) {
            await store.updateTeamTask(byId.id, { linkedFindingIdentity: a.identity });
            cardIdentities.set(a.identity, { ...byId, linkedFindingIdentity: a.identity });
            backfilled++;
          }
          continue;                                  // card exists, any status
        }
        // A card for this finding under its OLD id. Re-point it instead of
        // filing a second one: this is where the duplicates came from — six
        // cards for "inflate copy-pasted 2× (899 lines each)", one per id the
        // hash produced. Re-pointing also puts the card back inside `stillOpen`
        // for the close sweep, so it stops being a candidate for a false close.
        const twin = cardIdentities.get(a.identity);
        if (twin) {
          if (twin.linkedFindingId !== a.id) {
            await store.updateTeamTask(twin.id, { linkedFindingId: a.id });
            byFinding.set(a.id, twin);
            repointed++;
          }
          continue;
        }
        if (created >= MAX_NEW_CARDS_PER_RUN) break;
        await store.createTeamTask({
          title: `[${severityOfPri(a.pri)}] ${a.title}`.slice(0, 500),
          description: [
            a.fix,
            a.loc?.length ? `Where: ${a.loc.slice(0, 6).map((l) => l.line ? `${l.file}:${l.line}` : l.file).join('; ')}` : '',
            a.agentPrompt ? 'Agent prompt:\n```\n' + a.agentPrompt + '\n```' : '',
            '_Filed automatically from a code finding. It closes itself when a re-index no longer reports the finding._',
          ].filter(Boolean).join('\n\n'),
          projectId: a.projectId,
          createdBy: 'auto-tasks',
          linkedFindingId: a.id,
          // Stored so a later id shift is recognisable as the same finding.
          linkedFindingIdentity: a.identity,
        });
        created++;
      }

      // CLOSE sweep: a card whose finding is gone (fixed and re-indexed, or
      // dismissed) has served its purpose. Only cards this service created
      // (createdBy check) and only open ones — a human's manual state wins.
      //
      // 'rejected' MUST be excluded, not just 'done'. Rejecting a card dismisses
      // its underlying action, which removes it from listCodeActions('suggested')
      // above, which puts it outside stillOpen — so without this guard the very
      // next run flips the card the user rejected to 'done' and comments that it
      // closed itself. The machine would overwrite the human verdict, silently,
      // and rejection is the ONE verdict that is the human's alone to give.
      // A MISSING ID IS NOT A FIXED PROBLEM. This closed a card whenever its
      // finding id was absent from the open set, and an id shift is
      // indistinguishable from a fix by that test alone. It was not a rare race:
      // 93 of 97 cards on one board were closed this way, all with no session
      // attached, while every one of the 313 findings was still open. The board
      // asserted ~90 completed pieces of work that never happened.
      //
      // So before closing, ask whether the finding is really gone — by IDENTITY,
      // not by id. If an open action still matches, the id moved and the card is
      // re-pointed at it rather than closed.
      const stillOpen = new Set(open.map((a) => a.id));
      const CLOSED: ReadonlySet<string> = new Set(['done', 'rejected']);
      for (const t of existing) {
        if (t.createdBy !== 'auto-tasks' || CLOSED.has(t.status)) continue;
        if (!t.linkedFindingId || stillOpen.has(t.linkedFindingId)) continue;

        // Only the stored identity can answer this. A card without one predates
        // the column, and for it a missing id still means "gone" — which is safe,
        // because the phantom cards that behaviour produced have been removed and
        // every card filed from here on carries an identity.
        const twin = t.linkedFindingIdentity
          ? openByIdentity.get(t.linkedFindingIdentity) : undefined;
        if (twin) {
          await store.updateTeamTask(t.id, { linkedFindingId: twin.id });
          repointed++;
          continue;
        }

        await store.updateTeamTask(t.id, { status: 'done' });
        // Name the id that vanished. "The finding is no longer reported" gave a
        // reader nothing to check, and every one of those 93 comments was wrong.
        await store.addTeamTaskComment(t.id, 'auto-tasks',
          `Closed automatically: finding ${t.linkedFindingId} is no longer reported, `
          + 'and no open finding matches this card. If the problem is still there, reopen it.');
        closed++;
      }

      });

      if (created || closed || repointed || backfilled) log.info({ tenant, created, closed, repointed, backfilled }, 'auto-tasks run');
      // Recorded even when both counts are zero: "it ran and found nothing" and
      // "it never ran" are different answers to "is anything happening?", and
      // the UI can only tell them apart if the zero is written down.
      const cp2 = await createControlPlane();
      try {
        await cp2.setTenantSetting(tenant, LAST_RESULT_KEY,
          JSON.stringify({ at: Date.now(), created, closed, repointed, backfilled }));
      } finally { await cp2.close(); }
      return { created, closed, repointed, backfilled };
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
  byProject: Array<{ projectId: string; counts: Record<string, number>; eligible: number }>;
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

      // Every severity is counted, not just the two above the old floor: the
      // panel has to show what a LOWER floor would pick up, or choosing one is
      // guesswork.
      const rows = new Map<string, { projectId: string; counts: Record<string, number>; eligible: number }>();
      let eligible = 0;
      let filed = 0;
      for (const a of open) {
        const key = a.projectId || 'unknown';
        const row = rows.get(key) ?? { projectId: key, counts: {}, eligible: 0 };
        const sev = severityOfPri(a.pri);
        row.counts[sev] = (row.counts[sev] ?? 0) + 1;
        if (carded.has(a.id)) { if (a.pri <= policy.maxPri) filed++; }
        else if (a.pri <= policy.maxPri) { row.eligible++; eligible++; }
        rows.set(key, row);
      }
      const weight = (c: Record<string, number>) =>
        PRI_SEVERITY.reduce((n, s, i) => n + (c[s] ?? 0) * (PRI_SEVERITY.length - i) * 1000, 0);
      const byProject = [...rows.values()]
        .sort((x, y) => weight(y.counts) - weight(x.counts) || x.projectId.localeCompare(y.projectId));
      return { policy, lastRun, eligible, filed, byProject };
    } finally {
      await store.close();
    }
  });
}
