#!/usr/bin/env node
/**
 * CLI for chat-recall.
 */

import { config } from 'dotenv';
import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { execSync } from 'child_process';

import { getDataDir, getIdentityFilePath, getHooksDir } from '@chat-recall/engine/core/paths.js';
import { claudeBackend } from '@chat-recall/engine/core/backends/claude.js';
import { resolveProjectId } from '@chat-recall/engine/core/project-resolver.js';
import { loadAllCredentials, type Credentials } from './sync-client.js';

// Load .env configuration
config();

// ── Remote scope (chat-recall server) ───────────────────────────────────────
// The CLI is a thin collector: it ships local sessions to a server (`sync`)
// and reads everything else back from that server over HTTP. It deliberately
// imports ZERO local-store / index / embedder code so the published binary
// has no native dependencies. Read commands therefore require a login.
//
// We talk to the FIRST logged-in target (the same one `loadCredentials()`
// resolves). Multi-target fan-out only applies to writes (sync/delete); reads
// have a single source of truth.

interface RemoteTarget { base: string; token: string; }

/** First logged-in target with its trailing slashes stripped, or null. */
function firstTarget(): RemoteTarget | null {
  const cred: Credentials | undefined = loadAllCredentials()[0];
  if (!cred) return null;
  return { base: cred.serverUrl.replace(/\/+$/, ''), token: cred.token };
}

/**
 * Resolve the first target or exit with the uniform "you must log in" message.
 * Every server-backed read command calls this so the user always gets the same
 * actionable error instead of a raw fetch failure.
 */
function requireTarget(): RemoteTarget {
  const t = firstTarget();
  if (!t) {
    console.error(chalk.red('Not logged in.'), 'Run', chalk.bold('chat-recall login <server-url>'), 'first.');
    process.exit(1);
  }
  return t;
}

/** GET <path> on the first target and parse JSON. Throws on non-2xx. */
async function serverGet<T>(path: string): Promise<T> {
  const t = requireTarget();
  const res = await fetch(t.base + path, { headers: t.token ? { authorization: `Bearer ${t.token}` } : {} });
  if (!res.ok) throw new Error(`server ${path}: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  return res.json() as Promise<T>;
}

/**
 * GET that tolerates 202 (pending-sync — the session's compute hasn't shipped
 * from its origin machine yet) and 404 (unknown id), returning the status so
 * callers render a friendly note instead of a stack trace.
 */
async function serverGetSoft<T>(path: string): Promise<{ status: number; data: T | null; message?: string }> {
  const t = requireTarget();
  const res = await fetch(t.base + path, { headers: t.token ? { authorization: `Bearer ${t.token}` } : {} });
  if (res.status === 202 || res.status === 404) {
    const body = await res.json().catch(() => ({}));
    return { status: res.status, data: null, message: (body as { message?: string }).message };
  }
  if (!res.ok) throw new Error(`server ${path}: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  return { status: res.status, data: (await res.json()) as T };
}

/** POST <path> with a JSON body on the first target and parse JSON. Throws on non-2xx. */
async function serverPost<T>(path: string, body: unknown): Promise<T> {
  const t = requireTarget();
  const res = await fetch(t.base + path, {
    method: 'POST',
    headers: t.token
      ? { 'content-type': 'application/json', authorization: `Bearer ${t.token}` }
      : { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`server ${path}: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  return res.json() as Promise<T>;
}

// Resolves to packages/cli/package.json from both src/ and the bundled dist/
const pkgVersion: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8')
).version;

const program = new Command();

program
  .name('chat-recall')
  .description('Semantic search for Claude Code sessions - recall and resume past conversations')
  .version(pkgVersion);

program
  .command('init')
  .description('Set up chat-recall: connect to your server, configure MCP, ship your local sessions')
  .option('--server <url>', 'chat-recall server URL to connect this machine to')
  .option('--token <token>', 'Self-host device token (skips the interactive OIDC login)')
  .option('--skip-mcp', 'Skip MCP server configuration')
  .option('--skip-sync', 'Skip the first session sync')
  .option('--with-codeindex', 'Force-download the codeindex binary during init. Default behavior is to detect an already-installed codeindex on PATH and register it as an MCP server.')
  .option('--skip-codeindex', 'Skip the codeindex companion entirely (no detection, no registration).')
  .option('--skip-service', 'Skip installing the per-user background sync service (Linux/macOS/Windows). By default init installs it so new conversations ship automatically.')
  .action(async (options: { server?: string; token?: string; skipMcp?: boolean; skipSync?: boolean; withCodeindex?: boolean; skipCodeindex?: boolean; skipService?: boolean }) => {
    try {
      console.log(chalk.bold('chat-recall init'));
      console.log();

      // Step 1: Detect available AI CLIs (so the user can see which tools'
      // sessions this machine will ship). No summary generation happens in the
      // thin collector — that's the server's job.
      console.log(chalk.bold('1. Detecting AI tools...'));
      const clis: { name: string; cmd: string; available: boolean }[] = [
        { name: 'Gemini CLI', cmd: 'gemini', available: false },
        { name: 'Claude CLI', cmd: 'claude', available: false },
        { name: 'OpenCode', cmd: 'opencode', available: false },
        { name: 'Codex', cmd: 'codex', available: false },
      ];

      for (const cli of clis) {
        try {
          execSync(`which ${cli.cmd}`, { stdio: 'pipe' });
          cli.available = true;
        } catch { /* not found */ }
      }

      for (const cli of clis) {
        const icon = cli.available ? chalk.green('found') : chalk.dim('not found');
        console.log(`   ${cli.name}: ${icon}`);
      }
      console.log();

      // Step 2: Connect to a server. If a URL was supplied (or none is logged
      // in yet) we drive the same login flow the `login` command uses, so
      // there's a single source of truth for credential minting. An existing
      // login is reused untouched.
      console.log(chalk.bold('2. Connecting to your server...'));
      let target = firstTarget();
      if (options.server) {
        await runLogin(options.server, { token: options.token });
        target = firstTarget();
      } else if (!target) {
        console.log(`   ${chalk.yellow('Not logged in.')} Pass ${chalk.bold('--server <url>')} to connect, or run ${chalk.bold('chat-recall login <server-url>')} now.`);
      }
      if (target) {
        console.log(`   ${chalk.green('Connected')} → ${target.base}`);
      }
      console.log();

      // Step 4: Configure MCP server
      if (!options.skipMcp) {
        console.log(chalk.bold('4. Configuring MCP server...'));
        const mcpJsonPath = join(homedir(), '.mcp.json');
        let mcpConfig: Record<string, unknown> = {};

        if (existsSync(mcpJsonPath)) {
          try {
            mcpConfig = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
          } catch {
            mcpConfig = {};
          }
        }

        const mcpServers = (mcpConfig.mcpServers || {}) as Record<string, unknown>;
        const projectRoot = join(import.meta.dirname, '..');

        // Prefer the installed `chat-recall-mcp` bin (on PATH after `npm i -g`
        // or a packaged binary). Fall back to the source-checkout path only in
        // an un-installed dev tree. Re-running `init` REPAIRS a stale entry
        // (e.g. an old `node <checkout>/dist/mcp.js`) instead of skipping it.
        let mcpBinOnPath = false;
        try { execSync('command -v chat-recall-mcp', { stdio: 'ignore' }); mcpBinOnPath = true; } catch { /* not installed */ }
        const launch: { command: string; args?: string[] } = mcpBinOnPath
          ? { command: 'chat-recall-mcp' }
          : { command: 'node', args: [join(projectRoot, 'dist', 'mcp.js')] };
        const DEFAULT_ALLOW = [
          'recall_search', 'recall_show', 'recall_index', 'recall_status',
          'recall_recent', 'recall_context', 'recall_summary', 'recall_suggest_resume',
          'recall_memory_search', 'recall_memory_status', 'recall_plans', 'recall_plan_show',
          'recall_tasks', 'recall_smart_resume', 'recall_project_context',
          'recall_project_dossier', 'recall_weekly_digest',
          'recall_kg_query', 'recall_kg_add', 'recall_kg_invalidate',
          'recall_kg_timeline', 'recall_kg_stats',
          'recall_diary_write', 'recall_diary_read',
          'recall_diff', 'recall_commits', 'recall_outcome', 'recall_markers',
          'recall_edits_timeline', 'recall_subagent_search', 'recall_files_touched',
          'recall_user_prompts', 'recall_decision_record', 'recall_analytics_summary',
          'recall_wake_up', 'recall_similar_sessions', 'recall_session_files',
          'recall_redundant_files', 'recall_set', 'recall_get', 'recall_kv_list',
          'recall_rename_session',
          'recall_help',
        ];
        // Cap the MCP server's V8 heap via the spawner: it's a long-lived
        // per-session process, and v8.setFlagsFromString can't change the
        // limit after startup (verified) — NODE_OPTIONS is the only knob
        // that works when the AI tool owns the spawn.
        const MCP_ENV = { NODE_OPTIONS: '--max-old-space-size=1024' };
        const existing = mcpServers['chat-recall'] as { command?: string; args?: string[]; alwaysAllow?: string[]; env?: Record<string, string> } | undefined;
        const isCurrent = !!existing && existing.command === launch.command &&
          JSON.stringify(existing.args ?? null) === JSON.stringify(launch.args ?? null) &&
          existing.env?.NODE_OPTIONS === MCP_ENV.NODE_OPTIONS;
        if (isCurrent) {
          console.log(`   MCP server: ${chalk.green('already configured')} in ${mcpJsonPath}`);
        } else {
          const entry: Record<string, unknown> = { command: launch.command, alwaysAllow: existing?.alwaysAllow ?? DEFAULT_ALLOW, env: { ...existing?.env, ...MCP_ENV } };
          if (launch.args) entry.args = launch.args;
          mcpServers['chat-recall'] = entry;
          mcpConfig.mcpServers = mcpServers;
          writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2));
          console.log(`   MCP server: ${chalk.green(existing ? 'repaired' : 'configured')} (→ ${launch.command}) in ${mcpJsonPath}`);
        }
      } else {
        console.log(chalk.bold('4. Skipping MCP configuration (--skip-mcp)'));
      }
      console.log();

      // Step 5: Codeindex companion. Three modes:
      //   1. --skip-codeindex      → do nothing
      //   2. (default)             → detect an already-installed codeindex on
      //                              PATH and register it as an MCP server
      //   3. --with-codeindex      → force-download the binary, then register
      //
      // Detect-and-register is the right default once the user has codeindex
      // installed somewhere (system PATH, ~/.local/bin/codeindex, etc.) — no
      // network call, no surprise. Force-download is for fresh setups.
      const skipCodeindex = options.skipCodeindex === true;
      const forceInstall = options.withCodeindex === true || process.env.CHAT_RECALL_WITH_CODEINDEX === '1';

      if (skipCodeindex) {
        console.log(chalk.bold('5. Skipping codeindex companion (--skip-codeindex)'));
      } else {
        const {
          checkCodeindexStatus,
          installCodeindex,
          registerCodeindexMcp,
          CODEINDEX_BIN_PATH,
        } = await import('@chat-recall/engine/core/companions.js');

        const detected = checkCodeindexStatus();

        if (detected.installed && !forceInstall) {
          console.log(chalk.bold('5. Detected codeindex companion'));
          console.log(`   ${chalk.green('codeindex')}: ${detected.path}`);
          if (!options.skipMcp) {
            const mcpJsonPath = join(homedir(), '.mcp.json');
            const reg = registerCodeindexMcp(mcpJsonPath, detected.path!);
            if (reg.added) console.log(`   ${chalk.green('codeindex MCP server registered')} in ${mcpJsonPath}`);
            else console.log(`   codeindex MCP server: ${chalk.green('already registered')}`);
          }
        } else if (forceInstall) {
          console.log(chalk.bold('5. Installing codeindex companion (--with-codeindex)...'));
          try {
            const result = await installCodeindex({ force: true });
            if (result.installed) {
              const sizeMb = result.size ? `${(result.size / 1024 / 1024).toFixed(1)} MB` : '?';
              console.log(`   ${chalk.green('codeindex installed')} (${sizeMb}) → ${result.path}`);
              if (!options.skipMcp) {
                const mcpJsonPath = join(homedir(), '.mcp.json');
                const reg = registerCodeindexMcp(mcpJsonPath, CODEINDEX_BIN_PATH);
                if (reg.added) console.log(`   ${chalk.green('codeindex MCP server registered')} in ${mcpJsonPath}`);
              }
            } else if (!result.prebuiltAvailable) {
              console.log(`   ${chalk.yellow('codeindex')}: ${result.unsupportedReason}`);
            }
          } catch (err) {
            const msg = String(err);
            console.log(`   ${chalk.yellow('codeindex install failed')}: ${msg}`);
            if (msg.includes('404')) {
              console.log(chalk.dim('   The codeindex release returned 404. If the repo is private,'));
              console.log(chalk.dim('   authenticate `gh` to it, or build from source.'));
            }
          }
        } else {
          console.log(chalk.bold('5. codeindex companion: not installed'));
          console.log(chalk.dim('   codeindex is a separate MCP server for code-level lookup —'));
          console.log(chalk.dim('   find_symbol, plan_change, get_change_impact, etc.'));
          console.log(chalk.dim('   To install: `chat-recall init --with-codeindex`'));
          console.log(chalk.dim('   Or grab the binary from https://github.com/munhq/codeindex'));
        }
      }
      console.log();

      // Step 6: First sync — collect this machine's local sessions and ship
      // them to the server. Skipped when there's no login (nothing to ship to)
      // or when --skip-sync is passed.
      if (!options.skipSync && firstTarget()) {
        console.log(chalk.bold('6. Shipping local sessions to your server...'));
        try {
          const { syncSessions } = await import('./sync-client.js');
          const r = await syncSessions();
          console.log(`   ${chalk.green(`Synced ${r.uploaded} session(s), ${r.items} item(s)`)} ${chalk.dim(`— ${r.links} links, ${r.derived} derived rows, ${r.kgTriples} KG triples, ${r.skipped} skipped, ${r.redactions} secrets redacted, ${r.findings} secret findings${r.scanned ? ` (scanned ${r.scanned} in ${r.scanMs}ms)` : ''}`)}`);
        } catch (err) {
          console.log(`   ${chalk.yellow('Sync failed')} — ${err instanceof Error ? err.message : err}`);
          console.log(`   ${chalk.dim('Re-run `chat-recall sync` once your server is reachable.')}`);
        }
      } else if (!options.skipSync) {
        console.log(chalk.bold('6. Skipping first sync (not logged in)'));
      } else {
        console.log(chalk.bold('6. Skipping first sync (--skip-sync)'));
      }
      console.log();

      // Step 7: Background sync. There is ONE writer (see docs/SYNC.md): the
      // MCP server (configured above) ticks `syncIncremental()` every few
      // minutes while Claude Code runs — cross-platform, zero-install, and that
      // is exactly when transcripts change. We deliberately DON'T install the
      // standalone chat-recall-watch service anymore: a second, unlocked writer
      // raced the sync ledger with the MCP one (clobbered coverage, CPU spin).
      // Users who want an always-on agent (headless boxes, no editor running)
      // opt in with `chat-recall watch --install-service`.
      console.log(chalk.bold('7. Background sync'));
      console.log(chalk.dim('   Runs via the MCP server while Claude Code is open (no extra service to install).'));
      console.log(chalk.dim('   Always-on / headless? Opt in with `chat-recall watch --install-service`.'));
      void options.skipService; // retained for back-compat; no longer changes behaviour
      console.log();

      // Done
      console.log(chalk.green.bold('Setup complete!'));
      console.log();
      console.log('chat-recall MCP tools (42): recall_search, recall_recent, recall_context,');
      console.log('  recall_summary, recall_show, recall_suggest_resume, recall_smart_resume,');
      console.log('  recall_project_context, recall_project_dossier, recall_weekly_digest,');
      console.log('  recall_status, recall_index, recall_memory_search, recall_memory_status,');
      console.log('  recall_plans, recall_plan_show, recall_tasks, recall_diff, recall_commits,');
      console.log('  recall_outcome, recall_markers, recall_edits_timeline, recall_help,');
      console.log('  recall_kg_query/add/invalidate/timeline/stats,');
      console.log('  recall_diary_write/read, recall_subagent_search, recall_files_touched,');
      console.log('  recall_user_prompts, recall_decision_record, recall_set/get/kv_list,');
      console.log('  recall_analytics_summary, recall_wake_up, recall_similar_sessions,');
      console.log('  recall_session_files, recall_redundant_files');
      // List codeindex's tools too if it's available — detected above.
      if (!skipCodeindex) {
        const { checkCodeindexStatus } = await import('@chat-recall/engine/core/companions.js');
        if (checkCodeindexStatus().installed) {
          console.log();
          console.log('codeindex MCP tools (16): status, search, find_symbol, find_word, get_outline,');
          console.log('  get_tree, get_imports, get_imported_by, find_callers, plan_change,');
          console.log('  get_hot_files, index_workspace, analyze, read_file, read_symbol,');
          console.log('  get_change_impact');
        }
      }
      console.log();
      console.log(`${chalk.dim('Background sync is running — new conversations ship automatically. Manage it with `chat-recall service status|uninstall`.')}`);
    } catch (err) {
      console.error(chalk.red('Error:'), err);
      process.exit(1);
    }
  });

program
  .command('index')
  .description('Collect local sessions and ship them to your server (alias for sync)')
  .option('-f, --force', 'Ignore the per-server ledger and re-ship everything', false)
  .action(async (options: { force?: boolean }) => {
    try {
      // The thin collector has no local index to build. `index` stays as a
      // familiar verb but is now a collect-and-ship: --force walks every
      // session (ledger disabled) so a previously-shipped session re-uploads.
      const { syncSessions } = await import('./sync-client.js');
      const r = await syncSessions(options.force ? { useLedger: false } : {});
      console.log(chalk.green(`✓ Synced ${r.uploaded} session(s), ${r.items} item(s)`) + chalk.dim(` — ${r.links} links, ${r.derived} derived rows, ${r.kgTriples} KG triples, ${r.skipped} skipped, ${r.redactions} secrets redacted, ${r.findings} secret findings${r.scanned ? ` (scanned ${r.scanned} in ${r.scanMs}ms)` : ''}`));
    } catch (err) {
      console.error(chalk.red('Error:'), err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command('search <query>')
  .description('Search your server for relevant sessions (requires login)')
  .option('-n, --top <number>', 'Number of results to show', '5')
  .option('-p, --project <path>', 'Filter by project path (substring match)')
  .action(async (query, options: { top: string; project?: string }) => {
    try {
      const topK = parseInt(options.top, 10);
      // Server-backed: POST /api/search runs the server's FTS/vector search and
      // returns display-ready rows (firstPrompt, summary, matched chunks).
      const remote = await serverPost<{
        results: Array<{
          sessionId: string;
          score: number;
          projectPath: string;
          firstPrompt: string;
          summary?: string;
          matchedChunks?: Array<{ chunkType: string; text: string }>;
        }>;
        count: number;
      }>('/api/search', { query, topK, projectFilter: options.project });

      const results = remote.results;
      if (results.length === 0) {
        console.log(chalk.yellow('No matching sessions found.'));
        process.exit(0);
      }

      console.log();
      console.log(`${chalk.bold('Results for:')} "${query}"`);
      console.log();

      for (let i = 0; i < results.length; i++) {
        const result = results[i];

        let projectPath = result.projectPath || '';
        if (projectPath.length > 50) projectPath = '...' + projectPath.slice(-47);

        let title = (result.firstPrompt || '').replace(/\n/g, ' ').trim();
        if (title.length > 80) title = title.slice(0, 80) + '...';

        const scorePct = Math.round(result.score * 100);

        console.log(`${chalk.bold.cyan(`#${i + 1}`)} ${title}`);
        if (projectPath) console.log(`   ${chalk.dim('Project:')} ${projectPath}`);
        console.log(`   ${chalk.dim('Score:')} ${scorePct}/100`);

        if (result.summary) {
          let summary = result.summary.replace(/\n/g, ' ').trim();
          if (summary.length > 200) summary = summary.slice(0, 200) + '...';
          console.log(`   ${chalk.yellow('Summary:')} ${summary}`);
        }

        // First non-title matched chunk gives a hint of where the hit landed.
        const chunk = (result.matchedChunks || []).find(
          (c) => c.chunkType !== 'summary' && c.chunkType !== 'first_prompt',
        );
        if (chunk) {
          const label = chunk.chunkType === 'assistant' ? 'Discussed' :
                        chunk.chunkType === 'user_context' ? 'Asked about' :
                        chunk.chunkType === 'tool_result' ? 'Tool result' :
                        'Context';
          let text = chunk.text.replace(/\n/g, ' ').trim();
          if (text.length > 150) text = text.slice(0, 150) + '...';
          console.log(`   ${chalk.magenta(label + ':')} ${text}`);
        }

        console.log(`   ${chalk.green('Resume:')} claude --resume ${result.sessionId}`);
        console.log();
      }
    } catch (err) {
      console.error(chalk.red('Error:'), err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Show your server\'s sync status and statistics (requires login)')
  .action(async () => {
    try {
      // Two cheap server reads mirror the MCP recall_status: /api/status gives
      // chunk + per-project session counts; /api/status/sync gives the
      // coverage/freshness panel. There is no local index to report.
      const status = await serverGet<{ totalChunks: number; totalSessions: number; projects: Record<string, number> }>('/api/status');
      const sync = await serverGet<{ sessions: number; sourceTypes: Record<string, number>; rawArchived: number; newestSessionAgeMs: number | null }>('/api/status/sync');

      console.log(chalk.bold('Chat-Recall Server Status'));
      console.log();
      console.log(`Synced sessions: ${sync.sessions}`);
      console.log(`FTS5 chunks: ${status.totalChunks}`);
      console.log(`Raw archives: ${sync.rawArchived}`);
      if (sync.newestSessionAgeMs !== null) {
        const mins = Math.round(sync.newestSessionAgeMs / 60000);
        console.log(`Freshness: newest synced session ${mins} min ago`);
      }

      const types = Object.entries(sync.sourceTypes).filter(([, n]) => Number(n) > 0);
      if (types.length > 0) {
        console.log();
        console.log(chalk.bold('By source type:'));
        for (const [type, n] of types) console.log(`  ${type}: ${n} items`);
      }

      const projects = Object.entries(status.projects || {}).sort((a, b) => b[1] - a[1]).slice(0, 10);
      if (projects.length > 0) {
        console.log();
        console.log(chalk.bold('Top projects:'));
        for (const [proj, n] of projects) console.log(`  ${proj}: ${n} sessions`);
      }
    } catch (err) {
      console.error(chalk.red('Error:'), err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command('optimize')
  .description('Deprecated: storage is server-side now, nothing to optimize locally')
  .action(() => {
    // The thin collector keeps no local LanceDB/SQLite index — all storage and
    // compaction live on the server. Kept as a no-op so existing scripts and
    // cron jobs that call it don't error out.
    console.log(chalk.dim('Storage is server-side now; there is no local index to optimize.'));
    console.log(chalk.dim('Run `chat-recall sync` to ship sessions; the server manages its own storage.'));
    process.exit(0);
  });

program
  .command('show <session_id>')
  .description('Show conversation content from a session (requires login)')
  .option('-m, --messages <number>', 'Number of messages to show', '10')
  .option('-f, --full', 'Show full conversation (all messages)', false)
  .action(async (sessionId: string, options: { messages: string; full?: boolean }) => {
    try {
      // Server holds the full message list (rebuilt from synced chunks). limit=0
      // returns the whole session; each row's `content` is already display text.
      const soft = await serverGetSoft<{
        sessionId: string;
        messages: Array<{ line: number; role: string; content: string }>;
        total: number;
      }>(`/api/conversations/${encodeURIComponent(sessionId)}?limit=0`);

      if (!soft.data || soft.data.messages.length === 0) {
        console.log(chalk.yellow(soft.message || `Session not found: ${sessionId}`));
        process.exit(soft.status === 404 ? 1 : 0);
      }
      const messagesList = soft.data.messages;

      console.log(chalk.bold('Session:'), sessionId);
      console.log();

      // Without --full, show the first N messages (server returns them in order).
      const maxMessages = parseInt(options.messages, 10);
      const displayMessages = options.full ? messagesList : messagesList.slice(0, maxMessages);

      for (const msg of displayMessages) {
        let text = msg.content;
        if (!options.full && text.length > 1000) text = text.slice(0, 1000) + '...';

        if (msg.role === 'user') {
          console.log(`${chalk.bold.blue('User')} ${chalk.dim(`(line ${msg.line})`)}`);
        } else if (msg.role === 'assistant') {
          console.log(`${chalk.bold.green('Assistant')} ${chalk.dim(`(line ${msg.line})`)}`);
        } else {
          console.log(chalk.bold.yellow(msg.role));
        }
        console.log(text);
        console.log();
      }

      console.log(chalk.dim(`Showing ${displayMessages.length} of ${messagesList.length} messages. Use --full for the complete conversation.`));
      console.log(chalk.dim(`Resume: claude --resume ${sessionId}`));
    } catch (err) {
      console.error(chalk.red('Error:'), err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

// --- Memory command group ---
const memory = program
  .command('memory')
  .description('Unified memory system - index and search across all data sources');

memory
  .command('index')
  .description('Collect local sessions and ship them to your server (alias for sync)')
  .option('-f, --force', 'Ignore the per-server ledger and re-ship everything', false)
  .action(async (options: { force?: boolean }) => {
    try {
      // No local memory index in the thin collector — `memory index` ships the
      // same way `sync`/`index` do. All source-type extraction + chunking now
      // happens on the server when it ingests the synced sessions.
      const { syncSessions } = await import('./sync-client.js');
      const r = await syncSessions(options.force ? { useLedger: false } : {});
      console.log(chalk.green(`✓ Synced ${r.uploaded} session(s), ${r.items} item(s)`) + chalk.dim(` — ${r.links} links, ${r.derived} derived rows, ${r.kgTriples} KG triples, ${r.skipped} skipped, ${r.redactions} secrets redacted, ${r.findings} secret findings${r.scanned ? ` (scanned ${r.scanned} in ${r.scanMs}ms)` : ''}`));
    } catch (err) {
      console.error(chalk.red('Error:'), err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

memory
  .command('search <query>')
  .description('Search across all memory types on your server (requires login)')
  .option('-n, --top <number>', 'Number of results', '10')
  .option('-t, --types <types>', 'Filter by source types (comma-separated)')
  .action(async (query: string, options: { top: string; types?: string }) => {
    try {
      const topK = parseInt(options.top, 10);
      const sourceTypes = options.types ? options.types.split(',') : undefined;

      // Server-backed: POST /api/memory/search returns ranked rows across every
      // source type (session, plan, task, claude_md, history, paste, diary).
      const remote = await serverPost<{
        results: Array<{ itemId: string; sourceType: string; title: string; text: string; score: number; projectPath?: string; chunkType?: string }>;
        count: number;
      }>('/api/memory/search', { query, topK, sourceTypes });

      const results = remote.results;
      if (results.length === 0) {
        console.log(chalk.yellow('No matching results found.'));
        process.exit(0);
      }

      console.log();
      console.log(`${chalk.bold('Memory search:')} "${query}"`);
      console.log();

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const scorePct = Math.round(r.score * 100);

        const typeColor = ({
          session: chalk.blue,
          plan: chalk.green,
          task: chalk.yellow,
          claude_md: chalk.magenta,
          history: chalk.cyan,
          paste: chalk.gray,
          diary: chalk.redBright,
        } as Record<string, typeof chalk.white>)[r.sourceType] || chalk.white;

        const typeBadge = typeColor(`[${r.sourceType}]`);

        let title = (r.title || '').replace(/\n/g, ' ').trim();
        if (title.length > 70) title = title.slice(0, 67) + '...';

        console.log(`${chalk.bold.cyan(`#${i + 1}`)} ${typeBadge} ${title}`);

        if (r.projectPath) {
          let pp = r.projectPath;
          if (pp.length > 50) pp = '...' + pp.slice(-47);
          console.log(`   ${chalk.dim('Project:')} ${pp}`);
        }

        const typeSuffix = r.chunkType ? `  ${chalk.dim('Type:')} ${r.chunkType}` : '';
        console.log(`   ${chalk.dim('Score:')} ${scorePct}/100${typeSuffix}`);

        let preview = (r.text || '').replace(/\n/g, ' ').trim();
        if (preview.length > 150) preview = preview.slice(0, 147) + '...';
        if (preview) console.log(`   ${preview}`);

        if (r.sourceType === 'session') {
          console.log(`   ${chalk.green('Resume:')} claude --resume ${r.itemId}`);
        }

        console.log();
      }
    } catch (err) {
      console.error(chalk.red('Error:'), err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

memory
  .command('status')
  .description('Show your server\'s memory statistics across all source types (requires login)')
  .action(async () => {
    try {
      // Server-backed aggregate. Vector/index-path fields are local-only and
      // don't exist in the thin collector — only FTS5 chunk count and the
      // per-(source,tool) breakdown come back from the server.
      const status = await serverGet<{
        totalChunks: number;
        totalItems: number;
        linkCount: number;
        bySourceType: Record<string, { items: number; chunks: number }>;
        bySourceAndTool: Record<string, Record<string, number>>;
      }>('/api/memory/status');

      console.log(chalk.bold('Memory System Status'));
      console.log();
      console.log(`Total items: ${status.totalItems}`);
      console.log(`FTS5 chunks: ${status.totalChunks}`);
      console.log(`Total links: ${status.linkCount}`);

      const bySource = Object.entries(status.bySourceType || {});
      if (bySource.length > 0) {
        console.log();
        console.log(chalk.bold('By source type:'));
        for (const [type, data] of bySource) {
          console.log(`  ${type}: ${data.items} items, ${data.chunks} chunks`);
        }
      }

      const byTool = Object.entries(status.bySourceAndTool || {});
      if (byTool.length > 0) {
        console.log();
        console.log(chalk.bold('By source type and tool:'));
        for (const [type, tools] of byTool) {
          const parts = Object.entries(tools).map(([t, n]) => `${t}: ${n}`).join(', ');
          console.log(`  ${type}: ${parts}`);
        }
      }
    } catch (err) {
      console.error(chalk.red('Error:'), err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

memory
  .command('links <source_type> <item_id>')
  .description('Show relationships for a memory item (requires login)')
  .action(async (sourceType: string, itemId: string) => {
    try {
      // Server-backed: GET /api/memory/links/:type/:id returns the same
      // MemoryLinkRow shape the local store used to (source/target type+id,
      // link_type, confidence).
      const { links } = await serverGet<{
        links: Array<{ source_type: string; source_id: string; target_type: string; target_id: string; link_type: string; confidence: number }>;
        count: number;
      }>(`/api/memory/links/${encodeURIComponent(sourceType)}/${encodeURIComponent(itemId)}`);

      if (links.length === 0) {
        console.log(chalk.yellow('No links found.'));
        return;
      }

      console.log(chalk.bold(`Links for ${sourceType}:${itemId}`));
      console.log();

      for (const link of links) {
        const direction = link.source_id === itemId ? '->' : '<-';
        const otherType = link.source_id === itemId ? link.target_type : link.source_type;
        const otherId = link.source_id === itemId ? link.target_id : link.source_id;
        const confidence = Math.round(link.confidence * 100);

        console.log(`  ${direction} ${chalk.bold(otherType)}:${otherId.slice(0, 20)} [${link.link_type}] (${confidence}%)`);
      }
    } catch (err) {
      console.error(chalk.red('Error:'), err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

memory
  .command('wake-up')
  .description('Generate wake-up context (high-importance facts + knowledge graph snapshot) for an AI session (requires login)')
  .option('-p, --project <filter>', 'Restrict facts/KG to a project (substring match)')
  .action(async (options: { project?: string }) => {
    try {
      // Identity stays local — it's a tiny user-owned file the server never
      // sees. Everything else (high-importance facts, KG snapshot) is fetched
      // from /api/memory/wake-up, which runs the same classifier-filtered FTS
      // query + current-facts timeline server-side.
      const identityFile = getIdentityFilePath();
      let identity = 'AI coding assistant';
      if (existsSync(identityFile)) {
        identity = readFileSync(identityFile, 'utf-8').trim();
      }

      const lines = [
        chalk.bold('# Wake-Up Context'),
        chalk.bold('──────────────────'),
        '',
        chalk.bold('## Identity'),
        identity,
        '',
      ];

      const qs = options.project ? `?project_filter=${encodeURIComponent(options.project)}` : '';
      const wake = await serverGet<{
        highFacts: Array<{ type: string; text: string }>;
        kg: { stats: { entities?: number; current_facts?: number }; facts: Array<{ subject: string; predicate: string; object: string }> };
      }>(`/api/memory/wake-up${qs}`);

      if (wake.highFacts.length > 0) {
        lines.push(chalk.bold('## High-Importance Facts'));
        for (const fact of wake.highFacts) {
          lines.push(`  [${fact.type}] ${fact.text}`);
        }
        lines.push('');
      }

      if (wake.kg.facts.length > 0) {
        lines.push(chalk.bold('## Knowledge Graph'));
        const { entities, current_facts } = wake.kg.stats;
        if (entities !== undefined || current_facts !== undefined) {
          lines.push(chalk.dim(`${entities ?? 0} entities, ${current_facts ?? 0} current facts`));
        }
        for (const fact of wake.kg.facts) {
          lines.push(`  ${fact.subject} → ${fact.predicate} → ${fact.object}`);
        }
        lines.push('');
      }

      console.log(lines.join('\n'));
    } catch (err) {
      console.error(chalk.red('Error:'), err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

/**
 * `chat-recall doctor` — single-command health check.
 *
 * Tells the user, at a glance, whether each subsystem is OK. Useful for support
 * questions ("is my install working?") and for the launch demo where we can
 * show a green-row screenshot before doing anything else.
 */
program
  .command('doctor')
  .description('Quick health check across login, server, credentials, hooks, MCP server, and codeindex')
  .option('--purge-local', 'Remove the legacy local index (cache.db + vector/KG files) left by pre-thin-collector versions — storage is server-side now. Requires login; keeps credentials, sync ledger, identity, and the audit log.')
  .action(async (opts: { purgeLocal?: boolean }) => {
    const { existsSync, readFileSync, statSync } = await import('fs');
    const { execSync } = await import('child_process');

    type Row = { ok: boolean; label: string; detail?: string };
    const rows: Row[] = [];
    const note = (ok: boolean, label: string, detail?: string) => rows.push({ ok, label, detail });

    // Login — the thin collector reads everything back from a server, so a
    // login is the precondition for every read command.
    const targets = loadAllCredentials();
    const target = targets[0] ? { base: targets[0].serverUrl.replace(/\/+$/, ''), token: targets[0].token } : null;
    if (!target) {
      note(false, 'Logged in', 'no credentials — run `chat-recall login <server-url>`');
    } else {
      note(true, 'Logged in', `${targets.length} target(s); primary: ${target.base}`);
    }

    // Server reachability — GET /api/capabilities is unauthenticated and cheap,
    // and confirms the server is up and speaks a version we can sync to.
    if (target) {
      try {
        const caps = await fetch(`${target.base}/api/capabilities`).then((r) => r.json() as Promise<{ apiVersion?: number; edition?: string }>);
        note((caps.apiVersion ?? 0) >= 2, 'Server reachable', `apiVersion ${caps.apiVersion ?? 'unknown'}${caps.edition ? `, edition ${caps.edition}` : ''}`);
      } catch (err) {
        note(false, 'Server reachable', `unreachable: ${err instanceof Error ? err.message : err}`);
      }
    } else {
      note(false, 'Server reachable', 'N/A (not logged in)');
    }

    // Credentials file perms — the token grants sync access, so it must be 0600.
    const credFile = join(getDataDir(), 'credentials.json');
    if (!existsSync(credFile)) {
      note(false, 'Credentials file', `missing — run \`chat-recall login <server-url>\``);
    } else {
      try {
        const mode = statSync(credFile).mode & 0o777;
        // 0o600 (owner-only) is the safe default saveCredentials sets. Group/
        // world-readable bits expose the bearer token to other local users.
        const safe = (mode & 0o077) === 0;
        note(safe, 'Credentials file', `${credFile} (mode ${mode.toString(8).padStart(3, '0')}${safe ? '' : ' — should be 600'})`);
      } catch (err) {
        note(false, 'Credentials file', `error: ${err}`);
      }
    }

    // Hooks (Claude-specific)
    const hooksJson = claudeBackend.hooksFile();
    if (!existsSync(hooksJson)) {
      note(false, 'Claude Code hooks', `no ${hooksJson} — run \`chat-recall install-hooks\``);
    } else {
      try {
        const cfg = JSON.parse(readFileSync(hooksJson, 'utf-8'));
        const all = ['Stop', 'PreCompact', 'UserPromptSubmit'];
        const hits: string[] = [];
        for (const ev of all) {
          const arr = Array.isArray(cfg.hooks?.[ev]) ? cfg.hooks[ev] : [];
          if (arr.some((h: any) => (h.hooks?.[0]?.command || '').includes('chat_recall'))) hits.push(ev);
        }
        note(hits.length > 0, 'Claude Code hooks', `installed for: ${hits.join(', ') || 'none — run install-hooks'}`);
      } catch {
        note(false, 'Claude Code hooks', `${hooksJson} unparseable`);
      }
    }

    // MCP server registration
    const mcpJsonPath = join(homedir(), '.mcp.json');
    if (!existsSync(mcpJsonPath)) {
      note(false, 'MCP server registration', `no ${mcpJsonPath} — run \`chat-recall init\``);
    } else {
      try {
        const cfg = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
        const has = !!cfg.mcpServers?.['chat-recall'];
        note(has, 'chat-recall MCP server', has ? `registered in ${mcpJsonPath}` : 'not registered — run `chat-recall init`');
      } catch {
        note(false, 'chat-recall MCP server', `${mcpJsonPath} unparseable`);
      }
    }

    // Codeindex companion
    try {
      const { checkCodeindexStatus } = await import('@chat-recall/engine/core/companions.js');
      const ci = checkCodeindexStatus();
      if (ci.installed) {
        note(true, 'codeindex companion', `${ci.path}${ci.size ? ` · ${(ci.size / 1024 / 1024).toFixed(1)} MB` : ''}`);
      } else {
        note(false, 'codeindex companion', 'not installed (optional — needed for code-level lookup)');
      }
    } catch (err) {
      note(false, 'codeindex companion', `error: ${err}`);
    }

    // Watch daemon detection — cross-platform (best effort). Checks the
    // installed per-user service first (the supported way to keep collection
    // running), then falls back to a foreground process scan on Unix. `pgrep`
    // exists on Linux AND macOS but NOT Windows, so Windows uses tasklist +
    // the Scheduled Task query instead.
    let watchRunning = false;
    const tryCmd = (cmd: string): string => {
      try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch { return ''; }
    };
    if (process.platform === 'win32') {
      // Scheduled Task present + running, or a node process running watch.js.
      watchRunning = /Running/i.test(tryCmd('schtasks /query /tn chat-recall-watch /fo LIST /v 2>nul'));
      if (!watchRunning) watchRunning = /watch\.js/i.test(tryCmd('wmic process where "name=\'node.exe\'" get commandline 2>nul'));
    } else if (process.platform === 'darwin') {
      watchRunning = /com\.chat-recall\.watch/.test(tryCmd('launchctl list 2>/dev/null'));
    } else {
      // systemd is-active is authoritative; skip the pgrep fallback (it
      // self-matches the bash -c that runs the check, causing false positives).
      watchRunning = /active/.test(tryCmd('systemctl --user is-active chat-recall-watch.service 2>/dev/null'));
    }
    note(watchRunning, 'Watch daemon', watchRunning ? 'running' : 'not running (run `chat-recall watch --install-service` to keep collection running)');

    // Legacy local index — pre-thin-collector versions kept a local SQLite
    // store + vector/KG files here. The thin collector stores everything
    // server-side, so these are dead weight. We never auto-delete them; the
    // opt-in --purge-local flag (plus a login check, so history is already on
    // the server) is the explicit approval. Credentials, the sync ledger,
    // identity, and the WAL audit log are NOT touched.
    const dataDir = getDataDir();
    const legacyPaths = [
      join(dataDir, 'cache.db'), join(dataDir, 'cache.db-wal'), join(dataDir, 'cache.db-shm'),
      join(dataDir, 'index', 'lancedb'), join(dataDir, 'index', 'knowledge_graph.db'), join(dataDir, 'index', 'metadata.db'),
    ];
    const legacyPresent = legacyPaths.filter((p) => existsSync(p));

    if (opts.purgeLocal) {
      if (!target) {
        note(false, 'Purge legacy index', 'refused — log in and `chat-recall sync` first, so your history is on the server before removing local copies');
      } else if (legacyPresent.length === 0) {
        note(true, 'Purge legacy index', 'nothing to remove');
      } else {
        const { rmSync } = await import('fs');
        let removed = 0;
        for (const p of legacyPresent) {
          try { rmSync(p, { recursive: true, force: true }); removed++; } catch { /* leave the rest */ }
        }
        note(removed === legacyPresent.length, 'Purge legacy index', `removed ${removed}/${legacyPresent.length} legacy item(s); kept credentials, ledger, identity, audit log`);
      }
    } else if (legacyPresent.length > 0) {
      note(true, 'Legacy local index', `${legacyPresent.length} unused item(s) from old versions — reclaim space with \`chat-recall doctor --purge-local\``);
    } else {
      note(true, 'Legacy local index', 'none (clean)');
    }

    // Render
    console.log(chalk.bold('\nchat-recall doctor\n'));
    for (const r of rows) {
      const icon = r.ok ? chalk.green('✓') : chalk.yellow('•');
      console.log(`  ${icon} ${r.label.padEnd(28)} ${chalk.dim(r.detail || '')}`);
    }
    const failures = rows.filter(r => !r.ok).length;
    console.log();
    if (failures === 0) {
      console.log(chalk.green('All systems green.'));
    } else {
      console.log(chalk.dim(`${failures} item${failures === 1 ? '' : 's'} need attention.`));
    }
  });

// Companion-tools subcommands. Currently `codeindex` is the only companion.
// Default is "install when running chat-recall init"; this group lets users
// inspect/manage it after the fact.
const companions = program
  .command('companions')
  .description('Manage companion tools (codeindex)');

companions
  .command('status')
  .description('Show whether codeindex is installed and what it provides')
  .action(async () => {
    const { checkCodeindexStatus } = await import('@chat-recall/engine/core/companions.js');
    const s = checkCodeindexStatus();
    console.log(chalk.bold('codeindex status'));
    if (s.installed) {
      console.log(`  ${chalk.green('✓ installed')}`);
      if (s.path) console.log(`  path:        ${s.path}`);
      if (s.size) console.log(`  size:        ${(s.size / 1024 / 1024).toFixed(1)} MB`);
      if (s.version) console.log(`  version:     ${s.version}`);
    } else {
      console.log(`  ${chalk.yellow('not installed')}`);
      if (!s.prebuiltAvailable) {
        console.log(`  ${chalk.dim(s.unsupportedReason || 'no prebuilt binary for this platform')}`);
      } else {
        console.log(`  ${chalk.dim(`run \`chat-recall companions install\` to fetch ${s.artifactName}`)}`);
      }
    }
    console.log();
    console.log(chalk.dim('codeindex provides code-level lookup as a separate MCP server:'));
    console.log(chalk.dim('  find_symbol, find_callers, get_imports, plan_change,'));
    console.log(chalk.dim('  get_change_impact, analyze (security/dead_code/coupling/cycles/...)'));
  });

companions
  .command('install')
  .description('Install codeindex (downloads from munhq/codeindex GitHub release)')
  .option('--force', 'Re-download even if already installed')
  .action(async (opts: { force?: boolean }) => {
    const { installCodeindex, registerCodeindexMcp, CODEINDEX_BIN_PATH } = await import('@chat-recall/engine/core/companions.js');
    try {
      const result = await installCodeindex({ force: opts.force });
      if (!result.prebuiltAvailable && !result.installed) {
        console.log(chalk.yellow(`codeindex: ${result.unsupportedReason}`));
        console.log(chalk.dim('  Build from source: https://github.com/munhq/codeindex#install'));
        return;
      }
      if (result.installed) {
        const sizeMb = result.size ? `${(result.size / 1024 / 1024).toFixed(1)} MB` : '?';
        console.log(chalk.green(`✓ codeindex installed (${sizeMb}) → ${result.path}`));
        const mcpJsonPath = join(homedir(), '.mcp.json');
        const reg = registerCodeindexMcp(mcpJsonPath, CODEINDEX_BIN_PATH);
        if (reg.added) console.log(chalk.dim(`  Registered as MCP server in ${mcpJsonPath}`));
        else console.log(chalk.dim(`  Already registered as MCP server`));
      }
    } catch (err) {
      const msg = String(err);
      console.error(chalk.red(`codeindex install failed: ${msg}`));
      if (msg.includes('404')) {
        console.error(chalk.dim('  The codeindex release is currently private. Either authenticate `gh`'));
        console.error(chalk.dim('  to munhq/codeindex, or build from source: https://github.com/munhq/codeindex'));
      } else {
        console.error(chalk.dim('  This does not block chat-recall — it just disables code-level lookup.'));
      }
      process.exit(1);
    }
  });

companions
  .command('uninstall')
  .description('Remove the codeindex binary chat-recall installed (does not touch your other tools)')
  .action(async () => {
    const { uninstallCodeindex, unregisterCodeindexMcp } = await import('@chat-recall/engine/core/companions.js');
    const r = uninstallCodeindex();
    if (r.removed) console.log(chalk.green(`✓ Removed ${r.path}`));
    else console.log(chalk.dim(`  Nothing to remove at ${r.path}`));
    const mcpJsonPath = join(homedir(), '.mcp.json');
    const u = unregisterCodeindexMcp(mcpJsonPath);
    if (u.removed) console.log(chalk.dim(`  Unregistered MCP server from ${mcpJsonPath}`));
  });

// ── code: index a repo with codeindex + ship findings to the server ──────
// The collector runs LOCALLY (needs the repo files + git history), then POSTs
// its output to /api/code/index. The dashboard reads it back. Mirrors the
// thin-collector model: compute on the machine, store + render on the server.
const code = program
  .command('code')
  .description('Index a codebase with codeindex and ship findings/hotspots/actions to your server');

code
  .command('index [path]')
  .description('Run codeindex on a repo (default: cwd) and sync the results to your server')
  .option('--no-install', "Don't auto-install codeindex if missing")
  .action(async (path: string | undefined, opts: { install?: boolean }) => {
    try {
      const target = requireTarget();
      const { collectCode } = await import('@chat-recall/engine/core/code/collector.js');
      const workspace = resolve(path || process.cwd());
      console.log(chalk.bold(`code index ${workspace}`));
      const result = await collectCode({
        workspace,
        autoInstall: opts.install !== false,
        log: (m) => console.log(chalk.dim('  · ' + m)),
      });
      const resp = await serverPost<{ ok: boolean; projectId: string; findings: number; hotspots: number; actions: number }>(
        '/api/code/index',
        result,
      );
      console.log(chalk.green('✓ synced'), chalk.dim(`→ ${target.base}`));
      console.log(`  project:  ${resp.projectId}`);
      console.log(`  health:   ${result.project.health.score}/100`);
      console.log(`  findings: ${resp.findings}  hotspots: ${resp.hotspots}  actions: ${resp.actions}`);
    } catch (err) {
      console.error(chalk.red('code index failed:'), err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

code
  .command('status')
  .description('List code-indexed projects on your server')
  .action(async () => {
    try {
      const { projects } = await serverGet<{ projects: Array<{ projectId: string; health: { score: number; findings: number }; lastIndexedAt: number; label?: string | null }> }>('/api/code/projects');
      if (!projects.length) { console.log(chalk.dim('No code-indexed projects yet. Run `chat-recall code index` in a repo.')); return; }
      console.log(chalk.bold(`${projects.length} code project(s)`));
      for (const p of projects) {
        const when = new Date(p.lastIndexedAt).toISOString().slice(0, 16).replace('T', ' ');
        console.log(`  ${chalk.bold(p.projectId)}${p.label ? chalk.cyan(` [${p.label}]`) : ''}`);
        console.log(chalk.dim(`    health ${p.health.score}/100 · ${p.health.findings} findings · ${when}`));
      }
    } catch (err) {
      console.error(chalk.red('code status failed:'), err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

code
  .command('show <project>')
  .description('Show a project: health, findings summary, and the top action items')
  .action(async (project: string) => {
    try {
      const enc = encodeURIComponent(project);
      const p = await serverGet<{ projectId: string; rootPath: string; health: any; langs: Record<string, number> }>(`/api/code/projects/${enc}`);
      const { actions } = await serverGet<{ actions: Array<{ pri: number; category: string; title: string }> }>(`/api/code/actions?project=${enc}&limit=12`);
      console.log(chalk.bold(p.projectId), chalk.dim(p.rootPath));
      console.log(`  health ${p.health.score}/100 — ${p.health.critical}C ${p.health.high}H ${p.health.medium}M ${p.health.low}L · ${p.health.hotspots} hotspots · ${Math.round((p.health.aiAuthoredPct || 0) * 100)}% AI-authored`);
      console.log(chalk.bold('\n  Top actions:'));
      for (const a of actions) console.log(`    ${chalk.yellow('P' + a.pri)} [${a.category}] ${a.title}`);
    } catch (err) {
      console.error(chalk.red('code show failed:'), err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

// ── Team toolkit sync ───────────────────────────────────────────────────
//
// All commands talk to the team-server over HTTP. Config (server URL,
// team id, token env var name) lives in settings.team.*; the bearer
// token itself lives in the env var named by settings.team.tokenRef so
// tokens never land in shell history or settings.json.
// ── toolkit: personal cross-tool sync (skills/commands/agents/MCPs) ──
const toolkit = program
  .command('toolkit')
  .description('Copy skills / commands / agents / MCPs between your AI tools');

/**
 * After a local copy writes new toolkit files, push them to the server so the
 * web Toolkit matrix reflects the change immediately. The watch daemon doesn't
 * watch toolkit dirs, so without this the change wouldn't appear until the
 * 15-min heartbeat. No-op (silent) when not logged in.
 */
async function pushToolkitToServer(): Promise<void> {
  try {
    const { syncIncremental, isSyncSkip } = await import('./sync-client.js');
    const res = await syncIncremental();
    if (!isSyncSkip(res) && res.items > 0) console.log(chalk.dim(`  synced ${res.items} toolkit item(s) to the server.`));
  } catch (err) {
    console.error(chalk.dim(`  (could not sync to server: ${err instanceof Error ? err.message : err})`));
  }
}

toolkit
  .command('sync')
  .description('Fan every artifact out to every tool that is missing it (runs locally now)')
  .option('--types <list>', 'comma-separated subset: skill,mcp,command,agent')
  .action(async (options: { types?: string }) => {
    const { executeSyncAll } = await import('@chat-recall/engine/core/toolkit-sync.js');
    const types = options.types
      ? options.types.split(',').map(s => s.trim()).filter(Boolean) as Array<'skill' | 'mcp' | 'command' | 'agent'>
      : undefined;
    const r = await executeSyncAll(types);
    for (const c of r.copied) console.log(chalk.green(`  + ${c.type} ${c.name} → ${c.toTool}`) + chalk.dim(`  ${c.path || ''}`));
    for (const f of r.failed) console.log(chalk.red(`  ✗ ${f.type} ${f.name} → ${f.toTool}: ${f.error}`));
    console.log(chalk.bold(`Synced: ${r.copied.length} copied, ${r.skipped.length} already present, ${r.failed.length} failed.`));
    if (r.copied.length > 0) await pushToolkitToServer();
  });

toolkit
  .command('drain')
  .description('Process cross-tool sync intents queued from the web UI, now')
  .action(async () => {
    const { drainSyncIntents } = await import('./intent-drain.js');
    const r = await drainSyncIntents({ verbose: true });
    console.log(chalk.bold(`Processed ${r.processed} intent(s): ${r.done} done, ${r.errored} errored.`));
    if (r.done > 0) await pushToolkitToServer();
  });

toolkit
  .command('copy <type> <name> <fromTool> <toTool>')
  .description('Copy one artifact (skill|mcp|command|agent) from one tool to another')
  .action(async (type: string, name: string, fromTool: string, toTool: string) => {
    const { executeCopy } = await import('@chat-recall/engine/core/toolkit-sync.js');
    const r = await executeCopy(type as any, name, fromTool, toTool as any);
    if (r.ok) console.log(chalk.green(`Copied to ${r.targetPath}`));
    else { console.error(chalk.red(r.error || 'failed')); process.exit(1); }
  });

const team = program
  .command('team')
  .description('Sync team toolkit (skills, CLAUDE.md, MCPs, agents, commands)');

/** Common error funnel — converts typed client errors to a clean CLI exit. */
async function runTeam(label: string, fn: () => Promise<void>): Promise<void> {
  const { TeamConfigError, TeamAuthError, TeamHttpError } = await import('@chat-recall/engine/core/team-client.js');
  try { await fn(); }
  catch (err) {
    if (err instanceof TeamConfigError) {
      console.error(chalk.red(`${label}: ${err.message}`));
    } else if (err instanceof TeamAuthError) {
      console.error(chalk.red(`${label}: auth failed — ${err.message}`));
      console.error(chalk.dim('  Check the env var named in settings.team.tokenRef holds a valid Keycloak access token.'));
    } else if (err instanceof TeamHttpError) {
      console.error(chalk.red(`${label}: ${err.message}`));
    } else {
      throw err;
    }
    process.exit(1);
  }
}

team
  .command('whoami')
  .description('Show the user + team memberships the server sees for your token')
  .action(async () => runTeam('team whoami', async () => {
    const { teamMe } = await import('@chat-recall/engine/core/team-client.js');
    const me = await teamMe();
    console.log(chalk.bold(me.user.email) + chalk.dim(`  (${me.user.id})`));
    if (me.memberships.length === 0) {
      console.log(chalk.dim('  no team memberships yet — run `chat-recall team create <name>` or `team join <token>`'));
      return;
    }
    for (const m of me.memberships) {
      const role = m.role === 'owner' ? chalk.yellow(m.role) : chalk.dim(m.role);
      console.log(`  ${chalk.cyan(m.teamName)}  ${role}  ${chalk.dim(m.plan)}  ${chalk.dim(m.teamId)}`);
    }
  }));

team
  .command('create <name>')
  .description('Create a new team. You become the owner. Stores teamId in settings.')
  .action(async (name: string) => runTeam('team create', async () => {
    const { teamCreate } = await import('@chat-recall/engine/core/team-client.js');
    const t = await teamCreate(name);
    console.log(chalk.green(`✓ Team created: ${chalk.bold(t.name)}`));
    console.log(chalk.dim(`  id: ${t.id}`));
    console.log(chalk.dim(`  Now generate an invite: chat-recall team invite`));
  }));

team
  .command('invite')
  .description('Generate a single-use invite token for your team (owner-only)')
  .option('--email <hint>', 'Display hint (e.g. teammate@company.com); not validated')
  .action(async (opts: { email?: string }) => runTeam('team invite', async () => {
    const { teamInvite } = await import('@chat-recall/engine/core/team-client.js');
    const r = await teamInvite(opts.email);
    console.log(chalk.bold('Invite token (copy now — shown once):'));
    console.log('  ' + chalk.cyan(r.inviteToken));
    console.log(chalk.dim(`  expires: ${r.expiresAt}`));
    console.log();
    console.log(chalk.dim('Recipient runs:  chat-recall team join <token>'));
  }));

team
  .command('join <invite-token>')
  .description('Accept a team invite. Stores team id locally.')
  .action(async (inviteToken: string) => runTeam('team join', async () => {
    const { teamJoin } = await import('@chat-recall/engine/core/team-client.js');
    const t = await teamJoin(inviteToken);
    console.log(chalk.green(`✓ Joined team: ${chalk.bold(t.name)}`));
    console.log(chalk.dim(`  id: ${t.id}`));
    console.log(chalk.dim('  Run `chat-recall team pull` to fetch the team library.'));
  }));

team
  .command('pull')
  .description('Pull artifacts changed since the last pull and write them into your local ~/.claude/, ~/.gemini/, ~/.codex/ dirs')
  .option('--dry-run', "Fetch but don't write to disk (preview only)")
  .action(async (opts: { dryRun?: boolean }) => runTeam('team pull', async () => {
    const { teamPull } = await import('@chat-recall/engine/core/team-client.js');
    const r = await teamPull();
    if (r.pulled.length === 0 && r.removed.length === 0) {
      console.log(chalk.dim('Up to date.'));
      return;
    }
    for (const a of r.pulled) {
      console.log(`  ${chalk.green('+')} ${chalk.cyan(a.type + '/' + a.name)} v${a.version} ${chalk.dim('(' + a.tool + ')')}`);
    }
    for (const id of r.removed) {
      console.log(`  ${chalk.red('-')} ${chalk.dim(id + ' (revoked)')}`);
    }
    if (opts.dryRun) {
      console.log(chalk.dim(`Watermark: ${r.serverNow}  (dry-run — nothing written)`));
      return;
    }
    const { mergePullResult } = await import('@chat-recall/engine/core/team-merge.js');
    const m = mergePullResult({ pulled: r.pulled, removed: r.removed });
    console.log();
    if (m.written.length)  console.log(chalk.green(`✓ Wrote ${m.written.length} file${m.written.length === 1 ? '' : 's'}`));
    if (m.skipped.length)  console.log(chalk.dim(`  Skipped ${m.skipped.length} (unchanged or no target tool)`));
    if (m.removed.length)  console.log(chalk.yellow(`  Removed ${m.removed.length} revoked file${m.removed.length === 1 ? '' : 's'}`));
    for (const f of m.failures) {
      console.log(chalk.red(`  ! ${f.path}: ${f.error}`));
    }
    console.log(chalk.dim(`Watermark: ${r.serverNow}`));
  }));

team
  .command('publish <type> <name> <file>')
  .description('Publish a local file as an artifact (skill|command|agent|mcp|plan|plugin|instructions|hook)')
  .option('--tool <tool>', 'Target tool: claude|gemini|opencode|codex|cross_tool', 'cross_tool')
  .option('--pinned-to <glob>', 'Limit which projects pull this artifact')
  .action(async (type: string, name: string, file: string, opts: { tool: string; pinnedTo?: string }) => runTeam('team publish', async () => {
    const validTypes = ['skill','command','agent','mcp','plan','plugin','instructions','hook'] as const;
    if (!(validTypes as readonly string[]).includes(type)) {
      console.error(chalk.red(`Invalid type: ${type}. Must be one of: ${validTypes.join(', ')}`));
      process.exit(1);
    }
    const validTools = ['claude','gemini','opencode','codex','cross_tool'] as const;
    if (!(validTools as readonly string[]).includes(opts.tool)) {
      console.error(chalk.red(`Invalid tool: ${opts.tool}. Must be one of: ${validTools.join(', ')}`));
      process.exit(1);
    }
    const { readFileSync } = await import('fs');
    const body = readFileSync(file);
    const { teamPublish } = await import('@chat-recall/engine/core/team-client.js');
    const a = await teamPublish({
      type: type as any, tool: opts.tool as any, name, body, pinnedTo: opts.pinnedTo,
    });
    console.log(chalk.green(`✓ Published ${chalk.bold(type + '/' + name)} v${a.version}`));
    console.log(chalk.dim(`  id: ${a.id}`));
    console.log(chalk.dim(`  sha256: ${a.sha256}`));
  }));

team
  .command('list')
  .description('List artifacts in the team library (metadata only, no bodies)')
  .action(async () => runTeam('team list', async () => {
    const { teamList } = await import('@chat-recall/engine/core/team-client.js');
    const items = await teamList();
    if (items.length === 0) {
      console.log(chalk.dim('Library is empty. Try `chat-recall team publish <type> <name> <file>`.'));
      return;
    }
    for (const a of items) {
      const pinned = a.pinnedTo ? chalk.dim(` pinned=${a.pinnedTo}`) : '';
      console.log(`  ${chalk.cyan(a.type + '/' + a.name)} v${a.version} ${chalk.dim('(' + a.tool + ', ' + a.bytes + ' bytes)')}${pinned}`);
    }
  }));

team
  .command('revoke <artifact-id>')
  .alias('unpublish')
  .description('Revoke an artifact from the team library (owner-only)')
  .action(async (artifactId: string) => runTeam('team revoke', async () => {
    const { teamRevoke } = await import('@chat-recall/engine/core/team-client.js');
    const r = await teamRevoke(artifactId);
    console.log(chalk.green(`✓ Revoked ${chalk.bold(r.type + '/' + r.name)} (${r.id})`));
  }));

team
  .command('leave')
  .description('Clear local team config (does not delete pulled artifacts; does not remove your server-side membership)')
  .action(async () => runTeam('team leave', async () => {
    const { teamLeave } = await import('@chat-recall/engine/core/team-client.js');
    await teamLeave();
    console.log(chalk.green('✓ Local team config cleared.'));
    console.log(chalk.dim('  Server-side membership unchanged. Owner must remove you to fully leave.'));
  }));

// ── Vault: encrypted multi-device chat backup ──────────────────────────
//
// E2EE: passphrase → Argon2id → master key (32 bytes), used to
// XChaCha20-Poly1305 encrypt each chat session as a blob. Server holds
// ciphertext + integrity hash; cannot decrypt. Multi-device parity
// requires the same passphrase on each device.
const vault = program
  .command('vault')
  .description('Encrypted multi-device chat backup (E2EE — server cannot decrypt)');

async function runVault(label: string, fn: () => Promise<void>): Promise<void> {
  const { VaultConfigError, VaultAuthError, VaultHttpError } = await import('@chat-recall/engine/core/vault-client.js');
  try { await fn(); }
  catch (err) {
    if (err instanceof VaultConfigError)      console.error(chalk.red(`${label}: ${err.message}`));
    else if (err instanceof VaultAuthError)   console.error(chalk.red(`${label}: auth failed — ${err.message}`));
    else if (err instanceof VaultHttpError)   console.error(chalk.red(`${label}: ${err.message}`));
    else throw err;
    process.exit(1);
  }
}

/** Read passphrase from CLI prompt, env, or `--passphrase` flag. */
async function resolvePassphrase(opts: { passphrase?: string; envVar?: string }): Promise<string> {
  if (opts.passphrase) return opts.passphrase;
  if (opts.envVar) {
    const v = process.env[opts.envVar];
    if (v) return v;
    console.error(chalk.red(`Env var ${opts.envVar} is not set.`));
    process.exit(1);
  }
  // Interactive prompt (silent) — uses readline-sync style by reading stdin
  // with echoing off. Done with built-in node so no extra dep.
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return await new Promise<string>((resolve) => {
    process.stdout.write('Vault passphrase: ');
    // @ts-expect-error — _writeToOutput is internal but the only way to silence echoing.
    rl._writeToOutput = (s: string) => { if (s.startsWith('\n')) process.stdout.write(s); };
    rl.question('', (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

vault
  .command('enable')
  .description('Set up the Vault on this device. Generates a per-user salt; derives the master key from your passphrase.')
  .option('--passphrase <s>', 'Passphrase (insecure — prefer interactive or --passphrase-env)')
  .option('--passphrase-env <name>', 'Read passphrase from this env var')
  .option('--existing-salt <hex>', 'Reuse a salt from another device (64 hex chars)')
  .action(async (opts: { passphrase?: string; passphraseEnv?: string; existingSalt?: string }) => runVault('vault enable', async () => {
    const passphrase = await resolvePassphrase({ passphrase: opts.passphrase, envVar: opts.passphraseEnv });
    const { vaultEnable } = await import('@chat-recall/engine/core/vault-client.js');
    const r = vaultEnable(passphrase, { existingSaltHex: opts.existingSalt });
    console.log(chalk.green('✓ Vault enabled on this device.'));
    console.log(chalk.dim(`  keyId: ${r.keyId}`));
    console.log(chalk.dim(`  salt:  ${r.saltHex}`));
    console.log();
    console.log(chalk.yellow('To set up another device, run there:'));
    console.log(`  chat-recall vault enable --existing-salt ${r.saltHex}`);
    console.log(chalk.yellow('Then enter the SAME passphrase. Lose the passphrase = lose chat history. There is no recovery.'));
  }));

vault
  .command('sync')
  .description('Walk local chat sources, encrypt new/changed sessions, upload ciphertext to the server')
  .option('--passphrase <s>', 'Passphrase (insecure — prefer interactive or --passphrase-env)')
  .option('--passphrase-env <name>', 'Read passphrase from this env var')
  .action(async (opts: { passphrase?: string; passphraseEnv?: string }) => runVault('vault sync', async () => {
    const passphrase = await resolvePassphrase({ passphrase: opts.passphrase, envVar: opts.passphraseEnv });
    const { vaultSync } = await import('@chat-recall/engine/core/vault-client.js');
    const r = await vaultSync(passphrase);
    if (r.uploaded.length === 0 && r.skipped.length === 0 && r.failures.length === 0) {
      console.log(chalk.dim('No chat sources found.'));
      return;
    }
    if (r.uploaded.length) console.log(chalk.green(`✓ Uploaded ${r.uploaded.length} session${r.uploaded.length === 1 ? '' : 's'}`));
    if (r.skipped.length)  console.log(chalk.dim(`  Skipped ${r.skipped.length} (unchanged or denylisted)`));
    for (const f of r.failures) {
      console.log(chalk.red(`  ! ${f.tool}/${f.sessionId}: ${f.error}`));
    }
  }));

vault
  .command('restore')
  .description('Pull encrypted blobs from the server, decrypt locally, write them where chat-recall can index them')
  .option('--passphrase <s>', 'Passphrase (insecure — prefer interactive or --passphrase-env)')
  .option('--passphrase-env <name>', 'Read passphrase from this env var')
  .option('--since <ms>', 'Only restore blobs uploaded after this ms-epoch (default 0 = all)')
  .action(async (opts: { passphrase?: string; passphraseEnv?: string; since?: string }) => runVault('vault restore', async () => {
    const passphrase = await resolvePassphrase({ passphrase: opts.passphrase, envVar: opts.passphraseEnv });
    const { vaultRestore } = await import('@chat-recall/engine/core/vault-client.js');
    const r = await vaultRestore(passphrase, { since: opts.since ? Number(opts.since) : undefined });
    if (r.restored.length === 0 && r.skipped.length === 0 && r.failures.length === 0) {
      console.log(chalk.dim('No blobs to restore.'));
      return;
    }
    if (r.restored.length) console.log(chalk.green(`✓ Restored ${r.restored.length} session${r.restored.length === 1 ? '' : 's'}`));
    if (r.skipped.length)  console.log(chalk.dim(`  Skipped ${r.skipped.length} (unchanged or different key)`));
    for (const f of r.failures) {
      console.log(chalk.red(`  ! ${f.tool}/${f.sessionId}: ${f.error}`));
    }
  }));

vault
  .command('status')
  .description('Show whether the Vault is enabled, salt fingerprint, last sync time')
  .action(async () => runVault('vault status', async () => {
    const { vaultStatus } = await import('@chat-recall/engine/core/vault-client.js');
    const s = vaultStatus();
    if (!s.enabled) {
      console.log(chalk.dim('Vault: disabled. Run `chat-recall vault enable`.'));
      return;
    }
    console.log(chalk.green('Vault: enabled'));
    console.log(chalk.dim(`  keyId:        ${s.keyId ?? '(unknown — re-enable)'}`));
    console.log(chalk.dim(`  salt:         ${s.saltHex ? s.saltHex.slice(0, 16) + '…' : '(missing)'}`));
    console.log(chalk.dim(`  lastSyncAt:   ${s.lastSyncAt ? new Date(s.lastSyncAt).toISOString() : 'never'}`));
    console.log(chalk.dim(`  syncTools:    ${s.syncTools.join(', ')}`));
    console.log(chalk.dim(`  excludeProj:  ${s.excludeProjects.length ? s.excludeProjects.join(', ') : '(none)'}`));
  }));

program
  .command('install-hooks')
  .description('Install Claude Code hooks (Stop + PreCompact + UserPromptSubmit)')
  .option('--uninstall', 'Remove hooks instead of installing them')
  .option('--no-resume-hint', "Don't install the UserPromptSubmit resume-hint hook")
  .action(async (opts: { uninstall?: boolean; resumeHint?: boolean }) => {
    const { mkdirSync, copyFileSync, chmodSync, existsSync, readFileSync, writeFileSync, statSync } = await import('fs');
    const { fileURLToPath } = await import('url');

    // Locate the bundled hook scripts. When installed via npm the files live
    // at <pkg>/hooks/*.sh; in development they sit next to src/.
    const here = fileURLToPath(new URL('.', import.meta.url));
    const findHook = (name: string) => {
      const candidates = [
        join(here, '..', 'hooks', name),
        join(here, '..', '..', 'hooks', name),
      ];
      return candidates.find(p => existsSync(p));
    };
    const sourceSaveHook = findHook('chat_recall_save_hook.sh');
    const sourceResumeHook = findHook('chat_recall_resume_hook.sh');
    if (!sourceSaveHook) {
      console.error(chalk.red('Could not locate chat_recall_save_hook.sh in the package.'));
      process.exit(1);
    }

    const hooksDir = getHooksDir();
    const installedSaveHook = join(hooksDir, 'chat_recall_save_hook.sh');
    const installedResumeHook = join(hooksDir, 'chat_recall_resume_hook.sh');
    const hooksJson = claudeBackend.hooksFile();

    // Read existing hooks.json or start fresh.
    let config: any = {};
    if (existsSync(hooksJson)) {
      try {
        config = JSON.parse(readFileSync(hooksJson, 'utf-8'));
      } catch (err) {
        console.error(chalk.red(`Could not parse ${hooksJson}: ${err}`));
        console.error(chalk.dim('Fix the file or move it aside before re-running.'));
        process.exit(1);
      }
    }
    if (!config.hooks || typeof config.hooks !== 'object') config.hooks = {};

    // Identify our entries by command path. Two scripts now: save + resume.
    const matchesOurs = (h: any) => {
      const cmd = h?.hooks?.[0]?.command;
      return typeof cmd === 'string' && (
        cmd.includes('chat_recall_save_hook.sh') ||
        cmd.includes('chat_recall_resume_hook.sh')
      );
    };

    if (opts.uninstall) {
      let removed = 0;
      for (const event of ['Stop', 'PreCompact', 'UserPromptSubmit']) {
        const arr = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
        const filtered = arr.filter((h: any) => !matchesOurs(h));
        removed += arr.length - filtered.length;
        if (filtered.length) config.hooks[event] = filtered;
        else delete config.hooks[event];
      }
      writeFileSync(hooksJson, JSON.stringify(config, null, 2) + '\n');
      console.log(chalk.green(`✓ Removed ${removed} chat-recall hook entr${removed === 1 ? 'y' : 'ies'} from ${hooksJson}`));
      console.log(chalk.dim(`  (Hook scripts left in ${hooksDir} — delete manually if you want.)`));
      return;
    }

    // Install: copy scripts and merge entries idempotently.
    mkdirSync(hooksDir, { recursive: true });
    copyFileSync(sourceSaveHook, installedSaveHook);
    chmodSync(installedSaveHook, 0o755);

    const installResume = opts.resumeHint !== false && !!sourceResumeHook;
    if (installResume) {
      copyFileSync(sourceResumeHook!, installedResumeHook);
      chmodSync(installedResumeHook, 0o755);
    }

    const stopEntry = { matcher: '', hooks: [{ type: 'command', command: installedSaveHook }] };
    const precompactEntry = { matcher: '', hooks: [{ type: 'command', command: `${installedSaveHook} --precompact` }] };
    const resumeEntry = { matcher: '', hooks: [{ type: 'command', command: installedResumeHook }] };

    const events: Array<[string, any]> = [
      ['Stop', stopEntry],
      ['PreCompact', precompactEntry],
    ];
    if (installResume) events.push(['UserPromptSubmit', resumeEntry]);

    // Always strip our prior UserPromptSubmit entry too — even when reinstalling
    // without the resume hint, so we don't leave orphan registrations behind.
    for (const event of ['Stop', 'PreCompact', 'UserPromptSubmit']) {
      const arr = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
      const without = arr.filter((h: any) => !matchesOurs(h));
      const wanted = events.find(([e]) => e === event);
      if (wanted) without.push(wanted[1]);
      if (without.length) config.hooks[event] = without;
      else delete config.hooks[event];
    }

    writeFileSync(hooksJson, JSON.stringify(config, null, 2) + '\n');
    const saveSz = statSync(installedSaveHook).size;
    console.log(chalk.green(`✓ Installed chat-recall save hook (${saveSz} bytes)`));
    if (installResume) {
      const resumeSz = statSync(installedResumeHook).size;
      console.log(chalk.green(`✓ Installed chat-recall resume-hint hook (${resumeSz} bytes)`));
    }
    console.log(chalk.dim(`  scripts:   ${hooksDir}`));
    console.log(chalk.dim(`  config:    ${hooksJson}`));
    console.log(chalk.dim(`  events:    Stop, PreCompact${installResume ? ', UserPromptSubmit' : ''}`));
    console.log();
    console.log(chalk.dim('Run `chat-recall install-hooks --uninstall` to remove later.'));
    if (!installResume) {
      console.log(chalk.dim('(--no-resume-hint passed — UserPromptSubmit hook skipped)'));
    }
  });

program
  .command('dossier <project>')
  .description('Generate a project dossier (overview/architecture/decisions/etc) as markdown (requires login)')
  .option('--sessions <n>', 'Max sessions to enumerate', '10')
  .option('--tasks <n>', 'Max open tasks to list', '20')
  .option('--plans <n>', 'Max plans to list', '20')
  .option('--out <file>', 'Write report to this file instead of stdout')
  .action(async (project: string, options: { sessions: string; tasks: string; plans: string; out?: string }) => {
    try {
      // Server-backed: the dossier route resolves a path/id into a project_id
      // (via the engine's resolveProjectId) and aggregates sessions, tasks,
      // plans, commits and KG facts into markdown — all from synced data.
      const qs = new URLSearchParams({
        sessions: String(Number(options.sessions) || 10),
        tasks: String(Number(options.tasks) || 20),
        plans: String(Number(options.plans) || 20),
      });
      const dossier = await serverGet<{ project_id: string; markdown: string }>(
        `/api/projects/${encodeURIComponent(project)}/dossier?${qs.toString()}`,
      );
      const md = dossier.markdown;
      if (options.out) {
        writeFileSync(options.out, md);
        console.log(chalk.green(`Wrote dossier to ${options.out} (${md.length} chars)`));
      } else {
        console.log(md);
      }
    } catch (err) {
      console.error(chalk.red('Error:'), err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command('project-id <path>')
  .description('Show the resolved project_id for a path (debug helper)')
  .action((path) => {
    const r = resolveProjectId(path);
    console.log(JSON.stringify(r, null, 2));
  });

program
  .command('watch')
  .description('Run the live indexer daemon (watches all AI-tool session stores, generates summaries, precomputes, syncs when logged in)')
  .option('--install-service', 'Install + start a per-user background service so collection keeps running (Linux: systemd --user · macOS: launchd · Windows: Scheduled Task). No admin rights.')
  .action(async (opts: { installService?: boolean }) => {
    if (opts.installService) {
      try {
        const { installService, isServiceRunning, platformName } = await import('./service-installer.js');
        if (isServiceRunning()) {
          console.log(chalk.green(`✓ chat-recall-watch service already running (${platformName()}).`));
          return;
        }
        const paths = installService();
        console.log(chalk.green(`✓ chat-recall-watch service installed and started (${platformName()}).`));
        if (paths.definitionPath) console.log(chalk.dim(`  unit: ${paths.definitionPath}`));
        console.log(chalk.dim(`  logs: ${paths.logFile}   ·   manage: \`chat-recall service status\``));
      } catch (err) {
        const se = err as { hint?: string; message?: string };
        console.error(chalk.red(se.message || String(err)));
        if (se.hint) console.error(chalk.dim(`  ${se.hint}`));
        process.exit(1);
      }
      return;
    }
    // Foreground: the daemon module starts its watchers + workers on import.
    // Non-literal specifier so esbuild does NOT inline the daemon into cli.js
    // — in the published package it lives at dist/watch.js next to this file;
    // in the dev tree it's the raw auto-indexer source.
    const candidates = [
      new URL('./watch.js', import.meta.url).href,
      new URL('../auto-indexer/indexer.js', import.meta.url).href,
    ];
    let lastErr: unknown;
    for (const spec of candidates) {
      try { await import(spec); return; } catch (err) { lastErr = err; }
    }
    console.error(chalk.red('Could not load the watch daemon:'), lastErr instanceof Error ? lastErr.message : lastErr);
    process.exit(1);
  });

program
  .command('service <action>')
  .description('Manage the per-user background sync service (Linux: systemd --user · macOS: launchd · Windows: Scheduled Task). No admin rights.')
  .action(async (action: string) => {
    const { installService, uninstallService, isServiceRunning, platformName, ServiceInstallError } = await import('./service-installer.js');
    try {
      if (action === 'install') {
        if (isServiceRunning()) {
          console.log(chalk.green(`✓ chat-recall-watch service already running (${platformName()}).`));
          return;
        }
        const paths = installService();
        console.log(chalk.green(`✓ chat-recall-watch service installed and started (${platformName()}).`));
        if (paths.definitionPath) console.log(chalk.dim(`  unit: ${paths.definitionPath}`));
        console.log(chalk.dim(`  logs: ${paths.logFile}`));
      } else if (action === 'uninstall') {
        const removed = uninstallService();
        if (removed) console.log(chalk.green(`✓ chat-recall-watch service removed (${platformName()}).`));
        else console.log(chalk.dim('Service was not installed — nothing to remove.'));
      } else if (action === 'status') {
        const running = isServiceRunning();
        console.log(`chat-recall-watch service (${platformName()}): ${running ? chalk.green('running') : chalk.yellow('not running')}`);
        if (!running) console.log(chalk.dim('  install: `chat-recall service install`'));
      } else {
        console.error(chalk.red(`Unknown action '${action}'.`) + chalk.dim(' Use: install | uninstall | status'));
        process.exit(1);
      }
    } catch (err) {
      const se = err as { hint?: string; message?: string };
      console.error(chalk.red(se.message || String(err)));
      if (se.hint) console.error(chalk.dim(`  ${se.hint}`));
      process.exit(1);
    }
  });

/**
 * Shared login flow used by both `chat-recall login` and `chat-recall init`.
 * Either saves a self-host device token directly (--token) or runs the OIDC
 * device flow, picks a team, mints a per-device sync token and saves it.
 * Exits the process on failure so callers don't have to.
 */
async function runLogin(
  serverUrl: string,
  opts: { token?: string; issuer?: string; clientId?: string; team?: string; deviceId?: string },
): Promise<void> {
  const { saveCredentials } = await import('./sync-client.js');
  const base = serverUrl.replace(/\/+$/, '');

  // Self-host escape hatch: token supplied directly, no OIDC.
  if (opts.token) {
    saveCredentials({ serverUrl, token: opts.token });
    console.log(chalk.green('✓ Logged in.') + chalk.dim(`  server: ${serverUrl}`));
    return;
  }

  // Local self-host (AUTH_PROVIDER=none) needs NO token: a tenant-scoped request
  // with no auth resolves to the single 'default' tenant — which is also what the
  // no-auth dashboard reads, so collector and dashboard always agree. Detect it
  // (a no-auth /api/status returns 200; an auth-required server returns 401) and
  // save a tokenless target instead of forcing the OIDC flow.
  try {
    const probe = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(8000) });
    if (probe.status === 200) {
      saveCredentials({ serverUrl, token: '' });
      console.log(chalk.green('✓ Logged in.') + chalk.dim(`  ${serverUrl} (local server — no auth, no token needed)`));
      return;
    }
  } catch { /* unreachable or not a no-auth server — fall through to OIDC */ }

  try {
    const { deviceLogin } = await import('./device-auth.js');
    const tokens = await deviceLogin({ issuer: opts.issuer, clientId: opts.clientId }, (p) => {
      console.log();
      console.log(chalk.bold('To log in, open:'));
      console.log('  ' + chalk.cyan(p.url));
      console.log(chalk.dim(`  (if prompted, enter code: ${chalk.bold(p.userCode)} at ${p.verificationUri})`));
      console.log(chalk.dim('Waiting for approval…'));
    });

    const authHdr = { authorization: `Bearer ${tokens.accessToken}`, 'content-type': 'application/json' };

    // Which team? Use --team, else the user's sole team; bail with guidance otherwise.
    const me = await fetch(`${base}/api/me`, { headers: authHdr }).then((r) => r.json() as Promise<{ teams: { team_slug: string; name: string }[] }>);
    const teams = me.teams || [];
    let slug = opts.team;
    if (!slug) {
      if (teams.length === 1) slug = teams[0].team_slug;
      else if (teams.length === 0) { console.error(chalk.red('No team yet. Create one:') + ' chat-recall team create <name>, then re-run login.'); process.exit(1); }
      else { console.error(chalk.red('You belong to multiple teams — pass --team <slug>:')); teams.forEach((t) => console.error(`  ${t.team_slug}  ${chalk.dim(t.name)}`)); process.exit(1); }
    }

    // Mint a per-device sync token for that team.
    const deviceId = opts.deviceId || (await import('node:os')).hostname();
    const mint = await fetch(`${base}/api/teams/${encodeURIComponent(slug!)}/tokens`, {
      method: 'POST', headers: authHdr, body: JSON.stringify({ device_id: deviceId }),
    });
    if (!mint.ok) throw new Error(`token mint failed: HTTP ${mint.status} ${await mint.text().catch(() => '')}`);
    const { token } = (await mint.json()) as { token: string };

    saveCredentials({ serverUrl, token });
    console.log(chalk.green(`✓ Logged in to ${chalk.bold(slug!)}`) + chalk.dim(`  (device: ${deviceId})  server: ${serverUrl}`));
    console.log(chalk.dim('Run `chat-recall sync` to push redacted conversations.'));
  } catch (err) {
    console.error(chalk.red('login failed:'), err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

program
  .command('login <server-url>')
  .description('Log in via Keycloak (device flow) and mint a sync device token → ~/.chat-recall/credentials.json (0600)')
  .option('--token <token>', 'Self-host: skip OIDC and save this device token directly')
  .option('--issuer <url>', 'OIDC issuer (default: munhq realm)')
  .option('--client-id <id>', 'OIDC client id (default: chat-recall-web)')
  .option('--team <slug>', 'Team to mint the device token for (default: your only team)')
  .option('--device-id <id>', 'Device id for this machine (default: hostname)')
  .action((serverUrl: string, opts: { token?: string; issuer?: string; clientId?: string; team?: string; deviceId?: string }) =>
    runLogin(serverUrl, opts));

program
  .command('logout <server-url>')
  .description('Remove one sync target (other targets keep syncing)')
  .action(async (serverUrl: string) => {
    const { removeCredentials, loadAllCredentials } = await import('./sync-client.js');
    if (removeCredentials(serverUrl)) {
      const left = loadAllCredentials();
      console.log(chalk.green(`✓ Removed ${serverUrl}`) + chalk.dim(` — ${left.length} target(s) remain`));
    } else {
      console.error(chalk.red(`No such target: ${serverUrl}`));
      process.exit(1);
    }
  });

program
  .command('delete <session-id>')
  .description('Delete a session from chat-recall everywhere: purges it on every logged-in server and tombstones it so it can\'t resurrect on the next sync. Does NOT touch the AI tool\'s own transcript file.')
  .action(async (sessionId: string) => {
    const { loadAllCredentials } = await import('./sync-client.js');
    const targets = loadAllCredentials();
    if (targets.length === 0) {
      console.error(chalk.red('Not logged in — run `chat-recall login <server-url>` first.'));
      process.exit(1);
    }
    let ok = 0;
    for (const t of targets) {
      try {
        const res = await fetch(`${t.serverUrl.replace(/\/+$/, '')}/api/conversations/${encodeURIComponent(sessionId)}`, {
          method: 'DELETE', headers: { authorization: `Bearer ${t.token}` },
        });
        if (res.ok) { ok++; console.log(chalk.green(`✓ Deleted on ${t.serverUrl}`)); }
        else console.error(chalk.red(`✗ ${t.serverUrl}: HTTP ${res.status}`));
      } catch (e) {
        console.error(chalk.red(`✗ ${t.serverUrl}: ${e instanceof Error ? e.message : 'failed'}`));
      }
    }
    if (ok === 0) process.exit(1);
    console.log(chalk.dim(`Tombstoned on ${ok}/${targets.length} server(s) — re-sync cannot resurrect it.`));
  });

program
  .command('rename <session-id> <name>')
  .description('Give a session a memorable name on every logged-in server (mirrors Claude Code\'s /rename — shows in `recall recent` and the web UI in place of the auto summary). Pass an empty name "" to clear it and revert to the auto title.')
  .action(async (sessionId: string, name: string) => {
    const { loadAllCredentials } = await import('./sync-client.js');
    const targets = loadAllCredentials();
    if (targets.length === 0) {
      console.error(chalk.red('Not logged in — run `chat-recall login <server-url>` first.'));
      process.exit(1);
    }
    let ok = 0;
    for (const t of targets) {
      try {
        const res = await fetch(`${t.serverUrl.replace(/\/+$/, '')}/api/conversations/${encodeURIComponent(sessionId)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${t.token}` },
          body: JSON.stringify({ name }),
        });
        if (res.ok) { ok++; console.log(chalk.green(`✓ ${name.trim() ? 'Named' : 'Cleared name'} on ${t.serverUrl}`)); }
        else console.error(chalk.red(`✗ ${t.serverUrl}: HTTP ${res.status}`));
      } catch (e) {
        console.error(chalk.red(`✗ ${t.serverUrl}: ${e instanceof Error ? e.message : 'failed'}`));
      }
    }
    if (ok === 0) process.exit(1);
    console.log(chalk.dim(name.trim()
      ? `Named "${name.trim()}" on ${ok}/${targets.length} server(s).`
      : `Cleared name on ${ok}/${targets.length} server(s).`));
  });

program
  .command('sync')
  .description('Push redacted conversations to the configured server (secrets always masked). Bare `sync` is incremental (watermark-based); flags force an explicit window.')
  .option('--since-hours <n>', 'Only sync sessions modified in the last N hours')
  .option('--limit <n>', 'Max sessions to sync')
  .option('--full', 'Ignore the watermark and push everything')
  .option('--paths-cleartext', 'Send project paths in cleartext (self-host only; default hashes them)')
  .option('--throttle <ms>', 'Pause between upload batches in ms (default: 1000, or 3000 with --full)')
  .option('--prune', 'After syncing, drop server-side session rows that have no content (ghost rows)')
  .action(async (opts: { sinceHours?: string; limit?: string; full?: boolean; pathsCleartext?: boolean; throttle?: string; prune?: boolean }) => {
    const { syncSessions, syncIncremental, isSyncSkip } = await import('./sync-client.js');
    try {
      // Bare `chat-recall sync` = incremental: only sessions modified since
      // the last successful sync, watermark advanced on success. Any explicit
      // flag switches to the manual one-shot path (watermark untouched).
      if (!opts.sinceHours && !opts.limit && !opts.full && !opts.pathsCleartext && !opts.throttle && !opts.prune) {
        const r = await syncIncremental();
        if (isSyncSkip(r)) {
          const msg = {
            'no-credentials': 'Not logged in — run `chat-recall login <server-url>` first.',
            'paused': 'Sync is paused in settings — re-run `chat-recall login <server-url>` to resume.',
            'lock-held': 'Another sync is already running (MCP tick or watch daemon) — try again in a moment.',
          }[r.skipped];
          console.error(chalk.red(msg));
          process.exit(1);
        }
        console.log(chalk.green(`✓ Synced ${r.uploaded} session(s), ${r.items} item(s)`) + chalk.dim(` — ${r.links} links, ${r.derived} derived rows, ${r.kgTriples} KG triples, ${r.skipped} skipped, ${r.redactions} secrets redacted, ${r.findings} secret findings${r.scanned ? ` (scanned ${r.scanned} in ${r.scanMs}ms)` : ''} (incremental)`));
        return;
      }
      const sinceMs = opts.sinceHours ? Date.now() - Number(opts.sinceHours) * 3_600_000 : undefined;
      const r = await syncSessions({
        sinceMs,
        // undefined (not false) when the flag is absent so the persistent
        // sync.pathsCleartext setting can take effect.
        cleartextPaths: opts.pathsCleartext ? true : undefined,
        limit: opts.limit ? Number(opts.limit) : undefined,
        // Backfills hit the server's ingest pipeline hard — pace them.
        // Explicit --throttle wins (e.g. 100 for a localhost server).
        throttleMs: opts.throttle !== undefined ? Number(opts.throttle) : (opts.full ? 3000 : undefined),
        prune: !!opts.prune,
      });
      console.log(chalk.green(`✓ Synced ${r.uploaded} session(s), ${r.items} item(s)`) + chalk.dim(` — ${r.links} links, ${r.derived} derived rows, ${r.kgTriples} KG triples, ${r.skipped} skipped, ${r.redactions} secrets redacted, ${r.findings} secret findings${r.scanned ? ` (scanned ${r.scanned} in ${r.scanMs}ms)` : ''}`));
    } catch (err) {
      console.error(chalk.red('sync failed:'), err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command('reconcile')
  .description("Reconcile DERIVED FIELDS (e.g. native title) on every logged-in server WITHOUT re-syncing conversations. Scans each session once for any missing field, pushes only that field, and records 'scanned/absent' so it never retries. Normal `sync` does this automatically; run this for an explicit on-demand backfill. `--force` re-scans every session (ignores the coverage ledger).")
  .option('--force', 'Re-scan and re-push every field for every session')
  .action(async (opts: { force?: boolean }) => {
    const { reconcileFields } = await import('./sync-client.js');
    try {
      const r = await reconcileFields({ force: !!opts.force });
      const per = Object.entries(r.perTarget).map(([s, v]) => `${s}: ${v.pushed} pushed`).join(', ');
      console.log(chalk.green(`✓ Reconciled derived fields`) + chalk.dim(
        ` — ${r.sessions} sessions, ${r.scanned} scanned, ${r.pushed} pushed, ${r.absent} absent${per ? ` (${per})` : ''}`));
    } catch (err) {
      console.error(chalk.red('reconcile failed:'), err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program.parse();
