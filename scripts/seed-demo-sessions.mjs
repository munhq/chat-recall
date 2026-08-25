/**
 * Generate a synthetic Claude Code transcript tree for the REVIEWER DEMO ACCOUNT.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * The connector directory's submission portal requires "credentials for a fully
 * populated account" a reviewer can use end to end. chat-recall has a structural
 * problem there that most connectors do not: a brand-new account is EMPTY by
 * design. The transcripts live on the user's own disk, and nothing reaches the
 * server until their CLI syncs. A reviewer who signs up, connects and runs
 * recall_search gets zero results and reasonably concludes the product is broken.
 *
 * The obvious shortcut — hand them the maintainer's own tenant — is not
 * available: that is 223k chunks of real, private engineering history.
 *
 * So the demo account gets invented history. This script writes it.
 *
 * ── Everything here is invented, and that is a hard requirement ───────────
 *
 * This repository is public and the output is handed to a stranger. Every path,
 * project, branch and name below is synthetic: `/home/user/code/...`, `acme`,
 * `example-app`. Nothing is read off the machine that runs this. See the
 * "Never hardcode a real path, machine or account" section of CLAUDE.md — the
 * failure mode it describes is exactly this one, where the nearest concrete
 * value is the real one.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────
 *
 *   node scripts/seed-demo-sessions.mjs --out /tmp/demo-claude-home
 *   CHAT_RECALL_CLAUDE_HOME=/tmp/demo-claude-home \
 *     CHAT_RECALL_SERVER=https://chatrecall.dev \
 *     CHAT_RECALL_TOKEN=<demo account device token> \
 *     chat-recall index
 *
 * The sessions carry timestamps spread over the past several weeks, because a
 * memory product demonstrates nothing when every session happened at once — the
 * reviewer needs "what did I do last week" to have an answer.
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const outArg = process.argv.indexOf('--out');
const OUT = outArg > -1 ? process.argv[outArg + 1] : '/tmp/demo-claude-home';

/** Invented projects. Names chosen to be obviously fictional. */
// NOTE: no hyphens in the final path segment. Claude Code encodes a project
// directory by replacing '/' with '-', which is lossy — `example-app` decodes
// back to `example/app`, and the demo account would show invented projects under
// wrong-looking paths. Single-word names round-trip cleanly.
const PROJECTS = [
  { path: '/home/user/code/storefront', branch: 'main' },
  { path: '/home/user/code/checkout', branch: 'feat/idempotency' },
  { path: '/home/user/code/dashboard', branch: 'main' },
];

/**
 * The sessions. Written as real engineering conversations rather than lorem
 * ipsum, because the reviewer will search them: "did we decide on Postgres",
 * "the rate limiter bug". Filler text makes every recall tool look useless even
 * when it works perfectly.
 */
const SESSIONS = [
  {
    project: 0, daysAgo: 21, slug: 'rate-limiter-token-bucket',
    turns: [
      ['user', 'The rate limiter is letting through about twice the configured burst. Can you find why?'],
      ['assistant', 'Found it. `refill()` computes elapsed seconds with integer division, so any interval under a second rounds to zero and the bucket never drains — but the top-up still runs. Two calls inside the same second each see a full bucket.'],
      ['tool', 'Read', 'src/middleware/rate-limit.ts'],
      ['assistant', 'Switched to millisecond arithmetic and clamped the refill to the bucket capacity. Added a test that fires 50 requests inside one second and asserts exactly `burst` get through.'],
      ['tool', 'Edit', 'src/middleware/rate-limit.ts'],
      ['user', 'Good. Does that change behaviour for the sustained case?'],
      ['assistant', 'No — sustained rate is unchanged, because it was already computed from the same elapsed value at a granularity above one second. Only the sub-second path moves.'],
    ],
  },
  {
    project: 0, daysAgo: 18, slug: 'postgres-over-dynamo-decision',
    turns: [
      ['user', 'We need to pick a datastore for the audit log. Postgres or Dynamo?'],
      ['assistant', 'Postgres. The access pattern is "everything for one tenant between two dates, ordered", which is one index in Postgres and a GSI plus pagination glue in Dynamo. You also already run Postgres, so this adds no operational surface.'],
      ['user', 'What about write volume at peak?'],
      ['assistant', 'Peak is roughly 400 writes/sec by your own numbers. A single Postgres instance handles that comfortably with a BRIN index on the timestamp column. Revisit if it passes 5k/sec sustained, which is where partitioning starts to matter.'],
      ['user', 'Agreed, Postgres. Write it down.'],
      ['assistant', 'Recorded the decision: audit log on Postgres, BRIN index on `created_at`, revisit above 5k writes/sec sustained.'],
    ],
  },
  {
    project: 1, daysAgo: 12, slug: 'checkout-double-charge',
    turns: [
      ['user', 'A customer got charged twice for one checkout. Trace it.'],
      ['assistant', 'The retry is the cause. `POST /checkout` has no idempotency key, and the client retries on a 504. The first request succeeded server-side and timed out at the proxy, so the retry created a second charge against the same cart.'],
      ['tool', 'Read', 'src/routes/checkout.ts'],
      ['assistant', 'Added an idempotency key derived from cart id plus a client-supplied nonce, stored before the charge and checked inside the same transaction. A replay now returns the original result rather than charging again.'],
      ['tool', 'Edit', 'src/routes/checkout.ts'],
      ['user', 'Is the window long enough? The proxy retries for 30s.'],
      ['assistant', 'The key is kept for 24 hours, so a 30-second retry window is well inside it. The cost is one small row per checkout, expired by a nightly sweep.'],
    ],
  },
  {
    project: 1, daysAgo: 9, slug: 'checkout-a11y-pass',
    turns: [
      ['user', 'Run an accessibility pass over the checkout form.'],
      ['assistant', 'Four issues. The card-number field has no label (only a placeholder), the error summary is not announced, the submit button loses focus on validation failure, and the contrast on the disabled state is 2.1:1 against a 4.5:1 requirement.'],
      ['tool', 'Edit', 'src/components/CheckoutForm.tsx'],
      ['assistant', 'Fixed all four. The error summary is now a live region and receives focus on failure, which also solves the lost-focus problem.'],
    ],
  },
  {
    project: 2, daysAgo: 5, slug: 'flaky-test-timezone',
    turns: [
      ['user', 'This test only fails in CI, never locally. What is going on?'],
      ['assistant', 'A timezone assumption. The test builds a date with `new Date("2026-03-14")`, which parses as UTC midnight, then asserts a local-time format. Your machine is UTC+2 so it reads as the 14th; CI runs UTC and reads as the 14th too — until the clock crosses a DST boundary, which is exactly the date chosen.'],
      ['tool', 'Read', 'test/format-date.test.ts'],
      ['assistant', 'Pinned the test timezone explicitly and asserted against an ISO string rather than a locale-formatted one. It now fails or passes identically everywhere.'],
      ['tool', 'Edit', 'test/format-date.test.ts'],
    ],
  },
  {
    project: 2, daysAgo: 2, slug: 'n-plus-one-dashboard',
    turns: [
      ['user', 'The dashboard takes 8 seconds to load. Profile it.'],
      ['assistant', 'An N+1. The project list fetches each project, then issues one query per project for its member count — 140 queries for 140 projects. The rest of the page is under 200ms.'],
      ['tool', 'Read', 'src/services/projects.ts'],
      ['assistant', 'Replaced the per-project count with a single grouped aggregate joined onto the list. Load time drops from 8.1s to 240ms on the same data.'],
      ['tool', 'Edit', 'src/services/projects.ts'],
      ['user', 'Any risk with very large tenants?'],
      ['assistant', 'The aggregate is indexed on the tenant column, so it scales with matched rows rather than project count. The old version got linearly worse; this one does not.'],
    ],
  },
];

const DAY = 86_400_000;
const encode = (p) => p.replace(/\//g, '-');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'projects'), { recursive: true });

let written = 0;
for (const s of SESSIONS) {
  const proj = PROJECTS[s.project];
  const dir = join(OUT, 'projects', encode(proj.path));
  mkdirSync(dir, { recursive: true });

  const sessionId = randomUUID();
  let t = Date.now() - s.daysAgo * DAY;
  const lines = [];

  for (const turn of s.turns) {
    t += 45_000 + Math.round(30_000 * ((lines.length % 7) / 7));   // deterministic spread
    const ts = new Date(t).toISOString();
    const base = { sessionId, cwd: proj.path, gitBranch: proj.branch, slug: s.slug, timestamp: ts, uuid: randomUUID() };

    if (turn[0] === 'user') {
      lines.push({ ...base, type: 'user', message: { role: 'user', content: turn[1] } });
    } else if (turn[0] === 'assistant') {
      lines.push({ ...base, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: turn[1] }] } });
    } else {
      // A tool use, then its result — what the edit timeline and the diff tools read.
      lines.push({
        ...base, type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${randomUUID().slice(0, 12)}`, name: turn[1], input: { file_path: `${proj.path}/${turn[2]}` } }] },
      });
      lines.push({
        ...base, uuid: randomUUID(), type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', content: `Applied change to ${turn[2]}` }] },
      });
    }
  }

  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  written++;
  console.log(`  ${s.slug.padEnd(28)} ${proj.path}  (${s.daysAgo}d ago, ${lines.length} entries)`);
}

console.log(`\n${written} synthetic sessions across ${PROJECTS.length} invented projects → ${OUT}`);
console.log('Next: point CHAT_RECALL_CLAUDE_HOME at it and run `chat-recall index` as the demo account.');
