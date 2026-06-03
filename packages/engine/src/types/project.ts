/**
 * Types for the project / workspace identity layer.
 *
 * A "project" is the unit a dossier is generated for.
 * A "workspace" is a grouping label that contains projects (e.g. the
 * "inco" folder containing 20 repos).
 *
 * Resolution order at index time:
 *   1. User config match  (`~/.chat-recall/projects.json`)
 *   2. Git remote          (`git:<host>/<owner>/<repo>`)
 *   3. Local git           (`git-local:<sha1(realpath(toplevel))>`)
 *   4. Auto-workspace      (`ws:<basename>`) — parent has >=N git children
 *   5. Path fallback       (`path:<realpath>`)
 */

/** A user-declared sub-project inside a parent (e.g. monorepo split). */
export interface DeclaredSubProject {
  id: string;
  name?: string;
  /** Path relative to the parent's root. */
  path: string;
}

/** A user-declared standalone project or workspace parent. */
export interface DeclaredProject {
  id: string;
  name?: string;
  /** Absolute root folder this project (or workspace) covers. */
  root: string;
  /** True when this is a grouping label, not a single project. */
  workspace?: boolean;
  /** Sub-projects (only meaningful when workspace=false and user wants a split). */
  children?: DeclaredSubProject[];
}

/** A glob-ish ignore pattern: folder is skipped entirely. */
export interface IgnoreRule {
  match: string;
}

export interface ProjectsConfig {
  projects?: DeclaredProject[];
  ignore?: IgnoreRule[];
  /** Override auto-workspace threshold (default 3). */
  autoWorkspaceMinRepos?: number;
}

export type ProjectIdSource =
  | 'user'           // matched a user-declared project / workspace / child
  | 'git-remote'     // git remote URL
  | 'git-local'      // git repo with no remote
  | 'auto-workspace' // parent folder has >=N git children
  | 'path'           // raw filesystem path fallback
  | 'ignored';       // matches an ignore rule — caller should skip

export interface ResolvedProject {
  id: string;
  displayName: string;
  source: ProjectIdSource;
  /** Parent workspace id, if any. */
  workspaceId?: string;
}
