/**
 * One-shot cleanup of junk triples in the knowledge graph.
 *
 * The entity-extractor's decision regex used to capture the next token
 * after trigger phrases like "chose" or "rejected", which produced
 * triples like `chat-recall → chose → so` or
 * `chat-recall → rejected → paying`. The write-time filter
 * (`looksLikeDecisionObject` in `entity-extractor.ts`) catches these
 * now, but triples already in the graph from before the filter landed
 * still pollute the dossier's Decisions section.
 *
 * Usage:
 *   tsx scripts/cleanup-kg-triples.ts             # apply
 *   tsx scripts/cleanup-kg-triples.ts --dry       # report counts only
 */

import Database from 'better-sqlite3';

import { getKnowledgeGraphDbPath } from '@chat-recall/engine/core/paths.js';

interface TripleRow { id: string; subject: string; predicate: string; object: string }

const args = process.argv.slice(2);
const DRY = args.includes('--dry') || args.includes('--dry-run');

const STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with',
  'from', 'as', 'into', 'onto', 'off', 'out', 'up', 'down', 'over',
  'under', 'and', 'or', 'but', 'so', 'if', 'than', 'then', 'that',
  'this', 'these', 'those', 'it', 'its',
  'use', 'using', 'do', 'doing', 'go', 'going', 'be', 'being', 'have',
  'having', 'make', 'making', 'add', 'adding', 'remove', 'removing',
  'paying', 'reading', 'writing', 'returning', 'summarizing',
  'wins', 'default', 'content', 'now', 'here', 'there', 'just', 'one',
  'two', 'three', 'best', 'worst', 'good', 'bad',
  'leaf', 'loc', 'local', 'spin', 'shit', 'right', 'changes',
  'thing', 'things', 'stuff', 'all', 'some',
]);

const KNOWN_TOOLS = new Set([
  'typescript', 'javascript', 'python', 'rust', 'go', 'java', 'ruby',
  'react', 'vue', 'angular', 'svelte', 'express', 'fastapi', 'django',
  'flask', 'rails', 'spring', 'pingora', 'actix', 'axum', 'tailwind',
  'shadcn', 'nextjs',
  'postgres', 'postgresql', 'sqlite', 'mysql', 'mongodb', 'redis',
  'dragonfly', 'lancedb', 'chromadb', 'supabase', 'dynamodb',
  'docker', 'kubernetes', 'k8s', 'terraform', 'ansible', 'nginx',
  'caddy', 'cloudflare', 'gcp', 'aws', 'azure', 'vercel',
  'git', 'github', 'gitlab', 'ollama', 'gemini', 'claude', 'codex',
  'opencode', 'vitest', 'playwright', 'webpack', 'vite', 'esbuild',
  'solidity', 'move', 'haskell', 'kotlin', 'swift',
]);

/**
 * Mirror of entity-extractor.looksLikeDecisionObject. Kept inline here
 * so this script has no runtime dependency on the parser bundle.
 */
function looksMeaningful(raw: string): boolean {
  const t = raw.trim();
  if (t.length < 2) return false;
  const lower = t.toLowerCase();
  if (STOPWORDS.has(lower)) return false;
  if (KNOWN_TOOLS.has(lower)) return true;
  if (/^[A-Z]/.test(t)) return true;
  if (/[.-]/.test(t) && t.length >= 3) return true;
  if (/ing$/i.test(t)) return false;
  return false;
}

function main(): void {
  const dbPath = getKnowledgeGraphDbPath();
  const db = new Database(dbPath);

  const rows = db.prepare(
    `SELECT t.id, t.predicate, s.name AS subject, o.name AS object
     FROM triples t
     JOIN entities s ON t.subject = s.id
     JOIN entities o ON t.object = o.id
     WHERE t.predicate IN ('chose', 'rejected', 'chosen_over')`,
  ).all() as TripleRow[];

  const junkIds: string[] = [];
  for (const r of rows) {
    if (!looksMeaningful(r.object)) {
      junkIds.push(r.id);
      if (DRY) {
        console.log(`  drop: ${r.subject} → ${r.predicate} → ${r.object}`);
      }
    }
  }

  console.log(`Inspected ${rows.length} decision triples.`);
  console.log(`Would drop ${junkIds.length}, keep ${rows.length - junkIds.length}.`);

  if (DRY) {
    console.log('Dry run — no rows deleted.');
    db.close();
    return;
  }

  if (junkIds.length === 0) {
    console.log('Nothing to clean.');
    db.close();
    return;
  }

  // Batch in groups of 500 to keep param counts under SQLite's limit.
  const del = db.prepare(`DELETE FROM triples WHERE id = ?`);
  const txn = db.transaction((ids: string[]) => {
    for (const id of ids) del.run(id);
  });
  txn(junkIds);

  console.log(`Deleted ${junkIds.length} junk decision triples.`);
  db.close();
}

main();
