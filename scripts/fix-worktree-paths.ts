/**
 * One-shot repair for session rows whose `project_path` was mangled by
 * the naive Claude-projects-dir decoder (every `-` → `/`).
 *
 * Symptom: session rows with project_path like
 *   /home/user/claude/pr/bot/worktrees/acme/infrastructure/393
 * that don't exist on disk, because the real cwd had dashes inside
 * folder names (`.claude-pr-bot`, `acme-infrastructure-393`).
 *
 * Repair: open the JSONL, find the first `cwd` event, and use that
 * if it exists on disk. Then re-resolve project_id via the resolver
 * (which can now reach the worktree → git toplevel → remote).
 *
 * Idempotent. Safe to re-run.
 */

import { existsSync, readFileSync } from 'fs';
import Database from 'better-sqlite3';

import { getCacheDbPath } from '../src/core/paths.js';
import { resolveProjectId, resetProjectResolverCache } from '../src/core/project-resolver.js';

interface Row { id: string; source_type: string; project_path: string; project_id: string; file_path: string }

const DRY = process.argv.includes('--dry');

function readCwdFromJsonl(sessionPath: string): string {
  if (!existsSync(sessionPath)) return '';
  try {
    const text = readFileSync(sessionPath, 'utf-8');
    const lines = text.split('\n', 50);
    for (const line of lines) {
      if (!line || !line.includes('"cwd"')) continue;
      try {
        const obj = JSON.parse(line) as { cwd?: unknown };
        if (typeof obj.cwd === 'string' && obj.cwd) return obj.cwd;
      } catch { /* skip */ }
    }
  } catch { /* unreadable */ }
  return '';
}

function main(): void {
  resetProjectResolverCache();
  const db = new Database(getCacheDbPath());

  // Candidate rows: session rows whose stored project_path doesn't
  // exist on disk. That's the symptom of decoder mangling.
  const rows = db.prepare(
    `SELECT id, source_type, project_path, project_id, file_path
     FROM memory_metadata
     WHERE source_type = 'session' AND project_path <> '' AND file_path <> ''`,
  ).all() as Row[];

  const updates: Array<{ id: string; sourceType: string; newPath: string; newId: string }> = [];
  let checked = 0;
  let stale = 0;
  for (const r of rows) {
    checked++;
    if (existsSync(r.project_path)) continue; // already fine
    stale++;
    const cwd = readCwdFromJsonl(r.file_path);
    if (!cwd || !existsSync(cwd)) continue; // can't recover
    const resolved = resolveProjectId(cwd);
    const newId = resolved.source === 'ignored' || !resolved.id ? '' : resolved.id;
    if (cwd === r.project_path && newId === r.project_id) continue;
    updates.push({ id: r.id, sourceType: r.source_type, newPath: cwd, newId });
  }

  console.log(`Checked ${checked} session rows.`);
  console.log(`  ${stale} had a stale project_path (not on disk).`);
  console.log(`  ${updates.length} are repairable via JSONL cwd.`);

  if (DRY) {
    for (const u of updates.slice(0, 10)) {
      console.log(`  [dry] ${u.id.slice(0,12)}… -> ${u.newPath} (${u.newId})`);
    }
    db.close();
    return;
  }

  if (updates.length === 0) {
    db.close();
    return;
  }

  const stmt = db.prepare(
    `UPDATE memory_metadata
     SET project_path = ?, project_id = ?
     WHERE id = ? AND source_type = ?`,
  );
  const txn = db.transaction(() => {
    for (const u of updates) stmt.run(u.newPath, u.newId, u.id, u.sourceType);
  });
  txn();
  console.log(`Repaired ${updates.length} rows.`);

  // FTS rows mirror metadata; update them too so search filters land.
  const ftsStmt = db.prepare(
    `UPDATE memory_chunks_fts SET project_path = ?, project_id = ? WHERE item_id = ? AND source_type = ?`,
  );
  const fts = db.transaction(() => {
    for (const u of updates) ftsStmt.run(u.newPath, u.newId, u.id, u.sourceType);
  });
  fts();
  console.log('FTS chunks aligned.');

  db.close();
}

main();
