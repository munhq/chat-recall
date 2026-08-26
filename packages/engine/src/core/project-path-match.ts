/**
 * Matching a project path against a user's rule, when the path we hold is LOSSY.
 *
 * ── The bug this exists to fix ─────────────────────────────────────────────
 *
 * Claude Code names each project folder after the project's absolute path with
 * every separator replaced by '-', so `/home/user/code/chat-recall` becomes
 * `-home-user-code-chat-recall`. The encoding cannot be inverted: a real hyphen
 * in a directory name is indistinguishable from a separator. `listSessions()`
 * decodes structurally (decodeProjectDirName), so what the sync gate actually
 * receives for that project is:
 *
 *     /home/user/code/chat/recall
 *
 * The rule the user typed — `chat-recall exclude project ~/code/chat-recall` —
 * is stored verbatim as `/home/user/code/chat-recall`. A substring test between
 * those two strings is FALSE, so the excluded project kept syncing. Silently:
 * nothing errors, `exclude list` shows the rule, and the data uploads anyway.
 * Any project whose directory name contains '-' or '_' was affected, which is
 * most of them.
 *
 * ── The rule here ─────────────────────────────────────────────────────────
 *
 * Compare with the ambiguity collapsed: '-', '_' and '/' are all treated as the
 * same separator, on BOTH sides. `/home/user/code/chat-recall` and
 * `/home/user/code/chat/recall` then compare equal, which is correct — they are
 * two readings of one encoded directory name and we cannot tell which the user
 * meant.
 *
 * ── Additive, deliberately ────────────────────────────────────────────────
 *
 * Every function tries the RAW comparison first and only then the collapsed one.
 * A rule that matches today keeps matching, and the change can only ever match
 * MORE paths. For a privacy gate that is the sole acceptable direction to err:
 * over-matching withholds data the user might have been willing to send, while
 * under-matching uploads data they told us to keep.
 */

/**
 * Collapse everything that could be a separator, so two readings of one encoded
 * directory name compare equal.
 *
 * Lower-cased as well: a Windows path decoded on a Linux server differs only in
 * case from the same path typed by hand, and no user means two different
 * projects by `Code` and `code`.
 */
export function canonicalProjectPath(p: string): string {
  return (p || '')
    .trim()
    .replace(/\\/g, '/')      // Windows separators first
    .replace(/[-_]/g, '/')    // the ambiguity itself
    .replace(/\/{2,}/g, '/')  // C:\\ decoded, or a doubled separator
    .replace(/\/+$/, '')      // trailing separator is not a segment
    .toLowerCase();
}

/**
 * Does `candidate` contain `rule` anywhere — the semantics `exclude project`
 * and `sync-only` documented from the start ("substring match on the project
 * path"), now applied to the collapsed form too.
 */
export function projectPathIncludes(candidate: string, rule: string): boolean {
  if (!candidate || !rule) return false;
  if (candidate.includes(rule)) return true;
  const c = canonicalProjectPath(candidate);
  const r = canonicalProjectPath(rule);
  return !!r && c.includes(r);
}

/**
 * Is `candidate` the rule's own path, or somewhere beneath it? The stricter
 * relation the index-time allow/deny lists use, where a substring test would
 * make `/code/app` also match `/code/app-secrets`.
 */
export function projectPathAtOrUnder(candidate: string, rule: string): boolean {
  if (!candidate || !rule) return false;
  const strip = (s: string) => s.replace(/\/+$/, '');
  const cRaw = strip(candidate);
  const rRaw = strip(rule);
  if (cRaw === rRaw || cRaw.startsWith(`${rRaw}/`)) return true;
  const c = canonicalProjectPath(candidate);
  const r = canonicalProjectPath(rule);
  return !!r && (c === r || c.startsWith(`${r}/`));
}
