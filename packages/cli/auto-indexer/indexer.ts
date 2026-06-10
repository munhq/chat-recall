#!/usr/bin/env node
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
import { OllamaEmbedder } from '@chat-recall/engine/core/embedder.js';
import { createMetadataCache, type MetadataCacheDriver } from '@chat-recall/engine/core/store/caches.js';
import { getDiaryDir, getIndexDir } from '@chat-recall/engine/core/paths.js';
import { SummaryGenerator, reapShellChildren } from '@chat-recall/engine/core/summary-generator.js';
import { loadSettings, applySettingsToEnv } from '@chat-recall/engine/core/settings.js';
import { parseSessionFile, getAllSessions } from '@chat-recall/engine/parsers/session.js';
import { createVectorStore } from '@chat-recall/engine/core/store/vector.js';
import { createStore } from '@chat-recall/engine/core/store/index.js';
import { SourceRegistry } from '@chat-recall/engine/core/source-registry.js';
import { SessionSource } from '@chat-recall/engine/parsers/session-source.js';
import { PlanSource } from '@chat-recall/engine/parsers/plan-source.js';
import { TaskSource } from '@chat-recall/engine/parsers/task-source.js';
import { ClaudeMdSource } from '@chat-recall/engine/parsers/claude-md-source.js';
import { HistorySource } from '@chat-recall/engine/parsers/history-source.js';
import { DiarySource } from '@chat-recall/engine/parsers/diary-source.js';
import { GeminiSessionSource } from '@chat-recall/engine/parsers/gemini-source.js';
import { GeminiBrainSource } from '@chat-recall/engine/parsers/gemini-brain-source.js';
import { OpenCodeSource } from '@chat-recall/engine/parsers/opencode-source.js';
import { OpenCodeTodoSource } from '@chat-recall/engine/parsers/opencode-todo-source.js';
import { CodexSessionSource } from '@chat-recall/engine/parsers/codex-session-source.js';
import { SkillsSource } from '@chat-recall/engine/parsers/skills-source.js';
import { McpsSource } from '@chat-recall/engine/parsers/mcps-source.js';
import { SlashCommandsSource } from '@chat-recall/engine/parsers/slash-commands-source.js';
import { SubagentsSource } from '@chat-recall/engine/parsers/subagents-source.js';
import { HooksSource } from '@chat-recall/engine/parsers/hooks-source.js';
import { PluginsSource } from '@chat-recall/engine/parsers/plugins-source.js';
import { classifyChunk } from '@chat-recall/engine/core/memory-classifier.js';
import { extractAndPopulateKG } from '@chat-recall/engine/core/entity-extractor.js';
import { createKnowledgeGraph } from '@chat-recall/engine/core/store/knowledge-graph.js';
import { statSync, existsSync, readFileSync } from 'fs';
import { dirname, join, basename } from 'path';

import { claudeBackend, geminiBackend, opencodeBackend, codexBackend } from '@chat-recall/engine/core/backends/index.js';
import { isQuotaError, parseQuotaRetryMs } from '@chat-recall/engine/core/quota-detect.js';

const DEBOUNCE_MS = 5000;  // 5 seconds

// ── Auto-compaction policy ──────────────────────────────────────────
// LanceDB is MVCC — every write produces a new manifest + transaction
// record that lives forever unless cleanup_old_versions is called. With
// the daemon writing on every chat, the index can balloon to 10× the
// real data size within a week. We compact in the daemon's idle window
// (after each batch finishes, when the next batch hasn't arrived yet)
// to keep the index size proportional to actual content.
//
// Threshold tuned for the "typical user" load: ~5k chunks/week, so
// triggering at 1500 means roughly twice a week per active user.
// Lower values trade extra compaction CPU for tighter disk; higher
// values let the index grow.
const COMPACT_AFTER_CHUNKS = Number(process.env.CHAT_RECALL_COMPACT_AFTER ?? 1500);
let chunksSinceCompact = 0;
// All paths come from the backend registry — env-overridable via
// CHAT_RECALL_*_HOME. Adding a fifth tool means: register the backend
// in `backends/index.ts` and add its watcher pair below; everything
// else flows through the SourceRegistry.
const CLAUDE_DIR = claudeBackend.projectsDir();
const PLANS_DIR = claudeBackend.plansDir();
const TASKS_DIR = claudeBackend.tasksDir();
const HISTORY_PATH = claudeBackend.historyFile();
const DIARY_DIR = getDiaryDir();

// Per-tool source paths.
const CODEX_SESSIONS_DIR = codexBackend.sessionsDir();
const GEMINI_TMP_DIR = geminiBackend.tmpDir();
const OPENCODE_DB_PATH = opencodeBackend.dbPath();
// OpenCode SQLite uses WAL mode — incremental row writes hit cache.db-wal,
// not the main db file. Watching all three (db, db-wal, db-shm) catches
// every kind of write activity.
const OPENCODE_DB_DIR = dirname(OPENCODE_DB_PATH);

// Apply user settings — this populates SUMMARY_PROVIDER / SUMMARY_CLI_CMD /
// OLLAMA_HOST etc. into process.env so the SummaryGenerator below picks
// up the user's choice instead of always using gemini-cli (which they
// may not have configured). Was the cause of the "0 summaries in DB"
// bug: the indexer hardcoded a provider that silently failed.
const settings = loadSettings();
applySettingsToEnv(settings);

const embedder = new OllamaEmbedder();
// Storage-flag-aware metadata cache (sqlite local | postgres team/cloud).
// Lazy + memoized: the driver is async to construct, so callers await this.
let _metadataCache: MetadataCacheDriver | null = null;
async function getMetadataCache(): Promise<MetadataCacheDriver> {
  if (!_metadataCache) _metadataCache = await createMetadataCache();
  return _metadataCache;
}
// SummaryGenerator with no explicit config now reads SUMMARY_PROVIDER
// from env (which we just populated from settings). The user's
// configured provider is used end-to-end.
const summaryGenerator = new SummaryGenerator();
console.log(`[${new Date().toISOString()}] Summary provider: ${settings.summary.provider}${settings.summary.cliCommand ? ` · cmd: "${settings.summary.cliCommand}"` : ''}`);
let debounceTimer: NodeJS.Timeout | null = null;
const changedFiles = new Set<string>();
const changedMemoryTypes = new Set<string>();

/**
 * Circuit breaker + Ollama fallback for summary generation.
 *
 * Why this exists: prior to this, the auto-indexer awaited
 * `summaryGenerator.generate()` synchronously inside the main session
 * loop. A single quota-exhausted Gemini call (HTTP 429 with a 16-hour
 * retry-after) blocked the entire indexer, and no new sessions reached
 * the index. The fix has three parts:
 *
 *   1. **Indexing runs BEFORE summary generation.** Chunks land in
 *      memory_metadata + FTS5 + LanceDB regardless of whether the AI
 *      summarizer is healthy.
 *   2. **Per-call timeout + retry budget.** Each generate() is wrapped
 *      with Promise.race vs a 30s timeout. Failures get recorded via
 *      `metadataCache.recordSummaryError` and the worker moves on.
 *   3. **Quota circuit breaker.** When we detect quota/rate-limit
 *      signals (429, "QUOTA_EXHAUSTED", "exhausted", "rate"), we
 *      open the circuit for `QUOTA_COOLDOWN_MS` (60 minutes by default).
 *      Subsequent calls skip the primary provider until the cooldown
 *      expires. If Ollama is reachable, we transparently fall back to
 *      it so the indexer stays useful during long quota windows.
 */
const QUOTA_COOLDOWN_MS = 60 * 60 * 1000;
const SUMMARY_TIMEOUT_MS = 30_000;
/**
 * Trip the circuit after this many consecutive *any-kind* failures.
 * Catches the cases the quota-string match missed:
 *   - bare `summary timeout` (the 30s wrapper)
 *   - `/bin/bash: fork: retry: Resource temporarily unavailable`
 *   - `pthread_create: Resource temporarily unavailable`
 * Without this, a failing primary keeps spawning gemini/bash children
 * every 10s. After ~14h on a stale-quota box you exhaust the system's
 * thread/fork budget — exactly the fork-bomb we just hit.
 */
const SUMMARY_CONSECUTIVE_FAIL_THRESHOLD = 8;
let quotaCircuitOpenUntil = 0;
let consecutiveSummaryFailures = 0;
let fallbackGenerator: SummaryGenerator | null = null;

function getOllamaFallback(): SummaryGenerator | null {
  // Only build the fallback once. We use the explicit ollama provider so
  // it never re-enters the same broken provider path.
  if (fallbackGenerator !== null) return fallbackGenerator;
  if (settings.summary.provider === 'ollama') {
    // Primary already IS ollama — no separate fallback needed.
    return null;
  }
  try {
    fallbackGenerator = new SummaryGenerator({ provider: 'ollama' });
    return fallbackGenerator;
  } catch {
    return null;
  }
}

async function generateSummaryWithBudget(
  content: Awaited<ReturnType<typeof parseSessionFile>>,
): Promise<{ summary: string; source: 'gemini' | 'claude' | 'ollama' | 'cli' | 'fallback-ollama' }> {
  const timeout = (p: Promise<string>) => Promise.race<string>([
    p,
    new Promise<string>((_, rej) => setTimeout(() => rej(new Error('summary timeout')), SUMMARY_TIMEOUT_MS)),
  ]);

  const primaryProvider = summaryGenerator['config'].provider as 'cli' | 'gemini-cli' | 'claude' | 'ollama';
  const useFallback = Date.now() < quotaCircuitOpenUntil;

  if (!useFallback) {
    try {
      const out = await timeout(summaryGenerator.generate(content));
      consecutiveSummaryFailures = 0;
      return {
        summary: out,
        source: primaryProvider === 'gemini-cli' ? 'gemini' : primaryProvider,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      consecutiveSummaryFailures++;
      const quotaHit = isQuotaError(msg);
      const explicitRetryMs = parseQuotaRetryMs(msg);
      // Open the circuit when:
      //  (a) we see an explicit quota signal in the error string, OR
      //  (b) we've burned through `SUMMARY_CONSECUTIVE_FAIL_THRESHOLD`
      //      attempts in a row regardless of error kind. (b) catches
      //      timeouts and fork-failures that don't carry a recognisable
      //      quota string — those used to spam forever and exhaust the
      //      system process table.
      if (quotaHit || consecutiveSummaryFailures >= SUMMARY_CONSECUTIVE_FAIL_THRESHOLD) {
        const cooldown = explicitRetryMs ?? QUOTA_COOLDOWN_MS;
        quotaCircuitOpenUntil = Date.now() + cooldown;
        const reason = quotaHit ? 'quota' : `${consecutiveSummaryFailures} consecutive failures`;
        console.error(`[${new Date().toISOString()}] Summary provider circuit OPEN (${reason}) for ${Math.round(cooldown / 60_000)} min. Check settings → summary provider config.`);
      } else {
        // Re-throw non-quota errors so the caller logs them per-session.
        throw err;
      }
    }
  }

  // Quota cooldown active or primary just tripped. Try Ollama fallback.
  const fb = getOllamaFallback();
  if (!fb) {
    throw new Error('Summary provider in quota cooldown and no Ollama fallback configured');
  }
  const out = await timeout(fb.generate(content));
  return { summary: out, source: 'fallback-ollama' };
}

async function runSessionIndexing() {
  const files = Array.from(changedFiles).filter(f => f.endsWith('.jsonl') && f.includes('/projects/'));
  changedFiles.clear();

  if (files.length === 0) return;

  console.log(`[${new Date().toISOString()}] Processing ${files.length} session file(s)...`);

  // Phase 1: Index chunks for every new/updated session. This MUST run
  // independent of summary generation — otherwise a stuck AI provider
  // blocks the index and the user loses recall on every session
  // launched during the quota window.
  try {
    const memoryIndex = await createVectorStore(embedder);
    const store = await createStore();
    const kg = await createKnowledgeGraph();
    const source = new SessionSource();
    let processed = 0, chunks = 0;

    for await (const item of source.discover()) {
      try {
        if (!(await memoryIndex.needsUpdate(item.sourceType, item.id, item.mtime))) continue;
        await memoryIndex.deleteItem(item.sourceType, item.id);
        const itemChunks = await source.parse(item);
        for (const chunk of itemChunks) {
          const cls = classifyChunk(chunk.text);
          if (cls.memoryType !== 'general') {
            chunk.chunkType = `${chunk.chunkType}:${cls.memoryType}:imp${cls.importance}`;
          }
          await extractAndPopulateKG(kg, chunk.text, {
            projectPath: item.projectPath, sourceType: item.sourceType, sessionId: item.id,
          });
        }
        if (itemChunks.length > 0) {
          await memoryIndex.bufferChunks(itemChunks);
          chunks += itemChunks.length;
          chunksSinceCompact += itemChunks.length;
        }
        await store.setItem(item);
        processed++;
      } catch (err) {
        console.error(`[${new Date().toISOString()}] Error indexing session ${item.id}: ${err}`);
      }
    }

    await memoryIndex.flushBuffer();
    await kg.close();
    // optimize() removed from auto flows
    await store.close();

    if (processed > 0) {
      console.log(`[${new Date().toISOString()}] Session indexing: ${processed} processed, ${chunks} chunks`);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Session indexing failed:`, error);
  }

  // Phase 2: Best-effort summary generation for the files that landed
  // in this batch. Runs after indexing so a stalled provider can't
  // block the chunk pipeline. Per-file failures are recorded so the
  // UI can show "summary unavailable — check settings" instead of
  // silently falling back to first-prompt with no explanation.
  for (const filePath of files) {
    if (!existsSync(filePath)) continue;
    try {
      const sessionId = basename(filePath, '.jsonl');
      const stat = statSync(filePath);
      if (!(await (await getMetadataCache()).needsUpdate(sessionId, stat.mtimeMs))) continue;

      const content = await parseSessionFile(filePath);

      // Original summary embedded in transcript — no provider call needed.
      if (content.summaries.length > 0) {
        await (await getMetadataCache()).set({
          sessionId,
          firstPrompt: content.firstPrompt,
          summary: content.summaries[0],
          summarySource: 'original',
          mtime: stat.mtimeMs,
          indexedAt: Date.now(),
        });
        await (await getMetadataCache()).clearSummaryError(sessionId);
        continue;
      }

      try {
        console.log(`[${new Date().toISOString()}] Generating summary for ${sessionId.substring(0, 8)}...`);
        const { summary, source } = await generateSummaryWithBudget(content);
        // Map back to the storage enum (cache schema doesn't know fallback-ollama).
        const summarySource: 'original' | 'gemini' | 'claude' | 'ollama' =
          source === 'fallback-ollama' ? 'ollama' :
          source === 'cli' ? 'ollama' : // legacy compat — cli writes nothing meaningful here
          source;
        await (await getMetadataCache()).set({
          sessionId,
          firstPrompt: content.firstPrompt,
          summary,
          summarySource,
          mtime: stat.mtimeMs,
          indexedAt: Date.now(),
        });
        await (await getMetadataCache()).clearSummaryError(sessionId);
      } catch (genErr) {
        const reason = genErr instanceof Error ? genErr.message : String(genErr);
        await (await getMetadataCache()).recordSummaryError(sessionId, reason);
        console.error(`[${new Date().toISOString()}] Summary failed for ${sessionId.substring(0, 8)}: ${reason}`);
      }
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Summary phase error: ${err}`);
    }
  }
}

async function runMemoryIndexing() {
  const types = Array.from(changedMemoryTypes);
  changedMemoryTypes.clear();

  if (types.length === 0) return;

  console.log(`[${new Date().toISOString()}] Memory indexing for: ${types.join(', ')}`);

  try {
    const memoryIndex = await createVectorStore(embedder);
    const memoryStore = await createStore();
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

    const kg = await createKnowledgeGraph();

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
              if (!(await memoryIndex.needsUpdate(item.sourceType, item.id, item.mtime))) {
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
                await extractAndPopulateKG(kg, chunk.text, {
                  projectPath: item.projectPath, sourceType: item.sourceType, sessionId: item.id,
                });
              }

              if (chunks.length > 0) {
                await memoryIndex.bufferChunks(chunks);
                chunkCount += chunks.length;
                chunksSinceCompact += chunks.length;
              }

              await memoryStore.setItem(item);

              const links = await source.extractLinks(item);
              if (links.length > 0) {
                await memoryStore.addLinks(links);
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

    await kg.close();
    await memoryStore.close();
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Memory indexing failed:`, error);
  }
}

async function runIndexing() {
  await runSessionIndexing();
  await runMemoryIndexing();
  await maybeAutoCompact();
  await maybeSyncToServer();
}

// ── Continuous server sync ──────────────────────────────────────────
// When the user has run `chat-recall login` (credentials.json exists),
// push redacted conversations to the configured server after each batch.
// Watermark-based (settings.sync.lastSyncAt) so each run only uploads
// sessions modified since the previous successful sync. Min-interval
// guard keeps a chatty session from hammering the server; failures log
// and retry on the next batch (the watermark only advances on success).
const SYNC_MIN_INTERVAL_MS = Number(process.env.CHAT_RECALL_SYNC_INTERVAL_MS ?? 60_000);
let lastSyncAttemptAt = 0;
let syncInFlight = false;

async function maybeSyncToServer(): Promise<void> {
  if (syncInFlight) return;
  if (Date.now() - lastSyncAttemptAt < SYNC_MIN_INTERVAL_MS) return;
  syncInFlight = true;
  lastSyncAttemptAt = Date.now();
  try {
    const { syncIncremental } = await import('../src/sync-client.js');
    const r = await syncIncremental();
    if (r === null) return; // not logged in — feature off
    if (r.uploaded > 0) {
      console.log(`[${new Date().toISOString()}] Sync: ${r.uploaded} session(s) pushed (${r.redactions} secrets redacted, ${r.skipped} skipped)`);
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Sync failed (will retry next batch): ${(err as Error).message?.slice(0, 200)}`);
  } finally {
    syncInFlight = false;
  }
}

// Also sync on a slow heartbeat so a quiet machine still converges even if
// no file events fire (e.g. sessions written while the daemon was down).
setInterval(() => { void maybeSyncToServer(); }, 15 * 60 * 1000).unref();
setTimeout(() => { void maybeSyncToServer(); }, 20_000);

/**
 * Run a LanceDB compaction in the daemon's idle window if we've written
 * enough new chunks since the last one. Called only after both indexing
 * phases complete, so no writer is in flight from this process.
 *
 * The compaction itself takes the index lock — if some OTHER process
 * (manual `chat-recall optimize`, MCP write) is actively touching the
 * index, the lock acquisition fails and we no-op until next batch. No
 * retry loop, no waiting; the next batch will try again.
 *
 * `cleanupOlderThan` defaults to 24h inside MemoryIndex.optimize(). The
 * old default of 1h was the original "data corruption" trigger — long
 * read snapshots could be invalidated mid-flight. 24h is safe across
 * MCP, CLI, web-server, indexer.
 */
async function maybeAutoCompact(): Promise<void> {
  if (chunksSinceCompact < COMPACT_AFTER_CHUNKS) return;
  const beforeCount = chunksSinceCompact;
  chunksSinceCompact = 0;  // reset eagerly so a failure doesn't pile up

  console.log(`[${new Date().toISOString()}] Auto-compact: triggered after ${beforeCount} chunks`);
  try {
    const memoryIndex = await createVectorStore(embedder);
    const startedMs = Date.now();
    const stats = await memoryIndex.optimize({ lockKind: 'auto-indexer' });
    const elapsedMs = Date.now() - startedMs;
    if (stats.skipped) {
      console.log(`[${new Date().toISOString()}] Auto-compact: skipped (${stats.skipped})`);
      // If skipped, restore the counter so we'll retry next batch.
      chunksSinceCompact = beforeCount;
      return;
    }
    console.log(
      `[${new Date().toISOString()}] Auto-compact: ${stats.compactedFragments} fragments, `
        + `${stats.prunedFiles} versions pruned, ${elapsedMs}ms`,
    );
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Auto-compact failed:`, err);
    // Don't reset; let the next batch retry. If it keeps failing the
    // counter grows and we keep trying — visibility via the error log.
    chunksSinceCompact = beforeCount;
  }
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
// NO awaitWriteFinish: Claude Code appends to a session JSONL every few
// seconds while the user is chatting. With stabilityThreshold > 0, the
// file never settles, chokidar never fires, and the live session is
// invisible to the indexer until Claude Code is closed. We rely on the
// outer DEBOUNCE_MS batch + the polling interval to coalesce rapid
// writes into a single reindex pass.
// chokidar's `ignored` regex used to be `/\/\./`, which matched any path
// containing `/.` — including the entire `~/.claude/...` tree. Result:
// the watcher initialised but every event was silently dropped. The
// function form below ignores ONLY paths whose basename starts with `.`
// (true dotfiles), keeping `.claude/projects/<uuid>.jsonl` events live.
const sessionWatcher = chokidar.watch(`${CLAUDE_DIR}/**/*.jsonl`, {
  ignored: (p: string) => /agent-/.test(p) || /^\./.test(basename(p)),
  persistent: true,
  ignoreInitial: true,
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
// Conservative defaults: each gemini-cli spawn holds ~1.7 GB of V8
// heap reservation, and a stuck call can sit on a socket for the full
// cliTimeoutMs window. 2 in flight × ~1.7 GB ≈ 3.4 GB worst-case is the
// max we'll commit on a typical dev box. Users with rate-limited APIs
// can lower further; users on big servers can raise via env.
const SUMMARY_WORKER_INTERVAL_MS = Number(process.env.SUMMARY_WORKER_INTERVAL_MS) || 10_000;
const SUMMARY_WORKER_BATCH = Number(process.env.SUMMARY_WORKER_BATCH) || 10;
const SUMMARY_WORKER_PARALLEL = Number(process.env.SUMMARY_WORKER_PARALLEL) || 2;
const SUMMARY_MAX_ATTEMPTS = 3;
const SUMMARY_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
// Global circuit-breaker: when the LLM provider signals a hard quota
// exhaustion (429 / QUOTA_EXHAUSTED), no amount of per-session retrying
// will succeed. We pause the entire worker until the quota resets so we
// stop burning CPU + log volume on guaranteed-failing calls.
const SUMMARY_DEFAULT_QUOTA_PAUSE_MS = 60 * 60 * 1000; // 1h fallback
let summaryWorkerPausedUntil = 0;
let summaryWorkerPauseReason = '';

let summaryWorkerRunning = false;

async function summaryWorkerSweep(): Promise<void> {
  if (summaryWorkerRunning) return; // serialize sweeps
  const nowOuter = Date.now();
  if (summaryWorkerPausedUntil > nowOuter) {
    // Heartbeat every ~5 minutes so the user sees the pause in journalctl.
    if (nowOuter % 300_000 < SUMMARY_WORKER_INTERVAL_MS) {
      const remainingMin = Math.ceil((summaryWorkerPausedUntil - nowOuter) / 60_000);
      console.log(`[${new Date().toISOString()}] Summary worker paused (${summaryWorkerPauseReason}) — ~${remainingMin}m left`);
    }
    return;
  }
  summaryWorkerRunning = true;

  try {
    const { getAllSessions } = await import('@chat-recall/engine/parsers/session.js');
    const candidates: { sessionId: string; filePath: string; mtime: number }[] = [];
    const now = Date.now();

    for (const [entry, filePath] of getAllSessions()) {
      const cached = await (await getMetadataCache()).get(entry.sessionId);
      if (cached && cached.summary && cached.summary.length > 0) continue;

      const err = await (await getMetadataCache()).getSummaryError(entry.sessionId);
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
        await (await getMetadataCache()).set({
          sessionId,
          firstPrompt: content.firstPrompt,
          summary,
          summarySource,
          mtime,
          indexedAt: Date.now(),
        });
        await (await getMetadataCache()).clearSummaryError(sessionId);
        console.log(`[${new Date().toISOString()}]   ✓ ${sessionId.slice(0, 8)} (${summarySource}): "${summary.slice(0, 60).replace(/\n/g, ' ')}…"`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await (await getMetadataCache()).recordSummaryError(sessionId, msg);
        console.error(`[${new Date().toISOString()}]   ✗ ${sessionId.slice(0, 8)}: ${msg.slice(0, 200)}`);
        if (isQuotaError(msg)) {
          const retryMs = parseQuotaRetryMs(msg) ?? SUMMARY_DEFAULT_QUOTA_PAUSE_MS;
          // Cap at 24h so a parser glitch can't pause forever.
          const cappedMs = Math.min(retryMs, 24 * 60 * 60 * 1000);
          summaryWorkerPausedUntil = Math.max(summaryWorkerPausedUntil, Date.now() + cappedMs);
          summaryWorkerPauseReason = 'LLM quota exhausted';
          console.log(`[${new Date().toISOString()}] Summary worker: quota exhausted — pausing for ~${Math.round(cappedMs / 60_000)}m`);
        }
      }
    }

    for (let i = 0; i < batch.length; i += SUMMARY_WORKER_PARALLEL) {
      if (summaryWorkerPausedUntil > Date.now()) break; // bail mid-batch on quota
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

// ── Session mtime safety sweep ─────────────────────────────────────────
// chokidar's watcher on `~/.claude/projects/**/*.jsonl` has historically
// missed active sessions (used to be blocked by awaitWriteFinish; even
// now polling can lag on huge dirs). This sweep walks every Claude
// session file every SESSION_SWEEP_INTERVAL_MS, compares on-disk mtime
// to the indexer's `memory_mtime_cache.json`, and enqueues anything
// stale via scheduleIndexing(). It runs independently of the watcher
// so the index self-heals within a minute even if the watcher dies.
const SESSION_SWEEP_INTERVAL_MS = Number(process.env.CHAT_RECALL_SESSION_SWEEP_INTERVAL_MS ?? 60_000);
let sessionSweepRunning = false;
async function sessionMtimeSweep(): Promise<void> {
  if (sessionSweepRunning) return;
  sessionSweepRunning = true;
  try {
    const cachePath = join(getIndexDir(), 'memory_mtime_cache.json');
    let cache: Record<string, number> = {};
    try { cache = JSON.parse(readFileSync(cachePath, 'utf-8')); } catch { /* first run */ }

    // Walk every Claude session JSONL via the canonical source. We don't
    // load the SessionSource here because that pulls full file content;
    // a stat is enough to decide stale-vs-fresh.
    let stale: string[] = [];
    for (const [entry, sessionPath] of getAllSessions()) {
      const key = `session:${entry.sessionId}`;
      const cached = cache[key] || 0;
      if (entry.fileMtime > cached) {
        stale.push(sessionPath);
      }
    }
    if (stale.length === 0) return;

    console.log(`[${new Date().toISOString()}] Session sweep: ${stale.length} stale Claude session(s)`);
    for (const p of stale) scheduleIndexing(p);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Session sweep failed:`, err);
  } finally {
    sessionSweepRunning = false;
  }
}
setTimeout(() => { void sessionMtimeSweep(); }, 8_000);
setInterval(() => { void sessionMtimeSweep(); }, SESSION_SWEEP_INTERVAL_MS);
console.log(`  Session sweep: every ${SESSION_SWEEP_INTERVAL_MS / 1000}s (safety net for watcher misses)`);

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
type PrecomputeKind = 'outcome' | 'diff' | 'commits' | 'markers' | 'turns' | 'secrets';
const PRECOMPUTE_KINDS: PrecomputeKind[] = ['outcome', 'diff', 'commits', 'markers', 'turns', 'secrets'];

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
  const { extractTurnsAny } = await import('@chat-recall/engine/core/session-multi-tool.js');
  const { markPrompt, summarizeMarkers } = await import('@chat-recall/engine/core/session-sentiment.js');

  const cached = await (await getMetadataCache()).getComputeStale<{ sessionId: string; prompts: any[]; summary: any }>(sessionId, 'markers');
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
    await (await getMetadataCache()).setCompute(sessionId, 'markers', mtime, cached.data);
    return true;
  }
  const newPrompts = newPromptTurns.map(t => ({ line: t.line, ts: t.ts, tsIso: t.tsIso, ...markPrompt(t.text!) }));
  const merged = [...cached.data.prompts, ...newPrompts];
  await (await getMetadataCache()).setCompute(sessionId, 'markers', mtime, {
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
  const { extractTurnsAny } = await import('@chat-recall/engine/core/session-multi-tool.js');
  const cached = await (await getMetadataCache()).getComputeStale<{ found: boolean; turns: any[]; startMs: number; endMs: number; sessionId: string }>(sessionId, 'turns');
  if (!cached || !cached.data.found) return false;
  const lastLine = cached.data.turns.length > 0
    ? Math.max(...cached.data.turns.map((t: any) => Number(t.line) || 0))
    : 0;
  const fresh = extractTurnsAny(sessionId, { maxTurns: 50_000 });
  if (!fresh.found) return false;
  const newOnes = fresh.turns.filter(t => (Number(t.line) || 0) > lastLine);
  const merged = newOnes.length === 0 ? cached.data.turns : [...cached.data.turns, ...newOnes];
  await (await getMetadataCache()).setCompute(sessionId, 'turns', mtime, {
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
  // `*Any` dispatchers were removed from session-multi-tool when the
  // backend registry took over; outcome/commits now route through
  // `getBackendForId(...).<method>()`. Keep the local aliases so the
  // call sites below read the same.
  const { replaySessionAny, extractTurnsAny } = await import('@chat-recall/engine/core/session-multi-tool.js');
  const { getBackendForId } = await import('@chat-recall/engine/core/tool-backend.js');
  await import('@chat-recall/engine/core/backends/index.js'); // side-effect: register
  const computeOutcomeAny = (sid: string) => {
    const b = getBackendForId(sid);
    return b ? b.computeOutcome(sid) : { sessionId: sid, found: false } as ReturnType<NonNullable<ReturnType<typeof getBackendForId>>['computeOutcome']>;
  };
  const getSessionCommitsAny = (sid: string) => {
    const b = getBackendForId(sid);
    if (!b) return { sessionId: sid, found: false, repos: [], totalCommits: 0 };
    // Backends accept (id, files, startMs, endMs). Without a window we
    // pass the session's own edit-time bounds via the backend's replay.
    const r = b.replay(sid);
    if (!r.found) return { sessionId: sid, found: false, repos: [], totalCommits: 0 };
    const files = r.files.map(f => f.file);
    const start = (r as { startMs?: number }).startMs ?? 0;
    const end = (r as { endMs?: number }).endMs ?? Date.now();
    return b.getCommits(sid, files, start, end);
  };
  const { markPrompt, summarizeMarkers } = await import('@chat-recall/engine/core/session-sentiment.js');

  let replay: Awaited<ReturnType<typeof replaySessionAny>> | undefined;
  try {
    if (missing.includes('outcome')) {
      const outcome = computeOutcomeAny(sessionId);
      if (outcome.found) await (await getMetadataCache()).setCompute(sessionId, 'outcome', mtime, outcome);
    }
    if (missing.includes('diff')) {
      if (!replay) replay = replaySessionAny(sessionId);
      if (replay.found) await (await getMetadataCache()).setCompute(sessionId, 'diff', mtime, replay);
    }
    if (missing.includes('commits')) {
      if (sessionId.startsWith('codex_') || sessionId.startsWith('gemini_') || sessionId.startsWith('opencode_')) {
        const commits = getSessionCommitsAny(sessionId);
        await (await getMetadataCache()).setCompute(sessionId, 'commits', mtime, commits);
      } else {
        if (!replay) replay = replaySessionAny(sessionId);
        if (replay.found) {
          const commits = getSessionCommitsAny(sessionId);
          await (await getMetadataCache()).setCompute(sessionId, 'commits', mtime, commits);
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
          await (await getMetadataCache()).setCompute(sessionId, 'markers', mtime, {
            sessionId, prompts, summary: summarizeMarkers(prompts),
          });
        }
      }
    }
    if (missing.includes('turns')) {
      const ok = await tryIncrementalTurns(sessionId, mtime);
      if (!ok) {
        const turns = extractTurnsAny(sessionId, { maxTurns: 50_000 });
        if (turns.found) await (await getMetadataCache()).setCompute(sessionId, 'turns', mtime, turns);
      }
    }
    if (missing.includes('secrets')) {
      // Look up the source file path. Skip when missing or when neither
      // detector binary is installed (feature is opt-in: install
      // gitleaks + trufflehog into PATH and it lights up automatically).
      const { scanSessionForSecrets, isSecretScannerAvailable } = await import('@chat-recall/engine/core/secret-scanner.js');
      if (isSecretScannerAvailable()) {
        const { createStore } = await import('@chat-recall/engine/core/store/index.js');
        const store = await createStore();
        try {
          const item = await store.getItem(sessionId, 'session');
          const filePath = item?.file_path || '';
          if (filePath) {
            const r = await scanSessionForSecrets({ sessionId, filePath, store });
            if (r.ran && r.total > 0) {
              console.log(`[${new Date().toISOString()}]   🔐 secrets ${sessionId.slice(0, 8)}: ${r.total} (${Object.entries(r.byDetector).map(([k, v]) => `${k}=${v}`).join(', ')})`);
            }
          }
        } finally { await store.close(); }
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
          // Look up current mtime from memory_metadata. If absent, the
          // session is brand-new and hasn't been memory-indexed yet —
          // do that now, inline. Otherwise readers (Recent list, title
          // resolver, search) won't see this session until the next
          // batch indexer pass, and we get the cascade of "Untitled
          // session" / 404 / 202 surface bugs.
          const memStore = await createStore();
          let mtime = 0;
          try {
            const row = await memStore.getItem(sessionId, 'session');
            mtime = row?.mtime || 0;
          } finally { await memStore.close(); }

          if (!mtime) {
            const idxT0 = Date.now();
            mtime = await indexOneSession(sessionId);
            if (mtime > 0) {
              console.log(`[${new Date().toISOString()}]   ⚡ immediate memory-index ${sessionId.slice(0, 8)} in ${Date.now() - idxT0}ms`);
            } else {
              // Couldn't locate the session on disk — likely a delete
              // event arrived after the rename or the id doesn't match
              // any known tool. Skip rather than spin.
              return;
            }
          }

          const t0 = Date.now();
          await computeAndPersistSession(sessionId, mtime, ['outcome', 'diff', 'commits', 'markers', 'turns', 'secrets']);
          console.log(`[${new Date().toISOString()}]   ⚡ immediate compute ${sessionId.slice(0, 8)} in ${Date.now() - t0}ms`);
        } finally {
          IMMEDIATE_COMPUTE_PENDING.delete(sessionId);
        }
      })();
    });
  }, IMMEDIATE_COMPUTE_DEBOUNCE_MS);
  immediateComputeTimers.set(sessionId, timer);
}

/**
 * Memory-index a single session right now, instead of waiting for the
 * next batch sweep. Used by the file-watcher path: when a brand-new
 * session file appears on disk, the active session has no
 * memory_metadata row yet, which makes every reader (Recent, search,
 * title lookup, project tree) blind to it.
 *
 * Walks the session sources in order — Claude first because most
 * sessions live there, then Codex/Gemini/OpenCode. Stops on the first
 * match. Returns the indexed mtime, or 0 if the session can't be
 * located on disk.
 *
 * Side effects: writes a row to memory_metadata, populates FTS chunks,
 * runs the entity extractor against the new chunks. Mirrors what the
 * batch indexing loop does for a single item.
 */
async function indexOneSession(sessionId: string): Promise<number> {
  // Try each tool's source until one yields the session. The id prefix
  // disambiguates instantly via the backend registry — claude/codex/gemini/opencode.
  const sources: Array<{ ctor: () => any; matches: (id: string) => boolean }> = [
    { ctor: () => new SessionSource(),       matches: (id) => claudeBackend.matchesId(id) },
    { ctor: () => new CodexSessionSource(),  matches: (id) => codexBackend.matchesId(id) },
    { ctor: () => new GeminiSessionSource(), matches: (id) => geminiBackend.matchesId(id) },
    { ctor: () => new OpenCodeSource(),      matches: (id) => opencodeBackend.matchesId(id) },
  ];

  const source = sources.find(s => s.matches(sessionId))?.ctor();
  if (!source) return 0;

  // Locate the matching MemoryItem from this source's discover stream.
  let target: any = null;
  for await (const item of source.discover()) {
    if (item.id === sessionId) { target = item; break; }
  }
  if (!target) return 0;

  const memoryIndex = await createVectorStore(embedder);
  const memoryStore = await createStore();
  const kg = await createKnowledgeGraph();
  try {
    // Drop any partial chunks from a prior parse before reseeding.
    await memoryIndex.deleteItem(target.sourceType, target.id);

    const chunks = await source.parse(target);
    for (const chunk of chunks) {
      const cls = classifyChunk(chunk.text);
      if (cls.memoryType !== 'general') {
        chunk.chunkType = `${chunk.chunkType}:${cls.memoryType}:imp${cls.importance}`;
      }
      await extractAndPopulateKG(kg, chunk.text, {
        projectPath: target.projectPath, sourceType: target.sourceType, sessionId: target.id,
      });
    }
    if (chunks.length > 0) await memoryIndex.bufferChunks(chunks);
    await memoryIndex.flushBuffer();

    // Persist the metadata row LAST — it gates every downstream reader,
    // so we want it visible only after chunks/links exist.
    await memoryStore.setItem(target);
    const links = await source.extractLinks(target);
    if (links && links.length > 0) await memoryStore.addLinks(links);

    return target.mtime || 0;
  } finally {
    await kg.close();
    await memoryStore.close();
  }
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
    const now = Date.now();

    // Iterate ALL sessions across all 4 tools by querying memory_metadata
    // directly. Order by mtime DESC so the user's most recent sessions
    // (the ones they're likely to click) get cached first.
    type Cand = { sessionId: string; mtime: number; missing: PrecomputeKind[] };
    const candidates: Cand[] = [];
    {
      const memStore = await createStore();
      try {
        const rows = await memStore.listAllSessionsForPrecompute(); // { id, mtime, tool }[]
        // 'secrets' lives in its own table (`secret_findings`), not in
        // compute_cache — bulk-fetch the set of session ids that
        // already have findings so we can skip them without N round-
        // trips. Sessions that genuinely have zero secrets get
        // re-scanned on every sweep, which is wasted work but bounded
        // by PRECOMPUTE_FRESH_SKIP_MS — acceptable trade-off without
        // adding a "scanned but empty" sentinel table.
        const scannedSet = new Set<string>(
          (await memStore.secretFindingsBySession()).map(r => r.session_id),
        );
        for (const r of rows) {
          const mtime = r.mtime || 0;
          if (now - mtime < PRECOMPUTE_FRESH_SKIP_MS) continue;
          const missing: PrecomputeKind[] = [];
          for (const kind of PRECOMPUTE_KINDS) {
            if (kind === 'secrets') {
              if (!scannedSet.has(r.id)) missing.push(kind);
              continue;
            }
            const cached = await (await getMetadataCache()).getCompute(r.id, kind, mtime);
            if (!cached) missing.push(kind);
          }
          if (missing.length > 0) {
            candidates.push({ sessionId: r.id, mtime, missing });
          }
          if (candidates.length >= PRECOMPUTE_BATCH * 4) break;
        }
      } finally {
        await memStore.close();
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

// Handle graceful shutdown. The reap step kills every gemini/CLI
// child still in flight by process-group, so SIGTERM from systemd no
// longer leaks summary spawners as orphans reparented to systemd-user.
function shutdown(signal: string): void {
  console.log(`[${new Date().toISOString()}] Received ${signal}, shutting down...`);
  sessionWatcher.close();
  plansWatcher.close();
  tasksWatcher.close();
  historyWatcher.close();
  diaryWatcher.close();
  codexWatcher.close();
  geminiWatcher.close();
  opencodeWatcher.close();
  try { reapShellChildren(); } catch { /* best-effort */ }
  // Give SIGTERM a beat to flush, then exit. SIGKILL grace fires from
  // inside reapShellChildren on its own 1s timer.
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
