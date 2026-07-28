/**
 * The "unresolved sessions" behaviour signal shared by both recommendation
 * builders — account-level (`/api/recommendations`) and project-level
 * (`/api/code/recommendations`).
 *
 * The two routes had grown a verbatim copy of this block. They differ only in
 * HOW the sessions are listed (tenant-wide `listItems('session', 500, 0)` vs
 * `listItemsByProjectId('session', projectId, 200)`), so the caller supplies a
 * loader rather than the ids: the original code wrapped the listing inside the
 * same try, and a listing failure must keep yielding `undefined` instead of
 * failing the request.
 *
 * `interrupted` = the user bailed before resolution; that is the unresolved
 * signal. The signal is always optional — recommendations still render without
 * it, so every failure path returns `undefined`.
 */

import { createOutcomeCache } from '../imports.js';
import type { BehaviorSignal } from '../imports.js';

export async function behaviorSignal(
  loadSessionIds: () => Promise<string[]>,
): Promise<BehaviorSignal | undefined> {
  try {
    const ids = await loadSessionIds();
    if (!ids.length) return undefined;
    const oc = await createOutcomeCache();
    try {
      const rows = await oc.getMany(ids);
      let failed = 0;
      for (const [, r] of rows) if (r && r.status === 'interrupted') failed++;
      return { failedOrAbandoned: failed, totalSessions: ids.length };
    } finally { await oc.close(); }
  } catch {
    return undefined; // behavioural signal is optional
  }
}
