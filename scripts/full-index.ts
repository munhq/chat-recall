#!/usr/bin/env tsx
/**
 * Full indexing script for chat-recall.
 * Indexes all conversations found in ~/.claude/projects/
 */

import { indexAllSessions } from '../src/core/indexer.js';
import { OllamaEmbedder } from '../src/core/embedder.js';

async function fullIndex() {
  console.log('Starting full indexing of all Claude Code sessions...\n');

  const embedder = new OllamaEmbedder();

  try {
    const stats = await indexAllSessions(embedder, {
      force: false,  // Only index new/changed sessions
      showProgress: true,
    });

    console.log('\n✅ Indexing complete!');
    console.log(`   Sessions processed: ${stats.sessionsProcessed}`);
    console.log(`   Sessions skipped: ${stats.sessionsSkipped}`);
    console.log(`   Chunks added: ${stats.chunksAdded}`);

    if (stats.errors > 0) {
      console.log(`   ⚠️  Errors: ${stats.errors}`);
    }
  } catch (error) {
    console.error('❌ Indexing failed:', error);
    process.exit(1);
  }
}

fullIndex();
