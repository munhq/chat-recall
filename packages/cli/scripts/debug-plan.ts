import { getCacheDbPath } from '@chat-recall/engine/core/paths.js';
#!/usr/bin/env tsx
import Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';
import { readFileSync, existsSync } from 'fs';

const db = new Database(getCacheDbPath());

const row = db
  .prepare(
    `SELECT id, source_type, title, project_path, file_path,
            length(content_preview) AS preview_len,
            substr(content_preview, 1, 500) AS preview_head
       FROM memory_metadata
      WHERE source_type = 'plan'
        AND id = 'ok-then-you-do-flickering-sunset'`
  )
  .get() as any;

console.log('DB row for plan:');
console.log(JSON.stringify(row, null, 2));

if (row?.file_path && existsSync(row.file_path)) {
  const raw = readFileSync(row.file_path, 'utf-8');
  console.log(`\nFile exists, ${raw.length} chars on disk. Head:`);
  console.log(raw.slice(0, 500));
  console.log('\n…tail:');
  console.log(raw.slice(-400));
}

db.close();
