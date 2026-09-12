/**
 * GET /api/decisions — the decision register, already resolved.
 *
 * ── Why the server resolves, not the caller ─────────────────────────────────
 *
 * A decision exists at three scopes and they disagree on purpose: the account
 * says BetterAuth, one client's repository says Keycloak, and an individual
 * has habits that bind nobody. Handing an agent three layers and asking it to
 * work out which wins produces a different answer per model and per prompt.
 * So the cascade runs here, once, and both callers — the MCP tool and the
 * dashboard — get one effective value per area with its provenance attached.
 *
 * Precedence, most specific first:
 *
 *   project  >  account  >  user
 *
 * User sits LAST deliberately. A personal preference fills a gap nobody has
 * decided; it never overrules a team decision, or one person's habit silently
 * becomes everyone's architecture. Those rows come back flagged `advisory` so
 * the caller can say so rather than having to know it.
 *
 * ── Where the data comes from ───────────────────────────────────────────────
 *
 * `subject → decided → object` triples whose subject is `<project>:<area>`
 * (see core/decision-areas.ts). The knowledge graph already carries validity
 * windows, so history is the expired rows for the same subject and needs no
 * second table. `because` triples carry the rationale, keyed on the same
 * subject.
 *
 * Candidates are a different thing and are NOT decisions: `chose` triples the
 * regex extractor guessed. They are offered for confirmation and never
 * resolved into the register on their own.
 */
import express from 'express';
import { createKnowledgeGraph } from '../imports.js';
import {
  canonArea, decisionSubject, parseDecisionSubject, isKnownArea, inferArea,
  DECISION_AREAS, ACCOUNT_SCOPE,
} from '@chat-recall/engine/core/decision-areas.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';

const router = express.Router();
const log = createLogger('decisions');

/** Confidence below which an extracted guess is not offered as a candidate. */
const CANDIDATE_FLOOR = 0.5;

type Fact = {
  subject: string; predicate: string; object: string;
  valid_from: string | null; valid_to: string | null;
  confidence?: number; source_session?: string | null; current?: boolean;
  /** When the row was written. Stands in for `valid_from` when it is null. */
  recorded_at?: string | null;
};

export interface DecisionRow {
  area: string;
  /** True when `area` is one of the canonical areas rather than a slug. */
  known: boolean;
  value: string;
  since: string | null;
  why: string | null;
  source_session: string | null;
  /** Which scope the winning value came from. */
  scope: 'account' | 'project' | 'user';
  /** The value applies here but was decided at the account level. */
  inherited: boolean;
  /** This project deliberately disagrees with an account decision. */
  override: boolean;
  /** A personal preference. Fills a gap; binds nobody. */
  advisory: boolean;
  /** What this replaced, newest first. Empty when nothing was superseded. */
  history: Array<{ value: string; from: string | null; to: string | null; current: boolean }>;
}

/** Group `decided` facts by their area-keyed subject. */
function bySubject(facts: Fact[]): Map<string, Fact[]> {
  const m = new Map<string, Fact[]>();
  for (const f of facts) {
    const parsed = parseDecisionSubject(f.subject);
    if (!parsed) continue; // free-text subject from before areas existed
    const list = m.get(f.subject) ?? [];
    list.push(f);
    m.set(f.subject, list);
  }
  return m;
}

/** The live value for a subject, plus everything it replaced. */
function resolveOne(facts: Fact[]): { current: Fact; history: DecisionRow['history'] } | null {
  const sorted = [...facts].sort((a, b) => String(b.valid_from ?? '').localeCompare(String(a.valid_from ?? '')));
  const current = sorted.find((f) => f.valid_to === null);
  if (!current) return null; // every value expired and nothing replaced it
  return {
    current,
    history: sorted.map((f) => ({
      value: f.object, from: f.valid_from, to: f.valid_to, current: f.valid_to === null,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/decisions?project=<id>&include_candidates=1
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const project = typeof req.query.project === 'string' && req.query.project.trim()
    ? req.query.project.trim() : null;
  const userId = typeof req.query.user === 'string' && req.query.user.trim()
    ? req.query.user.trim() : null;
  const wantCandidates = req.query.include_candidates !== '0';

  const kg = await createKnowledgeGraph();
  try {
    const [decided, because] = await Promise.all([
      kg.queryRelationship('decided') as Promise<Fact[]>,
      kg.queryRelationship('because') as Promise<Fact[]>,
    ]);

    // Rationale, keyed by subject. Newest wins when several were recorded —
    // `because` is deliberately multi-valued, so this picks one to show rather
    // than pretending there is only ever one reason.
    const why = new Map<string, string>();
    for (const b of [...because].sort((a, z) => String(a.valid_from ?? '').localeCompare(String(z.valid_from ?? '')))) {
      if (b.valid_to === null) why.set(b.subject, b.object);
    }

    const grouped = bySubject(decided);

    /** area → resolved row, for one scope key. */
    const atScope = (scopeKey: string): Map<string, { current: Fact; history: DecisionRow['history'] }> => {
      const out = new Map<string, { current: Fact; history: DecisionRow['history'] }>();
      for (const [subject, facts] of grouped) {
        const parsed = parseDecisionSubject(subject)!;
        if (parsed.project !== scopeKey) continue;
        const r = resolveOne(facts);
        if (r) out.set(parsed.area, r);
      }
      return out;
    };

    const accountRows = atScope(ACCOUNT_SCOPE);
    const projectRows = project ? atScope(project) : new Map();
    const userRows = userId ? atScope(`user:${userId}`) : new Map();

    const row = (
      area: string,
      r: { current: Fact; history: DecisionRow['history'] },
      scope: DecisionRow['scope'],
      opts: { inherited?: boolean; override?: boolean; advisory?: boolean } = {},
    ): DecisionRow => ({
      area,
      known: isKnownArea(area),
      value: r.current.object,
      // Facts asserted before addTriple stamped a date have no valid_from, and
      // a decision without a date persuades nobody. The write date is when
      // somebody recorded it, so it answers "since when" for those rows.
      since: r.current.valid_from ?? r.current.recorded_at ?? null,
      why: why.get(decisionSubject(scope === 'account' ? ACCOUNT_SCOPE : scope === 'user' ? `user:${userId}` : project, area)) ?? null,
      source_session: r.current.source_session ?? null,
      scope,
      inherited: !!opts.inherited,
      override: !!opts.override,
      advisory: !!opts.advisory,
      history: r.history,
    });

    // Resolve every area anyone has an opinion about, in precedence order.
    const areas = new Set<string>([...accountRows.keys(), ...projectRows.keys(), ...userRows.keys()]);
    const decisions: DecisionRow[] = [];
    for (const area of areas) {
      const p = projectRows.get(area), a = accountRows.get(area), u = userRows.get(area);
      if (p) decisions.push(row(area, p, 'project', { override: !!a }));
      else if (a) decisions.push(row(area, a, 'account', { inherited: !!project }));
      else if (u) decisions.push(row(area, u, 'user', { advisory: true }));
    }
    decisions.sort((x, z) => x.area.localeCompare(z.area));

    // A gap is a canonical area nobody has decided at any scope in view. Slug
    // areas are excluded on purpose: an area invented once is not evidence
    // that every project owes it an answer.
    const gaps = DECISION_AREAS.filter((a) => !areas.has(a)).map((area) => ({ area }));

    let candidates: Array<{ area: string | null; value: string; mentions: number; last_seen: string | null }> = [];
    if (wantCandidates) {
      const chose = (await kg.queryRelationship('chose')) as Fact[];
      // One row per distinct value, with how often it was seen — a value the
      // extractor caught eleven times is worth confirming before one it saw once.
      const seen = new Map<string, { value: string; mentions: number; last: string | null }>();
      for (const c of chose) {
        if (c.valid_to !== null) continue;
        if ((c.confidence ?? 1) < CANDIDATE_FLOOR) continue;
        if (project && !c.subject.startsWith(project)) continue;
        const key = c.object.toLowerCase();
        const prev = seen.get(key);
        seen.set(key, {
          value: c.object,
          mentions: (prev?.mentions ?? 0) + 1,
          last: [prev?.last ?? '', c.valid_from ?? c.recorded_at ?? ''].sort().pop() || null,
        });
      }
      candidates = [...seen.values()]
        .sort((a, b) => b.mentions - a.mentions)
        .slice(0, 25)
        // A guessed area, so confirming is one click. Null when nothing in the
        // value names an area — better to ask than to file it under the wrong
        // key, which is the exact failure this feature removes.
        .map((c) => ({ area: inferArea(c.value), value: c.value, mentions: c.mentions, last_seen: c.last }));
    }

    res.json({
      scope: project ? 'project' : 'account',
      project,
      decisions,
      gaps,
      candidates,
      areas: DECISION_AREAS,
    });
  } catch (error) {
    log.error({ err: error }, 'decisions list failed');
    res.status(500).json({ error: error instanceof Error ? error.message : 'failed' });
  } finally {
    await kg.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/decisions — record one, superseding whatever it replaces.
//
// The MCP tool writes through /api/kg/add; this is the dashboard's path and
// exists so the UI does not have to know the triple shape or remember to pass
// supersede. Same write, one caller-facing name.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', express.json(), async (req, res) => {
  const { area: rawArea, value, reason, project, session_id } = req.body ?? {};
  const area = canonArea(typeof rawArea === 'string' ? rawArea : null);
  if (!area) return res.status(400).json({ error: 'area is required' });
  if (typeof value !== 'string' || !value.trim()) return res.status(400).json({ error: 'value is required' });

  const kg = await createKnowledgeGraph();
  try {
    const subject = decisionSubject(typeof project === 'string' ? project : null, area);
    // supersede defaults on, which is the whole point: recording auth closes
    // the previous auth decision and leaves every other area alone.
    await kg.addTriple(subject, 'decided', value.trim(), {
      confidence: 1, sourceSession: session_id ?? undefined, origin: 'asserted', supersede: true,
    } as never);
    if (typeof reason === 'string' && reason.trim()) {
      await kg.addTriple(subject, 'because', reason.trim(), {
        confidence: 1, sourceSession: session_id ?? undefined, origin: 'asserted', supersede: false,
      } as never);
    }
    res.status(201).json({ subject, area, value: value.trim() });
  } catch (error) {
    log.error({ err: error }, 'decision write failed');
    res.status(500).json({ error: error instanceof Error ? error.message : 'failed' });
  } finally {
    await kg.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/decisions/candidates/resolve — confirm or discard a guess.
//
// Both outcomes retire the guess, which is the point: a candidate you have
// judged must stop being offered, or the queue never empties and people stop
// reading it. Confirming also records the decision; discarding only retires it.
//
// Retiring is `invalidate` on the extracted `chose` triple rather than a delete.
// The graph is temporal, so the guess keeps its validity window and the record
// still shows that the extractor saw this and a human said no.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/candidates/resolve', express.json(), async (req, res) => {
  const { value, action, area: rawArea, project, reason, session_id } = req.body ?? {};
  if (typeof value !== 'string' || !value.trim()) {
    return res.status(400).json({ error: 'value is required' });
  }
  if (action !== 'confirm' && action !== 'discard') {
    return res.status(400).json({ error: "action must be 'confirm' or 'discard'" });
  }

  const area = action === 'confirm'
    ? canonArea(typeof rawArea === 'string' && rawArea ? rawArea : inferArea(value))
    : null;
  if (action === 'confirm' && !area) {
    // Refusing beats guessing. Without an area the decision supersedes nothing,
    // which is the bug this whole surface exists to remove.
    return res.status(400).json({ error: 'area is required — nothing in the value names one' });
  }

  const kg = await createKnowledgeGraph();
  try {
    // The live guesses this value came from. Read BEFORE the write, because
    // confirming supersedes and retires them, and one of them carries the
    // conversation the extractor read the value out of.
    const chose = (await kg.queryRelationship('chose')) as Fact[];
    const target = value.trim().toLowerCase();
    const guesses = chose.filter((c) => c.valid_to === null && c.object.trim().toLowerCase() === target);

    // A confirmed candidate inherits its guess's session. The dashboard has no
    // session of its own, so without this the register shows a decision that
    // no conversation accounts for, and the guard can only assert it.
    const inherited = [...guesses]
      .sort((a, b) => String(a.valid_from ?? a.recorded_at ?? '').localeCompare(String(b.valid_from ?? b.recorded_at ?? '')))
      .reverse()
      .find((c) => c.source_session)?.source_session ?? undefined;
    const sourceSession = session_id ?? inherited;

    if (action === 'confirm' && area) {
      const subject = decisionSubject(typeof project === 'string' ? project : null, area);
      await kg.addTriple(subject, 'decided', value.trim(), {
        confidence: 1, sourceSession, origin: 'asserted', supersede: true,
      } as never);
      if (typeof reason === 'string' && reason.trim()) {
        await kg.addTriple(subject, 'because', reason.trim(), {
          confidence: 1, sourceSession, origin: 'asserted', supersede: false,
        } as never);
      }
    }

    // Retire every live `chose` guess naming this value, whichever subject the
    // extractor filed it under — the candidate row is one value, not one row.
    let retired = 0;
    for (const c of guesses) {
      retired += await kg.invalidate(c.subject, 'chose', c.object);
    }

    res.json({ action, value: value.trim(), area, retired });
  } catch (error) {
    log.error({ err: error }, 'candidate resolve failed');
    res.status(500).json({ error: error instanceof Error ? error.message : 'failed' });
  } finally {
    await kg.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/decisions/check — is this tool call about to undo a decision?
//
// The register only enforces if something reads it BEFORE the agent acts. This
// is what the pre-execution hooks call, and it returns a verdict rather than
// rows so that every harness gets the same answer: the alternative is five
// hooks each re-implementing the cascade and disagreeing.
//
// WARN, not DENY, by default. A wrong block burns the user's turn and teaches
// them to uninstall the guard; a wrong warning costs a line of context. The
// caller may escalate per area, but the server never decides to block on its
// own.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/check', express.json(), async (req, res) => {
  const names: string[] = Array.isArray(req.body?.names)
    ? req.body.names.filter((n: unknown): n is string => typeof n === 'string' && !!n.trim())
      .map((n: string) => n.trim().toLowerCase())
    : [];
  const project = typeof req.body?.project === 'string' && req.body.project.trim()
    ? req.body.project.trim() : null;
  const via = typeof req.body?.via === 'string' ? req.body.via : null;

  // Nothing named means nothing to check, which is the overwhelmingly common
  // answer. Return before opening the graph so the hook stays cheap enough to
  // run on every tool call.
  if (names.length === 0) return res.json({ verdict: 'allow', findings: [] });

  const kg = await createKnowledgeGraph();
  try {
    const [decided, rejected, chosenOver] = await Promise.all([
      kg.queryRelationship('decided') as Promise<Fact[]>,
      kg.queryRelationship('rejected') as Promise<Fact[]>,
      kg.queryRelationship('chosen_over') as Promise<Fact[]>,
    ]);

    const want = new Set(names);
    const findings: Array<{
      name: string; area: string | null; instead: string | null;
      since: string | null; source_session: string | null; reason: string;
    }> = [];

    // 1. The strong signal: this name is the live decision's LOSER. `chosen_over`
    //    is subject=winner, object=loser, so a hit names both sides.
    for (const c of chosenOver) {
      if (c.valid_to !== null) continue;
      const loser = c.object.trim().toLowerCase();
      if (!want.has(loser)) continue;
      findings.push({
        name: loser, area: null, instead: c.subject,
        since: c.valid_from ?? c.recorded_at ?? null, source_session: c.source_session ?? null,
        reason: `${c.subject} was chosen over ${c.object}`,
      });
    }

    // 2. Recorded as rejected outright, with no winner named.
    for (const r of rejected) {
      if (r.valid_to !== null) continue;
      const name = r.object.trim().toLowerCase();
      if (!want.has(name)) continue;
      if (findings.some((f) => f.name === name)) continue;
      findings.push({
        name, area: null, instead: null,
        since: r.valid_from ?? r.recorded_at ?? null, source_session: r.source_session ?? null,
        reason: `${r.object} was rejected`,
      });
    }

    // 3. An area is decided and this is not what it decided. Scoped to the
    //    project when one is given, so a client repo's own override is what its
    //    agents are held to rather than the account default.
    const scopes = project ? [project, ACCOUNT_SCOPE] : [ACCOUNT_SCOPE];
    const live = new Map<string, Fact>();
    for (const d of decided) {
      if (d.valid_to !== null) continue;
      const parsed = parseDecisionSubject(d.subject);
      if (!parsed) continue;
      // Most specific scope wins, matching GET / above.
      const rank = scopes.indexOf(parsed.project);
      if (rank < 0) continue;
      const prev = live.get(parsed.area);
      const prevRank = prev ? scopes.indexOf(parseDecisionSubject(prev.subject)!.project) : 99;
      if (!prev || rank < prevRank) live.set(parsed.area, d);
    }
    for (const [area, d] of live) {
      const settled = d.object.trim().toLowerCase();
      for (const n of want) {
        if (n === settled || settled.includes(n)) continue;   // already the decision
        if (inferArea(n) !== area) continue;                   // different question
        if (findings.some((f) => f.name === n)) continue;
        findings.push({
          name: n, area, instead: d.object,
          since: d.valid_from ?? d.recorded_at ?? null, source_session: d.source_session ?? null,
          reason: `${area} is decided: ${d.object}`,
        });
      }
    }

    res.json({
      verdict: findings.length ? 'warn' : 'allow',
      via,
      findings,
    });
  } catch (error) {
    // A guard that fails closed would block work whenever the server hiccups,
    // which is how a safety feature becomes the thing people disable.
    log.error({ err: error }, 'decision check failed');
    res.json({ verdict: 'allow', findings: [], error: 'check unavailable' });
  } finally {
    await kg.close();
  }
});

export default router;
