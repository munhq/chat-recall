/**
 * Decode the directory name Claude Code uses for a project.
 *
 * Claude Code names each project folder under ~/.claude/projects/ after the
 * project's absolute path with every path separator replaced by '-':
 *
 *   /home/user/code/chat-recall   ->  -home-user-code-chat-recall
 *   C:\Users\user\code\app        ->  C--Users-user-code-app
 *
 * Ten call sites each open-coded `name.replace(/-/g, '/')`, which is correct on
 * POSIX and produces nonsense on Windows: `C--Users-user-code-app` becomes
 * `C//Users/user/code/app`. Every session, plan, task, hook, subagent, command,
 * CLAUDE.md and memory file was therefore attributed to a path that does not
 * exist, so nothing grouped by repo and no project ever resolved to a git id.
 *
 * This is the one decoder. Do not add an eleventh.
 *
 * NOTE ON AMBIGUITY: the encoding is lossy — a real '-' in a directory name is
 * indistinguishable from a separator, which is why `-home-user-code-chat-recall`
 * could be `.../chat-recall` or `.../chat/recall`. Callers that can touch the
 * filesystem should prefer the probing decoder in parsers/session.ts, which
 * resolves the ambiguity against real directories. This function is the cheap
 * structural answer for callers that only need a stable identity.
 */
import { sep } from 'node:path';
import { readdirSync } from 'node:fs';

/** True when the name encodes a Windows drive-rooted path (`C--Users-…`). */
export function looksWindowsEncoded(dirName: string): boolean {
  return /^[A-Za-z]--/.test(dirName);
}

/**
 * Decode a project directory name back to an absolute path.
 *
 * The shape of the NAME decides the output, not the host platform: a Linux
 * server indexing a transcript synced from a Windows laptop must still decode
 * it as a Windows path, or the two machines disagree about what the project is.
 */
export function decodeProjectDirName(dirName: string): string {
  if (!dirName) return '';

  if (looksWindowsEncoded(dirName)) {
    // `C--Users-user-code-app` -> `C:\Users\user\code\app`. The drive letter and
    // its '--' (from ':' plus '\') come off first; the rest is separators.
    const drive = dirName[0].toUpperCase();
    const rest = dirName.slice(3).replace(/-/g, '\\');
    return `${drive}:\\${rest}`;
  }

  // POSIX: a single leading '-' is the root slash.
  return '/' + dirName.replace(/^-/, '').replace(/-/g, '/');
}

/**
 * Decode a project directory name by PROBING the filesystem.
 *
 * `decodeProjectDirName` above is the cheap structural answer and it is wrong
 * whenever a real directory name contains the character the encoding uses as
 * its separator. Claude Code flattens a path by replacing '/' with '-', and a
 * '.' or '-' inside a name survives as '-' too, so three different characters
 * arrive as one and the name alone cannot say which:
 *
 *   -Users-me-code-chat-recall           .../chat-recall   or  .../chat/recall
 *   -Users-me-code-app--agent-wt-a1   .../app/.agent/worktrees/a1
 *
 * Both were mis-decoded. The first split one repo across two project ids
 * (`git-local:` for the real path, `path:/Users/me/code/chat/recall` for the
 * fiction). The second is how per-session worktrees stopped rolling up into
 * the repo they belong to: `.agent` became `agent`, the path did not
 * exist, git could not be consulted, and the sessions landed under a standalone
 * `path:` project instead of the parent repo's `git:` id.
 *
 * The fix is to ask the disk instead of guessing. At each level we list the
 * real children, encode each one the way Claude Code would, and take the
 * LONGEST whose encoding matches the head of what is left — so `chat-recall`
 * beats `chat` when the directory is really there, and `.agent` is found
 * even though its dot was flattened away.
 *
 * Probing can only improve the answer, never regress it: anything that does not
 * resolve on this machine (a Windows-encoded name, a path synced from another
 * device, a repo since deleted) falls straight back to the structural decode,
 * which is exactly what every caller got before.
 */
export function resolveProjectDirName(
  dirName: string,
  deps: { readdir?: (p: string) => string[] } = {},
): string {
  const structural = decodeProjectDirName(dirName);
  if (!dirName) return structural;

  // A drive-rooted name describes a Windows path. Probing the local
  // filesystem for it is meaningless on any host and actively wrong on a
  // Linux server indexing a laptop's transcripts.
  if (looksWindowsEncoded(dirName)) return structural;

  const readdir =
    deps.readdir ?? ((p: string) => readdirSync(p, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name));

  // Everything the encoder collapses into '-'.
  const encodeName = (name: string) => name.replace(/[-_.]/g, '-');

  let remaining = dirName.replace(/^-/, '');
  let current = '/';

  while (remaining) {
    let children: string[];
    try {
      children = readdir(current);
    } catch {
      break; // unreadable level — keep what we have, structural does the rest
    }

    let best = '';
    for (const child of children) {
      const encoded = encodeName(child);
      if (!encoded || encoded.length < best.length) continue;
      if (!remaining.startsWith(encoded)) continue;
      // The match has to end on a separator boundary, or a directory
      // named `web` would swallow the head of `web-ui` and leave `ui`
      // dangling as a path segment that was never a directory.
      const next = remaining[encoded.length];
      if (next !== undefined && next !== '-') continue;
      if (encoded.length > best.length) best = child;
    }

    if (!best) break;

    // POSIX join, spelled out. `node:path`'s join is HOST-relative: on Windows
    // it renders this as `\\Users\\alice`, the next readdir misses, the probe
    // gives up at the first level and every name silently falls back to the
    // structural decode. This branch only ever describes a POSIX path, and the
    // shape of the NAME has to decide the answer — not the machine reading it.
    current = current === '/' ? `/${best}` : `${current}/${best}`;
    remaining = remaining.slice(encodeName(best).length).replace(/^-/, '');
  }

  // Nothing matched at all, or the tail could not be resolved: the structural
  // decode is the honest fallback rather than a half-probed path.
  return remaining ? structural : current;
}

/**
 * The project's own directory name — the last segment of the decoded path.
 * Separator-agnostic, so it works on a decoded Windows path under Linux.
 */
export function projectLeafName(dirName: string): string {
  const decoded = decodeProjectDirName(dirName);
  const parts = decoded.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** Split a decoded absolute path on either separator. */
export function splitPathSegments(p: string): string[] {
  return p.split(/[/\\]/).filter(Boolean);
}

/** The platform separator, re-exported so callers stop hard-coding '/'. */
export const PATH_SEP = sep;
