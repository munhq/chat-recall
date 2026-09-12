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
  canonArea, decisionSubject, parseDecisionSubject, isKnownArea,
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
      since: r.current.valid_from,
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
          last: [prev?.last ?? '', c.valid_from ?? ''].sort().pop() || null,
        });
      }
      candidates = [...seen.values()]
        .sort((a, b) => b.mentions - a.mentions)
        .slice(0, 25)
        .map((c) => ({ area: null, value: c.value, mentions: c.mentions, last_seen: c.last }));
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

export default router;
