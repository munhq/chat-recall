/**
 * Cross-platform project path normalization.
 *
 * Rules:
 *   - Convert backslashes to forward slashes (Windows → POSIX display form).
 *   - Collapse duplicate slashes.
 *   - Strip trailing slashes (except for pure "/" root).
 *   - Trim whitespace.
 *
 * Windows drive letters (e.g. "C:") are preserved as the first segment
 * so a path like "C:\Users\alice\code" becomes "C:/Users/alice/code".
 */
export function normalizeProjectPath(p: string | null | undefined): string {
  if (!p) return '';
  let n = String(p).trim();
  if (!n) return '';
  n = n.replace(/\\/g, '/');
  n = n.replace(/\/+/g, '/');
  if (n.length > 1) n = n.replace(/\/+$/, '');
  return n;
}

/**
 * Returns true if `candidate` is equal to or nested under `folder`.
 * Both arguments are normalized before comparison.
 *
 *   matchesPrefix('/a/b/c', '/a/b')    === true
 *   matchesPrefix('/a/b',   '/a/b')    === true
 *   matchesPrefix('/a/bc',  '/a/b')    === false
 *   matchesPrefix('/a',     '/a/b')    === false
 */
export function matchesPrefix(candidate: string, folder: string): boolean {
  const c = normalizeProjectPath(candidate);
  const f = normalizeProjectPath(folder);
  if (!f) return !!c;
  if (c === f) return true;
  return c.startsWith(f + '/');
}
