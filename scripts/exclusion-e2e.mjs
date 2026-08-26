#!/usr/bin/env node
/**
 * END-TO-END PROOF OF THE PRIVACY CONTROLS, against a real server.
 *
 * The controls we advertise on chatrecall.dev/security — exclude a path, exclude
 * a tool, invert to an allowlist, delete one session, delete a whole project —
 * were covered only by unit tests of the PURE helpers. The wiring that makes
 * them matter lives in closures inside `syncIncremental` (sync-client.ts), where
 * no unit test reaches, and the assertion that counts is not "the predicate
 * returned false" but "the row never appeared on the server". This asserts the
 * second thing, over HTTP, against Postgres.
 *
 * Run it against a booted server (docker compose up, or any instance you can
 * mint a token on):
 *
 *   ADMIN_KEY=… SERVER=http://localhost:8080 node scripts/exclusion-e2e.mjs
 *
 * It plants its own fixture transcripts in a throwaway CHAT_RECALL_CLAUDE_HOME
 * and never reads the real one. Exit code is the verdict.
 *
 * WHY A SCRIPT AND NOT A VITEST FILE. Every step needs the built CLI as a
 * SUBPROCESS (`chat-recall exclude …`, `chat-recall sync`) plus a live server:
 * the thing under test is the interaction of three processes and a database, and
 * a test runner that imports modules cannot observe it. The compose workflow
 * calls this after it boots the stack.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SERVER = (process.env.SERVER || 'http://localhost:8080').replace(/\/+$/, '');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const TENANT = process.env.TENANT || `e2e${Date.now().toString(36)}`;
const CLI = process.env.CLI_ENTRY || 'packages/cli/dist/cli.js';
const MCP = process.env.MCP_ENTRY || 'packages/cli/dist/mcp.js';

/* Every path below is invented. Nothing here may read the operator's own home:
 * the fixtures are the whole population, so a real path would only add risk. */
const ROOT = join(tmpdir(), `chat-recall-excl-${process.pid}`);
const HOME = join(ROOT, 'claude');
const DATA = join(ROOT, 'data');
/* HYPHENATED ON PURPOSE. Claude Code's directory encoding cannot tell a real
 * hyphen from a separator, so `-tmp-e2e-secret` decodes to `/tmp/e2e/secret` —
 * and comparing that against the rule the user typed is exactly the bug this
 * harness found. A hyphen-free fixture would have passed while the product was
 * broken for `chat-recall` itself. */
const KEEP = '/tmp/e2e-keep';
const SECRET = '/tmp/e2e-secret';

/**
 * Markers must share NO token with each other.
 *
 * The first version named them MARKER-keep-one, MARKER-secret-one, … and
 * Postgres FTS tokenizes on the hyphen: a search for MARKER-doomed matched every
 * fixture through the common `marker` token, and the harness read another
 * session's hit as the deleted one still being reachable. One token each, unique
 * per run, so a hit can only ever be the session that carries it.
 */
const RUN = Math.random().toString(36).slice(2, 8);
const MARK = Object.fromEntries(
  ['keepOne', 'secretOne', 'secretAfterExclude', 'keepAfterExclude',
   'secretUnderAllowlist', 'keepUnderAllowlist', 'afterToolExclude', 'doomed',
   'forgetViaMcp', 'excludedViaMcp']
    .map((k) => [k, `zq${RUN}${k.toLowerCase()}`]),
);

const env = {
  ...process.env,
  CHAT_RECALL_CLAUDE_HOME: HOME,
  CHAT_RECALL_DATA_DIR: DATA,
  // The five other backends must stay out of this run: an operator's own Codex
  // or Cursor history is not fixture data, and one stray session would make
  // every count below unreproducible.
  CHAT_RECALL_GEMINI_HOME: join(ROOT, 'none-gemini'),
  CHAT_RECALL_CODEX_HOME: join(ROOT, 'none-codex'),
  CHAT_RECALL_AGY_HOME: join(ROOT, 'none-agy'),
  CHAT_RECALL_CURSOR_HOME: join(ROOT, 'none-cursor'),
  CHAT_RECALL_CURSOR_IDE_HOME: join(ROOT, 'none-cursor-ide'),
  CHAT_RECALL_OPENCODE_DB: join(ROOT, 'none-opencode.db'),
};

let failures = 0;
const pass = (m) => console.log(`  [32mPASS[0m ${m}`);
const fail = (m) => { failures++; console.log(`  [31mFAIL[0m ${m}`); };
const step = (m) => console.log(`\n[1m${m}[0m`);
const check = (cond, m) => (cond ? pass(m) : fail(m));

const cli = (...args) => execFileSync('node', [CLI, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A minimal but REAL Claude transcript: the parser reads these fields, so a
 *  shorter shape would test the fixture rather than the product. */
function plantSession(projectPath, marker) {
  const slug = projectPath.replace(/\//g, '-');
  const dir = join(HOME, 'projects', slug);
  mkdirSync(dir, { recursive: true });
  const sid = crypto.randomUUID();
  const line = (role, content, uuid, parent) => JSON.stringify({
    parentUuid: parent, isSidechain: false, type: role,
    message: { role, content },
    uuid, timestamp: new Date(Date.now() - 3600_000).toISOString(),
    cwd: projectPath, sessionId: sid, version: '2.0.0', gitBranch: 'main',
  });
  writeFileSync(join(dir, `${sid}.jsonl`),
    `${line('user', `${marker} investigate the auth bug in the login flow`, 'u1', null)}\n`
    + `${line('assistant', `Fixed the ${marker} issue in the auth handler.`, 'a1', 'u1')}\n`);
  return sid;
}

/**
 * One API call, retried on a TRANSPORT failure only.
 *
 * Not defensive padding: a six-minute run spans a keep-alive idle timeout and,
 * in CI, a container that may still be settling, and `fetch failed` there is a
 * dropped socket rather than an answer about the product. A non-2xx response is
 * NEVER retried — that is a verdict, and hiding it would defeat the harness.
 */
async function api(path, init = {}, attempt = 1) {
  let res;
  try {
    res = await fetch(`${SERVER}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init.headers || {}) },
    });
  } catch (err) {
    if (attempt >= 4) throw err;
    await new Promise((r) => setTimeout(r, 1000 * attempt));
    return api(path, init, attempt + 1);
  }
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

/** Block until the server answers, so a stack that is still settling does not
 *  read as a product failure. */
async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${SERVER}/api/capabilities`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`server never answered at ${SERVER}`);
}

/** Does the SERVER hold a session whose text carries this marker? The question
 *  the whole script is built to ask, so it goes through the same search API the
 *  product uses rather than reading Postgres behind its back. */
async function serverHas(marker) {
  const r = await api('/api/search', { method: 'POST', body: JSON.stringify({ query: marker, topK: 50 }) });
  if (r.status !== 200) throw new Error(`/api/search → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return JSON.stringify(r.body.results ?? []).includes(marker);
}

/**
 * One long-lived stdio MCP server, driven over JSON-RPC exactly as a client
 * drives it — initialize, notifications/initialized, then requests.
 *
 * Spawned once rather than per call, and killed at the end: an MCP server does
 * not exit on its own (it is a daemon on stdio), so a fire-and-forget
 * execFileSync would sit until its timeout and lose the frames it already
 * printed. Credentials arrive through the environment, which is the path a
 * container or a directory listing uses (credentials-env.ts).
 */
function startMcp(profile = 'full') {
  const proc = spawn('node', [MCP], {
    env: { ...env, CHAT_RECALL_SERVER: SERVER, CHAT_RECALL_TOKEN: TOKEN, CHAT_RECALL_MCP_PROFILE: profile },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  const pending = new Map();
  proc.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      } catch { /* not a frame — the server logs to stderr, but be tolerant */ }
    }
  });
  let nextId = 1;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`MCP timeout: ${method} ${params?.name ?? ''}`)); }, 90_000);
  });
  const notify = (method) => proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  return { rpc, notify, stop: () => proc.kill() };
}

/** The text a tool actually returned, which is what an agent would read. */
const toolText = (r) => String(r.result?.content?.[0]?.text ?? JSON.stringify(r.error ?? r.result ?? {}));

let TOKEN = '';

async function main() {
  if (!ADMIN_KEY) { console.error('ADMIN_KEY is required (it mints the throwaway tenant).'); process.exit(2); }
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true });

  await waitForServer();

  step(`Mint tenant ${TENANT} + device token on ${SERVER}`);
  const mk = async (path, body) => {
    const res = await fetch(`${SERVER}${path}`, {
      method: 'POST',
      headers: { 'x-admin-key': ADMIN_KEY, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
    return res.json();
  };
  await mk('/api/tenants', { slug: TENANT, display_name: 'exclusion e2e' });
  TOKEN = (await mk(`/api/tenants/${TENANT}/tokens`, { device_id: 'e2e' })).token;
  if (!TOKEN) throw new Error('no device token minted');
  pass('tenant and token ready');

  step('1. Baseline — two projects sync, both searchable');
  plantSession(KEEP, MARK.keepOne);
  plantSession(SECRET, MARK.secretOne);
  cli('login', SERVER, '--token', TOKEN);
  cli('sync', '--paths-cleartext');
  check(await serverHas(MARK.keepOne), 'the keeper project reached the server');
  check(await serverHas(MARK.secretOne), 'the second project reached the server (nothing excluded yet)');

  step('2. `exclude project` — a new session under an excluded path never uploads');
  cli('exclude', 'project', SECRET);
  plantSession(SECRET, MARK.secretAfterExclude);
  plantSession(KEEP, MARK.keepAfterExclude);
  cli('sync', '--paths-cleartext');
  check(!(await serverHas(MARK.secretAfterExclude)), 'the excluded path did NOT upload its new session');
  check(await serverHas(MARK.keepAfterExclude), 'the un-excluded path kept syncing');
  check(await serverHas(MARK.secretOne), 'rows uploaded BEFORE the rule stay (documented: exclusion is not retroactive)');

  step('3. `sync-only` — the allowlist ships only what is listed');
  cli('exclude', 'remove', SECRET);
  cli('sync-only', 'add', KEEP);
  plantSession(SECRET, MARK.secretUnderAllowlist);
  plantSession(KEEP, MARK.keepUnderAllowlist);
  cli('sync', '--paths-cleartext');
  check(await serverHas(MARK.keepUnderAllowlist), 'the allowlisted project synced');
  check(!(await serverHas(MARK.secretUnderAllowlist)), 'a project outside the allowlist did NOT sync');
  cli('sync-only', 'remove', KEEP);
  cli('sync-only', 'all');

  step('4. `exclude tool` — a whole tool stops uploading');
  cli('exclude', 'tool', 'claude');
  plantSession(KEEP, MARK.afterToolExclude);
  cli('sync', '--paths-cleartext');
  check(!(await serverHas(MARK.afterToolExclude)), 'nothing from the excluded tool uploaded');
  cli('exclude', 'remove', 'claude');

  step('5. Reversibility — removing a rule puts the path back in scope');
  // The load-bearing detail: `modeOf` returns 'skip' at sync-client.ts:1364-1367
  // BEFORE it touches the ledger, and the upload loop's skip branch (:1495)
  // writes no ack. So a session held back by a rule is not recorded as done —
  // drop the rule and the next sync ships it. If skip had stamped the ledger,
  // re-adding a path would silently restore nothing, which is the failure this
  // step exists to catch.
  cli('sync', '--paths-cleartext');
  check(await serverHas(MARK.secretAfterExclude),
    'a session held back while the rule was in force uploads once the rule is gone');
  check(await serverHas(MARK.secretUnderAllowlist),
    'a session held back by the allowlist uploads after `sync-only all`');

  step('6. `delete <session>` — gone from the server, and a re-sync cannot revive it');
  const doomed = plantSession(KEEP, MARK.doomed);
  cli('sync', '--paths-cleartext');
  check(await serverHas(MARK.doomed), 'the session to be deleted was uploaded first');
  cli('delete', doomed);
  check(!(await serverHas(MARK.doomed)), 'the session is gone from the server');
  cli('sync', '--paths-cleartext');
  check(!(await serverHas(MARK.doomed)), 'a full re-sync did NOT resurrect it (tombstone holds)');
  // THE ASYMMETRY, asserted rather than assumed: a RULE is reversible (step 5),
  // a DELETE is not. There is no removeTombstone in the codebase — only
  // addTombstone/listTombstones — so `sync --full` cannot bring a deleted
  // session back even though the transcript is still on the user's disk.
  cli('sync', '--full', '--paths-cleartext');
  check(!(await serverHas(MARK.doomed)), 'even `sync --full` cannot restore a deleted session');

  step('7. `POST /api/data/delete` — a whole uploaded project goes');
  const projects = await api('/api/projects');
  const list = Array.isArray(projects.body?.all) ? projects.body.all : [];
  const keepProject = list.find((p) => JSON.stringify(p).includes('e2e-keep'));
  check(!!keepProject, 'the keeper project is listed on the server');
  if (keepProject) {
    const id = keepProject.projectId || keepProject.project_id || keepProject.id;
    const del = await api('/api/data/delete', { method: 'POST', body: JSON.stringify({ project: id }) });
    check(del.status === 200, `project delete returned 200 (got ${del.status})`);
    check(!(await serverHas(MARK.keepOne)), 'every session under that project is gone');
  }

  step('8. MCP — the same server, through the tool surface an agent uses');
  const mcp = startMcp();
  try {
    await mcp.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'exclusion-e2e', version: '1' } });
    mcp.notify('notifications/initialized');
    const listed = await mcp.rpc('tools/list', {});
    const names = (listed.result?.tools || []).map((t) => t.name);
    check(names.length > 40, `tools/list answered with ${names.length} tools`);

    // recall_search echoes the query in its header line, so a raw
    // `text.includes(marker)` is true even for a search that found nothing.
    // Drop the header, then test exactly — with one token per fixture, a marker
    // in the BODY can only be that session's own content.
    const body = (t) => t.split('\n').slice(1).join('\n');

    // A marker from the SECRET project, not the keeper: step 7 deleted the whole
    // keeper project, so asserting a keeper session here would assert that the
    // delete did not work. (An earlier version of this check counted UUIDs and
    // passed anyway, on hits belonging to other sessions — which is how a loose
    // assertion hides both a bug and its own wrongness.)
    const found = toolText(await mcp.rpc('tools/call', { name: 'recall_search', arguments: { query: MARK.secretUnderAllowlist, top_k: 20 } }));
    check(!/login required|not logged in/i.test(found), 'recall_search authenticated against the server');
    check(body(found).includes(MARK.secretUnderAllowlist), 'MCP finds a session that survived every rule and delete');

    const dead = toolText(await mcp.rpc('tools/call', { name: 'recall_search', arguments: { query: MARK.doomed, top_k: 20 } }));
    if (body(dead).includes(MARK.doomed)) console.log(`      returned: ${dead.slice(0, 240).replace(/\n/g, ' ')}`);
    check(!body(dead).includes(MARK.doomed), 'MCP cannot find the session that was deleted');


    // Stated as an assertion, because it is a deliberate boundary: no recall_*
    // tool reads or writes the exclusion rules, so an agent cannot widen its own
    // sync scope. That is why every mutation above goes through the CLI and only
    // the READ-BACK comes through MCP.
    // The NARROW/WIDEN boundary, asserted on the live tool list. An agent may
    // remove things; it must never be able to put them back.
    check(names.includes('recall_forget'), 'recall_forget is offered — an agent can delete a conversation');
    check(names.includes('recall_exclude_path'), 'recall_exclude_path is offered — an agent can stop syncing a path');
    check(!names.some((n) => /unexclude|exclude_remove|sync_only|retention/i.test(n)),
      'no MCP tool WIDENS scope (no un-exclude, no allowlist, no retention)');

    // confirm is required, not optional: without it the call must fail rather
    // than delete. This is the host-independent brake.
    const noConfirm = await mcp.rpc('tools/call', { name: 'recall_forget', arguments: { session_id: 'whatever' } });
    check(/confirm|required|invalid/i.test(toolText(noConfirm)), 'recall_forget without confirm:true is refused');

    // And it really deletes: plant one, sync it, forget it, confirm it is gone.
    const doomedByMcp = plantSession(SECRET, MARK.forgetViaMcp);
    cli('sync', '--paths-cleartext');
    check(await serverHas(MARK.forgetViaMcp), 'the session to forget was uploaded first');
    const forgot = toolText(await mcp.rpc('tools/call', {
      name: 'recall_forget', arguments: { session_id: doomedByMcp, confirm: true },
    }));
    check(/deleted/i.test(forgot), `recall_forget reported success (${forgot.slice(0, 60)})`);
    check(!(await serverHas(MARK.forgetViaMcp)), 'the session is gone from the server after recall_forget');

    // exclude_path writes the rule the sync gate then honours.
    const excluded = toolText(await mcp.rpc('tools/call', {
      name: 'recall_exclude_path', arguments: { path: '/tmp/e2e-mcp-excluded', confirm: true },
    }));
    check(/stopped syncing/i.test(excluded), `recall_exclude_path reported success (${excluded.slice(0, 60)})`);
    plantSession('/tmp/e2e-mcp-excluded', MARK.excludedViaMcp);
    cli('sync', '--paths-cleartext');
    check(!(await serverHas(MARK.excludedViaMcp)),
      'a path excluded THROUGH MCP does not upload');
  } finally {
    mcp.stop();
  }

  // Step 8 drives CHAT_RECALL_MCP_PROFILE=full, so it proves the tools WORK and
  // says nothing about whether an agent can SEE them. The default is lean, and
  // the two remove tools shipped outside LEAN_TOOLS: every check above passed
  // while "forget this conversation" reached a model whose tool list had no
  // recall_forget in it. A privacy control the agent cannot see is a dashboard
  // feature. So assert the DEFAULT listing, with no profile override at all.
  step('9. MCP — the two remove tools are reachable in the DEFAULT profile');
  const leanMcp = startMcp('');
  try {
    await leanMcp.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'exclusion-e2e-lean', version: '1' } });
    leanMcp.notify('notifications/initialized');
    const leanNames = ((await leanMcp.rpc('tools/list', {})).result?.tools || []).map((t) => t.name);
    check(leanNames.length > 10 && leanNames.length < 40,
      `the default profile is the SHORT list (${leanNames.length} tools) — otherwise this check is vacuous`);
    check(leanNames.includes('recall_forget'),
      'recall_forget is listed WITHOUT setting CHAT_RECALL_MCP_PROFILE');
    check(leanNames.includes('recall_exclude_path'),
      'recall_exclude_path is listed WITHOUT setting CHAT_RECALL_MCP_PROFILE');
    check(!leanNames.some((n) => /unexclude|exclude_remove|sync_only|retention/i.test(n)),
      'the default profile still WIDENS nothing');
  } finally {
    leanMcp.stop();
  }

  step(`Verdict: ${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
  rmSync(ROOT, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nharness error: ${err instanceof Error ? err.stack : err}`);
  process.exit(2);
});
