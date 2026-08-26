/**
 * WHAT WOULD LEAVE THIS MACHINE, answered before anything does.
 *
 * `chat-recall init` used to run its first sync and report afterwards: "Synced
 * 412 session(s)". By then every transcript on the disk was on the server. The
 * site tells people they can hold a path back; the binary never mentioned it
 * until the upload was done, which is the wrong order for the one decision a
 * user cannot take back.
 *
 * This computes the same answer the sync will reach, and it does so by calling
 * THE SAME predicates the sync gate calls — `projectPathIncludes` for the
 * exclusions, `isProjectSyncable` for the allowlist. A preview with its own copy
 * of the matching rules would drift, and a scope preview that disagrees with
 * what actually ships is worse than none: it converts a real decision into a
 * false reassurance.
 *
 * Cheap by construction: it reads each backend's session list (a readdir plus a
 * first-prompt peek, already cached for `chat-recall recent`) and resolves
 * project ids through the memoised resolver. No transcript is parsed, nothing is
 * uploaded, and nothing is written.
 */
import { listAvailableBackends } from './tool-backend.js';
// The registry is populated by a bootstrapper that only runs once this barrel is
// imported. WITHOUT this line the preview reports zeros on a machine full of
// sessions — "nothing would upload" — whenever no other module happened to pull
// the backends in first. A privacy preview must never be able to under-report by
// an import-order accident, so it takes the dependency itself.
import './backends/index.js';
import { resolveProjectId } from './project-resolver.js';
import { loadSettings, isProjectSyncable } from './settings.js';
import { projectPathIncludes } from './project-path-match.js';

/** One project's contribution to the scope. */
export interface ScopeProject {
  /** Resolved project id (`git:…`, `ws:…`, `path:…`). */
  id: string;
  /** The project path as the SYNC GATE sees it — decoded from the tool's own
   *  directory name, which is what an exclusion rule is matched against. */
  projectPath: string;
  sessions: number;
  /** Why this project would not ship, or null when it would. */
  heldBackBy: 'excluded-project' | 'excluded-tool' | 'not-in-allowlist' | null;
}

export interface SyncScope {
  /** Sessions that WOULD upload. */
  included: number;
  /** Sessions a rule currently holds back. */
  heldBack: number;
  /** Per-tool included counts, for the tools this machine actually has. */
  byTool: Array<{ tool: string; sessions: number }>;
  /** Every project, most sessions first. */
  projects: ScopeProject[];
  /** True when `syncMode: 'only'` is in force — the inverted, opt-in mode. */
  allowlistMode: boolean;
  /**
   * Sessions that would upload but carry NO project path, so no path rule can
   * reach them — only `exclude tool` can.
   *
   * Not a rounding error. A tool that files transcripts under a hash of its own
   * rather than per directory produces sessions with no path at all, and on one
   * real machine that was three quarters of one tool's history. Telling someone
   * "exclude a path" while much of their history has no path to exclude is the
   * kind of true-but-useless statement this surface exists to avoid.
   */
  noPathSessions: number;
}

/**
 * Look at the machine and say what the next sync would ship.
 *
 * `sinceMs` bounds the walk the same way a sync does; pass 0 (the default) for
 * "everything on this disk", which is the honest number to show at init time.
 */
export function summariseSyncScope(sinceMs = 0): SyncScope {
  const sync = loadSettings().sync;
  const excludeProjects = sync?.excludeProjects ?? [];
  const excludeTools = new Set<string>(sync?.excludeTools ?? []);
  const allowlistMode = (sync?.syncMode ?? 'all') === 'only';
  const syncOnly = new Set<string>(sync?.syncOnlyProjects ?? []);

  const perProject = new Map<string, ScopeProject>();
  const perTool = new Map<string, number>();

  for (const backend of listAvailableBackends()) {
    let refs: Array<{ projectPath?: string; toolId?: string }> = [];
    try {
      refs = backend.listSessions({ sinceMs }) as Array<{ projectPath?: string; toolId?: string }>;
    } catch {
      // A backend that cannot be read contributes nothing. It must not abort the
      // preview: a broken Cursor install is not a reason to hide the 400 Claude
      // sessions that are about to upload.
      continue;
    }

    for (const ref of refs) {
      const projectPath = ref.projectPath || '';
      const toolId = ref.toolId || backend.id;

      // The gate's own order: tool, then path exclusion, then allowlist. Kept
      // identical to sync-client's modeOf() so the reason shown is the reason
      // that will apply.
      let heldBackBy: ScopeProject['heldBackBy'] = null;
      if (excludeTools.has(toolId)) heldBackBy = 'excluded-tool';
      else if (excludeProjects.some((x) => projectPathIncludes(projectPath, x))) heldBackBy = 'excluded-project';
      else if (!isProjectSyncable(idOf(projectPath), projectPath, { syncMode: sync?.syncMode, syncOnly })) {
        heldBackBy = 'not-in-allowlist';
      }

      const id = idOf(projectPath);
      const key = `${id}\0${projectPath}`;
      const row = perProject.get(key)
        ?? { id, projectPath, sessions: 0, heldBackBy };
      row.sessions++;
      // A project's rows all resolve the same way; keep the first verdict rather
      // than letting the last session decide.
      row.heldBackBy = row.heldBackBy ?? heldBackBy;
      perProject.set(key, row);

      if (!heldBackBy) perTool.set(toolId, (perTool.get(toolId) ?? 0) + 1);
    }
  }

  const projects = [...perProject.values()].sort((a, b) => b.sessions - a.sessions);
  const noPathSessions = projects
    .filter((p) => !p.projectPath && !p.heldBackBy)
    .reduce((n, p) => n + p.sessions, 0);
  return {
    included: projects.filter((p) => !p.heldBackBy).reduce((n, p) => n + p.sessions, 0),
    heldBack: projects.filter((p) => p.heldBackBy).reduce((n, p) => n + p.sessions, 0),
    byTool: [...perTool.entries()].map(([tool, sessions]) => ({ tool, sessions })).sort((a, b) => b.sessions - a.sessions),
    projects,
    allowlistMode,
    noPathSessions,
  };
}

/** The resolver's id, with an ignored project reported as no project — the same
 *  translation every sync call site makes. */
function idOf(projectPath: string): string {
  if (!projectPath) return '';
  const r = resolveProjectId(projectPath);
  return r.source === 'ignored' ? '' : r.id;
}
