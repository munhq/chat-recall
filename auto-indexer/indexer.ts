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
import { getDiaryDir } from '../src/core/paths.js';
import { SummaryGenerator } from '../src/core/summary-generator.js';
import { loadSettings, applySettingsToEnv } from '../src/core/settings.js';
import { parseSessionFile } from '../src/parsers/session.js';
import { MemoryIndex } from '../src/core/memory-index.js';
import { MemoryStore } from '../src/core/memory-store.js';
import { SourceRegistry } from '../src/core/source-registry.js';
import { SessionSource } from '../src/parsers/session-source.js';
import { PlanSource } from '../src/parsers/plan-source.js';
import { TaskSource } from '../src/parsers/task-source.js';
import { ClaudeMdSource } from '../src/parsers/claude-md-source.js';
import { HistorySource } from '../src/parsers/history-source.js';
import { DiarySource } from '../src/parsers/diary-source.js';
import { GeminiSessionSource } from '../src/parsers/gemini-source.js';
import { GeminiBrainSource } from '../src/parsers/gemini-brain-source.js';
import { OpenCodeSource } from '../src/parsers/opencode-source.js';
import { OpenCodeTodoSource } from '../src/parsers/opencode-todo-source.js';
import { CodexSessionSource } from '../src/parsers/codex-session-source.js';
import { SkillsSource } from '../src/parsers/skills-source.js';
import { McpsSource } from '../src/parsers/mcps-source.js';
import { SlashCommandsSource } from '../src/parsers/slash-commands-source.js';
import { SubagentsSource } from '../src/parsers/subagents-source.js';
import { HooksSource } from '../src/parsers/hooks-source.js';
import { PluginsSource } from '../src/parsers/plugins-source.js';
import { classifyChunk } from '../src/core/memory-classifier.js';
import { extractAndPopulateKG } from '../src/core/entity-extractor.js';
import { KnowledgeGraph } from '../src/core/knowledge-graph.js';
import { statSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, basename } from 'path';

const DEBOUNCE_MS = 5000;  // 5 seconds
const CLAUDE_DIR = join(homedir(), '.claude', 'projects');
const PLANS_DIR = join(homedir(), '.claude', 'plans');
const TASKS_DIR = join(homedir(), '.claude', 'tasks');
const HISTORY_PATH = join(homedir(), '.claude', 'history.jsonl');
const DIARY_DIR = getDiaryDir();

// Per-tool source paths. Each tool stores sessions differently:
//   - Codex:    JSONL rollouts under YYYY/MM/DD/
//   - Gemini:   JSON files (one per session) under tmp/<projectHash>/chats/
//   - OpenCode: SQLite database (sessions and parts as rows)
// Adding watchers for these closes the gap where new non-Claude
// sessions previously only landed via manual reindex.
const CODEX_SESSIONS_DIR = join(homedir(), '.codex', 'sessions');
const GEMINI_TMP_DIR = join(homedir(), '.gemini', 'tmp');
const OPENCODE_DB_PATH = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
// OpenCode SQLite uses WAL mode — incremental row writes hit cache.db-wal,
// not the main db file. Watching all three (db, db-wal, db-shm) catches
// every kind of write activity.
const OPENCODE_DB_DIR = join(homedir(), '.local', 'share', 'opencode');

// Apply user settings — this populates SUMMARY_PROVIDER / SUMMARY_CLI_CMD /
// OLLAMA_HOST etc. into process.env so the SummaryGenerator below picks
// up the user's choice instead of always using gemini-cli (which they
// may not have configured). Was the cause of the "0 summaries in DB"
// bug: the indexer hardcoded a provider that silently failed.
const settings = loadSettings();
applySettingsToEnv(settings);

const embedder = new OllamaEmbedder();
const metadataCache = new MetadataCache();
// SummaryGenerator with no explicit config now reads SUMMARY_PROVIDER
// from env (which we just populated from settings). The user's
// configured provider is used end-to-end.
const summaryGenerator = new SummaryGenerator();
console.log(`[${new Date().toISOString()}] Summary provider: ${settings.summary.provider}${settings.summary.cliCommand ? ` · cmd: "${settings.summary.cliCommand}"` : ''}`);
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
    const kg = new KnowledgeGraph();
    const source = new SessionSource();
    let processed = 0, chunks = 0;

    for await (const item of source.discover()) {
      try {
        if (!memoryIndex.needsUpdate(item.sourceType, item.id, item.mtime)) continue;
        await memoryIndex.deleteItem(item.sourceType, item.id);
        const itemChunks = await source.parse(item);
        for (const chunk of itemChunks) {
          const cls = classifyChunk(chunk.text);
          if (cls.memoryType !== 'general') {
            chunk.chunkType = `${chunk.chunkType}:${cls.memoryType}:imp${cls.importance}`;
          }
          extractAndPopulateKG(kg, chunk.text, {
            projectPath: item.projectPath, sourceType: item.sourceType, sessionId: item.id,
          });
        }
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
    kg.close();
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
    registry.register(new DiarySource());
    // Non-Claude session backends — added so live file watches actually
    // re-index Gemini / OpenCode / Codex sessions (previously they only
    // landed when the user clicked the Reindex button).
    registry.register(new GeminiSessionSource());
    registry.register(new GeminiBrainSource());
    registry.register(new OpenCodeSource());
    registry.register(new OpenCodeTodoSource());
    registry.register(new CodexSessionSource());
    // Toolkit primitives across all four AI tools.
    registry.register(new SkillsSource());
    registry.register(new McpsSource());
    registry.register(new SlashCommandsSource());
    registry.register(new SubagentsSource());
    registry.register(new HooksSource());
    registry.register(new PluginsSource());

    const kg = new KnowledgeGraph();

    for (const sourceType of types) {
      // BUG FIX: was `registry.get(sourceType)` which returns only the
      // FIRST registered source for that type. For `session`, three
      // sources are registered (Gemini, OpenCode, Codex) — only one ever
      // ran, the other two silently dropped. `getAll()` returns the
      // full list so each tool's sessions get discovered + indexed.
      const sources = registry.getAll(sourceType as any);
      if (sources.length === 0) continue;

      let itemCount = 0;
      let chunkCount = 0;

      for (const source of sources) {
        try {
          for await (const item of source.discover()) {
            try {
              if (!memoryIndex.needsUpdate(item.sourceType, item.id, item.mtime)) {
                continue;
              }

              await memoryIndex.deleteItem(item.sourceType, item.id);
              const chunks = await source.parse(item);

              // Classify and extract entities
              for (const chunk of chunks) {
                const cls = classifyChunk(chunk.text);
                if (cls.memoryType !== 'general') {
                  chunk.chunkType = `${chunk.chunkType}:${cls.memoryType}:imp${cls.importance}`;
                }
                extractAndPopulateKG(kg, chunk.text, {
                  projectPath: item.projectPath, sourceType: item.sourceType, sessionId: item.id,
                });
              }

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
          console.error(`[${new Date().toISOString()}] Error discovering ${sourceType} (${source.constructor.name}): ${err}`);
        }
      }

      // Flush buffered chunks after each source type
      await memoryIndex.flushBuffer();

      if (itemCount > 0) {
        console.log(`[${new Date().toISOString()}] ${sourceType}: ${itemCount} items, ${chunkCount} chunks`);
      }
    }

    kg.close();
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

  // Detect which memory type was changed. The non-Claude session
  // backends (Codex, Gemini, OpenCode) all surface as source_type
  // 'session' in the unified memory store; their watchers route here
  // and we tag the change as a session re-index.
  if (filePath.startsWith(PLANS_DIR)) {
    changedMemoryTypes.add('plan');
  } else if (filePath.startsWith(TASKS_DIR)) {
    changedMemoryTypes.add('task');
  } else if (filePath === HISTORY_PATH) {
    changedMemoryTypes.add('history');
  } else if (filePath.startsWith(DIARY_DIR)) {
    changedMemoryTypes.add('diary');
  } else if (filePath.startsWith(CODEX_SESSIONS_DIR) ||
             filePath.startsWith(GEMINI_TMP_DIR) ||
             filePath.startsWith(OPENCODE_DB_DIR)) {
    changedMemoryTypes.add('session');
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

// 5. Diary entries
const diaryWatcher = chokidar.watch(`${DIARY_DIR}/**/*.json`, {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: {
    stabilityThreshold: 1000,
    pollInterval: 100,
  },
});

// 6. Codex sessions — JSONL rollouts under YYYY/MM/DD/. Without this
// watcher, a Codex session you start *now* never gets indexed until a
// manual reindex; conversation list misses it, badge shows nothing,
// outcome 404s on click.
const codexWatcher = chokidar.watch(`${CODEX_SESSIONS_DIR}/**/rollout-*.jsonl`, {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: {
    // Codex rolls every event into its own JSONL line — wait for at
    // least 2s of write quiescence so we don't reindex mid-write.
    stabilityThreshold: 2000,
    pollInterval: 200,
  },
  usePolling: true,
  interval: 5000,
});

// 7. Gemini sessions — one JSON file per session in
// ~/.gemini/tmp/<hash>/chats/session-*.json. Gemini writes the whole
// file each time, so atomic-rename style; we just watch for changes.
const geminiWatcher = chokidar.watch(`${GEMINI_TMP_DIR}/**/session-*.json`, {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: {
    stabilityThreshold: 1500,
    pollInterval: 200,
  },
  usePolling: true,
  interval: 5000,
});

// 8. OpenCode SQLite — watch the db + WAL/SHM. SQLite in WAL mode
// writes new rows to the .db-wal file; the main .db gets touched on
// checkpoint. Watching all three catches every kind of activity. We
// debounce because a single transaction can touch all three files.
const opencodeWatcher = chokidar.watch(
  [`${OPENCODE_DB_PATH}`, `${OPENCODE_DB_PATH}-wal`, `${OPENCODE_DB_PATH}-shm`],
  {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 2500,
      pollInterval: 500,
    },
    usePolling: true,
    interval: 10000,
  },
);

/**
 * Map a watched file path to its canonical session id (the same id
 * used in `memory_metadata.id`). Returns null when the mapping isn't
 * derivable from the path alone:
 *   - Gemini: filename = `session-<id>.json` BUT the indexed id is the
 *     `sessionId` field from inside the JSON, which often differs from
 *     the filename — too expensive to JSON-parse here, fall back to a
 *     full sweep instead of a per-session compute.
 *   - OpenCode: SQLite db file changes can't be attributed to a single
 *     session id; let the periodic sweep handle it.
 */
function sessionIdFromWatcherPath(name: string, path: string): string | null {
  if (name === 'sessions') {
    // Claude: ~/.claude/projects/<hash>/<sessionId>.jsonl
    const m = path.match(/\/([a-f0-9-]{36})\.jsonl$/i);
    return m ? m[1] : null;
  }
  if (name === 'codex') {
    // Codex: rollout-<timestamp>-<uuid>.jsonl. The indexer prefixes
    // 'codex_' to the UUID portion when storing in memory_metadata.
    const m = path.match(/rollout-[^/]*?([a-f0-9-]{36})\.jsonl$/i);
    return m ? `codex_${m[1]}` : null;
  }
  return null; // gemini / opencode → caller falls back to sweep
}

// Wire up all watchers
for (const [name, watcher] of Object.entries({
  sessions: sessionWatcher,
  plans: plansWatcher,
  tasks: tasksWatcher,
  history: historyWatcher,
  diary: diaryWatcher,
  codex: codexWatcher,
  gemini: geminiWatcher,
  opencode: opencodeWatcher,
})) {
  watcher
    .on('ready', () => {
      console.log(`[${new Date().toISOString()}] ${name} watcher ready`);
    })
    .on('add', (path) => {
      console.log(`[${new Date().toISOString()}] [${name}] New: ${path}`);
      scheduleIndexing(path);
      // For session-bearing watchers, kick off an IMMEDIATE per-session
      // compute too — don't wait for the next 30s sweep. The trigger is
      // debounced per-session (1.5s) so a flurry of events for the same
      // file collapses into one compute against the final state.
      if (name === 'sessions' || name === 'codex' || name === 'gemini' || name === 'opencode') {
        const sid = sessionIdFromWatcherPath(name, path);
        if (sid) triggerImmediateCompute(sid);
        // For Gemini/OpenCode where we can't derive sid: scheduleIndexing
        // already added 'session' to changedMemoryTypes — runMemoryIndexing
        // will index the new row, then the next precompute sweep picks it up.
      }
    })
    .on('change', (path) => {
      console.log(`[${new Date().toISOString()}] [${name}] Modified: ${path}`);
      scheduleIndexing(path);
      if (name === 'sessions' || name === 'codex' || name === 'gemini' || name === 'opencode') {
        const sid = sessionIdFromWatcherPath(name, path);
        if (sid) triggerImmediateCompute(sid);
      }
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
console.log(`  Watching diary: ${DIARY_DIR}`);
console.log(`  Debounce: ${DEBOUNCE_MS}ms`);
console.log(`  Ready for changes...`);

// Keep process alive - heartbeat every 60 seconds
setInterval(() => {
  console.log(`[${new Date().toISOString()}] Heartbeat - ${changedFiles.size} pending files, ${changedMemoryTypes.size} memory types`);
}, 60000);

/**
 * Background summary worker.
 *
 * Why this exists: chokidar only fires for files that *change*. The 575
 * pre-existing sessions on disk never trigger a watch event, so they
 * never got a summary. This loop scans for sessions that are missing
 * summaries (or whose previous attempt failed long enough ago to retry)
 * and generates one for the oldest unprocessed batch each minute.
 *
 * Scheduling:
 *   - Sweeps every 60s
 *   - Processes BATCH_SIZE per sweep so a 575-session backlog clears in
 *     ~10 minutes without flooding the LLM provider
 *   - Backs off after MAX_ATTEMPTS failures per session, retries after
 *     RETRY_AFTER_MS (24h) — so a transient API outage gets retried, but
 *     a permanent config bug doesn't burn quota forever
 *   - Logs successes and failures so the user can grep the journal to
 *     diagnose why summaries aren't appearing
 */
// Aggressive defaults so the backlog clears in minutes, not hours. With
// 915 sessions at 8s/session via gemini-cli, a sustained 4-in-flight rate
// finishes in ~30 minutes instead of the 3 hours we had at 5/min serial.
// Configurable via env so users with rate-limited APIs can dial it down.
const SUMMARY_WORKER_INTERVAL_MS = Number(process.env.SUMMARY_WORKER_INTERVAL_MS) || 10_000;
const SUMMARY_WORKER_BATCH = Number(process.env.SUMMARY_WORKER_BATCH) || 20;
const SUMMARY_WORKER_PARALLEL = Number(process.env.SUMMARY_WORKER_PARALLEL) || 4;
const SUMMARY_MAX_ATTEMPTS = 3;
const SUMMARY_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

let summaryWorkerRunning = false;

async function summaryWorkerSweep(): Promise<void> {
  if (summaryWorkerRunning) return; // serialize sweeps
  summaryWorkerRunning = true;

  try {
    const { getAllSessions } = await import('../src/parsers/session.js');
    const candidates: { sessionId: string; filePath: string; mtime: number }[] = [];
    const now = Date.now();

    for (const [entry, filePath] of getAllSessions()) {
      const cached = metadataCache.get(entry.sessionId);
      if (cached && cached.summary && cached.summary.length > 0) continue;

      const err = metadataCache.getSummaryError(entry.sessionId);
      if (err) {
        if (err.attemptCount >= SUMMARY_MAX_ATTEMPTS && (now - err.lastFailedAt) < SUMMARY_RETRY_AFTER_MS) {
          continue; // backed off
        }
      }
      candidates.push({ sessionId: entry.sessionId, filePath, mtime: entry.fileMtime || 0 });
      if (candidates.length >= SUMMARY_WORKER_BATCH * 4) break; // cap candidate scan cost
    }

    if (candidates.length === 0) return;

    // Newest first — user is more likely to want recent sessions summarized.
    candidates.sort((a, b) => b.mtime - a.mtime);
    const batch = candidates.slice(0, SUMMARY_WORKER_BATCH);

    console.log(`[${new Date().toISOString()}] Summary worker: processing ${batch.length} session(s) (of ${candidates.length}+ candidates) · ${SUMMARY_WORKER_PARALLEL} in parallel`);

    // Process in parallel chunks. Each chunk awaits Promise.all so a slow
    // session doesn't block independent ones. The chunk size matches the
    // configured parallelism — smaller systems can lower it via env.
    async function processOne({ sessionId, filePath, mtime }: { sessionId: string; filePath: string; mtime: number }): Promise<void> {
      try {
        const content = await parseSessionFile(filePath);
        let summary: string;
        let summarySource: 'original' | 'gemini' | 'claude' | 'ollama';
        if (content.summaries.length > 0) {
          summary = content.summaries[0];
          summarySource = 'original';
        } else {
          summary = await summaryGenerator.generate(content);
          const provider = (summaryGenerator as any).config?.provider;
          summarySource = provider === 'gemini-cli' ? 'gemini' : (provider as any) || 'gemini';
        }
        metadataCache.set({
          sessionId,
          firstPrompt: content.firstPrompt,
          summary,
          summarySource,
          mtime,
          indexedAt: Date.now(),
        });
        metadataCache.clearSummaryError(sessionId);
        console.log(`[${new Date().toISOString()}]   ✓ ${sessionId.slice(0, 8)} (${summarySource}): "${summary.slice(0, 60).replace(/\n/g, ' ')}…"`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        metadataCache.recordSummaryError(sessionId, msg);
        console.error(`[${new Date().toISOString()}]   ✗ ${sessionId.slice(0, 8)}: ${msg.slice(0, 200)}`);
      }
    }

    for (let i = 0; i < batch.length; i += SUMMARY_WORKER_PARALLEL) {
      const slice = batch.slice(i, i + SUMMARY_WORKER_PARALLEL);
      await Promise.all(slice.map(processOne));
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Summary worker sweep failed:`, err);
  } finally {
    summaryWorkerRunning = false;
  }
}

// Kick off first sweep after a short delay so it doesn't race the watcher
// startup, then on a steady cadence.
setTimeout(() => { void summaryWorkerSweep(); }, 5_000);
setInterval(() => { void summaryWorkerSweep(); }, SUMMARY_WORKER_INTERVAL_MS);
console.log(`  Summary worker: every ${SUMMARY_WORKER_INTERVAL_MS / 1000}s, batch ${SUMMARY_WORKER_BATCH}, parallel ${SUMMARY_WORKER_PARALLEL}, max ${SUMMARY_MAX_ATTEMPTS} attempts`);

/**
 * Heavyweight pre-compute worker.
 *
 * Walks the session list and pre-computes the four expensive
 * per-session classifiers — outcome, diff, commits, markers — into the
 * compute_cache table BEFORE the user opens those tabs. Eliminates the
 * "first open after restart pays the parse cost" lag because by the
 * time the user clicks anything, the result is already in SQLite.
 *
 * Cheaper than the summary worker because it doesn't shell out to an
 * LLM — pure local CPU work. Higher batch size + faster cadence
 * accordingly. Skips sessions whose mtime is within the last 60s
 * (still being actively written) so we don't compute against a moving
 * target and waste work.
 */
const PRECOMPUTE_INTERVAL_MS = Number(process.env.PRECOMPUTE_INTERVAL_MS) || 30_000;
const PRECOMPUTE_BATCH = Number(process.env.PRECOMPUTE_BATCH) || 30;
const PRECOMPUTE_PARALLEL = Number(process.env.PRECOMPUTE_PARALLEL) || 3;
// Skip sessions modified within this many ms — the file may still be in
// the middle of a write. Was 60s; reduced to 5s now that:
//   1. chokidar's awaitWriteFinish (1-2.5s stabilityThreshold) already
//      ensures we only see fully-written file states
//   2. file-change events fire `triggerImmediateCompute` directly with
//      its own 1.5s debounce
// 5s is enough headroom that we never compute a half-written file but
// short enough that the user clicking outcome on a session they were
// just typing in 6s ago sees fresh data, not 90s-stale.
const PRECOMPUTE_FRESH_SKIP_MS = 5_000;

let precomputeWorkerRunning = false;
type PrecomputeKind = 'outcome' | 'diff' | 'commits' | 'markers' | 'turns';
const PRECOMPUTE_KINDS: PrecomputeKind[] = ['outcome', 'diff', 'commits', 'markers', 'turns'];

/**
 * Compute + persist all missing classifier kinds for a single session.
 * Shared between the periodic precompute sweep and the
 * file-change-triggered immediate-compute path. Tool-aware: dispatches
 * via the *Any* multi-tool wrappers so Claude/Codex/Gemini/OpenCode all
 * work uniformly.
 *
 * `missing` is the list of kinds that need (re)computing — passing all
 * 4 kinds is the common case after a file change.
 */
/**
 * Markers are append-only: each user prompt is classified independently
 * and the summary is a count of marker types. So when a file grows, we
 * can read the cached row, classify ONLY the new user prompts, append,
 * and recompute the summary — no need to re-walk the entire transcript.
 *
 * Returns true when the incremental path succeeded; the caller should
 * fall back to full regen on false (cache miss, shape mismatch, etc.).
 */
async function tryIncrementalMarkers(sessionId: string, mtime: number): Promise<boolean> {
  const { extractTurnsAny } = await import('../src/core/session-multi-tool.js');
  const { markPrompt, summarizeMarkers } = await import('../src/core/session-sentiment.js');

  const cached = metadataCache.getComputeStale<{ sessionId: string; prompts: any[]; summary: any }>(sessionId, 'markers');
  if (!cached) return false;
  const lastLine = cached.data.prompts.length > 0
    ? Math.max(...cached.data.prompts.map((p: any) => Number(p.line) || 0))
    : 0;

  // Pull all current prompts and keep only those past the last cached line.
  const turns = extractTurnsAny(sessionId, { maxTurns: 50_000 });
  if (!turns.found) return false;
  const newPromptTurns = turns.turns.filter(t => t.kind === 'user' && t.text && (Number(t.line) || 0) > lastLine);
  if (newPromptTurns.length === 0) {
    // Nothing new — just update the mtime stamp on the existing row.
    metadataCache.setCompute(sessionId, 'markers', mtime, cached.data);
    return true;
  }
  const newPrompts = newPromptTurns.map(t => ({ line: t.line, ts: t.ts, tsIso: t.tsIso, ...markPrompt(t.text!) }));
  const merged = [...cached.data.prompts, ...newPrompts];
  metadataCache.setCompute(sessionId, 'markers', mtime, {
    sessionId, prompts: merged, summary: summarizeMarkers(merged),
  });
  return true;
}

/**
 * Turns are also append-only — parse from the last cached line forward
 * and append. We over-approximate by re-extracting all turns and
 * filtering by line; a true byte-offset incremental parse would be
 * faster but the safety win isn't worth the complexity for a worker
 * that runs in the background.
 */
async function tryIncrementalTurns(sessionId: string, mtime: number): Promise<boolean> {
  const { extractTurnsAny } = await import('../src/core/session-multi-tool.js');
  const cached = metadataCache.getComputeStale<{ found: boolean; turns: any[]; startMs: number; endMs: number; sessionId: string }>(sessionId, 'turns');
  if (!cached || !cached.data.found) return false;
  const lastLine = cached.data.turns.length > 0
    ? Math.max(...cached.data.turns.map((t: any) => Number(t.line) || 0))
    : 0;
  const fresh = extractTurnsAny(sessionId, { maxTurns: 50_000 });
  if (!fresh.found) return false;
  const newOnes = fresh.turns.filter(t => (Number(t.line) || 0) > lastLine);
  const merged = newOnes.length === 0 ? cached.data.turns : [...cached.data.turns, ...newOnes];
  metadataCache.setCompute(sessionId, 'turns', mtime, {
    ...cached.data,
    turns: merged,
    startMs: cached.data.startMs || fresh.startMs,
    endMs: fresh.endMs,
  });
  return true;
}

async function computeAndPersistSession(
  sessionId: string,
  mtime: number,
  missing: PrecomputeKind[],
): Promise<void> {
  const { computeOutcomeAny, replaySessionAny, getSessionCommitsAny, extractTurnsAny } =
    await import('../src/core/session-multi-tool.js');
  const { markPrompt, summarizeMarkers } = await import('../src/core/session-sentiment.js');

  let replay: Awaited<ReturnType<typeof replaySessionAny>> | undefined;
  try {
    if (missing.includes('outcome')) {
      const outcome = computeOutcomeAny(sessionId);
      if (outcome.found) metadataCache.setCompute(sessionId, 'outcome', mtime, outcome);
    }
    if (missing.includes('diff')) {
      if (!replay) replay = replaySessionAny(sessionId);
      if (replay.found) metadataCache.setCompute(sessionId, 'diff', mtime, replay);
    }
    if (missing.includes('commits')) {
      if (sessionId.startsWith('codex_') || sessionId.startsWith('gemini_') || sessionId.startsWith('opencode_')) {
        const commits = getSessionCommitsAny(sessionId);
        metadataCache.setCompute(sessionId, 'commits', mtime, commits);
      } else {
        if (!replay) replay = replaySessionAny(sessionId);
        if (replay.found) {
          const commits = getSessionCommitsAny(sessionId);
          metadataCache.setCompute(sessionId, 'commits', mtime, commits);
        }
      }
    }
    if (missing.includes('markers')) {
      // Try append-only incremental first; on miss/shape-mismatch full regen.
      const ok = await tryIncrementalMarkers(sessionId, mtime);
      if (!ok) {
        const turns = extractTurnsAny(sessionId, { maxTurns: 50_000 });
        if (turns.found) {
          const prompts = turns.turns
            .filter(t => t.kind === 'user' && t.text)
            .map(t => ({ line: t.line, ts: t.ts, tsIso: t.tsIso, ...markPrompt(t.text!) }));
          metadataCache.setCompute(sessionId, 'markers', mtime, {
            sessionId, prompts, summary: summarizeMarkers(prompts),
          });
        }
      }
    }
    if (missing.includes('turns')) {
      const ok = await tryIncrementalTurns(sessionId, mtime);
      if (!ok) {
        const turns = extractTurnsAny(sessionId, { maxTurns: 50_000 });
        if (turns.found) metadataCache.setCompute(sessionId, 'turns', mtime, turns);
      }
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}]   compute ✗ ${sessionId.slice(0, 8)}: ${(err as Error).message?.slice(0, 200)}`);
  }
}

/**
 * Per-session in-flight tracker so a flurry of file-change events for
 * the same session collapses into ONE compute (not N). Combined with
 * chokidar's awaitWriteFinish, this means a single user "save" or
 * append → exactly one compute invocation, regardless of how many fs
 * events fire underneath.
 */
const IMMEDIATE_COMPUTE_PENDING = new Set<string>();
const IMMEDIATE_COMPUTE_DEBOUNCE_MS = 1500;
const immediateComputeTimers = new Map<string, NodeJS.Timeout>();

/**
 * Trigger an immediate compute for one session. Debounced per-session:
 * rapid successive calls (file written in chunks, multiple events
 * within 1.5s) collapse into a single compute against the FINAL mtime.
 * Runs in setImmediate after the debounce so we never block the caller.
 */
function triggerImmediateCompute(sessionId: string): void {
  // Clear and reset the per-session debounce timer.
  const existing = immediateComputeTimers.get(sessionId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    immediateComputeTimers.delete(sessionId);
    if (IMMEDIATE_COMPUTE_PENDING.has(sessionId)) return; // already running
    IMMEDIATE_COMPUTE_PENDING.add(sessionId);
    setImmediate(() => {
      void (async () => {
        try {
          // Look up current mtime from memory_metadata (faster than
          // resolving the file path via tool-specific logic).
          const memStore = new MemoryStore();
          let mtime = 0;
          try {
            const row = memStore.db
              .prepare('SELECT mtime FROM memory_metadata WHERE source_type = \'session\' AND id = ?')
              .get(sessionId) as { mtime: number } | undefined;
            mtime = row?.mtime || 0;
          } finally { memStore.close(); }
          if (!mtime) return; // session not yet in memory_metadata — wait for next memory-indexing pass

          const t0 = Date.now();
          await computeAndPersistSession(sessionId, mtime, ['outcome', 'diff', 'commits', 'markers', 'turns']);
          console.log(`[${new Date().toISOString()}]   ⚡ immediate compute ${sessionId.slice(0, 8)} in ${Date.now() - t0}ms`);
        } finally {
          IMMEDIATE_COMPUTE_PENDING.delete(sessionId);
        }
      })();
    });
  }, IMMEDIATE_COMPUTE_DEBOUNCE_MS);
  immediateComputeTimers.set(sessionId, timer);
}

async function precomputeWorkerSweep(): Promise<void> {
  if (precomputeWorkerRunning) return;
  precomputeWorkerRunning = true;

  try {
    // Use the multi-tool variants for ALL paths so Codex/Gemini/OpenCode
    // sessions get precomputed too — not just Claude. Previous version
    // walked `getAllSessions()` (Claude-only) which left ~340 non-Claude
    // sessions with no cached rows; the user paid the parse cost on
    // every first-click.
    const { computeOutcomeAny, replaySessionAny, getSessionCommitsAny, extractTurnsAny } =
      await import('../src/core/session-multi-tool.js');
    const { markPrompt, summarizeMarkers } = await import('../src/core/session-sentiment.js');

    const now = Date.now();

    // Iterate ALL sessions across all 4 tools by querying memory_metadata
    // directly. Order by mtime DESC so the user's most recent sessions
    // (the ones they're likely to click) get cached first.
    type Cand = { sessionId: string; mtime: number; missing: PrecomputeKind[] };
    const candidates: Cand[] = [];
    {
      const memStore = new MemoryStore();
      try {
        const rows = memStore.db
          .prepare(`SELECT id, mtime FROM memory_metadata WHERE source_type='session' ORDER BY mtime DESC`)
          .all() as Array<{ id: string; mtime: number }>;
        for (const r of rows) {
          const mtime = r.mtime || 0;
          if (now - mtime < PRECOMPUTE_FRESH_SKIP_MS) continue;
          const missing: PrecomputeKind[] = [];
          for (const kind of PRECOMPUTE_KINDS) {
            const cached = metadataCache.getCompute(r.id, kind, mtime);
            if (!cached) missing.push(kind);
          }
          if (missing.length > 0) {
            candidates.push({ sessionId: r.id, mtime, missing });
          }
          if (candidates.length >= PRECOMPUTE_BATCH * 4) break;
        }
      } finally {
        memStore.close();
      }
    }
    if (candidates.length === 0) return;

    candidates.sort((a, b) => b.mtime - a.mtime); // newest first
    const batch = candidates.slice(0, PRECOMPUTE_BATCH);
    console.log(`[${new Date().toISOString()}] Precompute worker: ${batch.length} session(s) (of ${candidates.length}+ candidates)`);

    // Delegate to the shared compute helper (also used by the
    // file-change-triggered immediate-compute path).
    for (let i = 0; i < batch.length; i += PRECOMPUTE_PARALLEL) {
      const slice = batch.slice(i, i + PRECOMPUTE_PARALLEL);
      await Promise.all(slice.map(c => computeAndPersistSession(c.sessionId, c.mtime, c.missing)));
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Precompute sweep failed:`, err);
  } finally {
    precomputeWorkerRunning = false;
  }
}

setTimeout(() => { void precomputeWorkerSweep(); }, 8_000);
setInterval(() => { void precomputeWorkerSweep(); }, PRECOMPUTE_INTERVAL_MS);
console.log(`  Precompute worker: every ${PRECOMPUTE_INTERVAL_MS / 1000}s, batch ${PRECOMPUTE_BATCH}, parallel ${PRECOMPUTE_PARALLEL} (kinds: ${PRECOMPUTE_KINDS.join(', ')})`);

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log(`[${new Date().toISOString()}] Received SIGTERM, shutting down...`);
  sessionWatcher.close();
  plansWatcher.close();
  tasksWatcher.close();
  historyWatcher.close();
  diaryWatcher.close();
  codexWatcher.close();
  geminiWatcher.close();
  opencodeWatcher.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log(`[${new Date().toISOString()}] Received SIGINT, shutting down...`);
  sessionWatcher.close();
  plansWatcher.close();
  tasksWatcher.close();
  historyWatcher.close();
  diaryWatcher.close();
  codexWatcher.close();
  geminiWatcher.close();
  opencodeWatcher.close();
  process.exit(0);
});
