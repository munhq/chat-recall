/**
 * Decode the directory name Claude Code uses for a project.
 *
 * Claude Code names each project folder under ~/.claude/projects/ after the
 * project's absolute path with every path separator replaced by '-':
 *
 *   /home/adi/code/chat-recall   ->  -home-adi-code-chat-recall
 *   C:\Users\adi\code\app        ->  C--Users-adi-code-app
 *
 * Ten call sites each open-coded `name.replace(/-/g, '/')`, which is correct on
 * POSIX and produces nonsense on Windows: `C--Users-adi-code-app` becomes
 * `C//Users/adi/code/app`. Every session, plan, task, hook, subagent, command,
 * CLAUDE.md and memory file was therefore attributed to a path that does not
 * exist, so nothing grouped by repo and no project ever resolved to a git id.
 *
 * This is the one decoder. Do not add an eleventh.
 *
 * NOTE ON AMBIGUITY: the encoding is lossy — a real '-' in a directory name is
 * indistinguishable from a separator, which is why `-home-adi-code-chat-recall`
 * could be `.../chat-recall` or `.../chat/recall`. Callers that can touch the
 * filesystem should prefer the probing decoder in parsers/session.ts, which
 * resolves the ambiguity against real directories. This function is the cheap
 * structural answer for callers that only need a stable identity.
 */
import { sep } from 'node:path';

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
    // `C--Users-adi-code-app` -> `C:\Users\adi\code\app`. The drive letter and
    // its '--' (from ':' plus '\') come off first; the rest is separators.
    const drive = dirName[0].toUpperCase();
    const rest = dirName.slice(3).replace(/-/g, '\\');
    return `${drive}:\\${rest}`;
  }

  // POSIX: a single leading '-' is the root slash.
  return '/' + dirName.replace(/^-/, '').replace(/-/g, '/');
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
