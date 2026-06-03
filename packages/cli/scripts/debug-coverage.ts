import { getCacheDbPath } from '@chat-recall/engine/core/paths.js';
#!/usr/bin/env tsx
import Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';

const cache = new Database(getCacheDbPath());

// Sessions by tool, with chunk presence and summary presence.
const rows = cache
  .prepare(
    "SELECT json_extract(extra_json, '$.tool') AS tool, " +
      "       COUNT(*) AS items, " +
      "       SUM(CASE WHEN content_preview != '' THEN 1 ELSE 0 END) AS with_preview, " +
      "       SUM(CASE WHEN json_extract(extra_json,'$.summary') IS NOT NULL THEN 1 ELSE 0 END) AS with_summary " +
      "FROM memory_metadata WHERE source_type='session' GROUP BY tool"
  )
  .all();
console.log('session coverage by tool:');
for (const r of rows) console.log(' ', r);

// How many FTS chunks exist per tool? Proxy: join chunk itemIds to metadata tool.
const chunkCount = cache
  .prepare(
    "SELECT json_extract(m.extra_json,'$.tool') AS tool, COUNT(c.rowid) AS chunks " +
      "FROM memory_chunks_fts c JOIN memory_metadata m ON m.id = c.itemId " +
      "WHERE m.source_type='session' GROUP BY tool"
  )
  .all();
console.log('FTS chunks per tool:');
for (const r of chunkCount) console.log(' ', r);

// session_metadata table (summaries) — how many per tool-equivalent? session_metadata has no tool col;
// count how many sessions from each group have a summary row.
const perToolSummaries = cache
  .prepare(
    "SELECT json_extract(m.extra_json,'$.tool') AS tool, " +
      "       COUNT(DISTINCT m.id) AS sessions, " +
      "       SUM(CASE WHEN sm.summary IS NOT NULL AND sm.summary != '' THEN 1 ELSE 0 END) AS with_summary " +
      "FROM memory_metadata m " +
      "LEFT JOIN session_metadata sm ON sm.session_id = m.id " +
      "WHERE m.source_type='session' GROUP BY tool"
  )
  .all();
console.log('summary coverage per tool:');
for (const r of perToolSummaries) console.log(' ', r);

cache.close();
