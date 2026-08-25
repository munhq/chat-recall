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
/**
 * How many auto-filed cards may be OPEN at once, across every project.
 *
 * The per-run cap alone bounds a burst, not a total: every ingest triggers a run,
 * so 10-at-a-time keeps going until the whole backlog is cards. Measured on one
 * real account, moving the floor from high to medium made 1,070 items eligible —
 * 316 actions and 754 findings — and a board of a thousand cards is not a queue
 * anyone works from. It is the same unreadable board that duplicate cards
 * produced, reached by volume instead.
 *
 * So filing STOPS at the ceiling and resumes as cards are closed, which makes the
 * board self-limiting rather than monotonic. Nothing is lost: the backlog stays
 * visible as `eligible`, and the ranked findings view already shows all of it.
 * Closing, re-pointing and de-duplicating are never blocked — those only ever
 * make the board smaller.
 */
const MAX_OPEN_AUTO_CARDS = 50;
/** The card states that count against the ceiling: work not yet finished. */
const OPEN_CARD_STATES: ReadonlySet<string> = new Set(['todo', 'in_progress']);

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
): Promise<{ created: number; closed: number; repointed: number; backfilled: number; reopened: number; deduped: number } | null> {
  try {
    return await run(tenant, opts.force === true);
  } catch (err) {
    log.warn({ tenant, err: err instanceof Error ? err.message : String(err) }, 'auto-tasks run failed');
    return null;
  }
}

async function run(tenant: string, force = false): Promise<{ created: number; closed: number; repointed: number; backfilled: number; reopened: number; deduped: number } | null> {
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
          // The findings this action ROLLS UP. Stamped by the collector, which is
          // the only place that knows the parentage.
          covers: (a.covers ?? []) as string[],
        })),
        ...openFindings
          .filter((f) => f.status === 'open')
          .map((f) => ({
            id: f.id, pri: priOfSeverity(f.severity), title: f.title,
            fix: f.why ?? '', agentPrompt: f.agentPrompt ?? '',
            projectId: f.projectId,
            loc: [{ file: f.file, line: f.line ?? null }],
            identity: f.id,
            covers: [] as string[],       // a finding summarises nothing
          })),
      ];
      const urgent = open.filter((a) => a.pri <= policy.maxPri);

      // ── A ROLL-UP SPEAKS FOR ITS MEMBERS ─────────────────────────────────
      //
      // An action summarises findings the same collector run also emitted, and
      // both are fileable, so one problem produced two cards worded differently:
      // `_callWithFeeRetry ×30` (the clone finding) beside `_callWithFeeRetry
      // copy-pasted 30× (10 lines each)` (the roll-up). Four such pairs on this
      // board.
      //
      // Suppression applies to FILING ONLY, and only when the roll-up is itself
      // being filed — a member whose summary sits below the policy floor must
      // still be reachable, which is the bug the finding source was added to fix.
      // `open` is left whole on purpose: the close sweep asks whether a finding
      // is still reported, and a suppressed finding is still very much there.
      const rolledUp = new Set<string>();
      for (const a of urgent) for (const id of a.covers) rolledUp.add(id);
      const fileableNow = urgent.filter((a) => !rolledUp.has(a.id));

      const byFinding = new Map(existing.map((t) => [t.linkedFindingId as string, t]));
      /** Roll-up id → what it covers, for the card-level reconciliation below. */
      const coversByActionId = new Map(openActions.map((a) => [a.id, (a.covers ?? []) as string[]]));

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
      /** Redundant cards for one finding, retired in favour of the oldest.
       *  Reported because a run that only tidies the board still did work. */
      let deduped = 0;
      /** Cards whose finding id moved under them. Reported because a run that
       *  re-points twenty cards did real work and used to look idle. */
      let repointed = 0;
      /** Pre-identity cards given one. Reported so a run that only repairs
       *  bookkeeping is distinguishable from a run that did nothing. */
      let backfilled = 0;
      /** Machine-closed cards whose finding came back. Counted separately from
       *  `created`: a reopen is not a new problem, it is one that was never
       *  fixed, and conflating the two hides how often that happens. */
      let reopened = 0;
      // WRITES keep the author stamp, so a card records who filed it.
      await runWithAuthor({ sub: 'auto-tasks', device: null }, async () => {

      // ── DEDUP: several cards, ONE finding ────────────────────────────────
      //
      // Two ways a board ends up with duplicates of the same finding, and both
      // have happened here:
      //
      //  1. The id scheme invented identities. A collector that emitted one
      //     finding four times got four ids, so four cards were filed for
      //     `memory-index.ts:53` — byte-identical, and 387 stored findings were
      //     duplicates of that kind. The ordinal now counts distinct lines, so
      //     those four collapse to one id, and the four cards land on it.
      //  2. Any id change re-points cards through the remap in
      //     replaceCodeFindings, which can likewise land several on one id.
      //
      // The OLDEST card wins: it holds the history, the comments, and whatever a
      // person did to it. A retired duplicate is closed and has its finding link
      // CLEARED — not left pointing at the survivor's finding. That link is what
      // the reopen branch below reads, so a duplicate that kept it would be
      // reopened on the next run (its finding is still reported), closed again,
      // and again, for ever. Clearing it says what is true: this card no longer
      // represents a finding, because the survivor does.
      const OPEN_STATES = OPEN_CARD_STATES;
      const byFindingAll = new Map<string, typeof existing>();
      for (const t of existing) {
        if (t.createdBy !== 'auto-tasks' || !t.linkedFindingId) continue;
        const g = byFindingAll.get(t.linkedFindingId);
        if (g) g.push(t); else byFindingAll.set(t.linkedFindingId, [t]);
      }
      for (const [findingId, group] of byFindingAll) {
        const live = group.filter((t) => OPEN_STATES.has(t.status))
          .sort((a, b) => a.createdAt - b.createdAt);
        if (live.length < 2) continue;
        const [survivor, ...extra] = live;
        for (const dup of extra) {
          await store.updateTeamTask(dup.id, { status: 'done', linkedFindingId: null });
          await store.addTeamTaskComment(dup.id, 'auto-tasks',
            `Closed as a duplicate of ${survivor.id}: both cards were filed for finding `
            + `${findingId}. The older card keeps the history; this one was an artefact of `
            + 'the same finding being reported more than once.');
          deduped++;
        }
        byFinding.set(findingId, survivor);
      }

      // ── AND ACROSS THE TWO SOURCES ───────────────────────────────────────
      //
      // The pass above only sees cards that name the SAME id. A roll-up card and
      // a card for one of the findings it summarises name different ids, so they
      // are the same duplication seen from the other side — and the four clone
      // cards on this board sit next to four duplication roll-ups saying the same
      // thing in different words.
      //
      // Here the ROLL-UP wins regardless of age, unlike the pass above: it states
      // the whole problem ("copy-pasted 30× across these files") while the member
      // is one instance of it, so retiring the summary and keeping the instance
      // would lose what the board is for.
      for (const rollup of existing) {
        if (rollup.createdBy !== 'auto-tasks' || !rollup.linkedFindingId) continue;
        if (!OPEN_STATES.has(rollup.status)) continue;
        const covers = coversByActionId.get(rollup.linkedFindingId);
        if (!covers?.length) continue;
        for (const memberId of covers) {
          const member = byFinding.get(memberId);
          if (!member || member.id === rollup.id) continue;
          if (member.createdBy !== 'auto-tasks' || !OPEN_STATES.has(member.status)) continue;
          await store.updateTeamTask(member.id, { status: 'done', linkedFindingId: null });
          await store.addTeamTaskComment(member.id, 'auto-tasks',
            `Closed as a duplicate of ${rollup.id}: that card is the roll-up for finding `
            + `${memberId} and everything else in the same group, so this card repeated one `
            + 'part of it. The roll-up is where the work is tracked.');
          deduped++;
        }
      }

      // ── THE CEILING ──────────────────────────────────────────────────────
      //
      // Counted here, after the two dedup sweeps above, so a run that retires
      // three duplicates may file three more — the board's size is what is
      // capped, not the run's ambition.
      //
      // `existing` is every finding-linked card, and the sweeps mutated the rows
      // in place, so this reads the post-sweep state.
      const openNow = existing.filter(
        (t) => t.createdBy === 'auto-tasks' && OPEN_CARD_STATES.has(t.status)).length;
      const room = Math.max(0, MAX_OPEN_AUTO_CARDS - openNow);
      const budget = Math.min(MAX_NEW_CARDS_PER_RUN, room);
      if (room === 0) {
        log.info({ tenant, openNow, ceiling: MAX_OPEN_AUTO_CARDS },
          'auto-tasks: board at the ceiling — filing paused, closing still runs');
      }

      for (const a of fileableNow) {
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
        if (created >= budget) break;
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
        if (t.createdBy !== 'auto-tasks') continue;

        // ── REOPEN. A close is not permanent, because a finding can come back.
        //
        // The sweep only ever closed. 'done' sat in CLOSED, so a machine-closed
        // card was skipped for ever — and the filing loop above matches an open
        // finding to a card BY ID, so it filed nothing either. The finding was
        // therefore invisible: the board said done, the code still had the
        // problem, and nothing surfaced it. Worse than a duplicate card.
        //
        // Observed on this board: 8 cards closed in one sweep, then their
        // findings reappeared under the SAME ids — which is expected now, since a
        // finding's id is derived from its content and is stable, so a finding
        // that returns returns as itself.
        //
        // Only machine-closed cards reopen, and the guard is the linked session:
        //   - createdBy 'auto-tasks'  — never a card a person made
        //   - status 'done'           — 'rejected' is the human's verdict and stands
        //   - NO linked session       — a card closed by work that attached its
        //     session records a finished episode. If the finding returns after
        //     that, it is a new occurrence and deserves a new card, not the
        //     resurrection of someone's completed one.
        if (t.status === 'done'
            && !t.linkedSessionId
            && t.linkedFindingId
            && stillOpen.has(t.linkedFindingId)) {
          await store.updateTeamTask(t.id, { status: 'todo' });
          await store.addTeamTaskComment(t.id, 'auto-tasks',
            `Reopened: finding ${t.linkedFindingId} is being reported again. This card was `
            + 'closed automatically, not by work, so the problem was never fixed.');
          reopened++;
          continue;
        }

        if (CLOSED.has(t.status)) continue;
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

      if (created || closed || repointed || backfilled || reopened || deduped) log.info({ tenant, created, closed, repointed, backfilled, reopened, deduped }, 'auto-tasks run');
      // Recorded even when both counts are zero: "it ran and found nothing" and
      // "it never ran" are different answers to "is anything happening?", and
      // the UI can only tell them apart if the zero is written down.
      const cp2 = await createControlPlane();
      try {
        await cp2.setTenantSetting(tenant, LAST_RESULT_KEY,
          JSON.stringify({ at: Date.now(), created, closed, repointed, backfilled, reopened, deduped }));
      } finally { await cp2.close(); }
      return { created, closed, repointed, backfilled, reopened, deduped };
    } finally {
      await store.close();
    }
  });
}

/**
 * What the last run did, if there has been one.
 *
 * All five counters, not only `created`/`closed`: a run that re-points twenty
 * cards onto renamed findings did real work, and reporting it as "created 0,
 * closed 0" is indistinguishable from a dead switch. `run()` has always
 * persisted the five; this shape used to read back two of them.
 */
export interface AutoTasksLastRun {
  at: number;
  created: number;
  closed: number;
  repointed: number;
  backfilled: number;
  reopened: number;
  deduped: number;
}

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
  /** Auto-filed cards currently open, and the ceiling they are counted against. */
  openCards: number;
  ceiling: number;
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
        lastRun = {
          at: Number(o.at),
          created: Number(o.created) || 0,
          closed: Number(o.closed) || 0,
          // Absent in results recorded before these counters existed: an old
          // record must still read back as a run, with zeros for what it
          // never measured.
          repointed: Number(o.repointed) || 0,
          backfilled: Number(o.backfilled) || 0,
          reopened: Number(o.reopened) || 0,
          deduped: Number(o.deduped) || 0,
        };
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
      const openCards = existing.filter(
        (t) => t.createdBy === 'auto-tasks' && OPEN_CARD_STATES.has(t.status)).length;
      // FINDINGS COUNT TOO. This read only ever looked at code_actions, while the
      // filer reads both sources — so the panel's promise about a lower floor was
      // short by every finding. Asked what moving the floor to medium would pick
      // up, it answered 316 when the true number was 1,070, and a floor was
      // chosen on that answer. `codeFindingsSummary` is exact and uncapped, which
      // a capped list is not.
      const fsum = await store.codeFindingsSummary();
      const cardedFindings = [...carded].filter((id) => id.startsWith('cf_')).length;

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

      // Findings at or under the floor, less the ones that already have a card.
      // Approximate in one direction only: a finding suppressed by a roll-up is
      // still counted here, so the number is an upper bound rather than a promise
      // the filer will break. `byProject` stays action-derived — the per-project
      // finding counts would be a query per project.
      let findingsEligible = 0;
      for (const sev of PRI_SEVERITY) {
        if (priOfSeverity(sev) <= policy.maxPri) findingsEligible += fsum.bySeverity[sev] ?? 0;
      }
      findingsEligible = Math.max(0, findingsEligible - cardedFindings);

      return {
        policy, lastRun, filed, byProject, openCards,
        eligible: eligible + findingsEligible,
        ceiling: MAX_OPEN_AUTO_CARDS,
      };
    } finally {
      await store.close();
    }
  });
}
