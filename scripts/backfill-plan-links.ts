/**
 * One-off backfill: re-walk every plan (with the fixed PlanSource) so existing
 * plans get their `plan_for_session` link, corrected project_path (from cwd
 * frontmatter), and title (frontmatter stripped). Ships to all logged-in
 * targets.
 *
 * Uses `useLedger: true` so already-synced SESSIONS are skipped (fast), and
 * `sinceMs: 0` so the ITEM walk covers every plan regardless of mtime — the
 * item walk is gated only by sinceMs (sync-client.ts), not the session ledger.
 *
 * Run:  npx tsx scripts/backfill-plan-links.ts
 */
import { syncSessions } from '../packages/cli/src/sync-client.js';

const r = await syncSessions({ useLedger: true, sinceMs: 0 });
console.log(`Backfill complete — ${r.uploaded} session(s) shipped (rest skipped via ledger), ${r.items} item(s), ${r.links} links, ${r.skipped} skipped, ${r.redactions} secrets redacted.`);
