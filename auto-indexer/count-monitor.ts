#!/usr/bin/env tsx
/**
 * Simple file count monitor - checks every 60 seconds if new sessions were created.
 * Much more reliable than file watching!
 */

import { execSync } from 'child_process';
import { indexAllSessions } from '../src/core/indexer.js';
import { OllamaEmbedder } from '../src/core/embedder.js';
import { createMetadataCache, type MetadataCacheDriver } from '../src/core/store/caches.js';
import { SummaryGenerator } from '../src/core/summary-generator.js';
import { getAllSessions, parseSessionFile } from '../src/parsers/session.js';
import { claudeBackend } from '../src/core/backends/index.js';
import { statSync } from 'fs';

const CHECK_INTERVAL_MS = 60 * 1000;  // Check every 60 seconds
const CLAUDE_DIR = claudeBackend.projectsDir();

const embedder = new OllamaEmbedder();
let _metadataCache: MetadataCacheDriver | null = null;
async function getMetadataCache(): Promise<MetadataCacheDriver> {
  if (!_metadataCache) _metadataCache = await createMetadataCache();
  return _metadataCache;
}
const summaryGenerator = new SummaryGenerator({ provider: 'gemini-cli' });

let lastFileCount = 0;

function getFileCount(): number {
  try {
    const output = execSync(`find "${CLAUDE_DIR}" -name "*.jsonl" ! -name "*agent-*" | wc -l`, { encoding: 'utf-8' });
    return parseInt(output.trim());
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error counting files:`, error);
    return lastFileCount;
  }
}

async function runIndexing() {
  console.log(`[${new Date().toISOString()}] 🔄 New files detected, indexing...`);

  let summariesGenerated = 0;

  // Generate summaries for new/modified sessions
  for (const [entry, filePath] of getAllSessions()) {
    try {
      const stat = statSync(filePath);

      if (await (await getMetadataCache()).needsUpdate(entry.sessionId, stat.mtimeMs)) {
        const content = await parseSessionFile(filePath);

        let summary: string;
        let summarySource: 'original' | 'gemini';

        if (content.summaries.length > 0) {
          summary = content.summaries[0];
          summarySource = 'original';
        } else {
          console.log(`[${new Date().toISOString()}] Generating summary for ${entry.sessionId.substring(0, 8)}...`);
          summary = await summaryGenerator.generate(content);
          summarySource = 'gemini';
          summariesGenerated++;
        }

        await (await getMetadataCache()).set({
          sessionId: entry.sessionId,
          firstPrompt: content.firstPrompt,
          summary,
          summarySource,
          mtime: stat.mtimeMs,
          indexedAt: Date.now(),
        });
      }
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error: ${(error as Error).message}`);
    }
  }

  // Run vector indexing
  try {
    const stats = await indexAllSessions(embedder, {
      force: false,
      showProgress: false,
    });

    console.log(`[${new Date().toISOString()}] ✅ Done: ${summariesGenerated} new summaries, ${stats.chunksAdded} chunks indexed`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Indexing failed:`, error);
  }
}

async function checkAndIndex() {
  const currentCount = getFileCount();

  if (currentCount > lastFileCount) {
    const diff = currentCount - lastFileCount;
    console.log(`[${new Date().toISOString()}] 📈 File count increased: ${lastFileCount} → ${currentCount} (+${diff})`);
    lastFileCount = currentCount;
    await runIndexing();
  } else if (currentCount < lastFileCount) {
    console.log(`[${new Date().toISOString()}] 📉 File count decreased: ${lastFileCount} → ${currentCount}`);
    lastFileCount = currentCount;
  }
}

// Initialize
console.log(`[${new Date().toISOString()}] 🚀 Count monitor started`);
console.log(`   Directory: ${CLAUDE_DIR}`);
console.log(`   Check interval: ${CHECK_INTERVAL_MS / 1000}s`);
lastFileCount = getFileCount();
console.log(`   Initial file count: ${lastFileCount}`);

// Check every interval
setInterval(checkAndIndex, CHECK_INTERVAL_MS);

// Keep alive
setInterval(() => {
  console.log(`[${new Date().toISOString()}] ⏰ Monitoring... (${lastFileCount} files)`);
}, 5 * 60 * 1000);  // Heartbeat every 5 min

// Handle shutdown
process.on('SIGTERM', () => {
  console.log(`[${new Date().toISOString()}] Received SIGTERM, shutting down...`);
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log(`[${new Date().toISOString()}] Received SIGINT, shutting down...`);
  process.exit(0);
});
