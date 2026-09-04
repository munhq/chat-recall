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
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

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
const SESSIONS = [
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
    hoursAgo: 3,
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
}
