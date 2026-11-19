import { statSync, type Stats } from 'node:fs';
import { basename, sep } from 'node:path';

/**
 * True for a folder below a project folder of a Claude home.
 *
 * A Claude session is the file `<root>/<project>/<id>.jsonl`. The folders below
 * a project folder hold subagent transcripts, tool results and workflow
 * journals, and none of them is a session. On a machine with 3,445 folders
 * under its project roots, watching them cost 3,069 inotify watches and about
 * 80 MB of anonymous memory in a fresh process.
 */
export function isBelowProjectFolder(dir: string, roots: readonly string[]): boolean {
  for (const root of roots) {
    if (!dir.startsWith(root + sep)) continue;
    return dir.slice(root.length + 1).split(sep).length >= 2;
  }
  return false;
}

/**
 * The `ignored` rule of the sessions watcher.
 *
 * A root and a project folder are always watched: a new session is a file that
 * appears directly in a project folder, and a new project is a new folder in a
 * root. A transcript older than the window gets no watch of its own; the
 * heartbeat sync selects files by mtime and picks it up when it is written
 * again.
 */
export function sessionWatchIgnored(
  roots: readonly string[],
  windowMs: number,
  now: () => number = Date.now,
): (p: string, stats?: Stats) => boolean {
  return (p, stats) => {
    if (/agent-/.test(p) || /^\./.test(basename(p))) return true;
    // stats is absent for some entries during the initial scan; stat then, so
    // the decision is never "unknown means watch it".
    const st = stats ?? statSync(p, { throwIfNoEntry: false });
    if (!st) return false;
    if (st.isDirectory()) return isBelowProjectFolder(p, roots);
    return st.mtimeMs < now() - windowMs;
  };
}
