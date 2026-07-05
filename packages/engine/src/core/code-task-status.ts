/**
 * Status vocabulary for CODE_TASKS.md tasks — shared by the server (renders the
 * file + applies status writes) and the CLI (parses the file back). Mirrors
 * secret-task-status.ts but for code actions.
 *
 * File token  ->  code_actions status / queued
 *   todo       -> queued,    queued=true   (an outstanding task)
 *   done       -> done,      queued=false  (implemented)
 *   dismissed  -> dismissed, queued=false  (won't do)
 *
 * Pure and dependency-free so both the Node server and the CLI can import it.
 */

import type { CodeActionStatus } from '../types/code-intel.js';

export const CODE_TASK_STATUSES = ['todo', 'done', 'dismissed'] as const;
export type CodeTaskStatus = (typeof CODE_TASK_STATUSES)[number];

export function isCodeTaskStatus(v: unknown): v is CodeTaskStatus {
  return typeof v === 'string' && (CODE_TASK_STATUSES as readonly string[]).includes(v);
}

/** Map a file token to the persisted action status + queued flag. */
export function codeTaskToStatus(t: CodeTaskStatus): { status: CodeActionStatus; queued: boolean } {
  switch (t) {
    case 'done': return { status: 'done', queued: false };
    case 'dismissed': return { status: 'dismissed', queued: false };
    case 'todo': return { status: 'queued', queued: true };
  }
}

/** Inverse: persisted action status → file token. */
export function statusToCodeTask(status: CodeActionStatus | string | undefined | null): CodeTaskStatus {
  switch (status) {
    case 'done': return 'done';
    case 'dismissed': return 'dismissed';
    default: return 'todo'; // suggested/queued → todo
  }
}
