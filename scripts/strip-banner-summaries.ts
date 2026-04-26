#!/usr/bin/env tsx
/**
 * One-off cleanup: strip Claude Code status banners (MCP health
 * warnings, context-low, transient API errors) from already-indexed
 * summaries and first_prompts in the session metadata cache.
 *
 * This mutates existing rows in place — same regex set as
 * stripInjectedBanners in src/parsers/chunker.ts.
 */

import Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';
import { stripInjectedBanners } from '../src/parsers/chunker.js';

const dbPath = join(homedir(), '.claude', 'chat-recall-cache.db');
const db = new Database(dbPath);

const rows = db
  .prepare(
    `SELECT session_id, first_prompt, summary
       FROM session_metadata
      WHERE summary LIKE '%MCP issues detected%'
         OR summary LIKE '%Context low%Run /compact%'
         OR summary LIKE '%API Error:%'
         OR first_prompt LIKE '%MCP issues detected%'
         OR first_prompt LIKE '%Context low%Run /compact%'
         OR first_prompt LIKE '%API Error:%'`
  )
  .all() as { session_id: string; first_prompt: string | null; summary: string | null }[];

console.log(`Found ${rows.length} rows with injected banners.`);

const update = db.prepare(
  `UPDATE session_metadata SET summary = ?, first_prompt = ? WHERE session_id = ?`
);

let changed = 0;
const tx = db.transaction(() => {
  for (const row of rows) {
    const newSummary = row.summary ? stripInjectedBanners(row.summary) : row.summary;
    const newFirst = row.first_prompt ? stripInjectedBanners(row.first_prompt) : row.first_prompt;
    if (newSummary !== row.summary || newFirst !== row.first_prompt) {
      update.run(newSummary, newFirst, row.session_id);
      changed++;
    }
  }
});
tx();

console.log(`Cleaned ${changed} rows.`);
db.close();
