/**
 * The status vocabulary for SECURITY_TASKS.md tasks — the single source of
 * truth shared by the server (which renders the file + applies status writes)
 * and the CLI (which parses the file back and pushes status edits).
 *
 * File token  ->  server `secret_dismissals` status
 *   open         (no dismissal — clear it)
 *   rotated   -> rotated
 *   not-a-secret -> false_positive
 *   dismissed -> dismissed
 *
 * Pure and dependency-free so both the Node server and the CLI can import it.
 */

export const SECRET_TASK_STATUSES = ['open', 'rotated', 'not-a-secret', 'dismissed'] as const;
export type SecretTaskStatus = (typeof SECRET_TASK_STATUSES)[number];

export function isSecretTaskStatus(v: unknown): v is SecretTaskStatus {
  return typeof v === 'string' && (SECRET_TASK_STATUSES as readonly string[]).includes(v);
}

/** Map a file status token to the persisted dismissal status, or null = open/clear. */
export function taskStatusToDismissal(t: SecretTaskStatus): 'rotated' | 'false_positive' | 'dismissed' | null {
  switch (t) {
    case 'rotated': return 'rotated';
    case 'not-a-secret': return 'false_positive';
    case 'dismissed': return 'dismissed';
    case 'open': return null;
  }
}

/** Inverse: persisted dismissal status → file status token. */
export function dismissalToTaskStatus(status: string | undefined | null): SecretTaskStatus {
  switch (status) {
    case 'rotated': return 'rotated';
    case 'false_positive': return 'not-a-secret';
    case 'dismissed': return 'dismissed';
    default: return 'open';
  }
}
