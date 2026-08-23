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
import { dirname, basename, join, resolve, sep } from 'path';
import { homedir } from 'os';

import { claudeBackend, geminiBackend, opencodeBackend, codexBackend } from '@chat-recall/engine/core/backends/index.js';
import { getDiaryDir, getDataDir } from '@chat-recall/engine/core/paths.js';
import { loadSettings, isPersonalPath } from '@chat-recall/engine/core/settings.js';

// The only "work" import: the HTTP collector that ships sessions to the
// server. Everything else this daemon used to import (stores, embedder,
// summary generator, knowledge graph, source parsers) is gone — those
// responsibilities live on the server now.
import { syncIncremental, isSyncSkip } from '../src/sync-client.js';
import { fetchWithTimeout } from '../src/http.js';
import { drainSyncIntents } from '../src/intent-drain.js';
import { loadAllCredentials } from '../src/sync-client.js';
import { runAutoUpdate } from '../src/auto-update.js';
import { codeFingerprint, checkSelfRestart } from '../src/self-restart.js';
import { rotateLogIfLarge } from '../src/log-rotate.js';
import { runCollectorMigration } from '../src/collector-migrate.js';

// Injected by the bundler (scripts/bundle.mjs). Falls back for tsx/dev runs.
declare const __CLI_VERSION__: string;
const CLI_VERSION = typeof __CLI_VERSION__ === 'string' ? __CLI_VERSION__ : '0.0.0';
import { existsSync, readFileSync, statSync } from 'fs';
import { flushLedger } from '../src/sync-ledger.js';
import { readCollectorHealth, writeCollectorHealth, updateCollectorHealth, collectorHealthPath, type TargetHealth } from '@chat-recall/engine/core/collector-health.js';

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

// Resume-guard signal. Claude Code 2.1.20x writes `~/.claude/current-resume`
// (contents: `claude --resume <id>`) when a resume STARTS, and then rewrites
// that session's transcript in place — keeping only the continuation, dropping
// the earlier history from disk. We race that rewrite: the instant this file
// changes we snapshot the target session into the shadow archive, capturing the
// still-full transcript before it's truncated. Even if the rewrite wins the
// race, the snapshot merges with any prior shadow, so history is never lost.
const CURRENT_RESUME_PATH = join(claudeBackend.homeDir(), 'current-resume');
// A cleanup pass (trims/deletes transcripts) touches this; a change means the
// on-disk set shifted and a reconcile ship is worth scheduling.
const LAST_CLEANUP_PATH = join(claudeBackend.homeDir(), '.last-cleanup');

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
    // A completed walk is the only thing that counts as "the collector works".
    for (const server of syncTargetUrls()) noteSyncOutcome(server, true);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${ts()}] Sync failed (${trigger}, will retry next flush): ${msg.slice(0, 200)}`);
    for (const server of syncTargetUrls()) noteSyncOutcome(server, false, msg);
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

/**
 * Resume-guard: `~/.claude/current-resume` changed → a resume is starting for
 * the session id it names. Snapshot that session into the shadow IMMEDIATELY
 * (no debounce — we're racing the in-place rewrite) to preserve the full
 * pre-resume transcript. Best-effort: never throws into the watcher.
 *
 * Deduped by id + a re-arm window: Claude Code re-touches current-resume every
 * few seconds during an active session, so without this the daemon would
 * re-export and merge a multi-MB transcript on every touch. We snapshot when
 * the id CHANGES (a genuinely new resume), and at most once per re-arm window
 * for the same id (the sync path's own shadow update covers the rest).
 */
// Per-id re-arm window. A single global lastResumeId thrashed when two sessions
// were resumed close together (each id reset the other's guard → repeated
// re-snapshots + log spam); keying by id dedups each session independently.
const lastResumeAt = new Map<string, number>();
const RESUME_REARM_MS = 60_000;
async function onResumeSignal(path: string): Promise<void> {
  try {
    const txt = readFileSync(path, 'utf-8');
    const m = /--resume\s+([0-9a-fA-F-]{36})/.exec(txt);
    if (!m) return;
    const id = m[1];
    const now = Date.now();
    const prev = lastResumeAt.get(id);
    if (prev !== undefined && now - prev < RESUME_REARM_MS) return; // same resume, still armed
    lastResumeAt.set(id, now);
    const { snapshotShadow } = await import('@chat-recall/engine/transcript/index.js');
    const r = await snapshotShadow(id);
    // 'skipped' means the live file has not moved since the last snapshot, so
    // nothing was read. Not worth a log line every minute per active session —
    // it was two thirds of this log's resume-guard noise.
    if (r.status === 'skipped') return;
    console.log(`[${ts()}] [resume-guard] shadow ${r.status} for ${id.slice(0, 8)}…` + (r.recovered > 0 ? ` (recovered ${r.recovered} record(s))` : ''));
  } catch (e) {
    console.error(`[${ts()}] [resume-guard] ${e instanceof Error ? e.message : e}`);
  }
}

// ── File watchers ───────────────────────────────────────────────────

/**
 * Watch strategy: native events by default, polling only where it is needed.
 *
 * Every watcher below used to hard-code `usePolling: true`. chokidar implements
 * polling as one `fs.watchFile` per path, i.e. a `stat()` per file per interval
 * on the libuv threadpool. Measured on this developer's machine: ~2,900 stat()
 * per second, forever, with nobody typing — 251 million a day. On macOS it is
 * worse than wasteful: chokidar ships fsevents as an optional native dep and
 * installs it on every Mac, and `usePolling` explicitly disables it, so we paid
 * thousands of syscalls a second to avoid a kernel event stream that was already
 * there. Thousands of timer wakeups per second also keep the CPU out of deep
 * C-states, which is battery on a laptop.
 *
 * Native watching (inotify / FSEvents / ReadDirectoryChangesW) costs nothing at
 * idle on all three platforms. The one real reason to poll is a filesystem that
 * does not deliver events — a network mount (NFS, SMB), a VM shared folder, or
 * a container bind mount. That is a property of the user's setup, not of the
 * platform, so it is a setting rather than a guess.
 *
 * CHAT_RECALL_WATCH_POLL=1 forces polling back on. We also fall back to it
 * automatically when inotify runs out of watches, which is the one failure mode
 * Linux has here: the default fs.inotify.max_user_watches is 8192 and this
 * machine has 13,774 session files, so a large corpus CAN legitimately exhaust
 * it. That surfaces as ENOSPC on the watcher's error event, and the answer is
 * to reopen that watcher in polling mode rather than to poll everything always.
 */
const FORCE_POLL = process.env.CHAT_RECALL_WATCH_POLL === '1';

interface WatchTuning {
  /** Poll interval when polling is in force. Ignored for native watching. */
  interval: number;
  ignored?: (p: string) => boolean;
  ignoreInitial?: boolean;
}

/**
 * Poll options for one watcher, or nothing at all when native watching is on.
 * Spread into a chokidar option object: `...POLL(5000),`.
 */
const POLL = (interval: number): { usePolling?: true; interval?: number } =>
  (FORCE_POLL ? { usePolling: true, interval } : {});

const watchOpts = (t: WatchTuning, poll = FORCE_POLL): chokidar.WatchOptions => ({
  persistent: true,
  ignoreInitial: t.ignoreInitial ?? true,
  ...(t.ignored ? { ignored: t.ignored } : {}),
  ...(poll ? { usePolling: true, interval: t.interval } : {}),
});

/**
 * Open a watcher, and reopen it in polling mode if the OS cannot watch natively.
 *
 * ENOSPC from inotify means "no watch descriptors left", not "disk full". It is
 * the one case where polling is genuinely the right answer, and it is also the
 * case a user cannot diagnose from the outside — so say it in the log.
 */
function watchWithFallback(name: string, pattern: string | string[], t: WatchTuning): chokidar.FSWatcher {
  let w = chokidar.watch(pattern, watchOpts(t));
  let swapped = false;
  w.on('error', (err: unknown) => {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (swapped || FORCE_POLL || (code !== 'ENOSPC' && code !== 'EMFILE')) {
      console.error(`[${ts()}] ${name} watcher error: ${String(err)}`);
      return;
    }
    swapped = true;
    console.log(`[${ts()}] ${name} watcher: native watching hit ${code} — falling back to polling every ${t.interval}ms.`
      + ` Raise fs.inotify.max_user_watches to get native events back.`);
    void w.close().catch(() => {});
    w = chokidar.watch(pattern, watchOpts(t, true));
  });
  return w;
}


// 1. Session files.
// NO awaitWriteFinish: Claude Code appends to a session JSONL every few
// seconds while the user is chatting. With stabilityThreshold > 0, the
// file never settles, chokidar never fires, and the live session is
// invisible until Claude Code closes. We rely on the outer DEBOUNCE_MS
// batch + the polling interval to coalesce rapid writes into one ship.
//
// `ignored` is a function (not a /\/\./ regex) so it ignores ONLY true
// dotfiles (basename starting with `.`), not the entire ~/.claude tree.
const sessionWatcher = watchWithFallback('sessions', `${CLAUDE_DIR}/**/*.jsonl`, {
  ignored: (p: string) => /agent-/.test(p) || /^\./.test(basename(p)),
  interval: 5000,
});

// 2. Plans.
const plansWatcher = chokidar.watch(`${PLANS_DIR}/*.md`, {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 },
  ...POLL(10000),
});

// 3. Tasks.
const tasksWatcher = chokidar.watch(`${TASKS_DIR}/**/*.json`, {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 },
  ...POLL(10000),
});

// 4. History.
const historyWatcher = chokidar.watch(HISTORY_PATH, {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 500 },
  ...POLL(30000),  // check less frequently
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
  ...POLL(5000),
});

// 7. Gemini sessions — one JSON file per session in
// ~/.gemini/tmp/<hash>/chats/session-*.json. Gemini rewrites the whole
// file each time (atomic-rename style); we just watch for changes.
const geminiWatcher = chokidar.watch(`${GEMINI_TMP_DIR}/**/session-*.json`, {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 200 },
  ...POLL(5000),
});

// 8. OpenCode SQLite — watch the db + WAL only. SQLite in WAL mode writes new
// rows to the .db-wal file; the main .db is touched on checkpoint. Together
// those two catch every real write.
//
// We deliberately do NOT watch the .db-shm sidecar. The -shm is the WAL index
// in shared memory; SQLite touches it on *every* connection open — including
// our own read-only opens during a sync (listSessions/exportRawSession). With
// -shm watched, each sync's own DB reads bumped -shm's mtime, the poller saw a
// "change", and armed another sync — a self-sustaining ~10s loop that ran even
// when OpenCode wasn't running (verified 2026-07-13: -shm mtime advancing with
// no OpenCode process alive, ~830 spurious ticks per 2k log lines). Watching
// only .db + .db-wal breaks the loop: our reads don't append to -wal, so a
// genuine OpenCode write is still the only thing that fires an event.
const opencodeWatcher = chokidar.watch(
  [`${OPENCODE_DB_PATH}`, `${OPENCODE_DB_PATH}-wal`],
  {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 2500, pollInterval: 500 },
    ...POLL(10000),
  },
);

// 9. Per-project agent memory files (Claude Code ~/.claude/projects/<hash>/memory/*.md).
// Agents write reference/feedback/project-state notes here between sessions —
// the richest cross-session knowledge surface, now indexed + synced.
const agentMemoryWatcher = chokidar.watch(`${CLAUDE_DIR}/*/memory/*.md`, {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 },
  ...POLL(10000),
});

// 10. Cleanup marker — a change means Claude Code trimmed/deleted transcripts;
// schedule a reconcile ship so the server converges to the new on-disk set.
const cleanupWatcher = chokidar.watch(LAST_CLEANUP_PATH, {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 },
  ...POLL(30000),
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
  cleanup: cleanupWatcher,
};

// 11. Resume-guard — watched separately because its handler is NOT the
// debounced ship: it must snapshot the shadow immediately, before the resume
// rewrite lands. Fast poll for the same reason. `ignoreInitial: false` also
// snapshots whatever resume was last recorded when the daemon starts.
const resumeWatcher = chokidar.watch(CURRENT_RESUME_PATH, watchOpts({
  interval: 1000,
  ignoreInitial: false,
}));
resumeWatcher
  .on('add', (p) => { void onResumeSignal(p); })
  .on('change', (p) => { void onResumeSignal(p); })
  .on('error', (error) => { console.error(`[${ts()}] [resume-guard] watcher error:`, error); });

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
console.log(`  Resume-guard:      ${CURRENT_RESUME_PATH}`);
console.log(`  Debounce: ${DEBOUNCE_MS}ms · ships via syncIncremental() to the configured server`);
console.log(`  Ready for changes...`);

// Slow heartbeat: a quiet machine still converges even when no file
// events fire (e.g. sessions written while the daemon was down). Also
// kick one initial ship shortly after startup to drain any backlog.
setInterval(() => { void shipToServer('heartbeat'); }, 15 * 60 * 1000).unref();
setTimeout(() => { void shipToServer('startup'); }, 20_000);

// The bundle we booted with. A daemon keeps whatever code Node already parsed,
// so replacing dist/watch.js changes nothing until the process restarts — which
// silently kept THREE separate fixes out of effect for a day each (see
// self-restart.ts). Checked on the liveness tick: cheap (one stat) and frequent
// enough that a build is picked up within a minute.
const BOOT_CODE = codeFingerprint();
if (BOOT_CODE) {
  console.log(`[${ts()}] running bundle ${BOOT_CODE.path} (${BOOT_CODE.size} bytes)`);
}

// ── Log rotation ─────────────────────────────────────────────────────
//
// Only for the service managers whose redirection WE write: launchd's
// StandardOutPath and the Windows Scheduled Task's `>>`. A systemd unit we
// render sends output to the journal, which rotates itself — but units written
// before that change still carry `StandardOutput=append:…/watch.log`, so this
// runs there too.
//
// The rule (copy + truncate, never rename) and the incident that proved it live
// in log-rotate.ts, with the test that pins them.
{
  const r = rotateLogIfLarge(join(getDataDir(), 'watch.log'));
  if (r.rotated) {
    console.log(`[${ts()}] rotated watch.log at ${(r.sizeBefore / 1048576).toFixed(0)}MB → watch.log.1 (copy+truncate; the path is preserved)`);
  }
}

// ── Collector health ─────────────────────────────────────────────────
//
// The daemon crash-looped for eight days without telling anyone: systemd
// restarted it silently, the aborts went to a log nobody tails, and the only
// symptom a user could see was a lag number in the web app they happened to
// notice. This file is how the CLI, `doctor` and the MCP find out — a collector
// that cannot ship has to say so where the user already looks.
const PROC_START = Date.now();
const targetHealth: Record<string, TargetHealth> = {};

/** Recent process starts, so a crash loop is visible as a count. */
function recentStarts(): number[] {
  const prior = readCollectorHealth() as unknown as { starts?: number[] } | null;
  const cutoff = Date.now() - 3_600_000;
  return [...(prior?.starts ?? []), PROC_START]
    .filter((t) => typeof t === 'number' && t > cutoff)
    .filter((t, i, a) => a.indexOf(t) === i)
    .sort((a, b) => a - b)
    .slice(-20);
}

function publishHealth(): void {
  const starts = recentStarts();
  // MERGE, do not overwrite. The sync walk writes `progress` into this same
  // file; a plain write from the heartbeat would erase it every 60 seconds.
  updateCollectorHealth(Object.assign({
    v: 1 as const,
    updatedAt: Date.now(),
    startedAt: PROC_START,
    restartsLastHour: starts.length,
    targets: targetHealth,
  }, { starts }));
}

/** The servers this machine syncs to, for health reporting. Best-effort. */
function syncTargetUrls(): string[] {
  try { return loadAllCredentials().map((c) => c.serverUrl); } catch { return []; }
}

/** Record one target's sync outcome for the health file. */
function noteSyncOutcome(server: string, ok: boolean, err?: string): void {
  const t = targetHealth[server] ?? { lastOkAt: null, failures: 0 };
  if (ok) { t.lastOkAt = Date.now(); t.failures = 0; delete t.lastError; }
  else { t.failures += 1; t.lastError = (err ?? 'unknown error').slice(0, 160); }
  targetHealth[server] = t;
  publishHealth();
}

publishHealth();
{
  const n = recentStarts().length;
  if (n >= 3) {
    console.error(`[${ts()}] WARNING: this collector has restarted ${n} times in the last hour.`
      + ` Sync is probably falling behind. Health: ${collectorHealthPath()}`);
  }
}

// Liveness heartbeat for the journal.
setInterval(() => {
  // Before reporting liveness, make sure we are still the current code. Restarts
  // mid-sync are safe: the ledger only advances on server-acked writes, so an
  // interrupted pass re-ships rather than skipping.
  if (checkSelfRestart({ boot: BOOT_CODE, log: (m) => console.log(`[${ts()}] ${m}`) })) return;
  console.log(`[${ts()}] Heartbeat - ${pendingFileCount} pending file event(s), sync ${syncInFlight ? 'in-flight' : 'idle'}`);
  // Refresh updatedAt, so "has not reported in 30 minutes" means the daemon is
  // gone or wedged, rather than merely idle.
  publishHealth();
}, 60000);

// Cross-tool sync intents (Model B): poll the server(s) for queued intents the
// UI created and execute them locally. 45s cadence keeps "click in UI → files
// copied on disk" feeling prompt without hammering the server. Best-effort —
// errors are swallowed inside the drainer and retried next tick.
//
// The in-flight flag is a single point of failure: it is only cleared in the
// `finally`, so ONE await that never settles means the daemon stops draining
// forever, silently — no error, no log, just a queue that never empties (seen
// on adi-pc: 18 intents pending for days while the daemon logged healthy
// heartbeats the whole time). Every request in the drain path is now bounded,
// and this watchdog is the backstop for whatever comes next: if a tick has
// been running longer than any legitimate drain, say so and start a new one.
let intentDrainInFlight = false;
let intentDrainStartedAt = 0;
let intentDrainGeneration = 0;
const DRAIN_STALL_MS = 5 * 60_000;

/** @returns true when this tick actually applied something. */
async function drainIntentsTick(): Promise<boolean> {
  if (intentDrainInFlight) {
    const stuckMs = Date.now() - intentDrainStartedAt;
    if (stuckMs < DRAIN_STALL_MS) return false;
    console.error(`[${ts()}] sync-intents: previous drain has been running ${Math.round(stuckMs / 1000)}s — abandoning it and starting a fresh tick`);
  }
  intentDrainInFlight = true;
  intentDrainStartedAt = Date.now();
  // Generation guard: if an abandoned tick finally settles, its `finally` must
  // not clear the flag out from under the tick that replaced it.
  const gen = ++intentDrainGeneration;
  try {
    const r = await drainSyncIntents();
    if (r.processed > 0) {
      console.log(`[${ts()}] sync-intents: ${r.done} done, ${r.errored} errored`);
      // Applying an intent wrote files into toolkit dirs the chokidar watcher
      // does NOT watch — push them up now so the UI reflects the change in
      // seconds, instead of waiting for the 15-min heartbeat.
      if (r.done > 0) await shipToServer('intent-applied');
    }
    return r.processed > 0;
  } catch (err) {
    console.error(`[${ts()}] sync-intents drain failed: ${err instanceof Error ? err.message : err}`);
    return false;
  } finally {
    if (gen === intentDrainGeneration) intentDrainInFlight = false;
  }
}
// ADAPTIVE POLL. A fixed 15s tick is 5,760 requests a day PER TARGET for a
// queue that is almost always empty — and undici's idle keep-alive is 4s, so at
// that cadence nearly every one is a fresh TCP + TLS handshake. On a laptop
// that is a radio wake and a negotiation, thousands of times a day, to learn
// "nothing pending".
//
// Back off while idle, snap back the instant there is work: a user who clicks
// something in the UI still sees it applied within seconds, because any tick
// that finds work resets the interval to the floor.
const INTENT_POLL_MIN_MS = 15_000;
const INTENT_POLL_MAX_MS = 5 * 60_000;
let intentPollMs = INTENT_POLL_MIN_MS;
let intentTimer: NodeJS.Timeout | null = null;

function scheduleIntentPoll(ms: number): void {
  if (intentTimer) clearTimeout(intentTimer);
  intentTimer = setTimeout(async () => {
    const found = await drainIntentsTick();
    // Found work → poll eagerly again. Found nothing → double, up to the cap.
    intentPollMs = found ? INTENT_POLL_MIN_MS : Math.min(intentPollMs * 2, INTENT_POLL_MAX_MS);
    scheduleIntentPoll(intentPollMs);
  }, ms);
  intentTimer.unref?.();
}
scheduleIntentPoll(5_000);

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
  // Honor the SAME exclusions the sync path uses (local settings — the daemon
  // has no server tenant config here). Without this, code-intelligence walked
  // every session's project tree regardless of exclude rules — which on macOS
  // trips Photos/Music/Documents permission prompts when a path sits near a
  // protected folder, and indexes repos the user explicitly excluded. Excluded
  // = never handed to codeindex, so its filesystem walk never starts there.
  let excluded: string[] = [];
  let includeProjects: string[] = [];
  try {
    const s = loadSettings();
    excluded = [...(s.sync?.excludeProjects ?? []), ...(s.privacy?.projectDenylist ?? [])].filter(Boolean);
    includeProjects = (s.sync?.includeProjects ?? []).filter(Boolean);
  } catch { /* settings unreadable — no extra exclusions, personal-dir default still applies */ }
  const isExcluded = (p: string) => excluded.some((x) => p.includes(x));

  const candidates = [...newest.entries()]
    .filter(([p]) => !isExcluded(p))
    // Personal folders (Pictures/Music/Documents/…) are skipped by default —
    // opt a specific path back in via sync.includeProjects.
    .filter(([p]) => !isPersonalPath(p, includeProjects))
    .filter(([p]) => { try { return existsSync(p); } catch { return false; } })
    .filter(([p]) => isCodeWorkspace(p))
    .sort((a, b) => b[1] - a[1]);

  // Drop a directory that merely CONTAINS another candidate. A session whose
  // cwd was ~/code/personal made that whole tree a candidate, so codeindex was
  // handed the parent of twenty repos and spent 78 seconds on it before giving
  // up — every 180 minutes, forever.
  const roots = candidates.map(([p]) => p);
  const notAnAncestor = ([p]: [string, number]) =>
    !roots.some((other) => other !== p && other.startsWith(p.endsWith(sep) ? p : p + sep));

  return candidates.filter(notAnAncestor).slice(0, CODE_INDEX_MAX).map(([p]) => p);
}

/**
 * Is this directory actually a repository we can index?
 *
 * The log was full of `code intelligence: indexing /` and `indexing /tmp` and
 * `indexing /home/adi/code/personal`, each costing a process spawn and up to
 * 78 seconds before codeindex refused it — and each retried on the next sweep,
 * forever, because nothing here filtered on anything but existsSync.
 *
 * A marker file at the path itself is the test. Not a walk upward: the point is
 * to reject the PARENT of a repo, and a parent inherits nothing.
 */
const WORKSPACE_MARKERS = [
  '.git', 'package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'setup.py',
  'pom.xml', 'build.gradle', 'composer.json', 'Gemfile', 'mix.exs', 'deno.json',
];

function isCodeWorkspace(p: string): boolean {
  // Filesystem roots and home directories are never a workspace; codeindex
  // refuses them anyway, but only after we have paid for the spawn.
  try {
    const resolved = resolve(p);
    if (resolved === sep || resolved === homedir() || dirname(resolved) === resolved) return false;
  } catch { return false; }
  return WORKSPACE_MARKERS.some((m) => {
    try { return existsSync(join(p, m)); } catch { return false; }
  });
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
      // Per-workspace log line — when this tick OOMs or hangs, the log names
      // WHERE. (The 2026-07-03 crash hunt had to reconstruct this from GC
      // timestamps; never again.)
      const t0 = Date.now();
      console.log(`[${ts()}] code intelligence: indexing ${ws} …`);
      let result;
      try { result = await collectCode({ workspace: ws, binPath: bin }); }
      catch (e) {
        console.log(`[${ts()}] code intelligence: skipped ${ws} after ${Math.round((Date.now() - t0) / 1000)}s (${e instanceof Error ? e.message : e})`);
        continue;   // not a scannable workspace (codeindex refused) or transient — skip
      }
      for (const cred of creds) {
        const base = cred.serverUrl.replace(/\/+$/, '');
        const headers: Record<string, string> = { 'content-type': 'application/json', ...(cred.token ? { authorization: `Bearer ${cred.token}` } : {}) };
        try { await fetchWithTimeout(`${base}/api/code/index`, { method: 'POST', headers, body: JSON.stringify(result) }, 60_000); } catch { /* retry next tick */ }
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

// ── CLI self-update: keep the daemon current with the logged-in server ──────
// Checksum-pinned, same-origin, default-on for self-host (CHAT_RECALL_AUTO_UPDATE
// overrides). On success the watch service restarts onto the new binary.
async function autoUpdateTick(): Promise<void> {
  for (const cred of loadAllCredentials()) {
    const base = cred.serverUrl.replace(/\/+$/, '');
    const headers: Record<string, string> = cred.token ? { authorization: `Bearer ${cred.token}` } : {};
    try {
      const r = await runAutoUpdate(base, headers, CLI_VERSION);
      if (r.updated) console.log(`[${ts()}] auto-update: ${r.reason} (${base}) — restarting service`);
      else if (!/already current|disabled|no CLI release/.test(r.reason)) console.log(`[${ts()}] auto-update: ${r.reason} (${base})`);
    } catch { /* best effort — never crash the daemon */ }
  }
}
setTimeout(() => { void autoUpdateTick(); }, 30_000);
setInterval(() => { void autoUpdateTick(); }, 6 * 60 * 60 * 1000).unref();

// ── Collector-version migration: re-derive projects indexed by an older
//    collector once on startup (after any self-update settles). Reuses the
//    same collect+push path as codeIndexTick; the store prune cleans old FPs.
async function collectorMigrationOnce(): Promise<void> {
  const creds = loadAllCredentials();
  if (creds.length === 0) return;
  const { collectCode, resolveCodeindexBin, COLLECTOR_VERSION } = await import('@chat-recall/engine/core/code/collector.js');
  let bin: string;
  try { bin = await resolveCodeindexBin(true); } catch { return; }
  for (const cred of creds) {
    const base = cred.serverUrl.replace(/\/+$/, '');
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(cred.token ? { authorization: `Bearer ${cred.token}` } : {}) };
    const reindex = async (rootPath: string): Promise<boolean> => {
      try {
        const result = await collectCode({ workspace: rootPath, binPath: bin });
        const res = await fetchWithTimeout(`${base}/api/code/index`, { method: 'POST', headers, body: JSON.stringify(result) }, 60_000);
        return res.ok;
      } catch { return false; }
    };
    try {
      const r = await runCollectorMigration({ base, authHeaders: headers, current: COLLECTOR_VERSION, reindex, log: (m) => console.log(`[${ts()}] ${m}`) });
      if (r.reindexed || r.failed || r.missing) console.log(`[${ts()}] collector migration (${base}): re-derived ${r.reindexed}, failed ${r.failed}, skipped-missing ${r.missing}`);
    } catch { /* best effort */ }
  }
}
if (CODE_INDEX_ON) setTimeout(() => { void collectorMigrationOnce(); }, 150_000);

// ── Graceful shutdown ───────────────────────────────────────────────
// No child processes to reap anymore (summary generation moved
// server-side), so shutdown is just: close watchers, flush, exit.
function shutdown(signal: string): void {
  console.log(`[${ts()}] Received ${signal}, shutting down...`);
  // Coalesced ledger acks must reach disk before we go, or the next start
  // re-ships everything acked since the last flush.
  try { flushLedger(); } catch (e) { console.error(`[${ts()}] ledger flush on shutdown failed: ${String(e)}`); }
  for (const watcher of Object.values(watchers)) {
    void watcher.close();
  }
  if (debounceTimer) clearTimeout(debounceTimer);
  // Give in-flight logging a beat to flush, then exit.
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// WINDOWS HAS NO SIGTERM. `process.kill(pid,'SIGTERM')` and `schtasks /End`
// both map to TerminateProcess, so the handler above never ran: watchers stayed
// open, the debounce timer was never cleared, and an in-flight sync died
// mid-HTTP with its coalesced ledger acks still only in memory — which on the
// next start re-ships everything since the last flush.
//
// Ctrl+Break and console close DO raise events Node surfaces, and 'beforeExit'
// covers an ordinary run-to-completion. None of these fire on a hard kill;
// nothing can. What they do cover is every shutdown Windows lets us observe.
if (process.platform === 'win32') {
  process.on('SIGBREAK', () => shutdown('SIGBREAK'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
}
// Last line of defence on every platform: flush the ledger even if we are
// leaving for a reason nobody handled.
process.on('exit', () => { try { flushLedger(); } catch { /* leaving anyway */ } });
