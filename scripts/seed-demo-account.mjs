#!/usr/bin/env node
/**
 * POPULATE THE REVIEW / DEMO ACCOUNT with sessions that look like real work.
 *
 * The directory submission asks for "a fully populated account for review", and
 * ours was populated only on paper: six sessions, all old enough to fall outside
 * every default time window. A reviewer following the suggested prompts got
 * "No sessions found for this period", "Total sessions: 0", "No user prompts
 * found" — a product that appears to do nothing, from tools that are all working
 * correctly. Nothing is more expensive to explain after the fact.
 *
 * This seeds through THE REAL PIPELINE: it writes fixture transcripts into a
 * throwaway CHAT_RECALL_CLAUDE_HOME and runs the actual CLI sync against the
 * target server. No hand-written SQL, no rows conjured into tables — the data
 * arrives exactly as a user's does, through the same redaction, chunking,
 * classification and entity extraction. If the pipeline changes, the demo
 * account changes with it, which is the only way a demo stays honest.
 *
 * EVERY PATH, PROJECT AND NAME HERE IS INVENTED. This repository is public and
 * the account is public-facing; a real path would publish someone's machine and
 * add nothing. Timestamps are spread across the last few days so the weekly
 * digest, analytics and "what was I doing" windows all have something to show.
 *
 *   CHAT_RECALL_TOKEN=<device token> node scripts/seed-demo-account.mjs
 *   SERVER=https://chatrecall.dev CHAT_RECALL_TOKEN=… node scripts/seed-demo-account.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';

const SERVER = (process.env.SERVER || 'https://chatrecall.dev').replace(/\/+$/, '');
const TOKEN = process.env.CHAT_RECALL_TOKEN || '';
if (!TOKEN) { console.error('CHAT_RECALL_TOKEN is required (a device token for the demo tenant).'); process.exit(2); }

const ROOT = mkdtempSync(join(tmpdir(), 'cr-seed-'));
const HOME = join(ROOT, 'claude');
const HOUR = 3_600_000;
const now = Date.now();

/** Claude Code's directory encoding: separators become hyphens. */
const encode = (p) => p.replace(/\//g, '-');

/**
 * The sessions. Written to read like a small team's week, because a reviewer
 * judges the product by whether the ANSWERS look useful, not by row counts.
 * Each carries a decision or a problem the classifier can pick up, so the
 * knowledge graph and the "decisions" views are not empty either.
 */
/* AGES ARE PART OF THE FIXTURE.
 *
 * classifyStatus() reads recency: under two hours old is `in_progress`, and
 * edits with no commits is `abandoned`. Every seeded session had edits, no
 * commits and an age over two hours, so the list rendered fourteen identical
 * red "abandoned" labels — a demo account that looks like a graveyard.
 *
 * `shipped` is NOT reachable here and must not be faked: it requires commits,
 * and commits are resolved from the filesystem at view time, which a demo
 * tenant does not have. Two recent sessions give the list an honest second
 * state instead. */
/* CREDENTIAL SHAPES, ASSEMBLED AT RUN TIME.
 *
 * These fixtures must look like real credentials to chat-recall's scanner —
 * that is the whole point of them. But a literal of that shape in a source file
 * is also what GitHub's push protection matches, and it refused the push, which
 * is the correct behaviour on both sides.
 *
 * So the source holds no matching literal and the fixture transcript on disk
 * does. The values are still structurally valid and still dead: all-zero ids
 * and a placeholder body that has never been a live endpoint anywhere. */
const slackHook = ['https://hooks', '.slack.com/services',
  '/T00000000', '/B00000000', '/' + 'X'.repeat(24)].join('');
const githubPat = 'gh' + 'p_' + '0'.repeat(36);

const SESSIONS = [
  {
    /* ONE SESSION WITH REAL MASS.
     *
     * The published conversation screenshot showed 75 messages, 15 files and a
     * context bar well past 100%, and no seeded session had more than four
     * turns — so that figure could only ever be taken from a real account, and
     * the one that shipped carried real session titles and real file paths.
     *
     * COMMITS ARE DELIBERATELY ABSENT. `groupFilesByRepo` resolves a session's
     * file paths against the filesystem at view time, so commits only ever
     * render when the repository is on the machine doing the viewing. A demo
     * tenant cannot have them, and a marketing figure should not advertise a
     * panel that is empty for everyone who is not the author. */
    id: 'aa11bb22-cc33-4d44-8e55-f66600000015',
    project: '/home/user/code/storefront',
    hoursAgo: 1,
    model: 'claude-sonnet-4-5',
    turns: [
      ['user', 'Checkout is timing out for about one order in twenty. It is not the payment provider — their dashboard shows no failed calls at all for the ones that time out.'],
      ['assistant', 'Then the request is dying before it reaches them. Three places that can happen: the connection pool, a lock held across the provider call, or a retry storm. Start with the pool — what is `max` set to, and how many web workers are running?'],
      ['user', 'Pool max is 10, and there are 8 workers.'],
      ['assistant', "Eighty connections against a Postgres `max_connections` that is almost certainly 100, before you count migrations, the read replica's own pool and any psql session someone left open. Under load you are at the ceiling and new checkouts wait for a connection that never frees."],
      ['user', 'How do I confirm that rather than guess?'],
      ['assistant', '`select count(*), state from pg_stat_activity group by 2` during a spike. If `idle in transaction` is more than a handful, the pool is not the root cause — something is holding transactions open, and shrinking the pool will only move the queue.'],
      ['user', '42 idle in transaction.'],
      ['assistant', 'That is the answer, and it is not the pool. Something opens a transaction and then does slow work inside it. Given the symptom, I would bet the provider call happens inside the transaction that reserves stock.'],
      ['user', 'It does. reserveStock opens a transaction, calls the provider, then commits.'],
      ['assistant', 'So every checkout holds a row lock and a pooled connection for the entire round trip to a third party. One slow response from them and the queue backs up behind locks nobody can see, which is exactly why their dashboard looks clean: the calls that time out for you never arrive.'],
      ['user', 'So split it.'],
      ['assistant', 'Split it into three: reserve stock and commit, call the provider outside any transaction, then a second short transaction to confirm or release. The reservation needs a TTL so an abandoned checkout releases itself.'],
      ['user', 'What TTL?'],
      ['assistant', "Longer than the provider's own timeout plus your retries, shorter than a shopper will wait. Their timeout is 30s and you retry twice, so 2 minutes is safe and a sweeper releases anything older."],
      ['user', 'Done. What about the double-charge risk when the confirm transaction fails after the provider succeeded?'],
      ['assistant', 'Idempotency key on the provider call, keyed by reservation id. If the confirm fails you retry the same key and they return the original charge rather than making a second one. Store the key with the reservation before you call.'],
      ['user', 'Added. Anything else holding transactions open?'],
      ['assistant', 'The nightly report. It opens one transaction for the whole run and takes eleven minutes. It is not causing the checkout timeouts, but it is why you see this at 2am as well as at peak.'],
      ['user', 'Fixed that too — batching in chunks of 500.'],
      ['assistant', 'Then the two sources are gone. Re-run the pg_stat_activity query at the next spike; `idle in transaction` should sit near zero.'],
      ['user', 'Ran it at peak. Two idle, both under a second.'],
      ['assistant', 'That is a healthy pool. The checkout timeouts should be gone with them.'],
      ['user', 'Confirmed, no timeouts in 6 hours. Thanks.'],
      ['assistant', 'Good. The reservation TTL sweeper is the part to watch: if it ever stops, stock leaks out of inventory silently rather than loudly. Alert on reservations older than the TTL rather than on the sweeper process.'],
    ],
    edits: [
      { file: '/home/user/code/storefront/src/checkout/reserve.ts', old: 'await tx.begin(); await provider.charge(order); await tx.commit();', new: 'await tx.begin(); const r = await reserve(order); await tx.commit();' },
      { file: '/home/user/code/storefront/src/checkout/reserve.ts', old: 'const RESERVATION_TTL = null;', new: 'const RESERVATION_TTL = 120_000;' },
      { file: '/home/user/code/storefront/src/checkout/confirm.ts', old: 'await provider.charge(order);', new: 'await provider.charge(order, { idempotencyKey: r.id });' },
      { file: '/home/user/code/storefront/src/checkout/sweeper.ts', old: '// TODO: release stale reservations', new: 'await releaseOlderThan(Date.now() - RESERVATION_TTL);' },
      { file: '/home/user/code/storefront/src/db/pool.ts', old: 'max: 10,', new: 'max: 6,' },
      { file: '/home/user/code/storefront/src/reports/nightly.ts', old: 'await tx.begin();', new: 'for (const chunk of chunks(rows, 500)) {' },
      { file: '/home/user/code/storefront/src/reports/nightly.ts', old: 'await tx.commit();', new: '}' },
      { file: '/home/user/code/storefront/src/checkout/types.ts', old: 'export interface Reservation { id: string; }', new: 'export interface Reservation { id: string; expiresAt: number; idempotencyKey: string; }' },
      { file: '/home/user/code/storefront/src/monitoring/alerts.ts', old: '// no reservation alerting', new: "alertOn('reservations_older_than_ttl', { threshold: 1 });" },
      { file: '/home/user/code/storefront/tests/checkout.reserve.test.ts', old: "it.todo('releases an abandoned reservation');", new: "it('releases an abandoned reservation', async () => { /* … */ });" },
    ],
  },
  {
    /* MORE THAN ONE FINDING, AND MORE THAN ONE SEVERITY.
     *
     * One finding renders a security board with a single row, which is why the
     * published security screenshot had to be taken from a real account — and
     * that image shipped 8392 real findings and the last four characters of
     * three live keys to a public marketing page.
     *
     * EVERY VALUE BELOW IS STRUCTURALLY VALID AND HAS NEVER BEEN LIVE. They are
     * vendor documentation examples or obvious placeholders that still match the
     * detector's shape, so the scanner grades them honestly and the liveness
     * check reports DEAD. Never swap one for a real or once-real key to make the
     * board look busier. */
    id: 'aa11bb22-cc33-4d44-8e55-f66600000011',
    project: '/home/user/code/acme-api',
    hoursAgo: 31,
    model: 'claude-sonnet-4-5',
    turns: [
      ['user', 'CI cannot clone the private module. This is the URL the job uses:\n\nhttps://ci-bot:EXAMPLEPASSWORDNOTREAL@git.example.com/acme/shared.git\n\nWhy does it 403?'],
      ['assistant', 'The token has read access to the org, not to that repository, so the clone is authorised and then refused at the repo boundary. Two things: grant the deploy key on `acme/shared`, and take the credential out of the URL. A password in a git remote ends up in every CI log line that echoes the command, and in the reflog on every runner that has ever cloned it. Use a deploy key or a credential helper instead.'],
      ['user', 'Moved it to a deploy key.'],
      ['assistant', 'Good. `.github/workflows/ci.yml` now clones over SSH with the deploy key, and the URL carries no credential. Rotate the old one — it was in the workflow file, so it is in the repository history until you do.'],
    ],
    edits: [
      { file: '/home/user/code/acme-api/.github/workflows/ci.yml', old: 'url: https://ci-bot:***@git.example.com/acme/shared.git', new: 'url: git@git.example.com:acme/shared.git' },
    ],
  },
  {
    id: 'aa11bb22-cc33-4d44-8e55-f66600000012',
    project: '/home/user/code/example-app',
    hoursAgo: 44,
    model: 'claude-sonnet-4-5',
    turns: [
      ['user', `The webhook relay stopped posting. Config:\n\nSLACK_WEBHOOK=${slackHook}\nGITHUB_TOKEN=${githubPat}\n\nIs the token expired?`],
      ['assistant', 'The token is not the problem — the relay is posting to a webhook that was revoked, so Slack returns 404 and the relay treats it as retryable and backs off forever. Recreate the webhook. Separately: you have just pasted both a Slack webhook and a GitHub token into this chat, and a webhook URL is itself the credential. Anyone holding it can post as that app. Rotate both and read them from the environment.'],
      ['user', 'Rotated. Reading from env now.'],
      ['assistant', 'Confirmed. `src/relay.ts` reads SLACK_WEBHOOK and GITHUB_TOKEN from `process.env` and fails loudly at boot when either is missing, rather than posting into the void.'],
    ],
    edits: [
      { file: '/home/user/code/example-app/src/relay.ts', old: 'const hook = cfg.SLACK_WEBHOOK;', new: 'const hook = requireEnv("SLACK_WEBHOOK");' },
    ],
  },
  {
    id: 'aa11bb22-cc33-4d44-8e55-f66600000013',
    project: '/home/user/code/dashboard',
    hoursAgo: 58,
    model: 'gpt-5-codex',
    turns: [
      ['user', 'Local migrations fail against staging. Connection string:\n\npostgres://app:EXAMPLEPASSWORDNOTREAL@db.staging.example.com:5432/app?sslmode=disable\n\nIt times out.'],
      ['assistant', 'It times out because `sslmode=disable` is refused by the staging proxy, which only accepts TLS — the connection is dropped before the handshake finishes, so you see a timeout rather than a rejection. Set `sslmode=require`. Also: that string carries the database password. Put it in a secret store and reference it by name; a connection string in a shell history is a password in a shell history.'],
      ['user', 'sslmode=require worked.'],
      ['assistant', 'Migrations run. `scripts/migrate.ts` now builds the URL from DATABASE_URL and refuses to start if sslmode is absent, so a working local default cannot silently become an insecure staging connection.'],
    ],
    edits: [
      { file: '/home/user/code/dashboard/scripts/migrate.ts', old: "sslmode=disable", new: "sslmode=require" },
    ],
  },
  {
    id: 'aa11bb22-cc33-4d44-8e55-f66600000014',
    project: '/home/user/code/widget-cli',
    hoursAgo: 71,
    model: 'claude-sonnet-4-5',
    turns: [
      ['user', 'Signing broke after the key rotation. This is what the build uses:\n\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAexampleexampleexampleexampleexampleexampleexampleex\nampleexampleexampleexampleexampleexampleexampleexampleexampleexampl\n-----END RSA PRIVATE KEY-----\n\nWhat changed?'],
      ['assistant', 'Stop — do not paste that anywhere else, and rotate it. A private key in a chat transcript is the whole credential, not a reference to it; it is now in this session file on disk and in any backup of it. On the actual failure: the new key is PKCS#1 and the signer expects PKCS#8, so it parses as garbage rather than erroring clearly. Convert it, load it from the keychain, and never put it in the build config.'],
      ['user', 'Rotated and moved to the keychain.'],
      ['assistant', 'Signing works. `build/sign.ts` reads the key from the OS keychain at run time and the build config holds only the key identifier.'],
    ],
    edits: [
      { file: '/home/user/code/widget-cli/build/sign.ts', old: 'const key = readFileSync("signing.pem");', new: 'const key = await keychain.get("widget-cli-signing");' },
    ],
  },
  {
    // THE CREDENTIAL FIXTURE. The security view and the "did I paste an API key"
    // test case both answer from a finding, and with no finding they answer
    // "none detected" — which reads as a broken scanner rather than a clean
    // account, and is a failed test case in review.
    //
    // The key is AWS's own documentation example (AKIAIOSFODNN7EXAMPLE). It
    // matches the AKIA detector in secret-redactor.ts, so a finding is raised,
    // and it has never been a live credential anywhere, so the liveness check
    // reports it DEAD. That is the honest demo: a finding a reviewer can see,
    // graded exactly as a stale key should be. NEVER replace this with a real
    // or once-real key to make the demo look better.
    id: 'aa11bb22-cc33-4d44-8e55-f66600000007',
    project: '/home/user/code/storefront',
    hoursAgo: 9,
    model: 'claude-sonnet-4-5',
    turns: [
      ['user', 'The nightly export box cannot reach S3. Here is the config it is using, tell me what is wrong:\n\nAWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nAWS_REGION=eu-west-3\nS3_BUCKET=storefront-exports'],
      ['assistant', 'Two problems. The bucket is in eu-west-1, not eu-west-3, so every call signs for the wrong region. And you just pasted a live-looking access key id into this conversation: rotate it and load it from the environment instead of the config file. I changed the region and moved the credential lookup to process.env in `scripts/export.ts`.'],
      ['user', 'Rotated. Keep the env lookup.'],
      ['assistant', 'Done. `scripts/export.ts` reads AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY from the environment, and the config file no longer carries either.'],
    ],
    edits: [
      { file: '/home/user/code/storefront/scripts/export.ts', old: "const region = 'eu-west-3';", new: "const region = 'eu-west-1';" },
      { file: '/home/user/code/storefront/scripts/export.ts', old: "const keyId = cfg.AWS_ACCESS_KEY_ID;", new: "const keyId = process.env.AWS_ACCESS_KEY_ID;" },
    ],
  },
  {
    // OAUTH, TWICE, WITH DIFFERENT ENDINGS. "Find my past sessions about OAuth
    // and tell me which ones actually shipped" is a submitted test case, and the
    // account had no OAuth session at all — the search correctly returned
    // nothing and the answer read as an empty product. Two sessions, because the
    // question is comparative: one that finished and one that did not, so the
    // answer can distinguish them instead of reporting a single row.
    id: 'aa11bb22-cc33-4d44-8e55-f66600000008',
    project: '/home/user/code/dashboard',
    hoursAgo: 20,
    model: 'claude-sonnet-4-5',
    turns: [
      ['user', 'Add OAuth login to the dashboard. Google and GitHub, and it has to work alongside the existing email and password sign-in.'],
      ['assistant', 'Added both providers behind a single callback route. `src/auth/oauth.ts` holds the provider config, `src/auth/callback.ts` exchanges the code and links the account to an existing email user when the addresses match, and the sign-in page now renders the two buttons above the password form.'],
      ['user', 'What happens when someone signs in with Google using an address that already has a password account?'],
      ['assistant', 'It links rather than duplicates: the callback looks the address up first and attaches the provider identity to the existing user. A social sign-in also marks the address verified, which the trial grant reads. Both paths are covered in `src/auth/oauth.test.ts`.'],
      ['user', 'Tested it with my own account, works. Ship it.'],
      ['assistant', 'Merged. Google and GitHub sign-in are live on the dashboard, account linking is by verified email, and the password path is unchanged.'],
    ],
    edits: [
      { file: '/home/user/code/dashboard/src/auth/oauth.ts', old: 'export const providers = [];', new: "export const providers = ['google', 'github'];" },
      { file: '/home/user/code/dashboard/src/auth/callback.ts', old: 'const user = await createUser(profile);', new: 'const user = await findByEmail(profile.email) ?? await createUser(profile);' },
      { file: '/home/user/code/dashboard/src/pages/sign-in.tsx', old: '<PasswordForm />', new: '<OAuthButtons />\n<PasswordForm />' },
    ],
  },
  {
    id: 'aa11bb22-cc33-4d44-8e55-f66600000009',
    project: '/home/user/code/storefront',
    hoursAgo: 62,
    model: 'claude-sonnet-4-5',
    turns: [
      ['user', 'Do the same OAuth login for the storefront.'],
      ['assistant', 'Started the same shape: provider config in `src/auth/oauth.ts` and a callback route. The storefront keeps its sessions in a signed cookie rather than the dashboard\'s server-side table, so the callback cannot reuse the dashboard\'s account-linking code as it stands.'],
      ['user', 'Leave it for now, I need to think about the cookie change.'],
      ['assistant', 'Stopped there. The provider config is in place and unused; nothing is wired into the sign-in page, so the storefront login is unchanged and this is safe to leave uncommitted.'],
    ],
    edits: [
      { file: '/home/user/code/storefront/src/auth/oauth.ts', old: 'export const providers = [];', new: "export const providers = ['google'];" },
    ],
  },
  {
    id: 'aa11bb22-cc33-4d44-8e55-f66600000001',
    project: '/home/user/code/example-app',
    hoursAgo: 1,
    model: 'claude-sonnet-4-5',
    turns: [
      ['user', 'The login endpoint returns 500 when the email has a plus sign. Can you find why?'],
      ['assistant', 'The address was being used unencoded in a query string, so `a+b@example.com` arrived as `a b@example.com`. I fixed the encoding in `src/auth/login.ts` and added a test for the plus case.'],
      ['user', 'Good. Does the same bug exist in the password reset path?'],
      ['assistant', 'It did. Same fix applied in `src/auth/reset.ts`. Both paths now use encodeURIComponent, and the test covers plus, dot and unicode addresses.'],
    ],
    edits: [
      { file: '/home/user/code/example-app/src/auth/login.ts', old: 'const q = `?email=${email}`;', new: 'const q = `?email=${encodeURIComponent(email)}`;' },
      { file: '/home/user/code/example-app/src/auth/reset.ts', old: 'const q = `?email=${email}`;', new: 'const q = `?email=${encodeURIComponent(email)}`;' },
    ],
  },
  {
    id: 'aa11bb22-cc33-4d44-8e55-f66600000002',
    project: '/home/user/code/example-app',
    hoursAgo: 27,
    model: 'claude-sonnet-4-5',
    turns: [
      ['user', 'We need caching in front of the pricing API. Redis or in-process?'],
      ['assistant', 'I chose Redis over an in-process cache, because pricing has to be consistent across the three API replicas and an in-process map would drift per pod. Added a 60-second TTL in `src/pricing/cache.ts`.'],
      ['user', 'What happens if Redis is down?'],
      ['assistant', 'It fails open to a direct call rather than erroring — a cache outage should slow the endpoint, not break it. That path is covered by a test that kills the client.'],
    ],
    edits: [
      { file: '/home/user/code/example-app/src/pricing/cache.ts', old: '', new: 'export async function cachedPrice(sku: string) { /* redis, 60s ttl, fail-open */ }' },
    ],
  },
  {
    id: 'aa11bb22-cc33-4d44-8e55-f66600000003',
    project: '/home/user/code/acme-api',
    hoursAgo: 50,
    model: 'claude-opus-4-1',
    turns: [
      ['user', 'Migrate the reporting queries off the primary and onto the read replica.'],
      ['assistant', 'Moved the six read-only report queries to the replica pool in `db/reports.ts`. One of them wrote an audit row, so that stayed on the primary — a read replica cannot take it.'],
      ['user', 'Any risk of stale numbers?'],
      ['assistant', 'Yes, replication lag means a report can trail by a second or two. That is acceptable for daily reporting, and I noted the limit in the module comment so nobody moves a real-time query there later.'],
    ],
    edits: [
      { file: '/home/user/code/acme-api/db/reports.ts', old: 'pool.query(', new: 'replicaPool.query(' },
    ],
  },
  {
    id: 'aa11bb22-cc33-4d44-8e55-f66600000004',
    project: '/home/user/code/acme-api',
    hoursAgo: 74,
    model: 'claude-sonnet-4-5',
    turns: [
      ['user', 'Rate limit the public search endpoint. It is getting hammered.'],
      ['assistant', 'Added a sliding-window limiter keyed on API key, 600 requests per 5 minutes, in `middleware/limit.ts`. Anonymous callers get a tenth of that, keyed on IP.'],
      ['user', 'Make sure health checks are exempt.'],
      ['assistant', 'Exempted `/healthz` and `/readyz` — a limiter that can fail a liveness probe takes the service down by itself, which is the opposite of what it is for.'],
    ],
    edits: [
      { file: '/home/user/code/acme-api/middleware/limit.ts', old: '', new: 'export const limiter = slidingWindow({ max: 600, windowMs: 300_000 });' },
    ],
  },
  {
    id: 'aa11bb22-cc33-4d44-8e55-f66600000005',
    project: '/home/user/code/widget-cli',
    hoursAgo: 100,
    model: 'claude-sonnet-4-5',
    turns: [
      ['user', 'The CLI prints a stack trace when the config file is missing. Make it a real message.'],
      ['assistant', 'It now says which path it looked in and how to create one. A stack trace tells a user nothing they can act on, and it hid the fact that the default path had moved.'],
      ['user', 'Add a test so it stays that way.'],
      ['assistant', 'Added a test asserting the message names the path and does not contain "at Object." — pinning the absence of the trace, since that is the regression.'],
    ],
    edits: [
      { file: '/home/user/code/widget-cli/src/config.ts', old: 'throw err;', new: 'console.error(`No config at ${path}. Create one with \\`widget init\\`.`);' },
    ],
  },
  {
    id: 'aa11bb22-cc33-4d44-8e55-f66600000006',
    project: '/home/user/code/widget-cli',
    hoursAgo: 130,
    model: 'claude-haiku-4-5',
    turns: [
      ['user', 'Why is the bundle 4MB? It was 900KB last month.'],
      ['assistant', 'A date library got pulled in transitively by the new export command and is bundled whole. Replacing three calls with the built-in Intl API drops it to 1.1MB.'],
      ['user', 'Do it, and add a size check to CI.'],
      ['assistant', 'Done — 1.06MB now, and CI fails above 1.5MB so the next regression is caught by the build rather than by a user on a slow connection.'],
    ],
    edits: [
      { file: '/home/user/code/widget-cli/src/export.ts', old: "import { format } from 'heavy-date';", new: '// Intl.DateTimeFormat — no dependency' },
    ],
  },
];

function buildTranscript(s) {
  const start = now - s.hoursAgo * HOUR;
  const lines = [];
  let i = 0;
  for (const [role, text] of s.turns) {
    const ts = new Date(start + i * 90_000).toISOString();
    if (role === 'user') {
      lines.push({
        type: 'user', uuid: `u${i}`, sessionId: s.id, timestamp: ts, cwd: s.project,
        gitBranch: 'main', message: { role: 'user', content: text },
      });
    } else {
      lines.push({
        type: 'assistant', uuid: `a${i}`, parentUuid: `u${i - 1}`, sessionId: s.id, timestamp: ts,
        cwd: s.project, gitBranch: 'main',
        message: {
          role: 'assistant', model: s.model,
          content: [{ type: 'text', text }],
          usage: { input_tokens: 900 + i * 120, output_tokens: 180 + i * 40, cache_read_input_tokens: 4200 },
        },
      });
    }
    i++;
  }
  // One edit per session, as a tool_use turn, so the diff and
  // files-touched views have something real to reconstruct.
  for (const [n, e] of s.edits.entries()) {
    lines.push({
      type: 'assistant', uuid: `e${n}`, parentUuid: `a${i - 1}`, sessionId: s.id,
      timestamp: new Date(start + (i + n) * 90_000).toISOString(), cwd: s.project, gitBranch: 'main',
      message: {
        role: 'assistant', model: s.model,
        content: [{
          type: 'tool_use', id: `tu_${s.id.slice(0, 8)}_${n}`, name: 'Edit',
          input: { file_path: e.file, old_string: e.old, new_string: e.new },
        }],
        usage: { input_tokens: 300, output_tokens: 60 },
      },
    });
  }
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

/* Declared out here so the finally block can remove it. Inside the try it is a
 * different scope, and `typeof FIXTURE_ROOT` there is simply "undefined" — the
 * cleanup would have looked correct and never run. */
let FIXTURE_ROOT = null;

try {
  for (const s of SESSIONS) {
    const dir = join(HOME, 'projects', encode(s.project));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${s.id}.jsonl`), buildTranscript(s));
  }
  console.log(`wrote ${SESSIONS.length} fixture sessions across 3 invented projects`);

  /**
   * THE TOOLKIT. Sessions alone leave the Toolkit screen at zero of everything,
   * and "Skills 0 / MCPs 0 / Commands 0" reads as a broken feature rather than
   * an empty account. Those zeros are also why the published Toolkit screenshot
   * could not be taken from the demo account: it was taken from a real machine,
   * which is how a device name and a real MCP inventory reached a public README.
   *
   * These fixtures are written into the SANDBOX, not posted as rows. The
   * collector discovers them from disk exactly as it discovers a user's own, so
   * the demo keeps matching what the product actually produces.
   *
   * EVERY NAME HERE IS INVENTED, for the same reason every path above is.
   */
  const SKILLS = [
    ['api-contract-review', 'Review an OpenAPI change for breaking fields, renamed paths and missing examples.'],
    ['migration-writer', 'Write a reversible SQL migration from a described schema change, with the down step.'],
    ['release-notes', 'Turn a commit range into release notes grouped by user-visible change.'],
    ['flaky-test-triage', 'Classify a failing test as flaky, environment-dependent or a real regression.'],
    ['perf-budget', 'Check a page against its size and request budget, and name the biggest offender.'],
    ['sql-explain', 'Read an EXPLAIN plan and say which index would remove the sequential scan.'],
  ];
  const SUBAGENTS = [
    ['schema-reviewer', 'Reviews a migration for lock duration, nullability and index coverage.'],
    ['test-writer', 'Writes unit tests for a changed function, including the failure paths.'],
    ['changelog-editor', 'Rewrites a changelog entry so it says what changed for the reader.'],
    ['dependency-auditor', 'Reports which direct dependencies moved a major version, and what broke.'],
  ];
  const COMMANDS = [
    ['ship-check', 'Run the pre-release checks and report the first one that fails.'],
    ['rollback-plan', 'Write the rollback steps for the change on the current branch.'],
    ['explain-query', 'Explain a slow query and propose one index.'],
    ['tidy-imports', 'Sort and de-duplicate imports in the files changed on this branch.'],
    ['spec-to-tests', 'Turn an acceptance criteria list into failing tests.'],
  ];
  const MCPS = {
    postgres: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', 'postgres://localhost:5432/example'] },
    github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
    filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/user/code'] },
    playwright: { command: 'npx', args: ['-y', '@playwright/mcp'] },
    'chat-recall': { command: 'chat-recall-mcp', args: [] },
  };
  const HOOKS = {
    SessionStart: [{ matcher: 'startup|clear', hooks: [{ type: 'command', command: 'chat-recall memory wake-up --project .' }] }],
    PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'npx prettier --write "$CLAUDE_FILE_PATHS"' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'chat-recall index --quiet' }] }],
  };

  for (const [name, description] of SKILLS) {
    const dir = join(HOME, 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${description}\n\n## When to use it\n\nUse it when the change touches the area named above and you want the same\nchecks every time.\n`);
  }
  mkdirSync(join(HOME, 'agents'), { recursive: true });
  for (const [name, description] of SUBAGENTS) {
    writeFileSync(join(HOME, 'agents', `${name}.md`),
      `---\nname: ${name}\ndescription: ${description}\n---\n\n${description}\n`);
  }
  mkdirSync(join(HOME, 'commands'), { recursive: true });
  for (const [name, description] of COMMANDS) {
    writeFileSync(join(HOME, 'commands', `${name}.md`),
      `---\ndescription: ${description}\n---\n\n${description}\n`);
  }
  writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ hooks: HOOKS }, null, 2));
  mkdirSync(join(ROOT, 'fakehome'), { recursive: true });
  writeFileSync(join(ROOT, 'fakehome', '.mcp.json'), JSON.stringify({ mcpServers: MCPS }, null, 2));
  console.log(`wrote toolkit fixtures: ${SKILLS.length} skills, ${Object.keys(MCPS).length} MCPs, ${COMMANDS.length} commands, ${SUBAGENTS.length} subagents, 3 hook events`);

  /**
   * CODE INTELLIGENCE. The project view is half the product and the demo
   * account had zero code findings, so "Structure", "coupling & risk" and the
   * health score all rendered empty. That is why the published project
   * screenshot was taken from a real machine, and why it shipped 147 real
   * sessions, real internal file paths and a real knowledge graph to a public
   * marketing page.
   *
   * `collectCode` runs the REAL codeindex binary over a REAL directory — it
   * cannot be faked with rows, and it refuses a temp path outright
   * (isJunkWorkspacePath). So the fixtures are small but genuine repositories:
   * an import cycle, one oversized module and a shared type barrel, which is
   * enough for codeindex to report cycles, a god module and coupling honestly.
   *
   * THE PROJECT ID IS DECLARED, NOT DERIVED. resolveProjectId() would otherwise
   * name these by their path on the machine that ran the seeder, which is the
   * exact leak this is fixing. projects.json maps each fixture root to the same
   * invented id the sessions already use, so the code data lands on the same
   * project and the operator's home never reaches the server.
   */
  const CODE_FIXTURES = {
    'example-app': {
      // A cycle: auth → session → auth. Deliberate, and the kind of thing the
      // findings view exists to name.
      'src/auth.ts':
        "import { readSession } from './session.js';\n" +
        "import type { User } from './types.js';\n\n" +
        "export function currentUser(token: string): User | null {\n" +
        "  const s = readSession(token);\n  return s ? s.user : null;\n}\n",
      'src/session.ts':
        "import { currentUser } from './auth.js';\n" +
        "import type { Session } from './types.js';\n\n" +
        "const store = new Map<string, Session>();\n" +
        "export function readSession(token: string): Session | null {\n" +
        "  return store.get(token) ?? null;\n}\n" +
        "export function refresh(token: string): boolean {\n" +
        "  return currentUser(token) !== null;\n}\n",
      'src/types.ts':
        "export interface User { id: string; email: string; }\n" +
        "export interface Session { user: User; expiresAt: number; }\n",
      // The god module: everything imports it and it does too much.
      'src/server.ts':
        "import { currentUser } from './auth.js';\n" +
        "import { readSession, refresh } from './session.js';\n" +
        "import type { User, Session } from './types.js';\n\n" +
        Array.from({ length: 40 }, (_, i) =>
          `export function handler${i}(token: string): string {\n` +
          `  const u = currentUser(token);\n` +
          `  if (!u) return 'anonymous';\n` +
          `  const s = readSession(token);\n` +
          `  if (s && refresh(token)) return u.email;\n` +
          `  return u.id;\n}\n`).join('\n'),
    },
    'acme-api': {
      'src/index.ts':
        "import { rateLimit } from './limit.js';\n" +
        "export function search(q: string, ip: string): string[] {\n" +
        "  if (!rateLimit(ip)) throw new Error('slow down');\n" +
        "  return q.split(' ');\n}\n",
      'src/limit.ts':
        "const seen = new Map<string, number>();\n" +
        "export function rateLimit(ip: string): boolean {\n" +
        "  const n = (seen.get(ip) ?? 0) + 1;\n  seen.set(ip, n);\n  return n < 100;\n}\n",
    },
    'storefront': {
      'src/checkout.ts':
        "import { price } from './price.js';\n" +
        "export function total(items: string[]): number {\n" +
        "  return items.reduce((n, i) => n + price(i), 0);\n}\n",
      'src/price.ts':
        "export function price(_sku: string): number { return 999; }\n",
    },
  };

  // NOT under ROOT: ROOT is an mkdtemp path and isJunkWorkspacePath() refuses
  // anything with a `tmp` component, which is the whole point of that guard.
  // Removed in the same finally block that removes ROOT.
  FIXTURE_ROOT = mkdtempSync(join(homedir(), '.chat-recall-demo-repos-'));
  const declared = [];
  for (const [name, files] of Object.entries(CODE_FIXTURES)) {
    const repo = join(FIXTURE_ROOT, name);
    for (const [rel, body] of Object.entries(files)) {
      const dest = join(repo, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, body);
    }
    writeFileSync(join(repo, 'package.json'),
      JSON.stringify({ name, version: '1.0.0', private: true }, null, 2));
    declared.push({ id: `path:/home/user/code/${name}`, name, root: repo });
  }
  // The sandbox data dir is created further down, after this block runs.
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(join(ROOT, 'data', 'projects.json'), JSON.stringify({ projects: declared }, null, 2));
  console.log(`wrote ${declared.length} code fixtures and declared their project ids`);

  /**
   * EVERY TOOL HOME, not just Claude's.
   *
   * The first version of this script set CHAT_RECALL_CLAUDE_HOME alone and ran a
   * real sync. The collector reads SIX homes, so the other five fell through to
   * the operator's actual ones and it uploaded 252 of their real sessions —
   * including client work, with cleartext paths, into the account meant for
   * external reviewers. Overriding one variable is not sandboxing; it is
   * sandboxing one sixth of the input and trusting the rest.
   *
   * Each points at an empty directory inside the throwaway root, so a home we
   * forget to seed contributes nothing instead of contributing everything.
   */
  const empty = join(ROOT, 'empty');
  mkdirSync(empty, { recursive: true });
  const env = {
    ...process.env,
    CHAT_RECALL_CLAUDE_HOME: HOME,
    CHAT_RECALL_CODEX_HOME: join(empty, 'codex'),
    CHAT_RECALL_GEMINI_HOME: join(empty, 'gemini'),
    CHAT_RECALL_AGY_HOME: join(empty, 'agy'),
    CHAT_RECALL_CURSOR_HOME: join(empty, 'cursor'),
    CHAT_RECALL_CURSOR_IDE_HOME: join(empty, 'cursor-ide'),
    CHAT_RECALL_OPENCODE_DB: join(empty, 'opencode', 'opencode.db'),
    // A fresh ledger too: reusing the operator's would make the sync think our
    // fixtures were already shipped and skip them.
    CHAT_RECALL_DATA_DIR: join(ROOT, 'data'),
    HOME: join(ROOT, 'fakehome'),
    CHAT_RECALL_SERVER: SERVER,
    CHAT_RECALL_TOKEN: TOKEN,
  };
  mkdirSync(join(ROOT, 'fakehome'), { recursive: true });
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  // --paths-cleartext so the demo projects show as readable names in the UI
  // rather than hashes; these paths are invented, so there is nothing to hide,
  // and a reviewer seeing "example-app" learns more than a hash.
  /**
   * PRE-FLIGHT: every tool home must resolve INSIDE the throwaway root.
   *
   * This is the check that would have stopped the incident. The first version of
   * this script overrode CHAT_RECALL_CLAUDE_HOME only; the collector reads six
   * homes, the other five fell through to the operator's real ones, and a sync
   * with --paths-cleartext uploaded 252 of their actual sessions — client work
   * included — into the account meant for external reviewers.
   *
   * A static assertion on the ENV, not a dry run of the CLI: the first attempt at
   * this guard called `sync --dry-run`, a flag that belongs to a different
   * command, so it crashed instead of guarding. A check that depends on a flag
   * existing can be wrong about whether it ran. This one cannot — if a variable
   * points outside ROOT, nothing is uploaded.
   */
  const HOME_VARS = [
    'CHAT_RECALL_CLAUDE_HOME', 'CHAT_RECALL_CODEX_HOME', 'CHAT_RECALL_GEMINI_HOME',
    'CHAT_RECALL_AGY_HOME', 'CHAT_RECALL_CURSOR_HOME', 'CHAT_RECALL_CURSOR_IDE_HOME',
    'CHAT_RECALL_OPENCODE_DB', 'CHAT_RECALL_DATA_DIR', 'HOME',
  ];
  const escaped = HOME_VARS.filter((v) => {
    const val = env[v];
    // Unset is the dangerous case, not a safe one: the collector then uses its
    // own default, which is the operator's real home.
    return !val || !resolve(val).startsWith(resolve(ROOT) + '/');
  });
  if (escaped.length) {
    console.error('\nREFUSING TO SYNC — these point outside the sandbox:');
    for (const v of escaped) console.error(`   ${v}=${env[v] ?? '(unset — defaults to the real home)'}`);
    console.error('\nEvery tool home must live under', ROOT);
    process.exit(1);
  }
  console.log(`sandbox verified: all ${HOME_VARS.length} home variables resolve inside the throwaway root`);

  const out = execFileSync(process.execPath,
    ['packages/cli/dist/cli.js', 'sync', '--paths-cleartext'],
    { env, encoding: 'utf-8' });
  console.log(out.split('\n').filter(Boolean).slice(-8).join('\n'));

  // CODE INTELLIGENCE, through the real binary. Each fixture is indexed as its
  // declared project id, so the findings, the coupling map and the health score
  // land on the same projects the sessions did.
  for (const d of declared) {
    try {
      const o = execFileSync(process.execPath,
        ['packages/cli/dist/cli.js', 'code', 'index', d.root],
        { env, encoding: 'utf-8' });
      const last = o.split('\n').filter(Boolean).pop() || '';
      console.log(`code index ${d.name}: ${last.replace(/\s+/g, ' ').trim().slice(0, 90)}`);
    } catch (e) {
      // Never fatal: a machine without the codeindex binary should still get a
      // seeded account, just without the code views.
      console.error(`code index ${d.name} failed: ${String(e.message || e).split('\n')[0].slice(0, 120)}`);
    }
  }
  // THE TASK BOARD. Sessions alone leave it empty, and an empty board is a
  // failed test case: "What are my open tasks?" is both a submitted test case
  // and a starter prompt on the ChatGPT listing, and both answer "nothing" on a
  // board with no cards — which reads as a broken feature rather than a tidy
  // team.
  //
  // Created through the REAL endpoint (POST /api/tasks) for the same reason the
  // sessions go through the real sync: a fixture written straight into the table
  // stops resembling what the product produces the moment the shape changes.
  //
  // Idempotent by title: re-running the seeder must not pile up duplicates, and
  // the endpoint only dedupes on linkedFindingId, which these have no reason to
  // carry.
  const TASKS = [
    { title: 'Rotate the export box AWS key and move it out of the config file',
      description: 'The nightly export config carried an access key id in cleartext. Key rotated; the loader now reads it from the environment. Close once the old key is confirmed revoked.' },
    { title: 'Backfill the plus-sign email fix into the invite path',
      description: 'login.ts and reset.ts both encode the address now. The invite acceptance route was not checked and probably has the same bug.' },
    { title: 'Decide the retention window for storefront export artifacts',
      description: 'Exports accumulate in the bucket with no lifecycle rule. Needs a number before the next billing review.' },
    { title: 'Add a regression test for the missing-config CLI error',
      projectId: 'path:/home/user/code/checkout',
      description: 'The abandoned session left a test asserting the error names the config path and carries no stack frame, but the clean-error handling itself was never implemented and nothing was committed.' },
    { title: 'Rate-limit the dashboard export endpoint',
      projectId: 'path:/home/user/code/dashboard',
      description: 'The sliding-window limiter covers the API key path only. The export endpoint is anonymous and unthrottled.' },
  ];
  // ASSIGNED TO THE DEMO USER, NOT LEFT UNASSIGNED. "What are my open tasks?"
  // is a submitted test case and a starter prompt, and a model reading the word
  // "my" passes mine:true to recall_tasks — which filters on assignee and
  // returns nothing for an unassigned board. The tool was right and the board
  // was wrong: three cards existed and ChatGPT answered "you have no open
  // tasks". Seen in the demo before the recording, which is the only reason it
  // was caught.
  // The caller's own sub, read back from a task rather than from a whoami
  // endpoint — there isn't one on this API, and a card reports `createdBy`,
  // which IS the authenticated caller. So the first card created (or any card
  // already on the board) tells us who to assign to.
  const existingTasks = await fetch(`${SERVER}/api/tasks`, { headers: { authorization: `Bearer ${TOKEN}` } })
    .then((r) => (r.ok ? r.json() : { tasks: [] }))
    .then((d) => new Map((d.tasks ?? []).map((t) => [t.title, t])))
    .catch(() => new Map());
  let me = [...existingTasks.values()].map((t) => t.createdBy).find(Boolean) ?? null;
  let made = 0; let fixed = 0;
  for (const t of TASKS) {
    const already = existingTasks.get(t.title);
    if (already) {
      // Backfill the assignee on a board seeded before this change.
      if (me && !already.assigneeSub) {
        const r = await fetch(`${SERVER}/api/tasks/${already.id}`, {
          method: 'PATCH',
          headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify({ assigneeSub: me }),
        });
        if (r.ok) fixed += 1;
      }
      continue;
    }
    const r = await fetch(`${SERVER}/api/tasks`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...t, projectId: t.projectId ?? 'path:/home/user/code/storefront', assigneeSub: me }),
    });
    if (!r.ok) { console.error(`task "${t.title.slice(0, 40)}…" failed: HTTP ${r.status}`); continue; }
    const card = (await r.json().catch(() => ({}))).task;
    made += 1;
    // First card on an empty board: it just told us who the caller is, so every
    // later card in this run can be assigned at creation time.
    if (!me && card?.createdBy) {
      me = card.createdBy;
      const back = await fetch(`${SERVER}/api/tasks/${card.id}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ assigneeSub: me }),
      });
      if (back.ok) fixed += 1;
    }
  }
  console.log(`task board: ${made} created, ${TASKS.length - made} already present${fixed ? `, ${fixed} assignee(s) backfilled` : ''}`);

  console.log(`\nseeded ${SERVER}`);
} finally {
  rmSync(ROOT, { recursive: true, force: true });
  // The code fixtures live outside ROOT (see FIXTURE_ROOT) and must be removed
  // with it, or every run leaves a directory in the operator's home.
  if (FIXTURE_ROOT) rmSync(FIXTURE_ROOT, { recursive: true, force: true });
}
