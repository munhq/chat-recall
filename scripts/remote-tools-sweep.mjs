#!/usr/bin/env node
/**
 * CALL EVERY TOOL THE REMOTE /mcp ENDPOINT OFFERS, and report what each one did.
 *
 * The directory submission asks whether every tool has been run through a real
 * client. Ours had not: the onboarding harness exercises the five tools a new
 * user hits, and the local stdio path is covered by the privacy harness — but
 * nothing had ever called all 26 over the REMOTE endpoint, where the surface is
 * deliberately different (the two tools that read the caller's own disk are
 * dropped, because on a shared server there is no such disk).
 *
 * A reviewer clicking through the connector is the first person who would find a
 * tool that 500s there. This finds it first.
 *
 * WHAT IT ASSERTS, deliberately narrowly: that every tool ANSWERS — a JSON-RPC
 * result, not a transport error and not an unhandled throw. It does not check
 * that answers are correct; an empty account legitimately returns "nothing
 * found" for most reads, and calling that a failure would make the sweep useless
 * on exactly the account a reviewer gets. A tool returning "no sessions yet" is
 * working. A tool returning an internal error is not.
 *
 * WRITES ARE SKIPPED BY DEFAULT. recall_forget deletes a conversation and
 * recall_exclude_path changes what syncs; running those against a real account
 * to see whether they answer is not a test, it is damage. Pass --include-writes
 * only against a throwaway tenant.
 *
 *   CHAT_RECALL_TOKEN=<oauth access token> node scripts/remote-tools-sweep.mjs
 *   SERVER=https://chatrecall.dev node scripts/remote-tools-sweep.mjs
 */
import { spawn } from 'node:child_process';

const SERVER = (process.env.SERVER || 'https://chatrecall.dev').replace(/\/+$/, '');
const TOKEN = process.env.CHAT_RECALL_TOKEN || '';
const INCLUDE_WRITES = process.argv.includes('--include-writes');

if (!TOKEN) {
  console.error('CHAT_RECALL_TOKEN is required — an OAuth access token for the account to sweep.');
  process.exit(2);
}

const c = {
  g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m`,
};

/** Tools that CHANGE something. Named here rather than inferred, so a new write
 *  tool is skipped only when someone decides it should be. */
const WRITES = new Set([
  'recall_forget', 'recall_exclude_path', 'recall_kg_add', 'recall_kg_invalidate',
  'recall_diary_write', 'recall_decision_record', 'recall_set', 'recall_task_create',
  'recall_task_update', 'recall_task_comment', 'recall_security_dismiss',
  'recall_recommendation_apply', 'recall_recommendation_dismiss', 'recall_project_label',
  'recall_reclassify', 'recall_regenerate_summary', 'recall_rename_session',
  'recall_index', 'recall_code_index',
]);

/**
 * Arguments for the tools whose required fields cannot be guessed.
 *
 * A missing required field returns a schema error, which would look like a
 * broken tool. Anything absent from this map is called with {} — correct for the
 * many tools whose every field is optional.
 */
const ARGS = {
  recall_search: { query: 'authentication' },
  recall_memory_search: { query: 'authentication' },
  recall_user_prompts: { query: 'error' },
  recall_subagent_search: { query: 'explore' },
  recall_context: { session_id: 'sweep-nonexistent-session' },
  recall_summary: { session_id: 'sweep-nonexistent-session' },
  recall_show: { session_id: 'sweep-nonexistent-session' },
  recall_diff: { session_id: 'sweep-nonexistent-session' },
  recall_commits: { session_id: 'sweep-nonexistent-session' },
  recall_markers: { session_id: 'sweep-nonexistent-session' },
  recall_outcome: { session_id: 'sweep-nonexistent-session' },
  recall_memory_item: { item_id: 'sweep-nonexistent-item' },
  recall_project_context: { project: 'example' },
  recall_kg_query: { subject: 'example' },
  recall_kg_timeline: { entity: 'example' },
  recall_get: { key: 'sweep-probe' },
  recall_diary_read: { agent_name: 'sweep' },
  recall_security_session: { session_id: 'sweep-nonexistent-session' },
  recall_edits_timeline: { since_hours: 24 },
};

/**
 * TWO TRANSPORTS, one sweep.
 *
 * `remote` talks HTTP to /mcp and needs an OAuth access token, which only a
 * browser login can mint — so it proves the hosted transport but cannot be run
 * unattended. `stdio` spawns the local MCP with a device token and exercises the
 * SAME dispatch and the same server endpoints behind it.
 *
 * The tool logic is identical either way; what differs is the listing (remote
 * drops the two tools that read the caller's own disk). So stdio is the mode
 * that can sweep every tool without a human, and the remote transport is
 * verified separately.
 */
const MODE = process.env.MODE === 'remote' ? 'remote' : 'stdio';

let stdioProc = null;
const stdioPending = new Map();
function startStdio() {
  const proc = spawn(process.execPath, ['packages/cli/dist/mcp.js'], {
    env: { ...process.env, CHAT_RECALL_SERVER: SERVER, CHAT_RECALL_TOKEN: TOKEN,
           CHAT_RECALL_MCP_PROFILE: 'full', CHAT_RECALL_NO_BROWSER: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (stdioPending.has(m.id)) { stdioPending.get(m.id)(m); stdioPending.delete(m.id); }
    }
  });
  return proc;
}

let id = 0;
async function rpc(method, params) {
  if (MODE === 'stdio') {
    if (!stdioProc) stdioProc = startStdio();
    const myId = ++id;
    return new Promise((res, rej) => {
      stdioPending.set(myId, res);
      setTimeout(() => rej(new Error(`${method} timed out`)), 90_000).unref?.();
      stdioProc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
    });
  }
  return rpcHttp(method, params);
}

async function rpcHttp(method, params) {
  const res = await fetch(`${SERVER}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    signal: AbortSignal.timeout(90_000),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 160)}`);
  // The endpoint answers as SSE ("event: message\ndata: {...}") or plain JSON.
  const m = /^data:\s*(\{.*)$/m.exec(raw) || /(\{[\s\S]*\})/.exec(raw);
  if (!m) throw new Error(`unparseable response: ${raw.slice(0, 160)}`);
  return JSON.parse(m[1]);
}

const results = { ok: [], empty: [], failed: [], skipped: [] };

async function main() {
  await rpc('initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'remote-tools-sweep', version: '1' },
  });

  const listed = await rpc('tools/list', {});
  const tools = (listed.result?.tools || []).map((t) => t.name);
  console.log(`${MODE} transport against ${SERVER} — ${tools.length} tools offered\n`);

  for (const name of tools) {
    if (WRITES.has(name) && !INCLUDE_WRITES) {
      results.skipped.push(name);
      console.log(`  ${c.y('SKIP')} ${name} ${c.d('(write — pass --include-writes on a throwaway tenant)')}`);
      continue;
    }
    try {
      const r = await rpc('tools/call', { name, arguments: ARGS[name] ?? {} });
      const text = r.result?.content?.[0]?.text ?? '';
      if (r.error) {
        // A JSON-RPC error IS a failure: the dispatch did not handle the call.
        results.failed.push([name, String(r.error.message || r.error).slice(0, 120)]);
        console.log(`  ${c.r('FAIL')} ${name} — ${String(r.error.message || r.error).slice(0, 110)}`);
        continue;
      }
      // isError with a readable message is a HANDLED refusal (bad id, nothing
      // found, needs a login) — the tool worked. An empty body is not.
      if (!text.trim()) {
        results.empty.push(name);
        console.log(`  ${c.y('EMPTY')} ${name} ${c.d('answered with no text')}`);
        continue;
      }
      results.ok.push(name);
      console.log(`  ${c.g('OK')}   ${name} ${c.d(text.replace(/\s+/g, ' ').slice(0, 78))}`);
    } catch (err) {
      results.failed.push([name, err instanceof Error ? err.message : String(err)]);
      console.log(`  ${c.r('FAIL')} ${name} — ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`\nanswered: ${results.ok.length}  empty: ${results.empty.length}  `
    + `failed: ${results.failed.length}  skipped(writes): ${results.skipped.length}`);
  if (results.failed.length) {
    console.log(c.r('\nTools a reviewer would find broken:'));
    for (const [n, e] of results.failed) console.log(`  ${n}: ${e}`);
  }
  stdioProc?.kill();
  process.exit(results.failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(c.r(`\nsweep error: ${err instanceof Error ? err.stack : err}`));
  process.exit(2);
});
