/**
 * Enqueue the `write_tasks_file` sync-intent that materialises a task checklist
 * in the user's repo.
 *
 * The server renders the markdown; the user's local drain writes it to disk
 * (≤45s), so no CLI change is needed to add a new checklist kind. Both
 * CODE_TASKS.md (`/api/code/tasks/write`) and SECURITY_TASKS.md
 * (`/api/secrets/tasks/write`) shipped byte-identical enqueue calls — the only
 * genuinely shared code between those two otherwise-different task domains
 * (one keys on projectId, the other on a filesystem path, with different
 * anchors, ids and persistence tables, so they are deliberately NOT merged
 * further).
 *
 * `rootPath` is where the file lands: a code project's `rootPath` for
 * CODE_TASKS.md, the repo path itself for SECURITY_TASKS.md.
 */

import type { SyncIntentInput } from '@chat-recall/engine';

/** Just the one method needed, so callers can pass any store-like object.
 *  Typed off the engine's own `SyncIntentInput` — `kind` is a union, not a
 *  free-form string, and a hand-rolled shape here silently widened it. */
interface IntentEnqueuer {
  enqueueSyncIntent(input: SyncIntentInput): Promise<string>;
}

export function enqueueTasksFile(
  store: IntentEnqueuer,
  opts: { rootPath: string; filename: string; content: string; createdBy: string },
): Promise<string> {
  return store.enqueueSyncIntent({
    kind: 'code_apply',
    artifactType: 'write_tasks_file',
    name: JSON.stringify({ rootPath: opts.rootPath, filename: opts.filename, content: opts.content }),
    createdBy: opts.createdBy,
  });
}
