/**
 * Backfill `memory_metadata.project_id` for rows indexed before the
 * project-resolver landed (or after the user changes
 * `~/.chat-recall/projects.json`).
 *
 * Strategy: SELECT DISTINCT project_path → resolve each → UPDATE rows
 * matching that path. One git subprocess per distinct path (cached by
 * the resolver). Idempotent: safe to re-run.
 *
 * Usage:
 *   tsx scripts/backfill-project-id.ts          # backfill all rows missing a project_id
 *   tsx scripts/backfill-project-id.ts --all    # recompute every row regardless
 *   tsx scripts/backfill-project-id.ts --dry    # show counts, don't write
 */

import Database from 'better-sqlite3';

import { getCacheDbPath } from '@chat-recall/engine/core/paths.js';
import {
  resolveProjectId,
  resetProjectResolverCache,
} from '@chat-recall/engine/core/project-resolver.js';

interface Args {
  all: boolean;
  dry: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  return {
    all: argv.includes('--all'),
    dry: argv.includes('--dry') || argv.includes('--dry-run'),
  };
}

interface PathRow { project_path: string; rows: number; current_ids: string }

function main(): void {
  const args = parseArgs();
  resetProjectResolverCache(); // fresh config load

  const db = new Database(getCacheDbPath());
  const hasTable = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='memory_metadata'`
  ).get();
  if (!hasTable) {
    console.log('memory_metadata table does not exist yet — run an index first.');
    db.close();
    return;
  }
  // Defensive: ensure the column exists in case this runs against an
  // un-migrated db (e.g. one that was opened by an older binary).
  try { db.exec(`ALTER TABLE memory_metadata ADD COLUMN project_id TEXT NOT NULL DEFAULT '';`); } catch { /* exists */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_project_id ON memory_metadata(project_id);`); } catch { /* exists */ }

  const where = args.all ? '' : `WHERE project_id = '' AND project_path <> ''`;
  const rows = db.prepare(
    `SELECT project_path,
            COUNT(*) AS rows,
            GROUP_CONCAT(DISTINCT project_id) AS current_ids
     FROM memory_metadata
     ${where}
     GROUP BY project_path
     ORDER BY rows DESC`,
  ).all() as PathRow[];

  if (rows.length === 0) {
    console.log('Nothing to backfill.');
    db.close();
    return;
  }

  console.log(`Found ${rows.length} distinct project_path values covering ${rows.reduce((s, r) => s + r.rows, 0)} rows.\n`);

  const update = db.prepare(`UPDATE memory_metadata SET project_id = ? WHERE project_path = ?`);
  let touched = 0;
  let changed = 0;
  const txn = db.transaction(() => {
    for (const r of rows) {
      const resolved = resolveProjectId(r.project_path);
      // `source = 'ignored'` short-circuits to no project; empty id from the
      // resolver (e.g. empty input path) is also treated as "no project_id".
      const newId = resolved.source === 'ignored' || !resolved.id ? '' : resolved.id;
      const prev = r.current_ids || '';
      if (args.dry) {
        if (prev !== newId) {
          console.log(`  [dry] ${r.project_path} (${r.rows} rows) -> ${newId || '(empty)'}  [was: ${prev || '(empty)'}]`);
        }
        continue;
      }
      const result = update.run(newId, r.project_path);
      touched += result.changes;
      if (prev !== newId) changed += result.changes;
    }
  });
  txn();

  if (args.dry) {
    console.log('\nDry run: no rows were modified.');
  } else {
    console.log(`Touched ${touched} rows (${changed} rows actually changed project_id).`);
  }

  db.close();
}

main();
