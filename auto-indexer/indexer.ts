#!/usr/bin/env tsx
/**
 * Auto-indexer daemon for chat-recall.
 * Watches ~/.claude/projects/ for changes and auto-indexes new/modified sessions.
 * Also watches ~/.claude/plans/, ~/.claude/tasks/, and ~/.claude/history.jsonl
 * for the unified memory system.
 *
 * Features:
 * - 5-second debounce after last change
 * - Batch multiple changes into single index run
 * - Direct imports from chat-recall (no subprocess overhead)
 * - Systemd-ready (logs to stdout/stderr)
 */

import chokidar from 'chokidar';
import { OllamaEmbedder } from '../src/core/embedder.js';
import { MetadataCache } from '../src/core/metadata-cache.js';
import { SummaryGenerator } from '../src/core/summary-generator.js';
import { parseSessionFile } from '../src/parsers/session.js';
import { MemoryIndex } from '../src/core/memory-index.js';
import { MemoryStore } from '../src/core/memory-store.js';
import { SourceRegistry } from '../src/core/source-registry.js';
import { SessionSource } from '../src/parsers/session-source.js';
import { PlanSource } from '../src/parsers/plan-source.js';
import { TaskSource } from '../src/parsers/task-source.js';
import { ClaudeMdSource } from '../src/parsers/claude-md-source.js';
import { HistorySource } from '../src/parsers/history-source.js';
import { statSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, basename } from 'path';

const DEBOUNCE_MS = 5000;  // 5 seconds
const CLAUDE_DIR = join(homedir(), '.claude', 'projects');
const PLANS_DIR = join(homedir(), '.claude', 'plans');
const TASKS_DIR = join(homedir(), '.claude', 'tasks');
const HISTORY_PATH = join(homedir(), '.claude', 'history.jsonl');

const embedder = new OllamaEmbedder();
const metadataCache = new MetadataCache();
const summaryGenerator = new SummaryGenerator({ provider: 'gemini-cli' });
let debounceTimer: NodeJS.Timeout | null = null;
const changedFiles = new Set<string>();
const changedMemoryTypes = new Set<string>();

async function runSessionIndexing() {
  const files = Array.from(changedFiles).filter(f => f.endsWith('.jsonl') && f.includes('/projects/'));
  changedFiles.clear();

  if (files.length === 0) return;

  console.log(`[${new Date().toISOString()}] Processing ${files.length} session file(s)...`);

  // Generate summaries for sessions that don't have them
  for (const filePath of files) {
    if (!existsSync(filePath)) continue;

    try {
      const sessionId = basename(filePath, '.jsonl');
      const stat = statSync(filePath);

      if (metadataCache.needsUpdate(sessionId, stat.mtimeMs)) {
        console.log(`[${new Date().toISOString()}] Generating summary for ${sessionId.substring(0, 8)}...`);

        const content = await parseSessionFile(filePath);

        let summary: string;
        let summarySource: 'original' | 'gemini' | 'claude' | 'ollama';

        if (content.summaries.length > 0) {
          summary = content.summaries[0];
          summarySource = 'original';
        } else {
          summary = await summaryGenerator.generate(content);
          summarySource = summaryGenerator['config'].provider === 'gemini-cli' ? 'gemini' : summaryGenerator['config'].provider;
          console.log(`[${new Date().toISOString()}] Generated: "${summary.substring(0, 60)}..."`);
        }

        metadataCache.set({
          sessionId,
          firstPrompt: content.firstPrompt,
          summary,
          summarySource,
          mtime: stat.mtimeMs,
          indexedAt: Date.now(),
        });
      }
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Summary generation failed:`, error);
    }
  }

  // Index sessions via unified MemoryIndex + SessionSource
  try {
    const memoryIndex = new MemoryIndex(embedder);
    const store = new MemoryStore();
    const source = new SessionSource();
    let processed = 0, chunks = 0;

    for await (const item of source.discover()) {
      try {
        if (!memoryIndex.needsUpdate(item.sourceType, item.id, item.mtime)) continue;
        await memoryIndex.deleteItem(item.sourceType, item.id);
        const itemChunks = await source.parse(item);
        if (itemChunks.length > 0) {
          await memoryIndex.bufferChunks(itemChunks);
          chunks += itemChunks.length;
        }
        store.setItem(item);
        processed++;
      } catch (err) {
        console.error(`[${new Date().toISOString()}] Error indexing session ${item.id}: ${err}`);
      }
    }

    await memoryIndex.flushBuffer();
    // optimize() removed from auto flows
    store.close();

    if (processed > 0) {
      console.log(`[${new Date().toISOString()}] Session indexing: ${processed} processed, ${chunks} chunks`);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Session indexing failed:`, error);
  }
}

async function runMemoryIndexing() {
  const types = Array.from(changedMemoryTypes);
  changedMemoryTypes.clear();

  if (types.length === 0) return;

  console.log(`[${new Date().toISOString()}] Memory indexing for: ${types.join(', ')}`);

  try {
    const memoryIndex = new MemoryIndex(embedder);
    const memoryStore = new MemoryStore();
    const registry = new SourceRegistry();

    registry.register(new PlanSource());
    registry.register(new TaskSource());
    registry.register(new ClaudeMdSource());
    registry.register(new HistorySource());

    for (const sourceType of types) {
      const source = registry.get(sourceType as any);
      if (!source) continue;

      let itemCount = 0;
      let chunkCount = 0;

      try {
        for await (const item of source.discover()) {
          try {
            if (!memoryIndex.needsUpdate(item.sourceType, item.id, item.mtime)) {
              continue;
            }

            await memoryIndex.deleteItem(item.sourceType, item.id);
            const chunks = await source.parse(item);

            if (chunks.length > 0) {
              await memoryIndex.bufferChunks(chunks);
              chunkCount += chunks.length;
            }

            memoryStore.setItem(item);

            const links = await source.extractLinks(item);
            if (links.length > 0) {
              memoryStore.addLinks(links);
            }

            itemCount++;
          } catch (err) {
            console.error(`[${new Date().toISOString()}] Error processing ${item.id}: ${err}`);
          }
        }
      } catch (err) {
        console.error(`[${new Date().toISOString()}] Error discovering ${sourceType}: ${err}`);
      }

      // Flush buffered chunks after each source type
      await memoryIndex.flushBuffer();

      if (itemCount > 0) {
        console.log(`[${new Date().toISOString()}] ${sourceType}: ${itemCount} items, ${chunkCount} chunks`);
      }
    }

    // Optimize after all source types processed
    try {
      // optimize() removed from auto flows
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Optimize error:`, err);
    }

    memoryStore.close();
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Memory indexing failed:`, error);
  }
}

async function runIndexing() {
  await runSessionIndexing();
  await runMemoryIndexing();
}

function scheduleIndexing(filePath: string) {
  changedFiles.add(filePath);

  // Detect which memory type was changed
  if (filePath.startsWith(PLANS_DIR)) {
    changedMemoryTypes.add('plan');
  } else if (filePath.startsWith(TASKS_DIR)) {
    changedMemoryTypes.add('task');
  } else if (filePath === HISTORY_PATH) {
    changedMemoryTypes.add('history');
  }

  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  debounceTimer = setTimeout(() => {
    runIndexing();
  }, DEBOUNCE_MS);
}

// Set up file watchers

// 1. Session files
const sessionWatcher = chokidar.watch(`${CLAUDE_DIR}/**/*.jsonl`, {
  ignored: [
    /agent-/,
    /\/\./,
  ],
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: {
    stabilityThreshold: 1000,
    pollInterval: 100,
  },
  usePolling: true,
  interval: 5000,
  binaryInterval: 5000,
});

// 2. Plans
const plansWatcher = chokidar.watch(`${PLANS_DIR}/*.md`, {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: {
    stabilityThreshold: 1000,
    pollInterval: 100,
  },
  usePolling: true,
  interval: 10000,
});

// 3. Tasks
const tasksWatcher = chokidar.watch(`${TASKS_DIR}/**/*.json`, {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: {
    stabilityThreshold: 1000,
    pollInterval: 100,
  },
  usePolling: true,
  interval: 10000,
});

// 4. History
const historyWatcher = chokidar.watch(HISTORY_PATH, {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: {
    stabilityThreshold: 2000,
    pollInterval: 500,
  },
  usePolling: true,
  interval: 30000,  // Check less frequently
});

// Wire up all watchers
for (const [name, watcher] of Object.entries({
  sessions: sessionWatcher,
  plans: plansWatcher,
  tasks: tasksWatcher,
  history: historyWatcher,
})) {
  watcher
    .on('ready', () => {
      console.log(`[${new Date().toISOString()}] ${name} watcher ready`);
    })
    .on('add', (path) => {
      console.log(`[${new Date().toISOString()}] [${name}] New: ${path}`);
      scheduleIndexing(path);
    })
    .on('change', (path) => {
      console.log(`[${new Date().toISOString()}] [${name}] Modified: ${path}`);
      scheduleIndexing(path);
    })
    .on('error', (error) => {
      console.error(`[${new Date().toISOString()}] [${name}] Watcher error:`, error);
    });
}

console.log(`[${new Date().toISOString()}] Auto-indexer started`);
console.log(`  Watching sessions: ${CLAUDE_DIR}`);
console.log(`  Watching plans: ${PLANS_DIR}`);
console.log(`  Watching tasks: ${TASKS_DIR}`);
console.log(`  Watching history: ${HISTORY_PATH}`);
console.log(`  Debounce: ${DEBOUNCE_MS}ms`);
console.log(`  Ready for changes...`);

// Keep process alive - heartbeat every 60 seconds
setInterval(() => {
  console.log(`[${new Date().toISOString()}] Heartbeat - ${changedFiles.size} pending files, ${changedMemoryTypes.size} memory types`);
}, 60000);

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log(`[${new Date().toISOString()}] Received SIGTERM, shutting down...`);
  sessionWatcher.close();
  plansWatcher.close();
  tasksWatcher.close();
  historyWatcher.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log(`[${new Date().toISOString()}] Received SIGINT, shutting down...`);
  sessionWatcher.close();
  plansWatcher.close();
  tasksWatcher.close();
  historyWatcher.close();
  process.exit(0);
});
