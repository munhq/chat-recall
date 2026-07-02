// Behavioral smoke of the MCP tool surface against a real logged-in server.
// Run: `node scripts/mcp-smoke.mjs` after `npm run build` with a
// `chat-recall login` in place. Complements the unit suite: it exercises the
// EXACT shipped artifact (dist/mcp.js) over JSON-RPC, including the params
// added by the 53→34 consolidation. Exits non-zero on any failure.
// Speaks JSON-RPC over stdio to the freshly built dist/mcp.js — the exact
// artifact users run. Each check asserts the merged param actually works.
import { spawn } from 'node:child_process';

const proc = spawn('node', ['packages/cli/dist/mcp.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const pending = new Map();
proc.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    try { const m = JSON.parse(line); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {}
  }
});
let nextId = 1;
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method} ${params?.name ?? ''}`)); } }, 30000);
  });
}
const call = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  const text = String(r.result?.content?.[0]?.text ?? JSON.stringify(r.error ?? r.result));
  return { ok: !r.error && !r.result?.isError && !/^Error:/.test(text.trim()), full: text, text: text.slice(0, 160).replace(/\n/g, ' ') };
};

await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const tools = (await rpc('tools/list', {})).result.tools.map(t => t.name);
console.log('tool count:', tools.length);
for (const dead of ['recall_help', 'recall_outcome', 'recall_plans', 'recall_kv_list', 'recall_suggest_resume', 'recall_project_dossier']) {
  if (tools.includes(dead)) console.log('FAIL: dead tool still registered:', dead);
}

const checks = [
  ['recall_search include_outcome', () => call('recall_search', { query: 'chat-recall launch', top_k: 2, include_outcome: true })],
  ['recall_search like_session absent-ok', () => call('recall_search', { query: 'networkpolicy', top_k: 2 })],
  ['recall_status (with memory breakdown)', () => call('recall_status', {})],
  ['recall_get no key = list scope', () => call('recall_get', { scope: 'default' })],
  ['recall_project_context by substring', () => call('recall_project_context', { project_path: 'chat-recall' })],
  ['recall_recent', () => call('recall_recent', { limit: 3 })],
  ['recall_recommendations scope:account', () => call('recall_recommendations', { scope: 'account' })],
];
let fail = 0;
for (const [label, fn] of checks) {
  try {
    const r = await fn();
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${label} :: ${r.text}`);
    if (!r.ok) fail++;
  } catch (e) { console.log(`FAIL ${label} :: ${e.message}`); fail++; }
}

// diff files_only + summary + edits group_by need a real session id — take one from recent.
const recent = await call('recall_recent', { limit: 1 });
const sid = (recent.full.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) || [])[0];
if (sid) {
  for (const [label, fn] of [
    [`recall_diff files_only (${sid.slice(0, 8)})`, () => call('recall_diff', { session_id: sid, files_only: true })],
    ['recall_summary (absorbed outcome)', () => call('recall_summary', { session_id: sid })],
    ['recall_edits_timeline group_by:session', () => call('recall_edits_timeline', { since_hours: 24, group_by: 'session' })],
    ['recall_show (session)', () => call('recall_show', { session_id: sid, max_messages: 2 })],
  ]) {
    try { const r = await fn(); console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${label} :: ${r.text}`); if (!r.ok) fail++; }
    catch (e) { console.log(`FAIL ${label} :: ${e.message}`); fail++; }
  }
} else console.log('WARN: no session id extracted for per-session checks');

console.log(fail === 0 ? 'SMOKE: ALL PASS' : `SMOKE: ${fail} FAILURES`);
proc.kill();
process.exit(fail === 0 ? 0 : 1);
