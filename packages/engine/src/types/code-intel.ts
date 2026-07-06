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
}

export interface CodeActionRow extends Required<Omit<CodeActionInput, never>> {
  projectId: string;
  status: CodeActionStatus;
  queued: boolean;
  createdAt: number;
  updatedAt: number;
}

// ── Deterministic ids ───────────────────────────────────────────────────────
// Stable across re-index so findings/hotspots/actions upsert in place rather
// than duplicate. Shared by the collector (builds rows) and the store (writes).

function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

export function codeFindingId(
  projectId: string,
  f: { category: string; file: string; line?: number | null; rule: string },
): string {
  return 'cf_' + shortHash([projectId, f.category, f.file, f.line ?? '', f.rule].join('|'));
}

export function codeHotspotId(projectId: string, file: string): string {
  return 'ch_' + shortHash([projectId, file].join('|'));
}

export function codeActionId(
  projectId: string,
  a: { category: string; title: string; loc: CodeActionLoc[] },
): string {
  const primary = a.loc[0] ? `${a.loc[0].file}:${a.loc[0].line ?? ''}` : '';
  return 'ca_' + shortHash([projectId, a.category, a.title, primary].join('|'));
}
