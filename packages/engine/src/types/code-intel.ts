/**
 * Code-intelligence types — the data the `codeindex` Zig engine produces,
 * enriched by the local collector (git churn, AI-authorship, complexity,
 * action-plan synthesis) and synced into the server's Postgres `code_*` tables.
 *
 * Four persisted shapes:
 *   - CodeProject  : one row per indexed project (counts, langs, health, map, label)
 *   - CodeFinding  : security / literal / clone / dup / dead-code / coupling / cycle
 *   - CodeHotspot  : per-file churn × complexity score + AI-authorship
 *   - CodeAction   : the ranked, actionable plan — the durable task queue
 *
 * Findings and hotspots are derived/regenerable (replaced wholesale on each
 * re-index). Actions carry user state (queued/done/dismissed) and are upserted
 * by deterministic id so re-indexing refreshes content without losing state.
 */

import { createHash } from 'crypto';

export type CodeFindingCategory =
  | 'security' | 'literal' | 'clone' | 'duplication' | 'dead_code' | 'coupling' | 'cycle'
  | 'unwrap' | 'coverage' | 'architecture'
  // Recovered count-only analyzers, now per-item findings:
  | 'crossref' | 'type_drift' | 'schema' | 'migration' | 'manifest';

export type CodeSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** Findings carry no durable user state beyond dismissal; status/queue lives on actions. */
export type CodeFindingStatus = 'open' | 'dismissed';

export type CodeActionStatus = 'suggested' | 'queued' | 'done' | 'dismissed';

/** Project intent label — gates downstream recommendations (POC → offer db reset, etc). */
export type CodeProjectLabel = 'poc' | 'production' | 'engineering';

// ── Project ───────────────────────────────────────────────────────────────

export interface CodeHealth {
  /** 0–100 composite health score (higher is better). */
  score: number;
  findings: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  hotspots: number;
  /** Share of files touched by AI-authored commits, 0–1. */
  aiAuthoredPct: number;
  /** Aggregate counts from count-only analyzers (crossref, type_drift,
   *  db_schema, migration_parity, manifest_compliance) — no per-item detail. */
  stats?: Record<string, number>;
  /** AI-authorship detail (POC parity): commits carrying AI markers / total. */
  aiCommits?: number;
  totalCommits?: number;
  /** codeindex token-savings vs reading the whole tree (status.savings_pct). */
  savingsPct?: number;
  totalLines?: number;
  totalBytes?: number;
  naiveTokens?: number;
  outlineTokens?: number;
  latestSeq?: number;
  watcher?: boolean;
}

export interface CodeMapNode {
  file: string;
  pkg?: string;
  symbols: number;
  lines: number;
  lang?: string;
}
export interface CodeMapEdge { from: string; to: string; }

/** Per-file coupling metrics (POC Structure tables: fan-in/fan-out/instability). */
export interface CodeCouplingMetric { file: string; fanIn: number; fanOut: number; instability: number; }

/** plan_change blast radius for a file — "what breaks if I touch this". Keyed by
 *  file in CodeMap.blast; surfaced in the hotspot/finding drawer as impact. */
export interface CodeBlastRadius {
  /** god_module | stable_core | driver | island | regular */
  fileRole: string;
  fanIn: number;
  fanOut: number;
  /** files that import this file directly */
  direct: number;
  /** files reachable transitively (blast radius) */
  transitive: number;
  maxDepth: number;
  /** sample of directly-impacted files (capped) */
  directFiles?: string[];
}

/** Dependency graph + structure buckets — render-only blob stored on the project. */
export interface CodeMap {
  nodes: CodeMapNode[];
  edges: CodeMapEdge[];
  buckets: {
    god_modules: string[];
    stable_cores: string[];
    unstable_drivers: string[];
    islands: string[];
    cycles: string[][];
  };
  /** Package → its files, for click-to-drill-down (POC drawFiles parity). */
  pkgFiles?: Record<string, string[]>;
  /** File-level dependency edges (drill-down graph). */
  fileEdges?: CodeMapEdge[];
  /** Per-file metadata for the drill-down graph. */
  fileMeta?: Record<string, { symbols: number; lang: string }>;
  /** language → symbol count (POC sizes the language bars by symbols). Lives on
   *  the map so it round-trips through map_json without a new column. */
  langSymbols?: Record<string, number>;
  /** file → plan_change blast radius. Lives on the map so it round-trips through
   *  map_json without a new column; the hotspot drawer joins on file. */
  blast?: Record<string, CodeBlastRadius>;
  /** Coupling tiers WITH metrics (POC Structure tables: file/in/out/I). */
  coupling?: {
    god_modules: CodeCouplingMetric[];
    stable_cores: CodeCouplingMetric[];
    unstable_drivers: CodeCouplingMetric[];
    islands: CodeCouplingMetric[];
  };
}

export interface CodeProjectInput {
  projectId: string;
  rootPath: string;
  fileCount: number;
  symbolCount: number;
  /** language → file count */
  langs: Record<string, number>;
  health: CodeHealth;
  map: CodeMap;
  label?: CodeProjectLabel | null;
  /** device id that produced this index */
  indexedBy?: string | null;
  lastIndexedAt: number;
  /** Collector logic version that produced this data (see COLLECTOR_VERSION).
   *  Lets the watch daemon re-derive projects indexed by an older collector. */
  collectorVersion?: number | null;
}

export interface CodeProjectRow extends CodeProjectInput {
  createdAt: number;
  updatedAt: number;
}

// ── Finding ─────────────────────────────────────────────────────────────────

export interface CodeFindingInput {
  /** Deterministic id (hash of project|category|file|line|rule); computed if absent. */
  id?: string;
  category: CodeFindingCategory;
  severity: CodeSeverity;
  file: string;
  line?: number | null;
  rule: string;
  title: string;
  snippet?: string;
  /** "why it matters" copy, server/collector-authored. */
  why?: string;
  /** ready-to-paste agent prompt that references codeindex tools. */
  agentPrompt?: string;
  extra?: Record<string, unknown>;
}

export interface CodeFindingRow extends Required<Omit<CodeFindingInput, 'extra'>> {
  projectId: string;
  status: CodeFindingStatus;
  firstSeenAt: number;
  lastSeenAt: number;
  extra: Record<string, unknown>;
}

export interface CodeFindingsSummary {
  total: number;
  bySeverity: Record<CodeSeverity, number>;
  byCategory: Record<string, number>;
}

// ── Hotspot ───────────────────────────────────────────────────────────────

export interface CodeHotspotInput {
  file: string;
  churn: number;
  complexity: number;
  /** churn × complexity */
  score: number;
  aiAuthored: boolean;
  lines: number;
  /** Actionable one-liner (POC suggest()): god-module/security/clone/churn/AI. */
  suggestion: string;
}

export interface CodeHotspotRow extends CodeHotspotInput {
  projectId: string;
  id: string;
  lastSeenAt: number;
}

// ── Action (the durable, actionable plan) ───────────────────────────────────

export interface CodeActionLoc { file: string; line?: number | null; }

export interface CodeActionInput {
  /** Deterministic id (hash of project|category|title|primary-loc); computed if absent. */
  id?: string;
  /** 0 = highest priority. */
  pri: number;
  category: string;
  title: string;
  fix: string;
  loc: CodeActionLoc[];
  agentPrompt: string;
  /**
   * Finding ids this action ROLLS UP, stamped by the collector.
   *
   * An action is a summary of findings the same run also emitted — "unwrap — 12
   * occurrence(s)" over twelve unwrap findings, "_callWithFeeRetry copy-pasted
   * 30×" over the clone finding for that group. Both are fileable, so without
   * this the board gets a card for the summary AND a card for each member: three
   * cards for one problem, observed as `_callWithFeeRetry ×30` next to
   * `_callWithFeeRetry copy-pasted 30× (10 lines each)`.
   *
   * WHY IT IS STAMPED AT THE SOURCE. The collector is the only place that knows
   * the parentage — it builds both from the same analyzer output. Anything
   * downstream has to guess from titles, and the titles are worded differently
   * for the same problem, so the guess is wrong in both directions. Absent on
   * anything an older collector sent, which simply means no suppression.
   */
  covers?: string[];
}

export interface CodeActionRow extends Required<Omit<CodeActionInput, never>> {
  projectId: string;
  status: CodeActionStatus;
  queued: boolean;
  createdAt: number;
  updatedAt: number;
}

// ── Priority ↔ severity, in ONE place ───────────────────────────────────────
/**
 * The canonical reading of a code action's numeric `pri`.
 *
 * It was read two different ways: the task board called pri 1 "high" while the
 * CLI's priToSeverity() called the same row "medium", so one finding wore two
 * severities depending on which screen you were looking at. This is the single
 * definition; both sides now import it.
 *
 * Note what the COLLECTOR actually emits: pri 0 only for critical security
 * findings, pri 1 for high security and heavy duplication, pri 2 for everything
 * structural. pri 3 exists so a policy can say "file everything" without
 * pretending the collector ranks that finely.
 */
export const PRI_SEVERITY = ['critical', 'high', 'medium', 'low'] as const;
export type PriSeverity = (typeof PRI_SEVERITY)[number];

export function severityOfPri(pri: number): PriSeverity {
  if (!Number.isFinite(pri) || pri <= 0) return 'critical';
  return PRI_SEVERITY[Math.min(Math.floor(pri), PRI_SEVERITY.length - 1)];
}

/**
 * The inverse, for findings.
 *
 * Actions carry a numeric `pri`; findings carry a `severity` STRING. The
 * auto-filer's policy is expressed in pri, and it only ever read actions — so a
 * finding could not be filed at all, whatever its severity. On one account that
 * meant 34 critical findings (unchecked `unwrap`, and a manifest rule) were
 * structurally incapable of becoming a task while a pri-2 "God module" filed one.
 *
 * 'info' maps to 3 rather than off the end: a policy that says "file everything"
 * should mean it, and clamping is what asMaxPri already does on the other side.
 */
export function priOfSeverity(severity: string): number {
  switch (severity) {
    case 'critical': return 0;
    case 'high': return 1;
    case 'medium': return 2;
    default: return 3;          // low, info, and anything unrecognised
  }
}

// ── Deterministic ids ───────────────────────────────────────────────────────
// Stable across re-index so findings/hotspots/actions upsert in place rather
// than duplicate. Shared by the collector (builds rows) and the store (writes).

function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/**
 * A finding's snippet, reduced to what identifies it.
 *
 * Whitespace only — digits are NOT collapsed here, unlike identityTitle. A
 * title's numbers are counts the collector computed about the finding; a
 * snippet's numbers are the code itself, and `retry(3)` is not `retry(9)`.
 */
function snippetKey(snippet?: string): string {
  return (snippet ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Stable ids for a whole batch of findings.
 *
 * WHY A BATCH. The old id hashed `project|category|file|LINE|rule`, and a line
 * number is the most volatile thing about a finding — every edit above it shifts
 * it. `replaceCodeFindings` carries `status` and `first_seen_at` forward BY ID,
 * so each shift silently discarded a triage verdict and reset the age; and the
 * auto-filer read the same instability as findings appearing and disappearing.
 *
 * Dropping the line is not enough on its own. Measured on 7,670 real findings:
 *
 *   with line                          7,670 distinct  (today — unstable)
 *   without line                       2,464 distinct  (merges real occurrences)
 *   without line, with snippet         4,973 distinct  (still merges ~2,700)
 *
 * Eight `.unwrap()` calls in one file are eight findings with one rule and one
 * snippet text, so no content hash can separate them. What separates them is
 * their ORDER, so identity is content plus an ordinal among identical siblings
 * in the same file. That is stable under edits elsewhere in the file, distinct
 * per occurrence, and shifts only when an identical sibling is added or removed
 * above one — which is the floor of what any scheme can achieve.
 *
 * THE TITLE IS PART OF THE KEY, and leaving it out cost twice.
 *
 * 1. It INVENTED identities. A collector that emits one finding four times — same
 *    category, file, line, rule, snippet, title, why, byte for byte — got four
 *    ids, because the ordinal counted EMISSIONS. Four cards were filed for
 *    `memory-index.ts:53`, and 387 of 8,290 stored findings were duplicates of
 *    this kind. So the ordinal now counts DISTINCT LINES: two findings on the
 *    same line with the same content are one occurrence, and the store's
 *    dedupe-by-id collapses them.
 * 2. It MERGED real ones. 918 findings carry no line at all — `type_drift` names
 *    a type, not a place — so sorting by line was a no-op and the ordinal fell
 *    back to the collector's emit order. 38 distinct missing fields on `AppState`
 *    were separated only by the analyzer's output order, which means re-running
 *    it over unchanged code renumbered them all. What actually distinguishes them
 *    is their title, and once the title is in the key they no longer need an
 *    ordinal to stay apart.
 *
 * `identityTitle` collapses digits, so a title's counts stay out of identity —
 * measured on the same 8,290: nothing distinct merges under that collapse, and it
 * is what keeps "copy-pasted 29×" from becoming a new finding at 30.
 *
 * Returns ids positionally aligned with `findings`; identical siblings on the
 * same line share an id, so the result is not necessarily distinct.
 */
export function codeFindingIds(
  projectId: string,
  findings: ReadonlyArray<{ category: string; file: string; line?: number | null; rule: string; title?: string; snippet?: string }>,
): string[] {
  // Group identical siblings, then order each group by line so the ordinal is a
  // property of position in the file rather than of the collector's emit order.
  const groups = new Map<string, number[]>();
  findings.forEach((f, i) => {
    const key = [f.category, f.file, f.rule, identityTitle(f.title ?? ''), snippetKey(f.snippet)].join('|');
    const g = groups.get(key);
    if (g) g.push(i); else groups.set(key, [i]);
  });

  // -1 for a missing line, never 0: a null line must not collide with line 0, and
  // nulls sort first so their ordinal is stable whatever else the file holds.
  const lineOf = (i: number): number => findings[i].line ?? -1;
  const ids = new Array<string>(findings.length);
  for (const [key, idxs] of groups) {
    idxs.sort((a, b) => lineOf(a) - lineOf(b));
    let ordinal = -1;
    let prevLine = Number.NaN;
    for (const idx of idxs) {
      // A new ordinal per distinct LINE, not per emission. Same line, same
      // content ⇒ same finding, however many times the collector reported it.
      if (lineOf(idx) !== prevLine) { ordinal++; prevLine = lineOf(idx); }
      ids[idx] = 'cf_' + shortHash([projectId, key, ordinal].join('|'));
    }
  }
  return ids;
}

/**
 * Single-finding id. Kept for callers that have one finding and no batch, but
 * PREFER codeFindingIds: without the batch there is no way to know a finding's
 * ordinal among its identical siblings, so this assumes it is the first — which
 * is wrong for the second `.unwrap()` in a file.
 */
export function codeFindingId(
  projectId: string,
  f: { category: string; file: string; line?: number | null; rule: string; snippet?: string },
): string {
  return codeFindingIds(projectId, [f])[0];
}

export function codeHotspotId(projectId: string, file: string): string {
  return 'ch_' + shortHash([projectId, file].join('|'));
}

/**
 * Titles carry COUNTS, and counts move. The collector writes things like
 * "slice copy-pasted 29× (13 lines each)", so one edit turns 29 into 30 and the
 * hash below changes — a new id for the same problem at the same place.
 *
 * That is not cosmetic. The task board links a card to a finding id, and closes
 * the card when the id stops being reported. So a shifting count silently closed
 * a card nobody had fixed and filed a near-identical replacement. Observed in
 * prod: 10 cards filed at 17:32 and closed at 17:38, same findings, new numbers.
 *
 * Digits collapse to '#' for identity only. The stored title keeps its real
 * numbers — this is what the row is KEYED by, not what anyone reads.
 */
export function identityTitle(title: string): string {
  return title.replace(/\d+/g, '#');
}

/**
 * The identity of an action independent of its id, for recognising the SAME
 * finding after its id has changed.
 *
 * WHY IT EXISTS. An id shift was indistinguishable from a finding disappearing,
 * so a card closed itself ("the finding is no longer reported") while the
 * finding sat there under a new id — and a duplicate was filed for it. 93 of 97
 * cards on one board went that way while all 313 findings were still open.
 *
 * IT MUST HASH EXACTLY WHAT codeActionId HASHES, minus the volatility. Keying on
 * project + title alone is WRONG and was the first thing tried: identityTitle
 * collapses every digit, so "Circular dependency (18 files)" and "Circular
 * dependency (87 files)" become one identity — and without the location, two
 * genuinely different findings in one project merge and one card is silently
 * dropped. The location is what keeps them apart, and it is in the id for the
 * same reason.
 */
export function actionIdentityKey(
  projectId: string,
  a: { category: string; title: string; loc: CodeActionLoc[] },
): string {
  return [projectId, a.category, identityTitle(a.title), locationKey(a.loc)].join('|');
}

/**
 * A stable location key: the lexicographically first DISTINCT file, and no line.
 *
 * `loc[0]` was the identity, and loc order comes from the analyzer, not from the
 * problem. Two runs over unchanged code produced the same finding with its
 * copies listed in a different order, so loc[0] moved and the id moved with it.
 * Measured in production: two cards with byte-identical project, title and file
 * list, filed two hours apart under different ids — the second one's hash is not
 * even reproducible from the row as stored, because the order at hash time is
 * gone. Sorting makes the key independent of it.
 *
 * The line number is dropped too: it is the most volatile part of a finding
 * (every edit above it shifts it) and it identifies nothing that the file and
 * the title do not already identify.
 */
function locationKey(loc: CodeActionLoc[]): string {
  const files = [...new Set((loc ?? []).map((l) => l.file).filter(Boolean))].sort();
  return files[0] ?? '';
}

export function codeActionId(
  projectId: string,
  a: { category: string; title: string; loc: CodeActionLoc[] },
): string {
  return 'ca_' + shortHash([projectId, a.category, identityTitle(a.title), locationKey(a.loc)].join('|'));
}
