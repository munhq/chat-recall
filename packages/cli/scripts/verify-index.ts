#!/usr/bin/env tsx
/**
 * Verify indexing coverage - check how many sessions are indexed.
 */

import { SessionIndex } from '@chat-recall/engine/core/indexer.js';
import { OllamaEmbedder } from '@chat-recall/engine/core/embedder.js';
import { getAllSessions } from '@chat-recall/engine/parsers/session.js';

async function verifyIndex() {
  console.log('Checking index coverage...\n');

  const embedder = new OllamaEmbedder();
  const index = new SessionIndex(embedder);

  // Get index stats
  const stats = await index.getStats();

  // Count total sessions on disk
  let totalSessions = 0;
  for (const _ of getAllSessions()) {
    totalSessions++;
  }

  console.log('Index Statistics:');
  console.log(`  Total sessions on disk: ${totalSessions}`);
  console.log(`  Indexed sessions: ${stats.totalSessions}`);
  console.log(`  Total chunks: ${stats.totalChunks}`);
  console.log(`  Index path: ${stats.indexPath}`);

  const coverage = ((stats.totalSessions / totalSessions) * 100).toFixed(1);
  console.log(`\nCoverage: ${coverage}%`);

  if (stats.totalSessions < totalSessions) {
    const missing = totalSessions - stats.totalSessions;
    console.log(`\n⚠️  ${missing} sessions missing from index`);
    console.log('   Run: npx tsx scripts/full-index.ts');
  } else {
    console.log('\n✅ All sessions indexed!');
  }

  console.log('\nProjects:');
  for (const [project, count] of Object.entries(stats.projects)) {
    console.log(`  ${project}: ${count} chunks`);
  }
}

verifyIndex();
