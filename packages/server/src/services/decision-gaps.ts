/**
 * Decision gaps — a project that never decided something, as a fileable finding.
 *
 * ── The loop this closes ────────────────────────────────────────────────────
 *
 * The register is push-only: a decision exists because somebody asserted it.
 * Nothing ever asks "which projects have not?", so a project with no opinion
 * inherits one — and on one production account eight decisions recorded from
 * inside a single repository became every other project's stack. A Tauri app
 * whose store is `rusqlite` was told its database decision was Postgres, and
 * the only way anybody found out was by reading the register and not believing
 * it.
 *
 * So: the server says which (project, area) pairs have no answer of their own,
 * auto-tasks files them on the board, and the agent that picks a card up reads
 * the repository — where the answer has been sitting in a manifest the whole
 * time — records it at project scope, and the card closes itself because the
 * gap is no longer reported. The scan runs agent-side, because the repository
 * is on the agent's machine and never on this one.
 *
 * ── Why inheriting ranks above blank ────────────────────────────────────────
 *
 * Two different problems wear the same shape:
 *
 *   INHERITED  The cascade answers, from a tier that never looked at this
 *              repository. The register states something false about the
 *              project, and an agent reading it before choosing a library acts
 *              on it. Filed at medium.
 *   BLANK      Nobody has decided anywhere. The register says so honestly and
 *              nothing is wrong — it is just unrecorded. Filed at low.
 *
 * Both are gaps and both are worth a card. Only the first is a wrong answer, so
 * only the first files under the default policy floor. That is also what keeps
 * the volume sane: twelve areas across every project is a big number, and the
 * priority floor the policy already has is the knob that governs it.
 */
import {
  DECISION_AREAS, ACCOUNT_SCOPE, decisionProjectAliases, workspaceFromPath,
  parseDecisionSubject, scopeKind,
  type DecisionArea,
} from '@chat-recall/engine/core/decision-areas.js';
import { createHash } from 'node:crypto';

/** A gap, in the shape auto-tasks files from. */
export interface DecisionGap {
  /** Stable id. A gap's id IS its identity — it is derived from nothing that moves. */
  id: string;
  identity: string;
  pri: 2 | 3;
  title: string;
  /** The card body: what the register says now and why that is a problem. */
  fix: string;
  /** What the agent that picks the card up should do. */
  agentPrompt: string;
  projectId: string;
  projectPath: string;
  area: DecisionArea;
  /** Whether a broader tier already answers this, and with what. */
  inherited: { value: string; from: string } | null;
  category: 'decisions';
  loc: Array<{ file: string; line: number | null }>;
  covers: string[];
}

/** The `decided` rows this service needs, in the shape the graph returns them. */
export interface DecidedFact {
  subject: string;
  object: string;
  valid_to: string | null;
}

/** One indexed project. */
export interface ProjectRef {
  project_id: string;
  project_path: string;
}

/** A gap id that survives a rename of anything that is not the key itself. */
function gapId(projectKey: string, area: string): string {
  return 'dg_' + createHash('sha1').update(`${projectKey}\u0000${area}`).digest('hex').slice(0, 16);
}

/** The repository's own name, for a title a person recognises. */
function projectName(ref: ProjectRef): string {
  const base = (ref.project_path || '').replace(/\\/g, '/').split('/').filter(Boolean).pop();
  return base || ref.project_id;
}

/** How a scope key reads in a sentence. */
function scopeLabel(key: string): string {
  if (key === ACCOUNT_SCOPE) return 'the account';
  if (scopeKind(key) === 'workspace') return `the ${key.replace(/^ws:/, '')} folder group`;
  if (scopeKind(key) === 'user') return 'a personal preference';
  return key;
}

/**
 * Which areas each scope key has a live answer for.
 *
 * One pass over every `decided` row, because the alternative is a graph query
 * per project per area and there are twelve areas.
 */
export function areasByScope(decided: DecidedFact[]): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const f of decided) {
    if (f.valid_to !== null) continue;          // superseded; it decides nothing now
    const parsed = parseDecisionSubject(f.subject);
    if (!parsed) continue;                       // free-text subject from before areas
    const areas = out.get(parsed.project) ?? new Map<string, string>();
    // First live value wins, matching the register's own resolution.
    if (!areas.has(parsed.area)) areas.set(parsed.area, f.object);
    out.set(parsed.project, areas);
  }
  return out;
}

/**
 * Every (project, area) with no decision of the project's own.
 *
 * "Its own" means project scope or the folder group it sits in. An answer that
 * comes from the account or from somebody's personal preferences is exactly the
 * case this reports, because neither of those tiers ever saw the repository.
 */
export function listDecisionGaps(
  projects: ProjectRef[],
  decided: DecidedFact[],
  opts: { userId?: string | null } = {},
): DecisionGap[] {
  const byScope = areasByScope(decided);
  const out: DecisionGap[] = [];

  for (const ref of projects) {
    if (!ref.project_path) continue;             // nothing for an agent to scan
    const keys = decisionProjectAliases(ref.project_id, ref.project_path);
    const workspace = workspaceFromPath(ref.project_path);
    const name = projectName(ref);

    /** The tiers that count as the project's own answer. */
    const own = [...keys, ...(workspace ? [workspace] : [])];
    /** The tiers that answer for it without having seen it. */
    const broader = [ACCOUNT_SCOPE, ...(opts.userId ? [`user:${opts.userId}`] : [])];

    for (const area of DECISION_AREAS) {
      if (own.some((k) => byScope.get(k)?.has(area))) continue;

      const fromKey = broader.find((k) => byScope.get(k)?.has(area));
      const inherited = fromKey
        ? { value: byScope.get(fromKey)!.get(area)!, from: scopeLabel(fromKey) }
        : null;

      const key = keys[0];
      out.push({
        id: gapId(key, area),
        identity: gapId(key, area),
        pri: inherited ? 2 : 3,
        title: inherited
          ? `${name} inherits its ${area} decision from ${inherited.from}`
          : `No ${area} decision for ${name}`,
        fix: inherited
          ? [
              `The register answers \`${area}\` for ${name} with **${inherited.value}**, decided at `
              + `${inherited.from}. Nothing in this repository was read to arrive at that, so it is `
              + `what somebody else decided, printed under this project's name.`,
              `Record what ${name} actually uses, or confirm the inherited value applies here. `
              + `Either way it becomes an answer this project owns.`,
            ].join('\n\n')
          : `Nobody has decided \`${area}\` for ${name}, at any scope. If the repository already `
            + `answers it, record the answer so the next session inherits it instead of choosing again.`,
        agentPrompt: agentPrompt(name, ref.project_path, area, inherited),
        projectId: ref.project_id,
        projectPath: ref.project_path,
        area,
        inherited,
        category: 'decisions',
        loc: [],
        covers: [],
      });
    }
  }

  return out;
}

/**
 * What the agent that picks the card up is asked to do.
 *
 * Written as a procedure because the failure it guards against is an agent
 * asserting a decision from nothing — which is how the eight account rows got
 * written in the first place. Evidence, or a question to the user. Never a
 * guess.
 */
function agentPrompt(
  name: string,
  path: string,
  area: DecisionArea,
  inherited: { value: string; from: string } | null,
): string {
  return [
    `Record the \`${area}\` decision for ${name} (${path}).`,
    '',
    inherited
      ? `Right now the register answers this with "${inherited.value}", inherited from ${inherited.from}. `
        + `Nobody checked that against this repository.`
      : `Nothing is recorded for this area at any scope.`,
    '',
    '1. Run `recall_decision_scan` in the repository. It reads the manifests and reports',
    `   which product answers \`${area}\`, with the file and line it read.`,
    '2. Run `recall_decisions` for the folder group, so a sibling project that already',
    '   decided this area is what you follow rather than a second answer to one question.',
    '3. If the scan found evidence, record it:',
    `   recall_decision_record(area: "${area}", project: "${name}", scope: "project",`,
    '     decision: <the product>, reason: <the file and line the scan named>)',
    '4. If the scan found nothing, ASK THE USER in this conversation which it is, and',
    '   record their answer with their words as the reason. Do not infer one from the',
    '   code, and do not record a decision nobody made.',
    '5. If the area does not apply to this repository at all, reject the card. Rejecting',
    '   is a verdict the board keeps — the card will not come back.',
    '',
    'The card closes itself once the project has an answer of its own.',
  ].join('\n');
}
