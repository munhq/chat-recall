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
 *  - On each flush: call `syncIncremental()`. If it skips (not logged in,
 *    paused, or another writer holds the sync lock) we log the actionable
 *    reasons and stay quiet on routine lock contention (no crash).
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
import { dirname, basename, join } from 'path';

import { claudeBackend, geminiBackend, opencodeBackend, codexBackend } from '@chat-recall/engine/core/backends/index.js';
import { getDiaryDir } from '@chat-recall/engine/core/paths.js';

// The only "work" import: the HTTP collector that ships sessions to the
// server. Everything else this daemon used to import (stores, embedder,
// summary generator, knowledge graph, source parsers) is gone — those
// responsibilities live on the server now.
import { syncIncremental, isSyncSkip } from '../src/sync-client.js';
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
    // File-change ticks fire on every debounced keystroke burst — walk only
    // the recent-mtime window (cheap). Heartbeat/startup/intent ticks do the
    // full ledger walk so old failed sessions still retry forever.
    const result = await syncIncremental({ scope: trigger === 'file-change' ? 'changed' : 'full' });
    if (isSyncSkip(result)) {
      // 'lock-held' is routine writer election (an MCP session's sync tick
      // won the lock) — nothing to say. Only the user-actionable reasons
      // warrant a log line.
      if (result.skipped === 'no-credentials') {
        console.warn(`[${ts()}] Sync skipped (${trigger}): not logged in — run \`chat-recall login\` to ship sessions to a server.`);
      } else if (result.skipped === 'paused') {
        console.warn(`[${ts()}] Sync skipped (${trigger}): sync is paused in settings — re-run \`chat-recall login <server-url>\` to resume.`);
      }
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

// Automatic code intelligence (codeindex merge). The daemon DISCOVERS the
// workspaces you actually work in — distinct project paths across ALL tool
// sessions in the recent window — and indexes each with codeindex, then syncs
// the findings/hotspots/actions to every logged-in server. No manual
// `chat-recall code index`. codeindex itself decides what's a scannable
// workspace (it walks up for markers and refuses $HOME and /), so the daemon
// applies no homemade path filters beyond "still exists on disk".
// On by default; CHAT_RECALL_CODE_INDEX=0 disables, *_MINUTES/_MAX/_DAYS tune it.
const CODE_INDEX_ON = process.env.CHAT_RECALL_CODE_INDEX !== '0';
const CODE_INDEX_MS = Math.max(15, parseInt(process.env.CHAT_RECALL_CODE_INDEX_MINUTES || '180', 10)) * 60 * 1000;
const CODE_INDEX_MAX = Math.max(1, parseInt(process.env.CHAT_RECALL_CODE_INDEX_MAX || '50', 10));
const CODE_INDEX_WINDOW_DAYS = Math.max(1, parseInt(process.env.CHAT_RECALL_CODE_INDEX_DAYS || '120', 10));
let codeIndexInFlight = false;

/** Workspaces to index = distinct project paths from recent sessions across all
 *  tools, that still exist on disk, newest-active first. No .git/marker check —
 *  codeindex is the authority on what's scannable. */
function discoverWorkspaces(): string[] {
  const sinceMs = Date.now() - CODE_INDEX_WINDOW_DAYS * 86_400_000;
  const newest = new Map<string, number>();
  for (const b of [claudeBackend, geminiBackend, opencodeBackend, codexBackend]) {
    let avail = false;
    try { avail = b.isAvailable(); } catch { /* backend not installed */ }
    if (!avail) continue;
    let refs: Array<{ projectPath: string; mtime: number }> = [];
    try { refs = b.listSessions({ sinceMs }); } catch { /* unreadable */ }
    for (const r of refs) {
      if (!r.projectPath) continue;
      const prev = newest.get(r.projectPath);
      if (prev === undefined || r.mtime > prev) newest.set(r.projectPath, r.mtime);
    }
  }
  return [...newest.entries()]
    .filter(([p]) => { try { return existsSync(p); } catch { return false; } })
    .sort((a, b) => b[1] - a[1])
    .slice(0, CODE_INDEX_MAX)
    .map(([p]) => p);
}

async function codeIndexTick(): Promise<void> {
  if (codeIndexInFlight) return;
  codeIndexInFlight = true;
  try {
    const creds = loadAllCredentials();
    if (creds.length === 0) return;
    const workspaces = discoverWorkspaces();
    if (workspaces.length === 0) return;
    const { collectCode, resolveCodeindexBin } = await import('@chat-recall/engine/core/code/collector.js');
    let bin: string;
    try { bin = await resolveCodeindexBin(true); }   // resolve/install codeindex once per pass
    catch (e) { console.error(`[${ts()}] code intelligence skipped — codeindex unavailable: ${e instanceof Error ? e.message : e}`); return; }
    let ok = 0;
    for (const ws of workspaces) {
      let result;
      try { result = await collectCode({ workspace: ws, binPath: bin }); }
      catch { continue; }   // not a scannable workspace (codeindex refused) or transient — skip
      for (const cred of creds) {
        const base = cred.serverUrl.replace(/\/+$/, '');
        const headers: Record<string, string> = { 'content-type': 'application/json', ...(cred.token ? { authorization: `Bearer ${cred.token}` } : {}) };
        try { await fetch(`${base}/api/code/index`, { method: 'POST', headers, body: JSON.stringify(result) }); } catch { /* retry next tick */ }
      }
      ok++;
    }
    if (ok > 0) console.log(`[${ts()}] code intelligence: indexed ${ok}/${workspaces.length} workspace(s)`);
  } finally {
    codeIndexInFlight = false;
  }
}
if (CODE_INDEX_ON) {
  setInterval(() => { void codeIndexTick(); }, CODE_INDEX_MS).unref();
  setTimeout(() => { void codeIndexTick(); }, 90_000);   // first pass shortly after startup
  console.log(`  Code intelligence: AUTO — discovers your repos & indexes them (every ${CODE_INDEX_MS / 60000}m · ${CODE_INDEX_WINDOW_DAYS}d window · max ${CODE_INDEX_MAX})`);
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
