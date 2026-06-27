/**
 * Code-index registry — the local source of truth for "which workspaces does
 * the daemon keep code-indexed". Lives in the data dir (code-index.json).
 *
 * Populated automatically: every time an AI tool is active in a repo (the watch
 * daemon sees the session write — which is exactly when codeindex's MCP scanned
 * it), that repo's path is added here. A 6h sweep re-indexes the list, skipping
 * repos whose git HEAD hasn't moved. Users can exclude paths (never scan) or
 * remove tracked paths via the CLI / dashboard.
 *
 * codeindex itself decides what's a real workspace; the only filtering here is
 * the exclude list + built-ins (tmp, node_modules, build dirs) so we never waste
 * a scan on junk.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { getDataDir } from '../paths.js';

export interface CodeRegistryEntry { sha?: string; indexedAt?: number; }
export interface CodeRegistry {
  /** tracked workspace path → last-index watermark */
  paths: Record<string, CodeRegistryEntry>;
  /** user-excluded paths (prefix match) — never scanned, never re-added */
  exclude: string[];
}

/** Substrings that are never worth scanning regardless of user config. */
const BUILTIN_EXCLUDE_SUBSTR = ['/node_modules/', '/.cache/', '/dist/', '/build/', '/vendor/', '/target/', '/.venv/', '/.next/', '/.git/'];

const registryFile = () => join(getDataDir(), 'code-index.json');

function load(): CodeRegistry {
  try {
    const r = JSON.parse(readFileSync(registryFile(), 'utf8'));
    return { paths: r.paths ?? {}, exclude: Array.isArray(r.exclude) ? r.exclude : [] };
  } catch { return { paths: {}, exclude: [] }; }
}
function save(r: CodeRegistry): void {
  const f = registryFile();
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(r, null, 2));
}

/** True if this path must not be scanned (tmp / build junk / user-excluded). */
export function isExcluded(path: string, exclude?: string[]): boolean {
  if (!path) return true;
  const ex = exclude ?? load().exclude;
  const tmp = tmpdir();
  if (path === tmp || path.startsWith(tmp + '/')) return true;
  if (path.includes('/tmp/')) return true;
  if (BUILTIN_EXCLUDE_SUBSTR.some((s) => path.includes(s))) return true;
  for (const e of ex) {
    if (!e) continue;
    if (path === e || path.startsWith(e.replace(/\/?$/, '/'))) return true;
  }
  return false;
}

export function getRegistry(): CodeRegistry { return load(); }

/** Add a path to the tracked set (no-op if excluded or already present). Returns true if newly added. */
export function addScannedPath(path: string): boolean {
  const r = load();
  if (isExcluded(path, r.exclude)) return false;
  if (r.paths[path]) return false;
  r.paths[path] = {};
  save(r);
  return true;
}

/** Record that a path was indexed at the given git HEAD (for incremental skip). */
export function setWatermark(path: string, sha: string | undefined): void {
  const r = load();
  r.paths[path] = { sha, indexedAt: Date.now() };
  save(r);
}
export function getWatermark(path: string): CodeRegistryEntry | undefined { return load().paths[path]; }

/** Stop tracking a path (does NOT exclude it — it may be re-added on next AI open). */
export function removeScannedPath(path: string): boolean {
  const r = load();
  if (!(path in r.paths)) return false;
  delete r.paths[path];
  save(r);
  return true;
}

/** Exclude a path: never scan, never re-add, and drop it from the tracked set. */
export function addExclude(path: string): void {
  const r = load();
  if (!r.exclude.includes(path)) r.exclude.push(path);
  delete r.paths[path];
  save(r);
}
export function removeExclude(path: string): boolean {
  const r = load();
  if (!r.exclude.includes(path)) return false;
  r.exclude = r.exclude.filter((x) => x !== path);
  save(r);
  return true;
}
