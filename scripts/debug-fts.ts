#!/usr/bin/env tsx
import Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';

const db = new Database(join(homedir(), '.claude', 'chat-recall-cache.db'));
const cols = db.prepare('PRAGMA table_info(memory_chunks_fts)').all();
console.log(
  'fts cols:',
  (cols as any[]).map((r) => r.name)
);
const ct = db.prepare('SELECT COUNT(*) AS n FROM memory_chunks_fts').get();
console.log('total FTS rows:', ct);
const sm = db
  .prepare("SELECT COUNT(*) AS n FROM session_metadata WHERE summary IS NOT NULL AND summary != ''")
  .get();
console.log('session_metadata rows with summary:', sm);
// Aggregate FTS coverage and summary coverage per tool.
for (const tool of ['claude', 'gemini', 'opencode']) {
  const pred =
    tool === 'claude'
      ? "(json_extract(m.extra_json,'$.tool') IS NULL OR json_extract(m.extra_json,'$.tool')='claude')"
      : "json_extract(m.extra_json,'$.tool')=?";
  const params = tool === 'claude' ? [] : [tool];
  const sessions = db
    .prepare(`SELECT COUNT(*) AS n FROM memory_metadata m WHERE m.source_type='session' AND ${pred}`)
    .get(...(params as any[])) as { n: number };
  const withChunks = db
    .prepare(
      `SELECT COUNT(DISTINCT m.id) AS n FROM memory_metadata m ` +
        `JOIN memory_chunks_fts c ON c.item_id = m.id ` +
        `WHERE m.source_type='session' AND ${pred}`
    )
    .get(...(params as any[])) as { n: number };
  const withSummary = db
    .prepare(
      `SELECT COUNT(*) AS n FROM memory_metadata m ` +
        `JOIN session_metadata sm ON sm.session_id = m.id ` +
        `WHERE m.source_type='session' AND sm.summary IS NOT NULL AND sm.summary != '' AND ${pred}`
    )
    .get(...(params as any[])) as { n: number };
  console.log(
    `  ${tool.padEnd(9)}: sessions=${sessions.n.toString().padStart(4)}  ` +
      `withFTS=${withChunks.n.toString().padStart(4)}  withSummary=${withSummary.n.toString().padStart(4)}`
  );
}
db.close();
