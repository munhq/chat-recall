import { getCacheDbPath } from '../src/core/paths.js';
#!/usr/bin/env tsx
import Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';

const db = new Database(getCacheDbPath());

const sessionTools = db
  .prepare(
    "SELECT json_extract(extra_json, '$.tool') AS tool, COUNT(*) AS n " +
      "FROM memory_metadata WHERE source_type='session' GROUP BY tool ORDER BY n DESC"
  )
  .all();
console.log('sessions by tool:'); for (const r of sessionTools) console.log(' ', r);

const plansByOrigin = db
  .prepare(
    "SELECT " +
      " CASE WHEN file_path LIKE '%.gemini/antigravity/brain%' THEN 'gemini-brain' " +
      "      WHEN file_path LIKE '%.claude/plans%'             THEN 'claude' " +
      "      ELSE 'other' END AS origin, COUNT(*) AS n " +
      "FROM memory_metadata WHERE source_type='plan' GROUP BY origin ORDER BY n DESC"
  )
  .all();
console.log('plans by origin:'); for (const r of plansByOrigin) console.log(' ', r);

const tasksByOrigin = db
  .prepare(
    "SELECT " +
      " CASE WHEN file_path LIKE '%opencode%'       THEN 'opencode-todos' " +
      "      WHEN file_path LIKE '%.claude/tasks%'  THEN 'claude' " +
      "      ELSE 'other' END AS origin, COUNT(*) AS n " +
      "FROM memory_metadata WHERE source_type='task' GROUP BY origin ORDER BY n DESC"
  )
  .all();
console.log('tasks by origin:'); for (const r of tasksByOrigin) console.log(' ', r);

db.close();
