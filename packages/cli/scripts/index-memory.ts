#!/usr/bin/env tsx
/**
 * Bulk indexing script for all memory sources.
 *
 * Usage:
 *   npx tsx scripts/index-memory.ts              # Index all sources (incremental)
 *   npx tsx scripts/index-memory.ts --force       # Force re-index all
 *   npx tsx scripts/index-memory.ts --types plan,task  # Only specific types
 *   npx tsx scripts/index-memory.ts --status      # Show current stats
 */

import { config } from 'dotenv';
config();

import { getEmbedder, type EmbedderProvider } from '@chat-recall/engine/core/embedder.js';
import { createVectorStore } from '@chat-recall/engine/core/store/vector.js';
import { createStore } from '@chat-recall/engine/core/store/index.js';
import { SourceRegistry } from '@chat-recall/engine/core/source-registry.js';
import { SessionSource } from '@chat-recall/engine/parsers/session-source.js';
import { PlanSource } from '@chat-recall/engine/parsers/plan-source.js';
import { TaskSource } from '@chat-recall/engine/parsers/task-source.js';
import type { SourceType, MemoryItem } from '@chat-recall/engine/types/memory.js';

// Parse args
const args = process.argv.slice(2);
const force = args.includes('--force') || args.includes('-f');
const statusOnly = args.includes('--status');
const typesArg = args.find(a => a.startsWith('--types=') || a.startsWith('--types '));
const typesIdx = args.indexOf('--types');
let requestedTypes: SourceType[] | undefined;

if (typesArg) {
  requestedTypes = typesArg.split('=')[1]?.split(',') as SourceType[];
} else if (typesIdx !== -1 && args[typesIdx + 1]) {
  requestedTypes = args[typesIdx + 1].split(',') as SourceType[];
}

const providerArg = args.find(a => a.startsWith('--provider='));
const providerIdx = args.indexOf('--provider');
let provider: EmbedderProvider = (process.env.EMBEDDING_PROVIDER as EmbedderProvider) || 'ollama';
if (providerArg) {
  provider = providerArg.split('=')[1] as EmbedderProvider;
} else if (providerIdx !== -1 && args[providerIdx + 1]) {
  provider = args[providerIdx + 1] as EmbedderProvider;
}

async function main() {
  const embedder = getEmbedder(provider);
  const memoryIndex = await createVectorStore(embedder);
  const memoryStore = await createStore();

  if (statusOnly) {
    const stats = await memoryIndex.getStats();
    const storeStats = await memoryStore.getStats();
    const linkCount = await memoryStore.getLinkCount();

    console.log('Memory Index Status');
    console.log('===================');
    console.log(`Index path: ${stats.indexPath}`);
    console.log(`Total items: ${stats.totalItems}`);
    console.log(`Total chunks: ${stats.totalChunks}`);
    console.log(`Total links: ${linkCount}`);
    console.log();

    console.log('By source type (vector index):');
    for (const [type, data] of Object.entries(stats.bySourceType)) {
      console.log(`  ${type}: ${data.items} items, ${data.chunks} chunks`);
    }

    console.log();
    console.log('By source type (metadata store):');
    for (const [type, count] of Object.entries(storeStats)) {
      console.log(`  ${type}: ${count} items`);
    }

    await memoryStore.close();
    return;
  }

  // Register sources
  const registry = new SourceRegistry();
  registry.register(new SessionSource());
  registry.register(new PlanSource());
  registry.register(new TaskSource());

  // Import additional sources if available
  try {
    const { ClaudeMdSource } = await import('@chat-recall/engine/parsers/claude-md-source.js');
    registry.register(new ClaudeMdSource());
  } catch { /* not yet implemented */ }

  try {
    const { AgentMemorySource } = await import('@chat-recall/engine/parsers/agent-memory-source.js');
    registry.register(new AgentMemorySource());
  } catch { /* not yet implemented */ }

  try {
    const { HistorySource } = await import('@chat-recall/engine/parsers/history-source.js');
    registry.register(new HistorySource());
  } catch { /* not yet implemented */ }

  try {
    const { PasteSource } = await import('@chat-recall/engine/parsers/paste-source.js');
    registry.register(new PasteSource());
  } catch { /* not yet implemented */ }

  const types = requestedTypes || registry.getRegisteredTypes();
  console.log(`Using embedding provider: ${provider}`);
  console.log(`Indexing source types: ${types.join(', ')}`);
  if (force) console.log('Force mode: re-indexing everything');
  console.log();

  const totalStats = {
    itemsProcessed: 0,
    itemsSkipped: 0,
    chunksAdded: 0,
    linksAdded: 0,
    errors: 0,
  };

  for (const sourceType of types) {
    const source = registry.get(sourceType);
    if (!source) {
      console.log(`Skipping unknown source type: ${sourceType}`);
      continue;
    }

    console.log(`--- ${sourceType} ---`);
    let typeItems = 0;
    let typeChunks = 0;
    let typeLinks = 0;
    let typeSkipped = 0;

    try {
      for await (const item of source.discover()) {
        try {
          // Check if needs update
          if (!force && !(await memoryIndex.needsUpdate(item.sourceType, item.id, item.mtime))) {
            typeSkipped++;
            continue;
          }

          // Delete old data for this item
          await memoryIndex.deleteItem(item.sourceType, item.id);

          // Parse into chunks (buffered — flushed in batches)
          const chunks = await source.parse(item);

          if (chunks.length > 0) {
            await memoryIndex.bufferChunks(chunks);
            typeChunks += chunks.length;
          }

          // Store metadata
          await memoryStore.setItem(item);

          // Extract and store links
          const links = await source.extractLinks(item);
          if (links.length > 0) {
            await memoryStore.addLinks(links);
            typeLinks += links.length;
          }

          typeItems++;

          // Progress logging
          const titlePreview = item.title.length > 60
            ? item.title.slice(0, 57) + '...'
            : item.title;
          console.log(`  [${item.sourceType}] ${titlePreview} (${chunks.length} chunks)`);
        } catch (err) {
          totalStats.errors++;
          console.error(`  Error processing ${item.id}: ${err}`);
        }
      }
    } catch (err) {
      totalStats.errors++;
      console.error(`  Error discovering ${sourceType}: ${err}`);
    }

    // Flush remaining buffered chunks for this source type
    const flushed = await memoryIndex.flushBuffer();
    if (flushed > 0) console.log(`  Flushed ${flushed} buffered chunks`);

    console.log(`  => ${typeItems} processed, ${typeSkipped} skipped, ${typeChunks} chunks, ${typeLinks} links`);
    console.log();

    totalStats.itemsProcessed += typeItems;
    totalStats.itemsSkipped += typeSkipped;
    totalStats.chunksAdded += typeChunks;
    totalStats.linksAdded += typeLinks;
  }

  console.log('===================');
  console.log(`Total: ${totalStats.itemsProcessed} items, ${totalStats.chunksAdded} chunks, ${totalStats.linksAdded} links`);
  console.log(`Skipped: ${totalStats.itemsSkipped}`);
  if (totalStats.errors > 0) {
    console.log(`Errors: ${totalStats.errors}`);
  }

  // Optimize LanceDB after bulk indexing
  if (totalStats.itemsProcessed > 0) {
    console.log();
    console.log('Optimizing LanceDB...');
    const optimizeStats = await memoryIndex.optimize();
    console.log(`  Compacted ${optimizeStats.compactedFragments} fragments, pruned ${optimizeStats.prunedFiles} old versions`);
  }

  await memoryStore.close();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
