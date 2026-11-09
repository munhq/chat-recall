/**
 * The project of a session: the repository its folder belongs to.
 *
 * The message hook runs on the machine that has the folder, so it computes the
 * project and reports it. The server never sees the file system, and it groups
 * sessions, labels them and checks a message across projects by this value.
 *
 * Order of the sources, from the folder up to the root of the file system:
 *   1. `.desk/config.json` with a `github` field (a work folder of desk has no git);
 *   2. the `origin` remote of `.git/config`, also for a linked worktree;
 *   3. the name of the folder that holds `.git`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const MAX_DEPTH = 32;
const OWNER_REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
/** An address that names a host: `scheme://…` or `user@host:path`. A local path is not one. */
const REMOTE_URL = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|[^/@\s]+@[^/\s:]+:)/;

/** `owner/repo` from the URL of a git remote, or null for anything else. */
export function repoFromRemoteUrl(url: string): string | null {
  const u = url.trim();
  if (!REMOTE_URL.test(u)) return null;
  const m = u.match(/[:/]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

function read(path: string): string | null {
  try { return readFileSync(path, 'utf-8'); } catch { return null; }
}

/** The URL of the `origin` remote in the text of a git config file. */
function originUrl(config: string): string | null {
  let inOrigin = false;
  for (const line of config.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('[')) { inOrigin = /^\[remote\s+"origin"\]$/.test(t); continue; }
    if (!inOrigin) continue;
    const m = t.match(/^url\s*=\s*(.+)$/);
    if (m) return m[1].trim();
  }
  return null;
}

/** The directory that holds the git config of a `.git` entry (a folder, or the file of a linked worktree). */
function gitConfigDir(gitEntry: string): string | null {
  const text = read(join(gitEntry, 'config'));
  if (text !== null) return gitEntry;
  const pointer = read(gitEntry)?.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
  if (!pointer) return null;
  const gitdir = isAbsolute(pointer) ? pointer : resolve(dirname(gitEntry), pointer);
  // A linked worktree keeps its own folder under <common>/worktrees/<name>.
  const common = basename(dirname(gitdir)) === 'worktrees' ? dirname(dirname(gitdir)) : gitdir;
  return read(join(common, 'config')) !== null ? common : null;
}

function deskRepo(configPath: string): string | null {
  const text = read(configPath);
  if (text === null) return null;
  try {
    const github = (JSON.parse(text) as { github?: unknown }).github;
    return typeof github === 'string' && OWNER_REPO.test(github) ? github : null;
  } catch { return null; }
}

/**
 * The project of a folder: `owner/repo`, or the name of the repository folder
 * when it has no remote. Null when the folder is in no repository.
 */
export function projectOfFolder(folder: string): string | null {
  if (!folder) return null;
  let dir = resolve(folder);
  for (let i = 0; i < MAX_DEPTH; i++) {
    const desk = deskRepo(join(dir, '.desk', 'config.json'));
    if (desk) return desk;
    const git = join(dir, '.git');
    if (existsSync(git)) {
      const configDir = gitConfigDir(git);
      const config = configDir ? read(join(configDir, 'config')) : null;
      const url = config ? originUrl(config) : null;
      return (url ? repoFromRemoteUrl(url) : null) ?? basename(dir);
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}
