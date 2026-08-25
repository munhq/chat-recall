/**
 * Merge layer for `recall_claude_suggestions` and `recall_improvements`.
 *
 * These two MCP tools do NOT compute recommendations. The engines that do are
 * `buildAccountRecommendations` and `buildRecommendations` in
 * `engine/src/core/code/recommendations.ts`, plus the code-action collector.
 * This module only does what a caller of several of those endpoints has to do
 * anyway: partition the output by what the item asks you to change, and put two
 * different priority scales into one honest order.
 *
 * It lives apart from `mcp.ts` because importing that file starts a server and
 * reads credentials, so nothing in it can be unit tested. Everything here is
 * pure: same input, same output, no I/O.
 */

/** A Recommendation as `engine/core/code/recommendations.ts` emits it. */
export interface EngineRec {
  id: string;
  kind: string;
  severity: Severity;
  title: string;
  rationale: string;
  evidence: string[];
  action: { type: string; payload: Record<string, unknown> };
}

/** A CodeActionRow as `GET /api/code/actions` returns it. */
export interface EngineAction {
  id: string;
  projectId: string;
  pri: number;
  category: string;
  title: string;
  fix: string;
  loc: Array<{ file: string; line?: number | null }>;
  agentPrompt: string;
  status: string;
}

export type Severity = 'high' | 'medium' | 'low';

/** One row of the merged, ranked improvements list. */
export interface Improvement {
  /** Lower sorts first, matching CodeAction.pri where 0 is the most urgent. */
  rank: number;
  severity: Severity;
  title: string;
  detail: string;
  source: string;
  project?: string;
  where: string[];
  agentPrompt?: string;
}

/**
 * Recommendation kinds that change agent instructions rather than code.
 *
 * This constant is what partitions the two tools. `recall_claude_suggestions`
 * takes these; `recall_improvements` takes the rest. They never both return the
 * same recommendation, so acting on one list cannot silently duplicate work
 * from the other.
 */
export const INSTRUCTION_KINDS = ['rule', 'skill'] as const;

export const SEVERITIES = ['high', 'medium', 'low'] as const;

/** `high` → 0. Lower sorts first, so this shares CodeAction.pri's direction. */
export function sevRank(sev: string): number {
  return sev === 'high' ? 0 : sev === 'medium' ? 1 : 2;
}

/**
 * Map a code action's numeric `pri` onto the three severity bands the
 * recommendations use.
 *
 * The bands are deliberately coarse. `pri` is an ordering, not a measurement,
 * so inventing more than three levels would claim a precision the collector
 * never had. A negative or non-finite `pri` is treated as most urgent rather
 * than dropped: a malformed row must not silently vanish from the plan.
 */
export function priToSeverity(pri: number): Severity {
  if (!Number.isFinite(pri) || pri <= 0) return 'high';
  return pri === 1 ? 'medium' : 'low';
}

/** Split one scope's recommendations into the two tools' halves. */
export function partitionRecs(recs: EngineRec[]): { instruction: EngineRec[]; improvement: EngineRec[] } {
  const kinds: readonly string[] = INSTRUCTION_KINDS;
  const instruction: EngineRec[] = [];
  const improvement: EngineRec[] = [];
  for (const rec of recs) (kinds.includes(rec.kind) ? instruction : improvement).push(rec);
  return { instruction, improvement };
}

/** Turn an unfinished code action into an improvement row. */
export function actionToImprovement(a: EngineAction): Improvement {
  return {
    rank: typeof a.pri === 'number' && Number.isFinite(a.pri) ? a.pri : 2,
    severity: priToSeverity(a.pri),
    title: a.title,
    detail: a.fix,
    source: `code action · ${a.category}`,
    project: a.projectId,
    where: (a.loc ?? []).map((l) => (l.line ? `${l.file}:${l.line}` : l.file)),
    agentPrompt: a.agentPrompt,
  };
}

/** Turn a non-instruction recommendation into an improvement row. */
export function recToImprovement(rec: EngineRec, scope: string): Improvement {
  return {
    rank: sevRank(rec.severity),
    severity: rec.severity,
    title: rec.title,
    detail: rec.rationale,
    source: `recommendation · ${rec.kind}`,
    project: scope === 'account' ? undefined : scope,
    where: rec.evidence ?? [],
  };
}

/** A code action that is already finished or waved off is not an improvement. */
export function isOpenAction(a: EngineAction): boolean {
  return a.status !== 'done' && a.status !== 'dismissed';
}

/**
 * Filter to `minSeverity` and above, order most urgent first, then cap.
 *
 * Ties break on title so the same inputs always produce the same order — a
 * caller that opens tasks from this list must not get a different set of cards
 * on a re-run just because two items scored the same.
 */
export function rankImprovements(
  items: Improvement[],
  opts: { minSeverity: Severity; limit: number },
): Improvement[] {
  const floor = sevRank(opts.minSeverity);
  return items
    .filter((i) => sevRank(i.severity) <= floor)
    .sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title))
    .slice(0, Math.max(0, opts.limit));
}

/** Order agent-instruction suggestions: most severe first, then by title. */
export function rankInstructions<T extends { rec: EngineRec }>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) => sevRank(a.rec.severity) - sevRank(b.rec.severity) || a.rec.title.localeCompare(b.rec.title),
  );
}

/** The task description written when `create_tasks` opens a card. */
export function taskBody(i: Improvement): string {
  const parts = [i.detail, '', `Source: ${i.source}`];
  if (i.where.length) parts.push(`Where: ${i.where.slice(0, 10).join('; ')}`);
  if (i.agentPrompt) parts.push('', 'Agent prompt:', i.agentPrompt);
  parts.push('', 'Opened by recall_improvements.');
  return parts.join('\n').slice(0, 20000);
}
