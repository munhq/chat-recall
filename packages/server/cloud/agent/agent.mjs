// chat-recall agent (Phase 1) — runs on a dev's laptop.
//
// Reads the local secret-scan FINDINGS (masked previews + metadata only —
// NEVER conversation text) from chat-recall's cache.db and pushes them to the
// chat-recall cloud on an interval. Incremental via a scanned_at watermark.
//
// Config (env or ~/.chat-recall/chat-recall.json):
//   CHAT_RECALL_API_URL   e.g. https://chat-recall.app.munhq.com
//   CHAT_RECALL_TOKEN     ct_… device token (from the cloud)
//   CHAT_RECALL_DB       default ~/.chat-recall/cache.db
//   CHAT_RECALL_INTERVAL_SEC  default 300
// Flags: --once  (single sync then exit)

import Database from 'better-sqlite3';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const cfgPath = join(homedir(), '.chat-recall', 'chat-recall.json');
const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {};
const API   = process.env.CHAT_RECALL_API_URL || cfg.apiUrl;
const TOKEN = process.env.CHAT_RECALL_TOKEN   || cfg.token;
const DB    = process.env.CHAT_RECALL_DB     || join(homedir(), '.chat-recall', 'cache.db');
const INTERVAL = (Number(process.env.CHAT_RECALL_INTERVAL_SEC) || 300) * 1000;
const STATE = join(homedir(), '.chat-recall', 'chat-recall-agent-state.json');
const ONCE = process.argv.includes('--once');

if (!API || !TOKEN) { console.error('Set CHAT_RECALL_API_URL and CHAT_RECALL_TOKEN (env or ~/.chat-recall/chat-recall.json)'); process.exit(1); }

const loadWatermark = () => { try { return JSON.parse(readFileSync(STATE, 'utf8')).watermark || 0; } catch { return 0; } };
const saveWatermark = (w) => { try { writeFileSync(STATE, JSON.stringify({ watermark: w, updated_at: new Date().toISOString() })); } catch {} };

function readNewFindings(sinceMs) {
  const db = new Database(DB, { readonly: true });
  try {
    return db.prepare(`
      SELECT sf.session_id, sf.detector, sf.rule, sf.line, sf.preview, sf.verified,
             sf.scanned_at, m.project_path
      FROM secret_findings sf
      LEFT JOIN memory_metadata m ON m.id = sf.session_id AND m.source_type = 'session'
      WHERE sf.scanned_at > ?
      ORDER BY sf.scanned_at ASC
    `).all(sinceMs);
  } finally { db.close(); }
}

async function pushBatch(findings) {
  const r = await fetch(`${API.replace(/\/+$/, '')}/api/sync`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ findings }),
  });
  if (!r.ok) throw new Error(`sync ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return (await r.json()).find || 0;
}

async function syncOnce() {
  const watermark = loadWatermark();
  const rows = readNewFindings(watermark);
  if (rows.length === 0) { console.log(`[${new Date().toISOString()}] up to date (watermark ${watermark})`); return; }
  let pushed = 0, maxTs = watermark;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500).map(r => ({
      session_id: r.session_id, detector: r.detector, rule: r.rule, line: r.line,
      preview: r.preview, project_path: r.project_path || null,
      verified_at: r.verified === 1 ? new Date().toISOString() : null,
    }));
    pushed += await pushBatch(batch);
    maxTs = Math.max(maxTs, ...rows.slice(i, i + 500).map(r => r.scanned_at || 0));
    saveWatermark(maxTs); // advance incrementally so a crash doesn't resend everything
  }
  console.log(`[${new Date().toISOString()}] pushed ${pushed} findings (watermark -> ${maxTs})`);
}

console.log(`chat-recall agent → ${API} (findings only). ${ONCE ? 'single run' : `every ${INTERVAL / 1000}s`}`);
await syncOnce().catch(e => console.error('sync error:', e.message));
if (!ONCE) setInterval(() => syncOnce().catch(e => console.error('sync error:', e.message)), INTERVAL);
