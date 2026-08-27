/**
 * Project identity resolver.
 *
 * Given a filesystem path (typically `MemoryItem.projectPath`), produce a
 * stable `project_id` that the rest of the system groups by.
 *
 * Resolution order:
 *   1. Ignore rule         → returns `ignored` (caller skips the item)
 *   2. User-declared child → `<parent.id>/<child.id>`
 *   3. User-declared root  → that project's `id`
 *   4. Bot worktree        → `path:<bot-root>` (PR-bot scratch checkouts)
 *   5. Git repo with remote→ `git:<host>/<owner>/<repo>`
 *   6. Local git (no remote)→ `git-local:<sha1(realpath(toplevel))>`
 *   7. Auto-workspace      → `ws:<basename>` (parent has >=N git children)
 *   8. Fallback            → `path:<realpath>`
 *
 * Side-effect-free: pure path resolution + git subprocess + readdir. No DB
 * writes. Memoised per realpath; clear via `resetProjectResolverCache()`.
 *
 * The config file lives at `<DATA_DIR>/projects.json`. JSON (not TOML) so we
 * don't take a runtime dependency just for a small config shape.
 */

import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, readFileSync, realpathSync, readdirSync, statSync } from 'fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'path';

import { getDataDir } from './paths.js';
import type {
  DeclaredProject,
  DeclaredSubProject,
  ProjectsConfig,
  ResolvedProject,
} from '../types/project.js';

const DEFAULT_AUTO_WORKSPACE_MIN_REPOS = 3;

/**
 * Directory names that mark throwaway bot worktrees. These are git
 * checkouts of real repos (so step-5 git resolution would otherwise tag
 * them with the repo's real `git:` id and let dozens of identically-
 * templated bot runs flood the main feed and pollute the real repo's
 * view). We bucket every session under such a directory into a single
 * `path:<bot-root>` id so the feed hides them by default (the `path:%`
 * filter) while they stay inspectable under "Untracked locations".
 */
const BOT_WORKTREE_MARKERS = ['.claude-pr-bot'];

/** Resolved-id cache keyed on realpath input. */
const resolveCache = new Map<string, ResolvedProject>();

/** Git remote cache keyed on git toplevel realpath. */
const gitCache = new Map<string, { remote: string | null }>();

/** Auto-workspace cache keyed on parent dir realpath. */
const workspaceCache = new Map<string, string | null>();

/** `resolveWorkspaceId` result cache keyed on realpath input. */
const wsIdCache = new Map<string, string | null>();

let cachedConfig: { mtime: number; cfg: ProjectsConfig } | null = null;

/** Path to the user's editable config file. */
export function getProjectsConfigPath(): string {
  return join(getDataDir(), 'projects.json');
}

/** Load + memoise the user's projects config. Returns empty config when missing. */
export function loadProjectsConfig(): ProjectsConfig {
  // Test-injected configs use mtime=MAX_SAFE_INTEGER as a sentinel; respect it.
  if (cachedConfig && cachedConfig.mtime === Number.MAX_SAFE_INTEGER) {
    return cachedConfig.cfg;
  }

  const path = getProjectsConfigPath();
  if (!existsSync(path)) {
    cachedConfig = { mtime: 0, cfg: {} };
    return cachedConfig.cfg;
  }
  const mtime = statSync(path).mtimeMs;
  if (cachedConfig && cachedConfig.mtime === mtime) return cachedConfig.cfg;
  try {
    const raw = readFileSync(path, 'utf-8');
    const cfg = JSON.parse(raw) as ProjectsConfig;
    cachedConfig = { mtime, cfg };
    return cfg;
  } catch {
    // Malformed config: behave as if absent rather than crashing the indexer.
    cachedConfig = { mtime, cfg: {} };
    return cachedConfig.cfg;
  }
}

/** Clear all caches. Call after the config file changes or in tests. */
export function resetProjectResolverCache(): void {
  resolveCache.clear();
  gitCache.clear();
  workspaceCache.clear();
  wsIdCache.clear();
  cachedConfig = null;
}

/** Test seam: inject a config without touching disk. */
export function _setProjectsConfigForTests(cfg: ProjectsConfig | null): void {
  resetProjectResolverCache();
  cachedConfig = cfg === null ? null : { mtime: Number.MAX_SAFE_INTEGER, cfg };
}

/* -----------------------------------------------------------------------
 * Public API
 * --------------------------------------------------------------------- */

export function resolveProjectId(inputPath: string): ResolvedProject {
  // Empty input has no useful project_id — return a sentinel callers
  // recognise as "skip" rather than synthesising a bogus `path:` row.
  if (!inputPath) {
    return { id: '', displayName: '', source: 'path' };
  }
  if (!isAbsolute(inputPath)) {
    return { id: `path:${inputPath}`, displayName: inputPath, source: 'path' };
  }

  const realPath = safeRealpath(inputPath);
  const cached = resolveCache.get(realPath);
  if (cached) return cached;

  const result = doResolve(realPath);
  resolveCache.set(realPath, result);
  return result;
}

/**
 * Resolve the workspace a path belongs to, independent of its `project_id`.
 *
 * Unlike `resolveProjectId` (which short-circuits at the git step and never
 * reports the enclosing workspace for a repo), this answers "which workspace
 * contains this repo?" — the question the project tree needs to nest git
 * projects under their workspace.
 *
 * It anchors on the **git repo root**, not the input path, so it returns the
 * same workspace no matter how deep inside the repo a session happened to run
 * (a session's CWD is arbitrary; the repo root is stable). Returns the
 * workspace id (`ws:<name>` or a user-declared workspace id) or null when the
 * path belongs to no workspace.
 */
export function resolveWorkspaceId(inputPath: string): string | null {
  if (!inputPath || !isAbsolute(inputPath)) return null;

  const realPath = safeRealpath(inputPath);
  const cached = wsIdCache.get(realPath);
  if (cached !== undefined) return cached;

  const result = doResolveWorkspace(realPath);
  wsIdCache.set(realPath, result);
  return result;
}

function doResolveWorkspace(realPath: string): string | null {
  const cfg = loadProjectsConfig();

  // 1. User-declared workspace containing this path (longest root wins).
  const declaredWorkspaces = (cfg.projects || [])
    .filter(p => p.workspace)
    .sort((a, b) => b.root.length - a.root.length);
  for (const proj of declaredWorkspaces) {
    if (isInside(realPath, safeRealpath(proj.root))) return proj.id;
  }

  // 2. Auto-workspace anchored at the repo root. Walking up from the git
  //    toplevel (not the deep session CWD) keeps the search shallow enough
  //    for AUTO_WORKSPACE_MAX_DEPTH and makes the result CWD-independent.
  const anchor = findGitToplevel(realPath) ?? realPath;
  const ws = resolveAutoWorkspace(anchor, cfg.autoWorkspaceMinRepos ?? DEFAULT_AUTO_WORKSPACE_MIN_REPOS);
  return ws ? ws.id : null;
}

/* -----------------------------------------------------------------------
 * Resolver internals
 * --------------------------------------------------------------------- */

function doResolve(realPath: string): ResolvedProject {
  const cfg = loadProjectsConfig();

  // 1. Ignore rule
  if (matchesIgnore(realPath, cfg)) {
    return { id: `ignored:${realPath}`, displayName: basename(realPath), source: 'ignored' };
  }

  // 2 + 3. User-declared project / sub-project
  const declared = matchDeclaredProject(realPath, cfg.projects || []);
  if (declared) return declared;

  // 4. Bot worktree — bucket before git so templated bot runs don't get
  // tagged with the real repo's id.
  const bot = resolveBotWorktree(realPath);
  if (bot) return bot;

  // 5 + 6. Git
  const git = resolveGit(realPath);
  if (git) return git;

  // 7. Auto-workspace
  const ws = resolveAutoWorkspace(realPath, cfg.autoWorkspaceMinRepos ?? DEFAULT_AUTO_WORKSPACE_MIN_REPOS);
  if (ws) return ws;

  // 8. Path fallback
  return {
    id: `path:${realPath}`,
    displayName: basename(realPath) || realPath,
    source: 'path',
  };
}

/* ----- 1. Ignore --------------------------------------------------------- */

function matchesIgnore(realPath: string, cfg: ProjectsConfig): boolean {
  const rules = cfg.ignore || [];
  for (const r of rules) {
    if (globMatch(r.match, realPath)) return true;
  }
  return false;
}

/* ----- 4. Bot worktree --------------------------------------------------- */

/**
 * If `realPath` lives under a bot-worktree marker dir (e.g.
 * `~/.claude-pr-bot/worktrees/repo-123`), collapse every such session
 * into one stable `path:<…/.claude-pr-bot>` bucket. Returns null when no
 * marker is an ancestor.
 */
function resolveBotWorktree(realPath: string): ResolvedProject | null {
  const parts = realPath.split(sep);
  const idx = parts.findIndex(p => BOT_WORKTREE_MARKERS.includes(p));
  if (idx === -1) return null;
  const botRoot = parts.slice(0, idx + 1).join(sep);
  return {
    id: `path:${botRoot}`,
    displayName: parts[idx],
    source: 'path',
  };
}

/* ----- 2 + 3. User-declared --------------------------------------------- */

function matchDeclaredProject(
  realPath: string,
  projects: DeclaredProject[],
): ResolvedProject | null {
  // Longest-root wins so a more specific declaration beats a broader workspace.
  const candidates = [...projects].sort((a, b) => b.root.length - a.root.length);

  for (const proj of candidates) {
    const root = safeRealpath(proj.root);
    if (!isInside(realPath, root)) continue;

    // 2. Sub-project (only if not a workspace).
    if (!proj.workspace && proj.children?.length) {
      const child = matchChild(realPath, root, proj.children);
      if (child) {
        return {
          id: `${proj.id}/${child.id}`,
          displayName: child.name || child.id,
          source: 'user',
          workspaceId: proj.id,
        };
      }
    }

    // 3. Workspace catch-all OR plain project root.
    return {
      id: proj.id,
      displayName: proj.name || proj.id,
      source: 'user',
      workspaceId: proj.workspace ? undefined : undefined,
    };
  }
  return null;
}

function matchChild(
  realPath: string,
  parentRoot: string,
  children: DeclaredSubProject[],
): DeclaredSubProject | null {
  const sorted = [...children].sort((a, b) => b.path.length - a.path.length);
  for (const c of sorted) {
    const childRoot = safeRealpath(join(parentRoot, c.path));
    if (isInside(realPath, childRoot)) return c;
  }
  return null;
}

/* ----- 4 + 5. Git -------------------------------------------------------- */

function resolveGit(realPath: string): ResolvedProject | null {
  const toplevel = findGitToplevel(realPath);
  if (!toplevel) return null;

  const remote = getGitRemote(toplevel);
  if (remote) {
    const parsed = parseGitRemote(remote);
    if (parsed) {
      return {
        id: `git:${parsed.host}/${parsed.owner}/${parsed.repo}`,
        displayName: parsed.repo,
        source: 'git-remote',
      };
    }
  }

  const hash = createHash('sha1').update(toplevel).digest('hex').slice(0, 12);
  return {
    id: `git-local:${hash}`,
    displayName: basename(toplevel),
    source: 'git-local',
  };
}

function findGitToplevel(realPath: string): string | null {
  // Walk up looking for a `.git` entry (dir or file — worktrees use a file).
  let cur = realPath;
  let last = '';
  while (cur && cur !== last) {
    if (existsSync(join(cur, '.git'))) return cur;
    last = cur;
    cur = dirname(cur);
  }
  return null;
}

function getGitRemote(toplevel: string): string | null {
  const cached = gitCache.get(toplevel);
  if (cached) return cached.remote;
  let remote: string | null = null;
  try {
    remote = execSync('git remote get-url origin', {
      cwd: toplevel,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      timeout: 2000,
    }).trim() || null;
  } catch {
    remote = null;
  }
  gitCache.set(toplevel, { remote });
  return remote;
}

/** Parse common git remote URL shapes into host/owner/repo. */
export function parseGitRemote(url: string): { host: string; owner: string; repo: string } | null {
  const trimmed = url.trim().replace(/\.git$/, '');
  if (!trimmed) return null;

  // ssh: git@github.com:owner/repo
  const ssh = /^[^@]+@([^:]+):(.+?)\/([^/]+)$/.exec(trimmed);
  if (ssh) return { host: normaliseHost(ssh[1]), owner: ssh[2], repo: ssh[3] };

  // https / git / ssh+url: scheme://[user@]host[:port]/owner/repo
  const url1 = /^[a-z+]+:\/\/(?:[^@]+@)?([^/:]+)(?::\d+)?\/(.+?)\/([^/]+)$/.exec(trimmed);
  if (url1) return { host: normaliseHost(url1[1]), owner: url1[2], repo: url1[3] };

  return null;
}

/**
 * Strip SSH host-alias suffixes for known providers so multi-account
 * setups don't fragment one logical host into many. e.g. when
 * `~/.ssh/config` defines `Host github.com-second` for a second
 * GitHub account, the remote `git@github.com-second:owner/repo`
 * should still bucket under `github.com`. Anything we don't recognise
 * is left alone so we don't accidentally collapse self-hosted hosts.
 */
function normaliseHost(host: string): string {
  for (const known of ['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org', 'gitea.com']) {
    if (host === known) return known;
    if (host.startsWith(known + '-') || host.startsWith(known + '.')) return known;
  }
  return host;
}

/* ----- 6. Auto-workspace ------------------------------------------------ */

/**
 * Maximum ancestor levels we'll walk looking for a workspace.
 * Use case: `/code/acme/some-tool/` → acme is the parent, that's the
 * workspace. We do NOT want to walk all the way up to `/tmp` or `/`
 * and pick up unrelated git repos as a "workspace". 2 levels covers
 * the common cases (input itself + immediate parent) without false
 * promotions across the filesystem.
 */
const AUTO_WORKSPACE_MAX_DEPTH = 2;

function resolveAutoWorkspace(realPath: string, minRepos: number): ResolvedProject | null {
  let cur = realPath;
  let last = '';
  let depth = 0;
  while (cur && cur !== last && depth < AUTO_WORKSPACE_MAX_DEPTH) {
    if (!existsSync(join(cur, '.git'))) {
      const cached = workspaceCache.get(cur);
      let qualifies: boolean;
      if (cached === undefined) {
        qualifies = countGitChildren(cur) >= minRepos;
        workspaceCache.set(cur, qualifies ? cur : null);
      } else {
        qualifies = cached !== null;
      }
      if (qualifies) {
        const name = basename(cur);
        return { id: `ws:${name}`, displayName: name, source: 'auto-workspace' };
      }
    }
    last = cur;
    cur = dirname(cur);
    depth++;
  }
  return null;
}

function countGitChildren(dir: string): number {
  let count = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const child = join(dir, name);
    try {
      const st = statSync(child);
      if (!st.isDirectory()) continue;
      if (existsSync(join(child, '.git'))) count++;
    } catch {
      // permission / dangling symlink — ignore
    }
  }
  return count;
}

/* -----------------------------------------------------------------------
 * Helpers
 * --------------------------------------------------------------------- */

function safeRealpath(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

function isInside(child: string, parent: string): boolean {
  if (!parent) return false;
  if (child === parent) return true;
  const c = child.endsWith(sep) ? child : child + sep;
  const p = parent.endsWith(sep) ? parent : parent + sep;
  return c.startsWith(p);
}

/**
 * Tiny glob matcher: supports `**`, `*`, `?` and brace groups `{a,b}`.
 *
 * SEPARATORS ARE NORMALISED, AND THAT IS THE WHOLE POINT ON WINDOWS. This
 * matched raw strings against a regex built with `/` hard-coded — `*` compiled
 * to `[^/]*` and `**` consumed only a `/`. A Windows path is separated by `\`,
 * so:
 *
 *   * a rule written the natural Windows way, `C:/code/vendored/**`, matched
 *     nothing at all;
 *   * a rule written `C:\code\vendored\*` matched, but `*` crossed a
 *     directory boundary, because `\` is not in `[^/]`.
 *
 * Either way an ignore rule the user set silently failed to apply and the
 * project they had excluded was indexed and uploaded — the same class of failure
 * as an exclusion that does not exclude, on the platform with no test coverage.
 * Both sides are converted to `/` before matching, so a pattern written with
 * either separator means the same thing.
 */
export function globMatch(pattern: string, path: string): boolean {
  const re = new RegExp('^' + globToRegex(toPosix(pattern)) + '$');
  return re.test(toPosix(path));
}

/** Backslashes to forward slashes, for separator-agnostic pattern matching. */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function globToRegex(glob: string): string {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      out += '.*'; i += 2;
      if (glob[i] === '/') i++; // consume slash after ** so `a/**/b` matches `a/b`
    } else if (c === '*') {
      out += '[^/]*'; i++;
    } else if (c === '?') {
      out += '[^/]'; i++;
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) { out += '\\{'; i++; continue; }
      const opts = glob.slice(i + 1, end).split(',').map(escapeRe).join('|');
      out += '(?:' + opts + ')'; i = end + 1;
    } else {
      out += escapeRe(c); i++;
    }
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}
