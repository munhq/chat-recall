import { getCacheDbPath } from '@chat-recall/engine/core/paths.js';
#!/usr/bin/env tsx
import Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';

const db = new Database(getCacheDbPath());

const rem = db
  .prepare(
    `SELECT COUNT(*) AS c FROM session_metadata
      WHERE summary LIKE '%MCP issues detected%'
         OR first_prompt LIKE '%MCP issues detected%'`
  )
  .get() as { c: number };
console.log('remaining rows with banner:', rem.c);

const sample = db
  .prepare(
    `SELECT session_id, substr(summary, 1, 160) AS s
       FROM session_metadata
      WHERE session_id = ?`
  )
  .get('29bd5d62-d8bd-4b40-81d7-85d80f3e049b') as any;
console.log('sample (0x8dxd session) summary head:', sample?.s);
db.close();
