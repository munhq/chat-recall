/**
 * Task-file read-back (file → server), the other half of the two-way sync for
 * BOTH task files:
 *   - SECURITY_TASKS.md  (kind=secret)  → POST /api/secrets/tasks/status
 *   - CODE_TASKS.md      (kind=code)    → POST /api/code/tasks/status
 *
 * The server renders each file and enqueues its write (intent-drain); here we
 * parse the user's/AI's edits and push status changes back. One generalized
 * parser + push handles both kinds (routed by the anchor's `kind`), so there is
 * no duplicated read-back logic. Runs on the same cadence as the intent drain.
 *
 * The only machine-parsed line per task is the anchor:
 *   - [x] status: `rotated` … <!-- cr-secret id=sec_ab12 was=open -->      (secret)
 *   - [x] status: `done`    … <!-- cr-task kind=code id=ca_9f3 was=todo --> (code)
 * We read the checkbox, the `status:` token, the id, and the original `was=`,
 * and only push tasks the user actually changed (intent !== was). Robust to
 * hand edits: reordering, extra prose, and malformed lines are all tolerated.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { isSecretTaskStatus } from '@chat-recall/engine/core/secret-task-status.js';
import { isCodeTaskStatus } from '@chat-recall/engine/core/code-task-status.js';

export type TaskKind = 'secret' | 'code';
export interface TaskEdit { kind: TaskKind; id: string; was: string; intent: string; }

// Matches both `cr-secret id=…` (kind implied secret) and `cr-task kind=… id=…`.
const ANCHOR_RE = /<!--\s*cr-(secret|task)\b(?:\s+kind=([a-z]+))?\s+id=([A-Za-z0-9_-]+)(?:\s+was=([a-z-]+))?\s*-->/;
const CHECKBOX_RE = /^\s*-\s*\[([ xX])\]/;
const STATUS_TOKEN_RE = /status:\s*`?([a-z-]+)`?/i;

function defaultWas(kind: TaskKind): string { return kind === 'secret' ? 'open' : 'todo'; }
function isValidStatus(kind: TaskKind, v: string | undefined): boolean {
  return kind === 'secret' ? isSecretTaskStatus(v) : isCodeTaskStatus(v);
}

/** Reconcile the `status:` token with the checkbox into the user's intent. */
function reconcile(kind: TaskKind, was: string, token: string | null, checked: boolean): string {
  const open = defaultWas(kind);              // 'open' (secret) | 'todo' (code) = the not-done state
  const done = kind === 'secret' ? 'rotated' : 'done'; // what a bare tick means
  if (token && token !== was) return token;   // explicit status edit wins
  if (checked && was === open) return done;   // bare tick on a not-done task
  if (!checked && was !== open) return open;   // bare untick on a resolved task
  return token ?? was;                        // no meaningful change
}

/** Parse one anchor line into a TaskEdit, or null if it isn't a task anchor. */
export function parseAnchorLine(line: string): TaskEdit | null {
  const m = ANCHOR_RE.exec(line);
  if (!m) return null;
  const kind: TaskKind = m[2] === 'code' ? 'code' : m[1] === 'secret' ? 'secret' : (m[2] as TaskKind) || 'secret';
  const id = m[3];
  const was = isValidStatus(kind, m[4]) ? (m[4] as string) : defaultWas(kind);

  const checked = (() => { const c = CHECKBOX_RE.exec(line); return c ? c[1].toLowerCase() === 'x' : false; })();
  const before = line.slice(0, line.indexOf('<!--'));
  const tokMatch = STATUS_TOKEN_RE.exec(before);
  const token = tokMatch && isValidStatus(kind, tokMatch[1]) ? tokMatch[1] : null;

  return { kind, id, was, intent: reconcile(kind, was, token, checked) };
}

/** All tasks the user actually changed in the file (intent !== was). */
export function parseTaskFile(content: string): TaskEdit[] {
  const out: TaskEdit[] = [];
  const seen = new Set<string>();
  for (const line of content.split('\n')) {
    const t = parseAnchorLine(line);
    if (!t || seen.has(t.id)) continue;       // first anchor per id wins
    seen.add(t.id);
    if (t.intent !== t.was) out.push(t);
  }
  return out;
}

/* ── mtime ledger: only re-push a file after it changes ───────────── */

function ledgerPath(): string { return join(homedir(), '.chat-recall', 'project-tasks-ledger.json'); }
function readLedger(): Record<string, number> {
  try { return JSON.parse(readFileSync(ledgerPath(), 'utf8')) as Record<string, number>; } catch { return {}; }
}
function writeLedger(l: Record<string, number>): void {
  try { mkdirSync(dirname(ledgerPath()), { recursive: true }); } catch { /* exists */ }
  try { writeFileSync(ledgerPath(), JSON.stringify(l)); } catch { /* best effort */ }
}

interface FileKind { kind: TaskKind; filename: string; trackedPath: string; statusPath: string; }
const FILE_KINDS: FileKind[] = [
  { kind: 'secret', filename: 'SECURITY_TASKS.md', trackedPath: '/api/secrets/tasks/tracked', statusPath: '/api/secrets/tasks/status' },
  { kind: 'code', filename: 'CODE_TASKS.md', trackedPath: '/api/code/tasks/tracked', statusPath: '/api/code/tasks/status' },
];

export interface PushResult { files: number; pushedTasks: number; }

/**
 * For one logged-in server: for each task-file kind, ask which project paths are
 * tracked, and for each that has a locally-edited task file, parse and push the
 * changes. Best-effort — errors on one file never abort the others.
 */
export async function pushProjectTaskStatuses(
  base: string,
  authHeaders: Record<string, string>,
  opts: { verbose?: boolean } = {},
): Promise<PushResult> {
  const out: PushResult = { files: 0, pushedTasks: 0 };
  const ledger = readLedger();
  let ledgerDirty = false;

  for (const fk of FILE_KINDS) {
    let projects: string[];
    try {
      const res = await fetch(`${base}${fk.trackedPath}`, { headers: authHeaders });
      if (!res.ok) continue;
      projects = ((await res.json()) as { projects?: string[] }).projects || [];
    } catch { continue; }

    for (const project of projects) {
      const file = join(project, fk.filename);
      if (!existsSync(file)) continue;
      let mtime: number;
      try { mtime = statSync(file).mtimeMs; } catch { continue; }
      if (ledger[file] === mtime) continue;                 // unchanged since last push

      let changed: TaskEdit[];
      try { changed = parseTaskFile(readFileSync(file, 'utf8')).filter((t) => t.kind === fk.kind); }
      catch { continue; }

      if (changed.length === 0) { ledger[file] = mtime; ledgerDirty = true; continue; }
      try {
        const res = await fetch(`${base}${fk.statusPath}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders },
          body: JSON.stringify({ project, items: changed.map((t) => ({ id: t.id, status: t.intent })) }),
        });
        if (!res.ok) continue;                               // leave ledger unset → retry next drain
        out.files++;
        out.pushedTasks += changed.length;
        ledger[file] = mtime; ledgerDirty = true;
        if (opts.verbose) console.error(`[project-tasks] ${file}: pushed ${changed.length} ${fk.kind} status change(s)`);
      } catch { /* retry next drain */ }
    }
  }

  if (ledgerDirty) writeLedger(ledger);
  return out;
}
