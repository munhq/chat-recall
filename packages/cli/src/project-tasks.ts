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
import { fetchWithTimeout } from './http.js';
import { isSecretTaskStatus } from '@chat-recall/engine/core/secret-task-status.js';
import { isCodeTaskStatus } from '@chat-recall/engine/core/code-task-status.js';

export type TaskKind = 'secret' | 'code' | 'team';
export interface TaskEdit { kind: TaskKind; id: string; was: string; intent: string; }

/** Collaborative-task statuses (mirrors the team_tasks CHECK constraint). */
const TEAM_STATUSES = new Set(['todo', 'in_progress', 'done', 'rejected']);
export function isTeamTaskStatus(v: string | undefined): boolean { return !!v && TEAM_STATUSES.has(v); }

// Matches both `cr-secret id=…` (kind implied secret) and `cr-task kind=… id=…`.
// Status tokens can contain underscores (`in_progress`, `false_positive`), so
// the `was=` capture and the inline `status:` token both allow `_`.
const ANCHOR_RE = /<!--\s*cr-(secret|task)\b(?:\s+kind=([a-z]+))?\s+id=([A-Za-z0-9_-]+)(?:\s+was=([a-z_-]+))?\s*-->/;
const CHECKBOX_RE = /^\s*-\s*\[([ xX])\]/;
const STATUS_TOKEN_RE = /status:\s*`?([a-z_-]+)`?/i;

function defaultWas(kind: TaskKind): string { return kind === 'secret' ? 'open' : 'todo'; }
function isValidStatus(kind: TaskKind, v: string | undefined): boolean {
  return kind === 'secret' ? isSecretTaskStatus(v) : kind === 'team' ? isTeamTaskStatus(v) : isCodeTaskStatus(v);
}

/** Reconcile the `status:` token with the checkbox into the user's intent. */
function reconcile(kind: TaskKind, was: string, token: string | null, checked: boolean): string {
  const open = defaultWas(kind);              // 'open' (secret) | 'todo' (code/team) = the not-done state
  const done = kind === 'secret' ? 'rotated' : 'done'; // what a bare tick means (code/team → 'done')
  if (token && token !== was) return token;   // explicit status edit wins (all kinds)
  if (kind === 'team') {
    // A TICK CANNOT MEAN DONE ANY MORE. Done is earned by the work: the route
    // refuses it without a linked session, so a tick here would send a 409 the
    // user cannot act on from a markdown file. The honest mapping is to claim
    // the card — that is what a person ticking a box in their repo means, and
    // the agent that finishes it closes it with its session attached.
    //
    // An untick still resets a done card, because undoing a claim is safe.
    if (checked && was === 'todo') return 'in_progress';
    if (!checked && was === 'done') return 'todo';
    return token ?? was;
  }
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
      // Bounded: this runs INSIDE the intent drain, whose tick is guarded by a
      // single in-flight flag — one silent, never-settling request here stops
      // the daemon from ever draining another intent (exactly what happened on
      // desktop: 18 intents queued, none applied, no error anywhere).
      const res = await fetchWithTimeout(`${base}${fk.trackedPath}`, { headers: authHeaders });
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
        const res = await fetchWithTimeout(`${base}${fk.statusPath}`, {
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

/* ── TEAM_TASKS.md projection (collaborative tasks in the repo) ──────────
 * Unlike SECURITY/CODE (server-rendered, server-tracked), team tasks are
 * projected on demand into the repo you're in via `chat-recall tasks pull`
 * and pushed back with `chat-recall tasks push`. Each task line carries a
 * `cr-task kind=team` anchor so a checkbox/status edit round-trips to the
 * server. Statuses: todo · in_progress · blocked · done.
 */
export interface TeamTaskLite { id: string; title: string; status: string; assigneeSub?: string | null; projectId?: string; }

/** Render assigned team tasks as TEAM_TASKS.md (anchored for push-back). */
export function renderTeamTasksMd(tasks: TeamTaskLite[]): string {
  const lines: string[] = [
    '# Team tasks',
    '',
    '<!-- Managed by chat-recall. Tick a box or edit the `status:` token, then run',
    '     `chat-recall tasks push`. Statuses: todo · in_progress · done · rejected.',
    '     A tick claims a task; only the session that does the work can close it. -->',
    '',
  ];
  if (tasks.length === 0) lines.push('_No tasks assigned to you here._');
  for (const t of tasks) {
    const checked = t.status === 'done' ? 'x' : ' ';
    lines.push(`- [${checked}] ${t.title}  status: \`${t.status}\` <!-- cr-task kind=team id=${t.id} was=${t.status} -->`);
  }
  return lines.join('\n') + '\n';
}

/** Parse a TEAM_TASKS.md and return the team-task edits the user actually made. */
export function parseTeamTasksFile(content: string): TaskEdit[] {
  return parseTaskFile(content).filter((t) => t.kind === 'team');
}
