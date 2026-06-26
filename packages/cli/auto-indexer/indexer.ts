#!/usr/bin/env node
/**
 * Ship daemon for chat-recall (`chat-recall-watch`).
 *
 * THIN COLLECTOR MODEL: this daemon keeps NO local index. It watches the
 * AI-tool session directories and, on change (debounced), calls the
 * collector's `syncIncremental()` to ship new/changed sessions to the
 * configured server. The server stores + indexes + (later) summarizes.
 *
 * What it does:
 *  - Watches ~/.claude/projects (sessions), plans, tasks, history, diary,
 *    plus Codex / Gemini / OpenCode session stores.
 *  - Debounces a burst of file events into one flush.
 *  - On each flush: call `syncIncremental()`. If the user isn't logged in
 *    it returns null — we log one warning line and skip (no crash).
 *
 * What it deliberately does NOT do anymore (all moved server-side):
 *  - No local indexing (LanceDB / FTS / metadata store).
 *  - No summary generation (Ollama / Gemini / Claude). Summaries are now
 *    produced by the server during ingest (see Step F). The intent isn't
 *    lost — it's just relocated to where the data lives.
 *  - No knowledge-graph population, no classifier, no compaction, no
 *    per-session precompute. None of that runs on the client.
 *
 * Removing the store/embedder dependencies also drops the last native
 * modules (the LanceDB vector store and the SQLite driver) from the
 * watch.js bundle — the ship daemon is pure JS over chokidar + the HTTP
 * sync client.
 *
 * Systemd-ready: all output goes to stdout/stderr with ISO timestamps.
 */

import chokidar from 'chokidar';
import { dirname, basename } from 'path';

import { claudeBackend, geminiBackend, opencodeBackend, codexBackend } from '@chat-recall/engine/core/backends/index.js';
import { getDiaryDir } from '@chat-recall/engine/core/paths.js';

// The only "work" import: the HTTP collector that ships sessions to the
// server. Everything else this daemon used to import (stores, embedder,
// summary generator, knowledge graph, source parsers) is gone — those
// responsibilities live on the server now.
import { syncIncremental } from '../src/sync-client.js';
import { drainSyncIntents } from '../src/intent-drain.js';
import { loadAllCredentials } from '../src/sync-client.js';
import { existsSync } from 'fs';

const DEBOUNCE_MS = 5000;  // coalesce a burst of file events into one flush

function ts(): string {
  return new Date().toISOString();
}

// ── Watched paths ───────────────────────────────────────────────────
// All paths come from the backend registry — env-overridable via
// CHAT_RECALL_*_HOME. Adding a fifth tool means: register the backend in
// `backends/index.ts` and add its watcher pair below.
const CLAUDE_DIR = claudeBackend.projectsDir();
const PLANS_DIR = claudeBackend.plansDir();
const TASKS_DIR = claudeBackend.tasksDir();
const HISTORY_PATH = claudeBackend.historyFile();
const DIARY_DIR = getDiaryDir();

// Per-tool session sources.
const CODEX_SESSIONS_DIR = codexBackend.sessionsDir();
const GEMINI_TMP_DIR = geminiBackend.tmpDir();
const OPENCODE_DB_PATH = opencodeBackend.dbPath();
// OpenCode SQLite uses WAL mode — incremental row writes hit the .db-wal
// file, not the main db. Watching all three (db, db-wal, db-shm) catches
// every kind of write activity.
const OPENCODE_DB_DIR = dirname(OPENCODE_DB_PATH);

// ── Debounced ship ──────────────────────────────────────────────────
// File events accumulate; after DEBOUNCE_MS of quiet we ship once. The
// sync client is watermark/ledger-based internally, so it figures out
// exactly which sessions changed — we don't track per-file deltas here.
let debounceTimer: NodeJS.Timeout | null = null;
let syncInFlight = false;
let pendingFileCount = 0;

/**
 * Ship to the server. Serialized via `syncInFlight` so overlapping
 * flushes (debounce + heartbeat) never run concurrently. Failures log
 * and are retried on the next flush — the sync client only advances its
 * ledger on success, so nothing is silently dropped.
 */
async function shipToServer(trigger: string): Promise<void> {
  if (syncInFlight) return;
  syncInFlight = true;
  try {
    const result = await syncIncremental();
    if (result === null) {
      // Not logged in (no credentials, or sync paused) — the daemon has
      // nothing to do until `chat-recall login` runs. Warn once per flush
      // so the journal shows why nothing is shipping, but don't crash.
      console.warn(`[${ts()}] Sync skipped (${trigger}): not logged in — run \`chat-recall login\` to ship sessions to a server.`);
      return;
    }
    if (result.uploaded > 0 || result.derived > 0) {
      console.log(
        `[${ts()}] Sync (${trigger}): ${result.uploaded} session(s) pushed, `
          + `${result.redactions} secret(s) redacted, ${result.skipped} skipped, `
          + `${result.items} items, ${result.links} links, ${result.derived} derived, `
          + `${result.kgEntities} KG entities, ${result.kgTriples} KG triples`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${ts()}] Sync failed (${trigger}, will retry next flush): ${msg.slice(0, 200)}`);
  } finally {
    syncInFlight = false;
  }
}

/**
 * Record a file change and (re)arm the debounce timer. The actual unit
 * of work is a single `syncIncremental()` — we don't care WHICH file
 * changed, only that something did, because the sync client rescans all
 * sessions and ships the ones its ledger hasn't acked yet.
 */
function scheduleSync(): void {
  pendingFileCount++;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    pendingFileCount = 0;
    void shipToServer('file-change');
  }, DEBOUNCE_MS);
}

// ── File watchers ───────────────────────────────────────────────────

// 1. Session files.
// NO awaitWriteFinish: Claude Code appends to a session JSONL every few
// seconds while the user is chatting. With stabilityThreshold > 0, the
// file never settles, chokidar never fires, and the live session is
// invisible until Claude Code closes. We rely on the outer DEBOUNCE_MS
// batch + the polling interval to coalesce rapid writes into one ship.
//
// `ignored` is a function (not a /\/\./ regex) so it ignores ONLY true
// dotfiles (basename starting with `.`), not the entire ~/.claude tree.
const sessionWatcher = chokidar.watch(`${CLAUDE_DIR}/**/*.jsonl`, {
  ignored: (p: string) => /agent-/.test(p) || /^\./.test(basename(p)),
  persistent: true,
  ignoreInitial: true,
  usePolling: true,
  interval: 5000,
  binaryInterval: 5000,
});

// 2. Plans.
const plansWatcher = chokidar.watch(`${PLANS_DIR}/*.md`, {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 },
  usePolling: true,
  interval: 10000,
});

// 3. Tasks.
const tasksWatcher = chokidar.watch(`${TASKS_DIR}/**/*.json`, {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 },
  usePolling: true,
  interval: 10000,
});

// 4. History.
const historyWatcher = chokidar.watch(HISTORY_PATH, {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 500 },
  usePolling: true,
  interval: 30000,  // check less frequently
});

// 5. Diary entries.
const diaryWatcher = chokidar.watch(`${DIARY_DIR}/**/*.json`, {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 },
});

// 6. Codex sessions — JSONL rollouts under YYYY/MM/DD/.
const codexWatcher = chokidar.watch(`${CODEX_SESSIONS_DIR}/**/rollout-*.jsonl`, {
  persistent: true,
  ignoreInitial: true,
  // Codex rolls every event into its own JSONL line — wait for ~2s of
  // write quiescence so we don't ship mid-write.
  awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 200 },
  usePolling: true,
  interval: 5000,
});

// 7. Gemini sessions — one JSON file per session in
// ~/.gemini/tmp/<hash>/chats/session-*.json. Gemini rewrites the whole
// file each time (atomic-rename style); we just watch for changes.
const geminiWatcher = chokidar.watch(`${GEMINI_TMP_DIR}/**/session-*.json`, {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 200 },
  usePolling: true,
  interval: 5000,
});

// 8. OpenCode SQLite — watch the db + WAL/SHM. SQLite in WAL mode writes
// new rows to the .db-wal file; the main .db is touched on checkpoint.
// Watching all three catches every kind of activity.
const opencodeWatcher = chokidar.watch(
  [`${OPENCODE_DB_PATH}`, `${OPENCODE_DB_PATH}-wal`, `${OPENCODE_DB_PATH}-shm`],
  {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 2500, pollInterval: 500 },
    usePolling: true,
    interval: 10000,
  },
);

// 9. Per-project agent memory files (Claude Code ~/.claude/projects/<hash>/memory/*.md).
// Agents write reference/feedback/project-state notes here between sessions —
// the richest cross-session knowledge surface, now indexed + synced.
const agentMemoryWatcher = chokidar.watch(`${CLAUDE_DIR}/*/memory/*.md`, {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 },
  usePolling: true,
  interval: 10000,
});

// Wire up all watchers. Every add/change just arms the debounced ship —
// the daemon no longer cares which source/type changed, because the sync
// client rescans and ledgers everything itself.
const watchers: Record<string, chokidar.FSWatcher> = {
  sessions: sessionWatcher,
  plans: plansWatcher,
  tasks: tasksWatcher,
  history: historyWatcher,
  diary: diaryWatcher,
  codex: codexWatcher,
  gemini: geminiWatcher,
  opencode: opencodeWatcher,
  agentMemory: agentMemoryWatcher,
};

for (const [name, watcher] of Object.entries(watchers)) {
  watcher
    .on('ready', () => {
      console.log(`[${ts()}] ${name} watcher ready`);
    })
    .on('add', (path) => {
      console.log(`[${ts()}] [${name}] New: ${path}`);
      scheduleSync();
    })
    .on('change', (path) => {
      console.log(`[${ts()}] [${name}] Modified: ${path}`);
      scheduleSync();
    })
    .on('error', (error) => {
      console.error(`[${ts()}] [${name}] Watcher error:`, error);
    });
}

// ── Startup banner ──────────────────────────────────────────────────
console.log(`[${ts()}] chat-recall ship daemon started (thin collector — no local index)`);
console.log(`  Watching sessions: ${CLAUDE_DIR}`);
console.log(`  Watching plans:    ${PLANS_DIR}`);
console.log(`  Watching tasks:    ${TASKS_DIR}`);
console.log(`  Watching history:  ${HISTORY_PATH}`);
console.log(`  Watching diary:    ${DIARY_DIR}`);
console.log(`  Watching codex:    ${CODEX_SESSIONS_DIR}`);
console.log(`  Watching gemini:   ${GEMINI_TMP_DIR}`);
console.log(`  Watching opencode: ${OPENCODE_DB_DIR}`);
console.log(`  Watching agent memory: ${CLAUDE_DIR}/*/memory/`);
console.log(`  Debounce: ${DEBOUNCE_MS}ms · ships via syncIncremental() to the configured server`);
console.log(`  Ready for changes...`);

// Slow heartbeat: a quiet machine still converges even when no file
// events fire (e.g. sessions written while the daemon was down). Also
// kick one initial ship shortly after startup to drain any backlog.
setInterval(() => { void shipToServer('heartbeat'); }, 15 * 60 * 1000).unref();
setTimeout(() => { void shipToServer('startup'); }, 20_000);

// Liveness heartbeat for the journal.
setInterval(() => {
  console.log(`[${ts()}] Heartbeat - ${pendingFileCount} pending file event(s), sync ${syncInFlight ? 'in-flight' : 'idle'}`);
}, 60000);

// Cross-tool sync intents (Model B): poll the server(s) for queued intents the
// UI created and execute them locally. 45s cadence keeps "click in UI → files
// copied on disk" feeling prompt without hammering the server. Best-effort —
// errors are swallowed inside the drainer and retried next tick.
let intentDrainInFlight = false;
async function drainIntentsTick(): Promise<void> {
  if (intentDrainInFlight) return;
  intentDrainInFlight = true;
  try {
    const r = await drainSyncIntents();
    if (r.processed > 0) {
      console.log(`[${ts()}] sync-intents: ${r.done} done, ${r.errored} errored`);
      // Applying an intent wrote files into toolkit dirs the chokidar watcher
      // does NOT watch — push them up now so the UI reflects the change in
      // seconds, instead of waiting for the 15-min heartbeat.
      if (r.done > 0) await shipToServer('intent-applied');
    }
  } catch (err) {
    console.error(`[${ts()}] sync-intents drain failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    intentDrainInFlight = false;
  }
}
setInterval(() => { void drainIntentsTick(); }, 45_000).unref();
setTimeout(() => { void drainIntentsTick(); }, 10_000);

// Periodic code re-index (codeindex merge). Opt-in (CHAT_RECALL_CODE_REINDEX=1)
// because running the analyzer over every known repo is heavier than a session
// ship. When on, it re-runs the collector on each project the server already
// knows about (skipping ones whose path is gone) and re-syncs findings, so the
// Code dashboard stays fresh without manual `chat-recall code index` runs.
const CODE_REINDEX_ON = process.env.CHAT_RECALL_CODE_REINDEX === '1';
const CODE_REINDEX_MS = Math.max(30, parseInt(process.env.CHAT_RECALL_CODE_REINDEX_MINUTES || '360', 10)) * 60 * 1000;
let codeReindexInFlight = false;
async function codeReindexTick(): Promise<void> {
  if (codeReindexInFlight) return;
  codeReindexInFlight = true;
  try {
    const { collectCode } = await import('@chat-recall/engine');
    for (const cred of loadAllCredentials()) {
      const base = cred.serverUrl.replace(/\/+$/, '');
      const headers: Record<string, string> = cred.token ? { authorization: `Bearer ${cred.token}` } : {};
      let projects: Array<{ projectId: string; rootPath: string }> = [];
      try {
        const res = await fetch(`${base}/api/code/projects`, { headers });
        if (!res.ok) continue;
        projects = ((await res.json()) as { projects?: Array<{ projectId: string; rootPath: string }> }).projects || [];
      } catch { continue; }
      for (const p of projects) {
        if (!p.rootPath || !existsSync(p.rootPath)) continue;   // repo moved/deleted — skip
        try {
          const result = await collectCode({ workspace: p.rootPath, autoInstall: false });
          await fetch(`${base}/api/code/index`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(result) });
          console.log(`[${ts()}] code re-indexed ${p.projectId} (health ${result.project.health.score})`);
        } catch (e) {
          console.error(`[${ts()}] code re-index failed for ${p.projectId}: ${e instanceof Error ? e.message : e}`);
        }
      }
    }
  } finally {
    codeReindexInFlight = false;
  }
}
if (CODE_REINDEX_ON) {
  setInterval(() => { void codeReindexTick(); }, CODE_REINDEX_MS).unref();
  setTimeout(() => { void codeReindexTick(); }, 60_000);
  console.log(`  Code re-index: ON (every ${CODE_REINDEX_MS / 60000} min)`);
}

// ── Graceful shutdown ───────────────────────────────────────────────
// No child processes to reap anymore (summary generation moved
// server-side), so shutdown is just: close watchers, flush, exit.
function shutdown(signal: string): void {
  console.log(`[${ts()}] Received ${signal}, shutting down...`);
  for (const watcher of Object.values(watchers)) {
    void watcher.close();
  }
  if (debounceTimer) clearTimeout(debounceTimer);
  // Give in-flight logging a beat to flush, then exit.
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
