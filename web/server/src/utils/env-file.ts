/**
 * Minimal `.env` reader/writer that preserves comments and line order.
 *
 * We update in place so existing user comments and layout survive. Unknown
 * keys in `updates` are ignored by the caller's allowlist — this helper
 * itself is trusting: feed it sanitised input.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';

export interface EnvFile {
  path: string;
  values: Record<string, string>;
}

export function readEnvFile(path: string): EnvFile {
  const values: Record<string, string> = {};
  if (!existsSync(path)) return { path, values };

  const text = readFileSync(path, 'utf-8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip surrounding quotes if the whole value is quoted.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return { path, values };
}

/**
 * Write updates back to the env file. Existing lines for listed keys are
 * replaced in place; new keys are appended. Comments and layout for
 * everything else are preserved. Pass `undefined` as the value for a key
 * to delete (comment-out) that entry.
 */
export function writeEnvFile(path: string, updates: Record<string, string | undefined>): void {
  const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  const lines = existing.split('\n');
  const handled = new Set<string>();

  const needsQuoting = (v: string): boolean => /[\s#"']/.test(v);
  const serialize = (k: string, v: string): string =>
    `${k}=${needsQuoting(v) ? `'${v.replace(/'/g, "'\\''")}'` : v}`;

  const updated = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) return line;
    const key = trimmed.slice(0, eq).trim();
    if (!(key in updates)) return line;
    handled.add(key);
    const val = updates[key];
    if (val === undefined) return `# ${serialize(key, '')}`; // soft-delete
    // Preserve the leading indentation from the original line.
    const leading = line.match(/^\s*/)?.[0] ?? '';
    return leading + serialize(key, val);
  });

  // Append new keys we didn't find.
  const appends: string[] = [];
  for (const [k, v] of Object.entries(updates)) {
    if (handled.has(k) || v === undefined) continue;
    appends.push(serialize(k, v));
  }
  let out = updated.join('\n');
  if (appends.length > 0) {
    if (!out.endsWith('\n')) out += '\n';
    out += appends.join('\n') + '\n';
  }
  writeFileSync(path, out, 'utf-8');
}
