/**
 * GET /api/decisions — the decision register, already resolved.
 *
 * ── Why the server resolves, not the caller ─────────────────────────────────
 *
 * A decision exists at four scopes and they disagree on purpose: the account
 * says BetterAuth, every repository in one folder group says Keycloak, one
 * client's repository says Auth0, and an individual has habits that bind
 * nobody. Handing an agent four layers and asking it to work out which wins
 * produces a different answer per model and per prompt. So the cascade runs
 * here, once, and both callers — the MCP tool and the dashboard — get one
 * effective value per area with its provenance attached.
 *
 * Precedence, most specific first:
 *
 *   project  >  workspace  >  account  >  user
 *
 * The workspace tier is the folder group a repository sits in (`ws:personal`
 * for everything under `code/personal`, see core/decision-areas.ts). It is
 * derived from the folder above the repository, so it holds across machines:
 * `/home/user/code/personal/example-app` and `/Users/alice/code/personal/other-app`
 * resolve to the same group.
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
import { createKnowledgeGraph, createStore, createControlPlane } from '../imports.js';
import {
  canonArea, decisionSubject, parseDecisionSubject, isKnownArea, inferArea,
  DECISION_AREAS, ACCOUNT_SCOPE,
  scopeChain, scopeKind, workspaceScope, workspaceFromPath,
  decisionProjectAliases,
  type DecisionScopeKind,
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
  /** Who asserted it. A byline only — it does not gate who can read the row. */
  author_sub?: string | null;
};

export interface DecisionRow {
  area: string;
  /** True when `area` is one of the canonical areas rather than a slug. */
  known: boolean;
  value: string;
  since: string | null;
  why: string | null;
  source_session: string | null;
  /** Who decided it, for a reader who was not in the room. Null when unknown. */
  by: string | null;
  /** Which tier the winning value came from. */
  scope: DecisionScopeKind;
  /** The exact scope key, so the caller can name the group it inherited from. */
  scope_key: string;
  /** The value applies here but was decided at a broader scope. */
  inherited: boolean;
  /** This scope deliberately disagrees with a broader one. */
  override: boolean;
  /** A personal preference. Fills a gap; binds nobody. */
  advisory: boolean;
  /** What this replaced, newest first. Empty when nothing was superseded. */
  history: Array<{ value: string; from: string | null; to: string | null; current: boolean; by: string | null }>;
}

/**
 * Which scope a write lands on.
 *
 * A write that cannot tell which scope it meant does NOT fall back to the
 * account: eight rows already reached the account register that way, and every
 * project then inherited one repository's stack. So a named scope with nothing
 * to key it on is an error, and only a caller that named no scope at all gets
 * the account.
 */
function writeScope(
  body: Record<string, unknown>,
  /** The canonical key for the project named in the body, already resolved. */
  projectKey: string | null,
): { key: string } | { error: string } {
  const scope = typeof body.scope === 'string' ? body.scope : null;
  // The caller's spelling never reaches the graph: a write always lands on the
  // canonical key, so the dashboard and an agent cannot file the same project's
  // decisions in two places.
  const project = projectKey
    ?? (typeof body.project === 'string' && body.project.trim() ? body.project.trim() : null);
  const ws = typeof body.workspace === 'string' && body.workspace.trim()
    ? workspaceScope(body.workspace.trim()) : null;

  if (scope === 'account') return { key: ACCOUNT_SCOPE };
  if (scope === 'workspace') {
    return ws ? { key: ws } : { error: 'workspace scope needs a workspace name' };
  }
  if (scope === 'project') {
    return project ? { key: project } : { error: 'project scope needs a project' };
  }
  // No scope named: the narrowest thing the caller identified, so a decision
  // binds as little as the caller actually asked for.
  return { key: project ?? ws ?? ACCOUNT_SCOPE };
}

/** A trimmed query-string value, or null when it was absent or empty. */
function qs(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Member sub → the name a teammate recognises (their email).
 *
 * Membership lives in the control plane, keyed by team slug = tenant. This is
 * best-effort on purpose: an author who has left the team, or an agent token
 * minted without a user, has no row here and shows no name rather than
 * blocking the register.
 */
async function nameBySub(tenant: string | undefined): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!tenant) return out;
  const cp = await createControlPlane();
  try {
    for (const m of await cp.listMembers(tenant)) {
      if (m.email) out.set(m.user_sub, m.email);
    }
  } catch {
    // No control plane (self-host without teams) — the register still answers.
  } finally {
    await cp.close();
  }
  return out;
}

/**
 * Everything the cascade needs to know about the project the caller named.
 *
 * The caller names it the way its own surface does: the dashboard passes a
 * project_id, an agent passes whatever the user typed, a hook may pass a path.
 * All three are matched against the indexed projects, and all three come back
 * as ONE key — or a repository grows a second register the first time someone
 * records a decision from the other surface, and each half looks complete.
 *
 * `keys` is that canonical key followed by older spellings the same project's
 * decisions may already sit under. Reads walk them in order; writes only ever
 * use `keys[0]`. Without the tail, canonicalising would silently orphan every
 * decision recorded before it.
 */
async function projectScope(project: string): Promise<{ keys: string[]; workspace: string | null }> {
  // A group id names a group, not a repository inside one.
  if (project.startsWith('ws:')) return { keys: [project], workspace: project };

  const store = await createStore();
  try {
    const rows = await store.listAllProjectIdPaths();
    const wanted = project.replace(/\/+$/, '');
    const base = wanted.split('/').filter(Boolean).pop() || wanted;
    const hit =
      rows.find((r) => r.project_id === wanted) ??
      rows.find((r) => r.project_path === wanted) ??
      rows.find((r) => (r.project_path || '').split('/').filter(Boolean).pop() === base) ??
      rows.find((r) => r.project_id.endsWith(`/${base}`));
    if (!hit) return { keys: [project], workspace: null };
    return {
      keys: decisionProjectAliases(hit.project_id, hit.project_path, project),
      workspace: workspaceFromPath(hit.project_path),
    };
  } catch {
    // Nothing indexed under that name yet. The caller's own spelling is the
    // only key there is, and the cascade still answers from the broader tiers.
    return { keys: [project], workspace: null };
  } finally {
    await store.close();
  }
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
      by: f.author_sub ?? null,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/decisions?project=<id>&include_candidates=1
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const project = qs(req.query.project);
  // The signed-in person, so the advisory tier is their OWN preferences and not
  // a tier any caller can ask for on someone else's behalf. The query param is
  // the fallback for a self-hosted server that runs without auth, where there
  // is no session to read an identity from.
  const userId = req.userId ?? qs(req.query.user);
  const wantCandidates = req.query.include_candidates !== '0';

  // One lookup answers both: which key this project's decisions live under, and
  // which folder group it sits in. A caller with the checkout in front of it
  // may name the group itself; otherwise the indexed path answers it, so the
  // dashboard resolves the same group without a filesystem of its own.
  const scope = project ? await projectScope(project) : { keys: [], workspace: null };
  const workspace = qs(req.query.workspace) ?? scope.workspace;

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

    // Every tier in view, most specific first. The winner for an area is the
    // first tier that has one — the cascade is the order of this array, so a
    // new tier is added by putting it in the chain, not by another branch here.
    const chain = scopeChain({ project: scope.keys, workspace, userId });
    const rowsByScope = new Map(chain.map((key) => [key, atScope(key)] as const));

    // Who decided what. A decision with no name on it reads as nobody's, and on
    // a team the next question after "what was decided" is always "by whom".
    // Skipped entirely when no row carries an author, which is every
    // single-user install — no name to look up, so no control-plane round trip.
    const anyAuthor = [...rowsByScope.values()].some((m) => [...m.values()].some(
      (r) => r.current.author_sub || r.history.some((h) => h.by)));
    const names = anyAuthor ? await nameBySub(req.tenant) : new Map<string, string>();
    const who = (sub: string | null | undefined): string | null =>
      (sub ? names.get(sub) ?? null : null);

    const row = (
      area: string,
      r: { current: Fact; history: DecisionRow['history'] },
      scopeKey: string,
      opts: { inherited?: boolean; override?: boolean } = {},
    ): DecisionRow => {
      const kind = scopeKind(scopeKey);
      return {
        area,
        known: isKnownArea(area),
        value: r.current.object,
        // Facts asserted before addTriple stamped a date have no valid_from, and
        // a decision without a date persuades nobody. The write date is when
        // somebody recorded it, so it answers "since when" for those rows.
        since: r.current.valid_from ?? r.current.recorded_at ?? null,
        why: why.get(r.current.subject) ?? why.get(decisionSubject(scopeKey, area)) ?? null,
        source_session: r.current.source_session ?? null,
        by: who(r.current.author_sub),
        scope: kind,
        scope_key: scopeKey,
        inherited: !!opts.inherited,
        override: !!opts.override,
        advisory: kind === 'user',
        history: r.history.map((h) => ({ ...h, by: who(h.by) })),
      };
    };

    // Resolve every area anyone has an opinion about, in precedence order.
    const areas = new Set<string>();
    for (const rows of rowsByScope.values()) for (const a of rows.keys()) areas.add(a);

    const decisions: DecisionRow[] = [];
    for (const area of areas) {
      const winnerIdx = chain.findIndex((key) => rowsByScope.get(key)!.has(area));
      if (winnerIdx < 0) continue;
      const key = chain[winnerIdx];
      const r = rowsByScope.get(key)!.get(area)!;
      // A broader tier that also decided this area. Below the winner it is what
      // the winner overrides; the winner itself is inherited when the caller
      // asked about a narrower scope than the one that answered.
      const broader = chain.slice(winnerIdx + 1)
        .filter((k) => scopeKind(k) !== 'user')
        .some((k) => rowsByScope.get(k)!.has(area));
      const kind = scopeKind(key);
      decisions.push(row(area, r, key, {
        override: kind !== 'account' && kind !== 'user' && broader,
        inherited: !!project && kind !== 'project' && kind !== 'user',
      }));
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
      /** The key a write for this project lands on, whatever spelling was asked. */
      project_key: scope.keys[0] ?? null,
      workspace,
      chain,
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
  const { area: rawArea, value, reason, session_id } = req.body ?? {};
  const area = canonArea(typeof rawArea === 'string' ? rawArea : null);
  if (!area) return res.status(400).json({ error: 'area is required' });
  if (typeof value !== 'string' || !value.trim()) return res.status(400).json({ error: 'value is required' });

  const named = typeof req.body?.project === 'string' && req.body.project.trim()
    ? req.body.project.trim() : null;
  const target = writeScope(req.body ?? {}, named ? (await projectScope(named)).keys[0] : null);
  if ('error' in target) return res.status(400).json({ error: target.error });

  const kg = await createKnowledgeGraph();
  try {
    const subject = decisionSubject(target.key, area);
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
  const { value, action, area: rawArea, reason, session_id } = req.body ?? {};
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
      const named = typeof req.body?.project === 'string' && req.body.project.trim()
        ? req.body.project.trim() : null;
      const scopeTarget = writeScope(req.body ?? {}, named ? (await projectScope(named)).keys[0] : null);
      if ('error' in scopeTarget) return res.status(400).json({ error: scopeTarget.error });
      const subject = decisionSubject(scopeTarget.key, area);
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

  // Resolved only once something is actually being checked. The caller names
  // the group when it knows it; the indexed path answers otherwise.
  const scope = project ? await projectScope(project) : { keys: [], workspace: null };
  const workspace = typeof req.body?.workspace === 'string' && req.body.workspace.trim()
    ? req.body.workspace.trim()
    : scope.workspace;

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
    const scopes = scopeChain({ project: scope.keys, workspace });
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
