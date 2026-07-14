/**
 * Collector-version migration: when the collector's logic version bumps, the
 * stored code data for projects indexed by an OLDER collector is re-derived (not
 * wiped). The watch daemon runs this once on startup after any self-update.
 *
 * For each server project whose stored collectorVersion < the running collector
 * AND whose rootPath still exists on disk, we re-index it — regenerating clean
 * findings/actions and pruning old false positives, while the store preserves
 * user-triaged state (queued/done/dismissed). A project whose repo is gone is
 * SKIPPED, never deleted (its data ages out, it is not lost).
 */
import { existsSync } from 'node:fs';
import { fetchWithTimeout } from './http.js';

export interface ProjectRef { projectId: string; rootPath: string; collectorVersion?: number | null; }

/** Pure: which projects need re-deriving — older version AND repo present. */
export function selectProjectsToReindex(
  projects: ProjectRef[],
  current: number,
  existsFn: (p: string) => boolean = existsSync,
): { reindex: ProjectRef[]; missing: ProjectRef[] } {
  const reindex: ProjectRef[] = [];
  const missing: ProjectRef[] = [];
  for (const p of projects) {
    if ((p.collectorVersion ?? 0) >= current) continue;   // already current/newer
    if (!p.rootPath) continue;
    if (existsFn(p.rootPath)) reindex.push(p);
    else missing.push(p);                                  // repo gone — skip, don't wipe
  }
  return { reindex, missing };
}

export interface MigrateResult { selected: number; reindexed: number; failed: number; missing: number; }

export async function runCollectorMigration(opts: {
  base: string;
  authHeaders: Record<string, string>;
  current: number;
  /** Re-derive one repo (collect + push). Returns success. Injected by the daemon. */
  reindex: (rootPath: string) => Promise<boolean>;
  fetchProjects?: () => Promise<ProjectRef[]>;
  existsFn?: (p: string) => boolean;
  log?: (m: string) => void;
}): Promise<MigrateResult> {
  const log = opts.log ?? (() => {});
  const fetchProjects = opts.fetchProjects ?? (async () => {
    const res = await fetchWithTimeout(`${opts.base.replace(/\/+$/, '')}/api/code/projects`, { headers: opts.authHeaders });
    if (!res.ok) return [];
    return ((await res.json()) as { projects?: ProjectRef[] }).projects ?? [];
  });

  let projects: ProjectRef[];
  try { projects = await fetchProjects(); }
  catch { return { selected: 0, reindexed: 0, failed: 0, missing: 0 }; }

  const { reindex, missing } = selectProjectsToReindex(projects, opts.current, opts.existsFn);
  if (reindex.length === 0 && missing.length === 0) return { selected: 0, reindexed: 0, failed: 0, missing: 0 };
  log(`collector migration: ${reindex.length} project(s) to re-derive, ${missing.length} skipped (repo missing)`);

  let reindexed = 0, failed = 0;
  for (const p of reindex) {
    try { (await opts.reindex(p.rootPath)) ? reindexed++ : failed++; }
    catch { failed++; }
  }
  return { selected: reindex.length, reindexed, failed, missing: missing.length };
}
