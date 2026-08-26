#!/usr/bin/env node
/**
 * CLI for chat-recall.
 */

import { resumeCommandFor } from '@chat-recall/engine/core/resume-command.js';
import type { McpClientId } from '@chat-recall/engine/core/mcp-clients.js';
import { config } from 'dotenv';
import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, readFileSync, writeFileSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { join, resolve, dirname, basename } from 'path';
import { execSync } from 'child_process';

import { getDataDir, getIdentityFilePath, getHooksDir } from '@chat-recall/engine/core/paths.js';
import { claudeBackend } from '@chat-recall/engine/core/backends/claude.js';
import { claudeHomeDirs } from '@chat-recall/engine/core/tool-paths.js';
import { resolveProjectId } from '@chat-recall/engine/core/project-resolver.js';
import type { RemoteArtifactRow } from '@chat-recall/engine/core/toolkit-pull.js';
import { tierAll, type ScoreTier } from '@chat-recall/engine/core/score-tier.js';
import { loadAllCredentials, type Credentials } from './sync-client.js';
import { printUpdateNotice, updateNotice } from './update-notice.js';
import { isOnPath } from '@chat-recall/engine/core/which.js';
import { readCollectorHealth, judgeHealth, progressLine, collectorHealthPath, STALE_AFTER_MS } from '@chat-recall/engine/core/collector-health.js';
import { userConsents, serverAllowsTelemetry } from './telemetry-consent.js';

/**
 * Colour a relevance tier for the terminal.
 *
 * Why not a percentage: FTS ranks and vector distances normalise into ranges
 * orders of magnitude apart, so the old `score * 100` printed "2/100" for the
 * single best match in the set. Every user reads that as a broken search. The
 * tier says what the number actually supports — how this result compares with
 * the best one in the same batch — and nothing it does not.
 */
function matchLabel(tier: ScoreTier | undefined): string {
  switch (tier) {
    case 'strong': return chalk.green('strong');
    case 'good': return chalk.yellow('good');
    case 'weak': return chalk.dim('weak');
    default: return chalk.dim('unranked');
  }
}

// Load .env configuration. quiet: dotenv 17 writes its banner to STDOUT, which
// corrupts every machine-readable command (`chat-recall search … | jq` parsed
// the banner as data) — same reason the MCP server sets it.
config({ quiet: true });

// ── Remote scope (chat-recall server) ───────────────────────────────────────
// The CLI is a thin collector: it ships local sessions to a server (`sync`)
// and reads everything else back from that server over HTTP. It deliberately
// imports ZERO local-store / index / embedder code so the published binary
// has no native dependencies. Read commands therefore require a login.
//
// We talk to the FIRST logged-in target (the same one `loadCredentials()`
// resolves). Multi-target fan-out only applies to writes (sync/delete); reads
// have a single source of truth.

/**
 * Every Claude profile's `hooks.json`, deduped by real path.
 *
 * `CLAUDE_CONFIG_DIR=~/.claude-work` makes that directory the whole config root
 * for a session, so a hook registered only in `~/.claude/hooks.json` never fires
 * there. Only profiles that are real installs (they have `projects/`) are
 * returned — a bare `~/.claude-backups` directory is not a Claude to configure.
 * The hook SCRIPTS are shared in one directory; only this registration is
 * per-profile.
 */
function claudeHookConfigFiles(): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const home of claudeHomeDirs()) {
    if (!existsSync(join(home, 'projects'))) continue;
    const file = join(home, 'hooks.json');
    let key: string;
    try { key = realpathSync(file); } catch { key = file; }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  if (out.length === 0) out.push(claudeBackend.hooksFile());
  return out;
}

interface RemoteTarget { base: string; token: string; }

/** First logged-in target with its trailing slashes stripped, or null. */
function firstTarget(): RemoteTarget | null {
  const cred: Credentials | undefined = loadAllCredentials()[0];
  if (!cred) return null;
  return { base: cred.serverUrl.replace(/\/+$/, ''), token: cred.token };
}

/**
 * Show what the first sync would upload, and give the user the chance to narrow
 * it before it happens. Returns true when the sync should run.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * init's first sync ships every transcript on the machine. The exclusions that
 * govern it (`chat-recall exclude project`, `sync-only`) are only useful BEFORE
 * that upload, and nothing in the CLI mentioned them until after it. The site
 * promises the user decides what leaves their disk; this is where that promise
 * either holds or is decoration.
 *
 * ── Why it does not hang a script ─────────────────────────────────────────
 *
 * The pause needs a TTY on stdin. `npx chat-recall init` inside a Dockerfile, a
 * provisioning script or CI has none, and a prompt there would block forever —
 * so with no TTY (or with --yes) the summary still PRINTS and the sync proceeds.
 * Non-interactive callers get the information; only an interactive user gets the
 * question.
 */
async function confirmFirstSyncScope(skipPause: boolean): Promise<boolean> {
  const { summariseSyncScope } = await import('@chat-recall/engine/core/sync-scope.js');
  let scope;
  try {
    scope = summariseSyncScope();
  } catch {
    // A preview that cannot be computed must not block the product. Say so and
    // carry on rather than refusing to sync over a listing error.
    console.log(chalk.dim('   (could not summarise local scope — proceeding)'));
    return true;
  }

  console.log(chalk.bold('6. What would leave this machine'));
  if (scope.included === 0 && scope.heldBack === 0) {
    console.log(chalk.dim('   No local sessions found yet — nothing to ship.'));
    return true;
  }

  const tools = scope.byTool.map((t) => `${t.tool} ${t.sessions}`).join(', ');
  console.log(`   ${chalk.bold(String(scope.included))} session(s) would upload${tools ? chalk.dim(`  (${tools})`) : ''}`);
  if (scope.heldBack > 0) {
    console.log(`   ${chalk.green(String(scope.heldBack))} held back by your existing rules`);
  }
  if (scope.allowlistMode) {
    console.log(chalk.yellow('   Allowlist mode is on — only the projects you listed would ship.'));
  }
  if (scope.noPathSessions > 0) {
    // Said plainly, because the alternative is a user who excludes three paths
    // and believes they are covered. Some tools file transcripts under a hash
    // rather than a project directory, so no path rule can reach those.
    console.log(`   ${chalk.yellow(String(scope.noPathSessions))} of those carry no project path — only \`exclude tool\` can hold those back`);
  }

  // The top projects BY NAME. A count alone does not let anyone recognise the
  // client repo they did not mean to include.
  const shown = scope.projects.filter((p) => !p.heldBackBy).slice(0, 8);
  for (const p of shown) {
    console.log(`     ${chalk.cyan(p.projectPath || p.id)} ${chalk.dim(`· ${p.sessions}`)}`);
  }
  const more = scope.projects.filter((p) => !p.heldBackBy).length - shown.length;
  if (more > 0) console.log(chalk.dim(`     …and ${more} more project(s)`));

  console.log(chalk.dim('   Secrets are masked on this machine before anything uploads.'));
  console.log(chalk.dim('   Hold one back:  chat-recall exclude project <path>'));
  console.log(chalk.dim('   Or invert it:   chat-recall sync-only add <project>'));

  if (skipPause || !process.stdin.isTTY) {
    console.log();
    return true;
  }

  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('   Upload these now? [Y/n] ')).trim().toLowerCase();
  rl.close();
  if (answer === 'n' || answer === 'no') {
    console.log(chalk.dim('   Skipped. Set your rules, then run `chat-recall sync`.'));
    return false;
  }
  console.log();
  return true;
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

/** PATCH <path> with a JSON body on the first target. Throws on non-2xx. */
async function serverPatch<T>(path: string, body: unknown): Promise<T> {
  const t = requireTarget();
  const res = await fetch(t.base + path, {
    method: 'PATCH',
    headers: t.token
      ? { 'content-type': 'application/json', authorization: `Bearer ${t.token}` }
      : { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`server ${path}: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  return res.json() as Promise<T>;
}

/** DELETE <path> with a JSON body on the first target. Throws on non-2xx. */
async function serverDelete<T>(path: string, body: unknown): Promise<T> {
  const t = requireTarget();
  const res = await fetch(t.base + path, {
    method: 'DELETE',
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

/**
 * Where `init` connects when the user names no server.
 *
 * Not a silent upload: runLogin drives a device flow the user must approve in a
 * browser, so this only decides which sign-in page they see. Self-hosting stays
 * a first-class path — see SELF_HOST_DOCS — and `--server` overrides this.
 */
const DEFAULT_SERVER = 'https://chatrecall.dev';

/**
 * Tools NEVER written into `alwaysAllow`, so the host asks every time.
 *
 * Everything else chat-recall exposes either reads, or writes something the user
 * can undo — and prompting on all of it is how a memory tool becomes a permission
 * dialog with a search feature attached. These two are different: they narrow
 * what we hold, and `recall_forget` has no undo at all. Auto-approving them would
 * mean an agent could delete a conversation with no human in the loop, which is
 * the one thing a privacy control must not allow.
 *
 * The annotations (destructiveHint) say the same thing, but they are advisory —
 * a host may ignore them. Absence from this list is what actually produces the
 * prompt, so `mcp-tool-registry.test.ts` pins the rule in both directions: every
 * other tool must be allow-listed, and these must not be.
 */
const NEVER_AUTO_ALLOW = ['recall_forget', 'recall_exclude_path'];

/**
 * Tools written into every AI tool's `alwaysAllow`, and printed by `init`.
 *
 * Module scope on purpose: the MCP registration and the setup-complete banner
 * must name the SAME set. The banner used to be a hand-typed literal and drifted
 * to naming ten tools that do not exist. `mcp-tool-registry.test.ts` asserts this
 * array equals the tools mcp.ts registers, MINUS NEVER_AUTO_ALLOW.
 */
const DEFAULT_ALLOW = [
  'recall_search', 'recall_show', 'recall_index', 'recall_status',
  // Must stay in step with the tools actually registered in mcp.ts.
  // This list had drifted badly: it named 11 tools that do not exist
  // (recall_plans, recall_help, recall_outcome, recall_files_touched, …
  // — some absorbed into other tools, some never built) while omitting 18
  // that do. Entries for missing tools are inert, but they hide the real
  // gap, which is a tool that DOES exist prompting on every call.
  'recall_recent', 'recall_context', 'recall_summary',
  'recall_memory_search', 'recall_memory_item', 'recall_reclassify',
  'recall_tasks', 'recall_task_create', 'recall_task_update', 'recall_task_comment',
  'recall_help',
  'recall_smart_resume', 'recall_project_context', 'recall_weekly_digest',
  'recall_kg_query', 'recall_kg_add', 'recall_kg_invalidate',
  'recall_kg_timeline', 'recall_kg_stats',
  'recall_diary_write', 'recall_diary_read',
  'recall_diff', 'recall_commits', 'recall_markers', 'recall_heal_audit',
  'recall_edits_timeline', 'recall_subagent_search', 'recall_redundant_files',
  'recall_user_prompts', 'recall_decision_record', 'recall_analytics_summary',
  'recall_outcome_summary', 'recall_regenerate_summary', 'recall_shares',
  'recall_wake_up', 'recall_set', 'recall_get', 'recall_rename_session',
  'recall_team_activity', 'recall_recommendations',
  'recall_security_summary', 'recall_security_session',
  'recall_security_dismiss', 'recall_security_rules',
  'recall_code_index', 'recall_code_projects', 'recall_code_findings',
  'recall_code_actions',
  'recall_claude_suggestions', 'recall_improvements',
  // Acting on advice, not just reading it. Allowed like the other writes
  // (task_create, kg_add, security_dismiss): the prompt is not the safeguard —
  // the tool descriptions say when to ask the user, and the annotations tell a
  // host which of these overwrite state.
  'recall_recommendation_apply', 'recall_recommendation_dismiss',
  'recall_project_label',
  'recall_toolkit_status', 'recall_toolkit_sync',
];
const SELF_HOST_DOCS = 'https://github.com/munhq/chat-recall/blob/main/docs/SELF_HOSTING.md';

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
  .option('--yes', 'Do not pause before the first upload. The scope summary still prints.', false)
  .action(async (options: { server?: string; token?: string; skipMcp?: boolean; skipSync?: boolean; withCodeindex?: boolean; skipCodeindex?: boolean; skipService?: boolean; yes?: boolean }) => {
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
        { name: 'Antigravity CLI', cmd: 'agy', available: false },
        { name: 'Cursor', cmd: 'cursor-agent', available: false },
      ];

      for (const cli of clis) {
        try {
          if (!isOnPath(cli.cmd)) throw new Error('not on PATH');
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
        await runLogin(options.server, { token: options.token, fromInit: true });
        target = firstTarget();
      } else if (!target) {
        // Default to the hosted service. Before this, `npx chat-recall init`
        // with no flags connected to nothing and printed an instruction, so the
        // documented one-command install did not actually install anything.
        //
        // Defaulting is safe because LOGIN IS THE CONSENT GATE: runLogin starts
        // an RFC 8628 device flow the user has to approve in a browser, and
        // nothing is read, indexed or uploaded until they do. Declining leaves
        // the machine exactly as it was.
        console.log(`   Connecting to ${chalk.bold(DEFAULT_SERVER)} — sign in to approve this machine.`);
        console.log(`   ${chalk.dim(`Prefer your own server? ${chalk.bold('--server <url>')}. Self-hosting is free: ${SELF_HOST_DOCS}`)}`);
        try {
          await runLogin(DEFAULT_SERVER, { token: options.token, fromInit: true });
          target = firstTarget();
        } catch (e) {
          // A declined or failed sign-in must not fail the whole init: MCP
          // wiring and skill installation below are still useful locally.
          console.log(`   ${chalk.yellow('Not connected.')} ${e instanceof Error ? e.message : e}`);
          console.log(`   ${chalk.dim(`Run ${chalk.bold('chat-recall login <server-url>')} when ready, or self-host: ${SELF_HOST_DOCS}`)}`);
        }
      }
      if (target) {
        console.log(`   ${chalk.green('Connected')} → ${target.base}`);
      }
      console.log();

      // Step 4: Configure MCP server
      if (!options.skipMcp) {
        console.log(chalk.bold('4. Configuring MCP server...'));
        const projectRoot = join(import.meta.dirname, '..');

        // Prefer the installed `chat-recall-mcp` bin (on PATH after `npm i -g`
        // or a packaged binary). Fall back to the source-checkout path only in
        // an un-installed dev tree. Re-running `init` REPAIRS a stale entry
        // (e.g. an old `node <checkout>/dist/mcp.js`) instead of skipping it.
        let mcpBinOnPath = false;
        mcpBinOnPath = isOnPath('chat-recall-mcp');
        const launch: { command: string; args?: string[] } = mcpBinOnPath
          ? { command: 'chat-recall-mcp' }
          : { command: 'node', args: [join(projectRoot, 'dist', 'mcp.js')] };
        // Cap the MCP server's V8 heap via the spawner: it's a long-lived
        // per-session process, and v8.setFlagsFromString can't change the
        // limit after startup (verified) — NODE_OPTIONS is the only knob
        // that works when the AI tool owns the spawn.
        const MCP_ENV = { NODE_OPTIONS: '--max-old-space-size=1024' };

        // Every tool detected in step 1 gets the entry, not just Claude Code.
        // The product claims one memory across five tools; a user who installs
        // it from Codex must find the tools inside Codex, without hand-editing
        // a TOML file they have never opened.
        const { registerMcpEverywhere } = await import('@chat-recall/engine/core/mcp-clients.js');
        // Map the DETECTED cli binary onto its MCP client id. The old version
        // hardcoded three ids and dropped everything else, so a machine with
        // Antigravity or Cursor installed never got the server registered
        // there — silently, because the filter just returned a shorter list.
        const MCP_CLIENT_FOR_BIN: Record<string, McpClientId> = {
          gemini: 'gemini', opencode: 'opencode', codex: 'codex',
          agy: 'agy', 'cursor-agent': 'cursor',
        };
        const detectedClients = clis
          .filter((c) => c.available)
          .map((c) => MCP_CLIENT_FOR_BIN[c.cmd])
          .filter((c): c is McpClientId => c !== undefined);
        const results = registerMcpEverywhere(
          { ...launch, env: MCP_ENV, alwaysAllow: DEFAULT_ALLOW },
          { extraIds: detectedClients },
        );
        for (const r of results) {
          const word = r.state === 'current' ? chalk.green('already configured')
            : r.state === 'created' ? chalk.green('configured')
            : r.state === 'repaired' ? chalk.green('repaired')
            : chalk.yellow('left alone — file does not parse');
          console.log(`   ${r.label}: ${word} → ${r.path}`);
        }
        console.log(chalk.dim(`   Launch: ${launch.command}${launch.args ? ' ' + launch.args.join(' ') : ''}`));
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

      // Install the chat-recall skills into every detected AI tool so agents
      // know when/how to reach for the recall_* tools (drop-in — the only
      // mechanism that covers all tools; see install-skills.ts).
      console.log(chalk.bold('Installing chat-recall skills into your AI tools...'));
      try {
        const { installSkills } = await import('./install-skills.js');
        const r = installSkills();
        const hits = r.perTarget.filter((t) => t.installed.length > 0);
        if (hits.length) {
          for (const t of hits) console.log(`   ${chalk.green(t.label)}: ${t.installed.length} skill(s) → ${t.dir}`);
        } else {
          console.log(chalk.dim('   No supported AI tools detected — skills not installed.'));
        }
        const userOwned = [...new Set(r.perTarget.flatMap((t) => t.skippedUserOwned))];
        if (userOwned.length) console.log(chalk.yellow(`   Kept your existing skill(s) of the same name: ${userOwned.join(', ')}`));
      } catch (err) {
        console.log(`   ${chalk.yellow('Skill install failed')} — ${err instanceof Error ? err.message : err}`);
      }
      console.log();

      // Bring this machine up to the setup the ACCOUNT already has, not just
      // the setup chat-recall ships. Without this step a second device gets
      // chat-recall's own MCP + skills and nothing else, so every other MCP
      // server the user relies on has to be registered by hand in each of
      // their tools — which is the whole reason cross-device setup was painful.
      // MCP registrations are the part the server can rebuild; see
      // toolkit-pull.ts for what cannot travel yet and why.
      if (!options.skipMcp && firstTarget()) {
        console.log(chalk.bold('Installing your other MCP servers from your account...'));
        try {
          const { loadAllCredentials } = await import('./sync-client.js');
          const { executePull } = await import('@chat-recall/engine/core/toolkit-pull.js');
          const { hostname } = await import('node:os');
          const rows: RemoteArtifactRow[] = [];
          for (const t of loadAllCredentials()) {
            try {
              const res = await fetch(`${t.serverUrl}/api/toolkit/browse/mcp?limit=1000`, {
                headers: t.token ? { authorization: `Bearer ${t.token}` } : {},
                signal: AbortSignal.timeout(20_000),
              });
              if (!res.ok) continue;
              const body = await res.json() as { items?: RemoteArtifactRow[] };
              for (const it of body.items || []) rows.push(it);
            } catch { /* one unreachable target must not stop init */ }
          }
          const report = executePull(rows, { thisDeviceId: hostname(), types: ['mcp'] });
          const written = report.outcomes.filter((o) => o.status === 'written');
          const present = report.outcomes.filter((o) => o.status === 'present').length;
          if (written.length === 0 && present === 0) {
            console.log(chalk.dim('   Nothing on your account to install yet.'));
          } else {
            console.log(`   ${chalk.green(`Installed ${written.length}`)} ${chalk.dim(`(${present} already present)`)}`);
            const envVars = [...new Set(written.flatMap((o) => o.needsEnv || []))].sort();
            if (envVars.length) {
              console.log(`   ${chalk.yellow('Set these env vars — their values were never uploaded:')} ${envVars.join(', ')}`);
            }
          }
        } catch (err) {
          console.log(`   ${chalk.yellow('Could not install account MCPs')} — ${err instanceof Error ? err.message : err}`);
          console.log(`   ${chalk.dim('Re-run `chat-recall toolkit pull` later.')}`);
        }
        console.log();
      }

      // Step 6: First sync — collect this machine's local sessions and ship
      // them to the server. Skipped when there's no login (nothing to ship to)
      // or when --skip-sync is passed.
      if (!options.skipSync && firstTarget()) {
        // BEFORE the upload, not after. This step used to open with "Shipping
        // local sessions" and report counts once every transcript on the disk
        // was already on the server — so the one irreversible decision in init
        // was made on the user's behalf and described in the past tense.
        const shipped = await confirmFirstSyncScope(!!options.yes);
        if (!shipped) {
          console.log();
        } else {
        // Not a second "6." — the scope summary above owns that number, and this
        // is the same step continuing once the user has agreed to it.
        console.log(chalk.dim('   Shipping...'));
        try {
          const { syncSessions } = await import('./sync-client.js');
          const r = await syncSessions();
          console.log(`   ${chalk.green(`Synced ${r.uploaded} session(s), ${r.items} item(s)`)} ${chalk.dim(`— ${r.links} links, ${r.derived} derived rows, ${r.kgTriples} KG triples, ${r.skipped} skipped, ${r.redactions} secrets redacted, ${r.findings} secret findings${r.scanned ? ` (scanned ${r.scanned} in ${r.scanMs}ms)` : ''}`)}`);
        } catch (err) {
          console.log(`   ${chalk.yellow('Sync failed')} — ${err instanceof Error ? err.message : err}`);
          console.log(`   ${chalk.dim('Re-run `chat-recall sync` once your server is reachable.')}`);
        }
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
      // Printed from DEFAULT_ALLOW, never from a hand-typed list. The literal
      // that used to sit here claimed 42 tools and named ten that do not exist
      // (recall_help, recall_plans, recall_files_touched, recall_similar_sessions,
      // recall_suggest_resume, …) while omitting the ones that do — the last
      // thing a new user reads on install. DEFAULT_ALLOW is asserted equal to the
      // registered tool set in mcp-tool-registry.test.ts, so this cannot drift.
      console.log(`chat-recall MCP tools (${DEFAULT_ALLOW.length}):`);
      for (let i = 0; i < DEFAULT_ALLOW.length; i += 3) {
        console.log('  ' + DEFAULT_ALLOW.slice(i, i + 3).join(', '));
      }
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
  .command('install-skills')
  .description('Install the chat-recall skills into every local AI tool (Claude/Gemini/Codex/OpenCode/Antigravity) so agents know how to use the recall_* tools')
  .option('--uninstall', 'Remove the chat-recall-managed skills from every tool')
  .option('--all-tools', 'Install to every supported tool, even ones not detected on this machine')
  .action(async (opts: { uninstall?: boolean; allTools?: boolean }) => {
    const mod = await import('./install-skills.js');
    if (opts.uninstall) {
      const r = mod.uninstallSkills();
      const hits = r.perTarget.filter((t) => t.removed.length > 0);
      if (!hits.length) { console.log(chalk.dim('No chat-recall skills were installed.')); return; }
      for (const t of hits) console.log(`${chalk.green('✓')} ${t.label}: removed ${t.removed.length} skill(s)`);
      return;
    }
    const r = mod.installSkills({ onlyAvailable: !opts.allTools });
    const names = mod.bundledSkillNames();
    console.log(chalk.bold(`Installing ${names.length} chat-recall skill(s) (v${r.version}):`), chalk.dim(names.join(', ')));
    const hits = r.perTarget.filter((t) => t.installed.length > 0);
    if (!hits.length) {
      console.log(chalk.yellow('No supported AI tools detected. Use --all-tools to install anyway.'));
      return;
    }
    for (const t of hits) console.log(`${chalk.green('✓')} ${t.label}: ${t.installed.length} → ${chalk.dim(t.dir)}`);
    const userOwned = [...new Set(r.perTarget.flatMap((t) => t.skippedUserOwned))];
    if (userOwned.length) console.log(chalk.yellow(`Kept your existing skill(s) of the same name: ${userOwned.join(', ')}`));
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
  .command('repair [sessionIds...]')
  .description('Rebuild sessions an upstream tool truncated in place (e.g. Claude Code resume rewrite) from the shrink-protected raw archive. DRY-RUN by default — pass --apply to write.')
  .option('--all', 'Scan the recency window and repair EVERY damaged session (no ids needed)', false)
  .option('--since-hours <n>', 'With --all: only scan sessions modified in the last N hours', '72')
  .option('--apply', 'Actually write the recovered conversations to the server(s). Without this, nothing is mutated.', false)
  .option('--server <url>', 'Target ONLY this server (e.g. the SaaS), instead of every configured sync endpoint')
  .option('--force', 'Push even to servers that already look full', false)
  .option('-v, --verbose', 'Per-session detail', false)
  .action(async (sessionIds: string[], options: { all?: boolean; sinceHours?: string; apply?: boolean; server?: string; force?: boolean; verbose?: boolean }) => {
    try {
      const mode = options.apply ? chalk.red('APPLY (writing to server)') : chalk.cyan('DRY-RUN (read-only)');
      const render = (r: import('./repair.js').RepairResult) => {
        const head = `${r.sessionId.slice(0, 8)}…`;
        if (r.status === 'no-archive') { console.log(chalk.yellow(`  ? ${head} no archive found`)); return; }
        if (r.status === 'already-full') { console.log(chalk.dim(`  = ${head} already full (${r.fullestMessages} msgs)`)); return; }
        if (r.status === 'error') { console.log(chalk.red(`  ✗ ${head} ${r.note}`)); return; }
        const verb = r.status === 'would-repair' ? 'would recover' : 'recovered';
        console.log(chalk.green(`  ${r.status === 'would-repair' ? '·' : '+'} ${head} ${verb} ${r.fullestMessages} msgs`) + chalk.dim(` from ${r.fullestSource}`));
        for (const p of r.pushed) console.log(chalk.dim(`      ${p.server}: ${p.before} → ${p.after}`));
      };

      if (options.all) {
        console.log(chalk.bold(`repair --all · ${mode} · window ${options.sinceHours}h`));
        const { repairAll } = await import('./repair.js');
        const report = await repairAll({
          sinceHours: Number(options.sinceHours) || 72,
          apply: options.apply,
          verbose: options.verbose,
          server: options.server,
        });
        report.candidates.forEach(render);
        const fixed = report.candidates.filter((r) => r.status === 'repaired').length;
        const would = report.candidates.filter((r) => r.status === 'would-repair').length;
        console.log(chalk.bold(
          `Scanned ${report.scanned} session(s) on ${report.discoveryServer}; ` +
          (options.apply ? `repaired ${fixed}.` : `${would} damaged, would repair. Re-run with --apply to write.`),
        ));
        return;
      }

      if (!sessionIds || sessionIds.length === 0) {
        console.error(chalk.red('Give session ids, or use --all. e.g. `chat-recall repair <uuid>` or `chat-recall repair --all`.'));
        process.exit(1);
      }
      console.log(chalk.bold(`repair · ${mode}`));
      const { repairSessions } = await import('./repair.js');
      const results = await repairSessions(sessionIds, { dryRun: !options.apply, force: options.force, verbose: options.verbose, server: options.server });
      results.forEach(render);
      const fixed = results.filter((r) => r.status === 'repaired').length;
      const would = results.filter((r) => r.status === 'would-repair').length;
      console.log(chalk.bold(options.apply ? `Repaired ${fixed} session(s).` : `${would} session(s) would be repaired. Re-run with --apply to write.`));
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

      // Relative tiers, not an absolute percentage. See core/score-tier.ts: BM25
      // ranks and vector distances land in completely different numeric ranges,
      // so `score * 100` printed 2/100 for a strong hit and read as "broken".
      const tiers = tierAll(results);

      for (let i = 0; i < results.length; i++) {
        const result = results[i];

        let projectPath = result.projectPath || '';
        if (projectPath.length > 50) projectPath = '...' + projectPath.slice(-47);

        let title = (result.firstPrompt || '').replace(/\n/g, ' ').trim();
        if (title.length > 80) title = title.slice(0, 80) + '...';

        console.log(`${chalk.bold.cyan(`#${i + 1}`)} ${title}`);
        if (projectPath) console.log(`   ${chalk.dim('Project:')} ${projectPath}`);
        console.log(`   ${chalk.dim('Match:')} ${matchLabel(tiers[i])}`);

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

        { const rc = resumeCommandFor(result.sessionId); if (rc) console.log(`   ${chalk.green('Resume:')} ${rc}`); }
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
      { const rc = resumeCommandFor(sessionId); if (rc) console.log(chalk.dim(`Resume: ${rc}`)); }
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

      // Same relative tiering as `search` — see core/score-tier.ts.
      const tiers = tierAll(results);

      for (let i = 0; i < results.length; i++) {
        const r = results[i];

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
        console.log(`   ${chalk.dim('Match:')} ${matchLabel(tiers[i])}${typeSuffix}`);

        let preview = (r.text || '').replace(/\n/g, ' ').trim();
        if (preview.length > 150) preview = preview.slice(0, 147) + '...';
        if (preview) console.log(`   ${preview}`);

        if (r.sourceType === 'session') {
          { const rc = resumeCommandFor(r.itemId); if (rc) console.log(`   ${chalk.green('Resume:')} ${rc}`); }
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

program
  .command('escalate [sessionId]')
  .description("Escalate a finished session's learnings (decisions, user corrections, outcome) into the knowledge graph (requires login)")
  .option('--latest', 'Pick the most recent synced session of the current project')
  .option('-p, --project <name>', 'Knowledge-graph entity name for the facts (default: project folder name)')
  .option('--dry-run', 'Extract and print the learnings without writing them')
  .action(async (sessionId: string | undefined, opts: { latest?: boolean; project?: string; dryRun?: boolean }) => {
    // Argument misuse is a real error (interactive user), but everything
    // environmental (no login, server down, session not synced) must be a
    // note + exit 0: this command runs from a SessionEnd hook, and a hook
    // must never break session end.
    if (!sessionId && !opts.latest) {
      console.error(chalk.red('Pass a session id or --latest.'));
      process.exit(1);
    }
    const target = firstTarget();
    if (!target) {
      console.log(chalk.dim('escalate: not logged in — nothing to do. Run `chat-recall login <server-url>` to enable learnings escalation.'));
      return;
    }
    try {
      const { runEscalate } = await import('./escalate.js');
      await runEscalate(
        { get: serverGet, getSoft: serverGetSoft, post: serverPost, log: (line) => console.log(chalk.dim(line)) },
        { sessionId, latest: opts.latest, project: opts.project, dryRun: opts.dryRun, cwd: process.cwd() },
      );
    } catch (err) {
      // Server unreachable / 5xx / anything unexpected: note, exit 0.
      console.log(chalk.dim(`escalate: skipped — ${err instanceof Error ? err.message : err}`));
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
    }

    // Reachability FIRST, then the credential — because the two failures have
    // different fixes and the old code could not tell them apart. A host that
    // had been renamed away served an HTML 404, `.json()` threw on `<!DO`, and
    // the single catch reported a JSON parse error while the row above still
    // showed a green "Logged in" tick (it only checked that the file had an
    // entry). See server-probe.ts.
    if (target) {
      const { probeServer, probeOk, probeAdvice } = await import('./server-probe.js');
      const probe = await probeServer(target.base);
      note(probeOk(probe), 'Server reachable', probeAdvice(probe, target.base));

      if (probeOk(probe)) {
        // The server is real, so a credential failure now means the CREDENTIAL,
        // which is the only case where "re-login" is the right advice.
        let tokenNote: { ok: boolean; detail: string };
        try {
          const res = await fetch(`${target.base}/api/status`, {
            headers: target.token ? { authorization: `Bearer ${target.token}` } : {},
            signal: AbortSignal.timeout(10_000),
          });
          if (res.ok) {
            tokenNote = { ok: true, detail: `${targets.length} target(s); primary: ${target.base}` };
          } else if (res.status === 401 || res.status === 403) {
            tokenNote = { ok: false, detail: `${target.base} rejected the token (HTTP ${res.status}) — run \`chat-recall login ${target.base}\`` };
          } else {
            tokenNote = { ok: false, detail: `${target.base} answered HTTP ${res.status} for an authenticated request` };
          }
        } catch (err) {
          tokenNote = { ok: false, detail: `could not verify the token: ${err instanceof Error ? err.message : err}` };
        }
        note(tokenNote.ok, 'Logged in', tokenNote.detail);

        // A stale CLI is the quietest failure this product has — it keeps
        // "working" while collecting with months-old logic. Make it a first-
        // class doctor row, not something you infer from missing data.
        const { refreshUpdateCheck } = await import('./update-notice.js');
        await refreshUpdateCheck(true).catch(() => null);
        const stale = updateNotice();
        note(!stale, 'CLI up to date', stale ? `${stale} (server serves ${probe.cliVersion ?? '?'})` : `${pkgVersion} — current`);
      } else {
        // Do NOT claim the login is fine when nothing answered — that green tick
        // is what sent the last debugging session after the wrong problem.
        note(false, 'Logged in', `cannot verify against ${target.base} — fix the server row above first`);
      }
    } else {
      note(false, 'Server reachable', 'N/A (not logged in)');
    }

    // Is the collector actually collecting? This is the row that was missing
    // when the daemon aborted 4,851 times over eight days and nothing said so:
    // every other check here was green while nothing had synced for weeks.
    {
      const h = readCollectorHealth();
      if (!h) {
        note(false, 'Collector reporting', `no health report at ${collectorHealthPath()} — the watch daemon may never have run (\`chat-recall watch --install-service\`)`);
      } else {
        const v = judgeHealth(h);
        note(v.ok, 'Collector healthy', v.ok
          ? `last reported ${Math.max(0, Math.round((Date.now() - h.updatedAt) / 1000))}s ago, ${Object.keys(h.targets).length} target(s)`
          : v.reasons.join('; '));
        // A walk in flight explains a target that looks behind, so report it
        // BEFORE the per-target lines rather than leaving the user to conclude
        // something is broken while a first sync is still running.
        const walking = progressLine(h);
        if (walking) note(true, 'Sync in progress', walking);
        // TELEMETRY IS VISIBLE OR IT IS NOT CONSENSUAL. A user must be able to
        // ask what leaves their machine and get a straight answer, including
        // exactly how to turn it off.
        {
          const consent = userConsents();
          // From the PERSISTED record, not this process's memory: doctor never
          // syncs, so its in-memory eligibility map is always empty and the old
          // version of this line told every user "no server accepts it" —
          // confidently, and wrongly.
          const confirmed = h.telemetryEligible ?? {};
          const sending = Object.entries(confirmed).filter(([, v]) => v.allowed).map(([u]) => u);
          const refused = Object.entries(confirmed).filter(([, v]) => !v.allowed).map(([u]) => u);
          note(true, 'Collector telemetry', !consent
            ? 'off — you opted out (privacy.telemetry=false or CHAT_RECALL_TELEMETRY=0)'
            : sending.length > 0
              ? `on → ${sending.join(', ')} · walk timings, counts and error classes only, `
                + 'never paths or content · turn off with CHAT_RECALL_TELEMETRY=0'
              : refused.length > 0
                ? `on, but ${refused.join(', ')} does not accept it (it needs a paid plan) — nothing is sent`
                : 'on, but no server has answered yet — nothing is sent until one confirms');
        }
        for (const [url, t] of Object.entries(h.targets)) {
          const okRecently = t.lastOkAt !== null && Date.now() - t.lastOkAt < STALE_AFTER_MS;
          note(okRecently, `Synced to ${url}`, t.lastOkAt === null
            ? `never — ${t.failures} consecutive failure(s)${t.lastError ? `: ${t.lastError}` : ''}`
            : `${Math.round((Date.now() - t.lastOkAt) / 60000)}m ago${t.failures ? ` (${t.failures} failure(s) since)` : ''}`);
        }
      }
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
        //
        // Windows has no POSIX mode: Node synthesises 0666 (or 0444 read-only),
        // so `mode & 0o077` is never 0 and this printed a permanent red row that
        // no user could ever clear. Access there is governed by the ACL the file
        // inherits from the per-user profile directory, which chmod cannot
        // express — so report the path and say the check does not apply.
        const isWin = process.platform === 'win32';
        const safe = isWin || (mode & 0o077) === 0;
        note(safe, 'Credentials file', isWin
          ? `${credFile} (Windows ACL — POSIX mode does not apply)`
          : `${credFile} (mode ${mode.toString(8).padStart(3, '0')}${safe ? '' : ' — should be 600'})`);
      } catch (err) {
        note(false, 'Credentials file', `error: ${err}`);
      }
    }

    // Hooks + skills, PER CLAUDE PROFILE. Reporting only the primary home is
    // how a profile ran with no hooks and no skills while every check said OK:
    // its sessions index fine, so nothing else surfaces the gap.
    for (const hooksJson of claudeHookConfigFiles()) {
      const profile = basename(dirname(hooksJson));
      const label = `Claude hooks (${profile})`;
      if (!existsSync(hooksJson)) {
        note(false, label, `no ${hooksJson} — run \`chat-recall install-hooks\``);
        continue;
      }
      try {
        // Claude reads hooks from settings.json AS WELL as hooks.json, and the
        // wake-up hook is commonly hand-wired in the former. Reading only
        // hooks.json reports a working hook as missing.
        const readHooks = (file: string): Record<string, any[]> => {
          if (!existsSync(file)) return {};
          try { return JSON.parse(readFileSync(file, 'utf-8')).hooks || {}; } catch { return {}; }
        };
        const cfg = readHooks(hooksJson);
        const settings = readHooks(join(dirname(hooksJson), 'settings.json'));
        const all = ['SessionStart', 'UserPromptSubmit', 'Stop', 'PreCompact', 'SessionEnd'];
        const hits: string[] = [];
        for (const ev of all) {
          const arr = [
            ...(Array.isArray(cfg[ev]) ? cfg[ev] : []),
            ...(Array.isArray(settings[ev]) ? settings[ev] : []),
          ];
          if (arr.some((h: any) => (h.hooks?.[0]?.command || '').includes('chat_recall'))) hits.push(ev);
        }
        note(hits.length === all.length, label,
          hits.length === 0 ? 'none — run `chat-recall install-hooks`'
            : `${hits.join(', ')}${hits.length < all.length ? ` (missing ${all.filter((e) => !hits.includes(e)).join(', ')} — run install-hooks)` : ''}`);
      } catch {
        note(false, label, `${hooksJson} unparseable`);
      }
    }

    // Skills, per target tool. An agent with no skill file has 50 recall_*
    // tools and no idea when to reach for one, which reads as "recall never
    // works here" rather than as a missing install.
    try {
      const { skillTargets, bundledSkillNames } = await import('./install-skills.js');
      const want = bundledSkillNames().length;
      for (const t of skillTargets()) {
        if (!t.available) continue;
        const have = want === 0 ? 0 : bundledSkillNames()
          .filter((n) => existsSync(join(t.dir, n, '.chat-recall-managed'))).length;
        note(have === want, `Skills — ${t.label}`,
          have === want ? `${have}/${want} in ${t.dir}` : `${have}/${want} in ${t.dir} — run \`chat-recall install-skills\``);
      }
    } catch (err) {
      note(false, 'Skills', `check failed: ${err}`);
    }

    // MCP server registration — PER CLIENT. One line per AI tool, because
    // "registered" in Claude Code told a Codex user nothing about Codex.
    try {
      const { inspectMcpClients } = await import('@chat-recall/engine/core/mcp-clients.js');
      for (const c of inspectMcpClients()) {
        if (!c.present && !c.registered) continue;  // tool not on this machine
        note(c.registered, `MCP server — ${c.label}`,
          c.registered ? `registered in ${c.path}` : `missing from ${c.path} — run \`chat-recall init\``);
      }
    } catch (err) {
      note(false, 'MCP server registration', `check failed: ${err}`);
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

    // Transcript folders — the check that would have surfaced a work profile
    // sitting unsynced for a day. A folder we found but nobody decided about is
    // NOT being collected, and until this line existed nothing said so.
    try {
      const { discoverHomes } = await import('@chat-recall/engine/core/home-discovery.js');
      const { homeDecision, grandfatherLegacyHomes } = await import('@chat-recall/engine/core/home-approval.js');
      grandfatherLegacyHomes();
      const homes = discoverHomes({ includeRunning: false });
      const pending = homes.filter((h) => homeDecision(h.path) === 'pending');
      const syncing = homes.filter((h) => ['primary', 'approved'].includes(homeDecision(h.path)));
      if (homes.length === 0) {
        note(false, 'transcript folders', 'none found — is an AI coding tool installed for this user?');
      } else if (pending.length > 0) {
        const n = pending.reduce((a, h) => a + h.sessions, 0);
        note(false, 'transcript folders',
          `${syncing.length} syncing, ${pending.length} awaiting a decision` +
          (n > 0 ? ` (${n} session${n === 1 ? '' : 's'} NOT synced)` : '') +
          ' — run `chat-recall sources`');
      } else {
        note(true, 'transcript folders', `${syncing.length} syncing across ${new Set(homes.map((h) => h.tool)).size} tool(s)`);
      }
    } catch (err) {
      note(false, 'transcript folders', `check failed: ${err instanceof Error ? err.message : err}`);
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

// ── verify: is the server actually holding what this machine has? ────────
// Every silent-loss incident here was found by a human asking about one
// session. `15604 skipped` prints identically whether the corpus is complete or
// a third of a session is missing, so this is the check that makes the
// difference visible without an investigation.
program
  .command('verify')
  .description('Check that the server holds everything this machine has, per session')
  .option('--deep', 'Compare per-session content size against each server', false)
  .option('--records', 'With --deep: also diff the exact record (uuid) sets — proof, not inference', false)
  .option('--since-hours <n>', 'Only check sessions modified in the last N hours (default: all)')
  .option('--repair', 'Re-ship every STRANDED session found (clears its ledger cursor)', false)
  .option('--json', 'Machine-readable output', false)
  .action(async (opts: { deep?: boolean; records?: boolean; sinceHours?: string; repair?: boolean; json?: boolean }) => {
    if (!opts.deep) {
      console.log(chalk.yellow('verify currently implements only --deep; re-run with --deep.'));
      return;
    }
    const { verifyAgainstServer, verifyTargets } = await import('./verify-deep.js');
    const { getBackend } = await import('@chat-recall/engine/core/tool-backend.js');
    const { gzipContainer, mapContainerText } = await import('@chat-recall/engine/transcript/index.js');
    const { redactSecrets } = await import('@chat-recall/engine/core/secret-redactor.js');
    const { fetchWithTimeout } = await import('./http.js');
    const { forceFullResync } = await import('./verify-repair.js');

    const targets = verifyTargets();
    if (targets.length === 0) {
      console.error(chalk.red('No server configured — run `chat-recall login` first.'));
      process.exit(1);
    }
    const sinceMs = opts.sinceHours ? Date.now() - Number(opts.sinceHours) * 3600_000 : 0;
    const claude = getBackend('claude');

    /** Local record (uuid) set for a session — the union across homes, which is
     *  what the archive is supposed to contain. */
    const localRecordIds = (rawId: string): Set<string> | null => {
      try {
        const exp = claude.exportRawSession?.(rawId);
        if (!exp) return null;
        const ids = new Set<string>();
        for (const f of exp.files) {
          for (const line of f.bytes.toString('utf-8').split('\n')) {
            if (!line.trim()) continue;
            try {
              const u = (JSON.parse(line) as { uuid?: unknown }).uuid;
              if (typeof u === 'string' && u) ids.add(u);
            } catch { /* not a record line */ }
          }
        }
        return ids;
      } catch { return null; }
    };

    const deps = {
      listSessions: (since: number) => claude.listSessions({ sinceMs: since }).map((s) => ({
        rawId: s.rawId, prefixedId: s.prefixedId, projectPath: s.projectPath, mtime: s.mtime,
      })),
      fileSize: (rawId: string) => claude.fileSize?.(rawId) ?? 0,
      localContainerSize: (rawId: string): number | null => {
        try {
          const exp = claude.exportRawSession?.(rawId);
          if (!exp) return null;
          const container = {
            v: 1, tool: 'claude', mtime: exp.mtime,
            files: exp.files.map((f) => ({ name: f.name, text: f.bytes.toString('utf-8') })),
          } as never;
          // REDACT FIRST — the sync ships a redacted container, so measuring the
          // raw one compares different things. Redaction changes size (a long
          // secret becomes a short sentinel), which showed up as a permanent
          // deficit that no amount of re-syncing could close: two sessions stayed
          // "stranded" through a full repair+sync cycle purely because they
          // contained secrets. Same call the sync path makes.
          const redacted = mapContainerText(container, (t) => redactSecrets(t, { force: true }));
          return gzipContainer(redacted).size;
        } catch { return null; }
      },
      serverSizes: async (server: string, token: string) => {
        const headers: Record<string, string> = {};
        if (token) headers.authorization = `Bearer ${token}`;
        const res = await fetchWithTimeout(`${server}/api/status/archives`, { headers }, 120_000);
        if (!res.ok) throw new Error(`${server}: HTTP ${res.status} from /api/status/archives`);
        const body = await res.json() as { archives?: Array<{ id: string; size: number }> };
        return new Map((body.archives || []).map((a) => [a.id, Number(a.size) || 0]));
      },
    };

    let exitCode = 0;
    const reports = [];
    for (const t of targets) {
      let report;
      try {
        report = await verifyAgainstServer(t.serverUrl, t.token, sinceMs, deps);
      } catch (e) {
        console.error(chalk.red(`${t.serverUrl}: ${e instanceof Error ? e.message : e}`));
        exitCode = 1;
        continue;
      }
      reports.push(report);
      if (opts.json) continue;

      console.log(chalk.bold(`\n${t.serverUrl}`));
      console.log(`  checked ${report.checked} · complete ${report.complete} · no archive ${report.missingArchive}`);
      if (report.pending.length > 0) {
        console.log(chalk.dim(`  ${report.pending.length} pending (the ledger knows there is more to send — these go on their own)`));
      }
      if (report.stranded.length === 0) {
        console.log(chalk.green('  ✓ nothing stranded'));
      } else {
        exitCode = 2;
        console.log(chalk.red(`  ✗ ${report.stranded.length} STRANDED — the ledger claims complete while the server holds less:`));
        for (const f of report.stranded.slice(0, 25)) {
          console.log(`      ${f.sessionId.slice(0, 8)}  server short by ${String(f.deficit).padStart(9)} B  ${(f.projectPath || '').slice(-44)}`);
        }
        if (report.stranded.length > 25) console.log(chalk.dim(`      …and ${report.stranded.length - 25} more`));
        if (!opts.repair) {
          console.log(chalk.dim('  Re-run with --repair to clear their cursors and re-ship.'));
        }
      }

      // --records: size parity is evidence, a record diff is proof. Two
      // containers can agree on bytes and differ in content, and a session that
      // size comparison called merely "pending" turned out to be missing 589
      // records. Run against everything the size pass did not call complete.
      if (opts.records) {
        const suspects = [...report.stranded, ...report.pending];
        if (suspects.length === 0) {
          console.log(chalk.dim('  --records: nothing to deep-check (size pass found no gaps)'));
        } else {
          console.log(chalk.bold(`\n  record-level diff (${suspects.length} session(s)):`));
          for (const f of suspects) {
            let serverIds: Set<string>;
            try {
              const headers: Record<string, string> = {};
              if (t.token) headers.authorization = `Bearer ${t.token}`;
              const res = await fetchWithTimeout(`${t.serverUrl}/api/status/archives/${f.sessionId}/records`, { headers }, 120_000);
              if (!res.ok) { console.log(`      ${f.sessionId.slice(0, 8)}  server records unavailable (HTTP ${res.status})`); continue; }
              const body = await res.json() as { records?: string[] };
              serverIds = new Set(body.records || []);
            } catch (e) {
              console.log(`      ${f.sessionId.slice(0, 8)}  record fetch failed: ${e instanceof Error ? e.message : e}`);
              continue;
            }
            const localIds = localRecordIds(f.sessionId);
            if (localIds === null) { console.log(`      ${f.sessionId.slice(0, 8)}  local unreadable`); continue; }
            const missing = [...localIds].filter((u) => !serverIds.has(u)).length;
            const onlyServer = [...serverIds].filter((u) => !localIds.has(u)).length;
            const verdict = missing === 0
              ? chalk.green('in sync')
              : chalk.red(`${missing} MISSING server-side`);
            console.log(
              `      ${f.sessionId.slice(0, 8)}  local ${String(localIds.size).padStart(6)}  server ${String(serverIds.size).padStart(6)}  ${verdict}` +
              (onlyServer > 0 ? chalk.dim(`  (+${onlyServer} server-only — resume truncation)`) : ''),
            );
            if (missing > 0) exitCode = 2;
          }
        }
      }

      if (opts.repair && report.stranded.length > 0) {
        const n = forceFullResync(t.serverUrl, report.stranded.map((f) => f.sessionId));
        console.log(chalk.green(`  ↻ cleared ${n} ledger cursor(s) — run \`chat-recall sync\` to re-ship`));
      }
    }
    if (opts.json) console.log(JSON.stringify({ reports }, null, 2));
    process.exit(exitCode);
  });

// ── sources: which transcript homes this machine syncs ───────────────────
// The answer to "can a user configure this?" — before this existed the only
// options were an undocumented env var or hand-editing settings.json, and there
// was no way to even SEE what was being synced. A profile not named
// `~/.claude-*` got silent zero coverage.
const sources = program
  .command('sources')
  .description('See and choose which AI-tool transcript folders get synced');

function decisionBadge(d: string): string {
  if (d === 'primary')  return chalk.green('syncing') + chalk.dim(' (main)');
  if (d === 'approved') return chalk.green('syncing');
  if (d === 'declined') return chalk.dim('not syncing');
  return chalk.yellow('NEEDS A DECISION');
}

async function listSources(): Promise<{ pending: number }> {
  const { discoverHomes } = await import('@chat-recall/engine/core/home-discovery.js');
  const { homeDecision, grandfatherLegacyHomes } = await import('@chat-recall/engine/core/home-approval.js');
  grandfatherLegacyHomes();
  const homes = discoverHomes();
  console.log(chalk.bold('Transcript folders found on this machine'));
  if (homes.length === 0) {
    console.log(chalk.dim('  none — no AI tool transcripts detected'));
    return { pending: 0 };
  }
  let pending = 0;
  for (const h of homes) {
    const d = homeDecision(h.path);
    if (d === 'pending') pending++;
    const count = h.sessions > 0 ? `${h.sessions} session${h.sessions === 1 ? '' : 's'}` : '—';
    console.log(
      `  ${h.tool.padEnd(9)} ${count.padStart(14)}  ${decisionBadge(d).padEnd(30)} ${h.path}` +
      (h.via === 'declared' ? chalk.dim('  (you configured this)') : ''),
    );
  }
  if (pending > 0) {
    console.log();
    console.log(chalk.yellow(`  ${pending} folder(s) need a decision — they are NOT being synced yet.`));
    console.log(chalk.dim('  chat-recall sources approve <path>   start syncing it'));
    console.log(chalk.dim('  chat-recall sources decline <path>   keep it out (e.g. a work account)'));
  }
  return { pending };
}

sources
  .command('list', { isDefault: true })
  .description('Show every transcript folder found, and whether it is synced')
  .action(async () => { await listSources(); });

sources
  .command('add <path>')
  .description('Sync a transcript folder we did not find automatically')
  .action(async (path: string) => {
    const { identifyHome } = await import('@chat-recall/engine/core/home-discovery.js');
    const { approveHome, normalizeHomePath } = await import('@chat-recall/engine/core/home-approval.js');
    const abs = normalizeHomePath(path);
    const tool = identifyHome(abs);
    if (!tool) {
      // Refuse rather than accept a path that will silently sync nothing.
      console.error(chalk.red(`Not a transcript folder: ${abs}`));
      console.error(chalk.dim('  Expected one of:'));
      console.error(chalk.dim('    <dir>/projects/<project>/<uuid>.jsonl        (Claude Code)'));
      console.error(chalk.dim('    <dir>/sessions/YYYY/MM/DD/rollout-*.jsonl    (Codex)'));
      console.error(chalk.dim('    <dir>/tmp/<project>/chats/session-*.json      (Gemini)'));
      console.error(chalk.dim('    <dir>/brain/<id>/.system_generated/logs/*     (Antigravity)'));
      console.error(chalk.dim('    <dir>/opencode.db                             (OpenCode)'));
      process.exit(1);
    }
    if (!approveHome(abs)) { console.error(chalk.red('Could not write settings.')); process.exit(1); }
    console.log(chalk.green(`✓ syncing ${tool} transcripts from ${abs}`));
    console.log(chalk.dim('  Takes effect on the next sync; run `chat-recall sync` to do it now.'));
  });

sources
  .command('approve <path>')
  .description('Start syncing a folder that was waiting for a decision')
  .action(async (path: string) => {
    const { approveHome, normalizeHomePath } = await import('@chat-recall/engine/core/home-approval.js');
    const abs = normalizeHomePath(path);
    if (!approveHome(abs)) { console.error(chalk.red('Could not write settings.')); process.exit(1); }
    console.log(chalk.green(`✓ now syncing ${abs}`));
  });

sources
  .command('decline <path>')
  .description('Keep a folder out of sync (e.g. a work account you do not want here)')
  .option('--delete-remote', 'Also delete sessions already uploaded FROM this folder (irreversible)', false)
  .option('--yes', 'Skip the confirmation prompt for --delete-remote', false)
  .action(async (path: string, opts: { deleteRemote?: boolean; yes?: boolean }) => {
    const { declineHome, normalizeHomePath } = await import('@chat-recall/engine/core/home-approval.js');
    const { identifyHome, sessionIdsInHome } = await import('@chat-recall/engine/core/home-discovery.js');
    const abs = normalizeHomePath(path);
    if (!declineHome(abs)) { console.error(chalk.red('Could not write settings.')); process.exit(1); }
    console.log(chalk.green(`✓ not syncing ${abs}`));

    if (!opts.deleteRemote) {
      console.log(chalk.dim('  Sessions already uploaded from it stay on the server.'));
      console.log(chalk.dim(`  To remove those too: chat-recall sources decline ${path} --delete-remote`));
      return;
    }

    // The SERVER cannot do this on its own: it never records which folder a
    // session came from, so only this machine can map folder → session ids.
    // Without it, declining stops future uploads but leaves prior ones — which
    // makes "keep my work data out of here" unenforceable after the fact.
    const tool = identifyHome(abs);
    if (!tool) { console.error(chalk.red(`Not a transcript folder: ${abs}`)); process.exit(1); }
    const ids = sessionIdsInHome(abs, tool);
    if (ids.length === 0) {
      console.log(chalk.dim('  Nothing to delete — no session files found in that folder.'));
      if (tool === 'opencode') {
        console.log(chalk.dim('  (OpenCode keys sessions by database row, so they cannot be enumerated from the path.)'));
      }
      return;
    }

    const targets = loadAllCredentials();
    if (targets.length === 0) { console.error(chalk.red('Not logged in — nothing to delete from.')); process.exit(1); }

    if (!opts.yes) {
      console.log();
      console.log(chalk.yellow(`About to DELETE ${ids.length} session(s) from ${targets.length} server(s).`));
      console.log(chalk.yellow('This is irreversible — the transcripts stay on this machine, but the'));
      console.log(chalk.yellow('server copies (search index, conversation view, archive) are removed.'));
      const { createInterface } = await import('node:readline/promises');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question('Type the number of sessions to confirm: ')).trim();
      rl.close();
      if (answer !== String(ids.length)) {
        console.log(chalk.dim('Cancelled — nothing deleted.'));
        return;
      }
    }

    const { fetchWithTimeout } = await import('./http.js');
    for (const t of targets) {
      const base = t.serverUrl.replace(/\/+$/, '');
      const headers: Record<string, string> = {};
      if (t.token) headers.authorization = `Bearer ${t.token}`;
      let deleted = 0, missing = 0, failed = 0;
      for (const id of ids) {
        try {
          const res = await fetchWithTimeout(`${base}/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE', headers }, 30_000);
          if (res.ok) deleted++;
          else if (res.status === 404) missing++;
          else failed++;
        } catch { failed++; }
      }
      const line = `  ${base}: deleted ${deleted}` + (missing ? `, ${missing} were not there` : '') + (failed ? chalk.red(`, ${failed} FAILED`) : '');
      console.log(failed ? chalk.yellow(line) : chalk.green(line));
      if (failed) process.exitCode = 1;
    }
  });

sources
  .command('forget <path>')
  .description('Undo a decision, so the folder is asked about again')
  .action(async (path: string) => {
    const { resetHomeDecision, normalizeHomePath } = await import('@chat-recall/engine/core/home-approval.js');
    const abs = normalizeHomePath(path);
    resetHomeDecision(abs);
    console.log(chalk.green(`✓ ${abs} is undecided again (not syncing until approved)`));
  });

// ── detectors: the OPTIONAL external secret scanners ─────────────────────
// These are a developer/CI/self-host tool, not part of the SaaS path — the
// detection every user relies on is in-process (see docs/SECRET-DETECTION.md).
// When they are used, they are used on our terms: pinned version, checksum
// verified, installed under the user's own data dir, invoked by absolute path.
// PATH is never consulted, because PATH is what made the same trufflehog
// version leak 34MB per spawn on one machine and not on another.
const detectors = program
  .command('detectors')
  .description('Manage the optional external secret detectors (gitleaks, trufflehog)');

detectors
  .command('status')
  .description('Show which detectors are installed, pinned and verified')
  .action(async () => {
    const { detectorStatus } = await import('@chat-recall/engine/core/detector-install.js');
    const { externalScannersEnabled } = await import('@chat-recall/engine/core/secret-scanner.js');
    console.log(chalk.bold('external secret detectors'));
    console.log(
      externalScannersEnabled()
        ? `  gate: ${chalk.green('enabled')} (CHAT_RECALL_EXTERNAL_SCANNERS)`
        : `  gate: ${chalk.yellow('disabled')} — set CHAT_RECALL_EXTERNAL_SCANNERS=1 to use them`,
    );
    if (process.env.CHAT_RECALL_DETECTOR_DIR) {
      console.log(`  dir:  ${chalk.dim(process.env.CHAT_RECALL_DETECTOR_DIR)} ${chalk.dim('(operator-supplied, unverified)')}`);
    }
    console.log();
    for (const d of detectorStatus()) {
      const label = `${d.name} ${chalk.dim(d.pinnedVersion)} ${chalk.dim(`[${d.license}]`)}`;
      if (d.state === 'ready')            console.log(`  ${chalk.green('✓')} ${label} → ${chalk.dim(d.path!)}`);
      else if (d.state === 'configured')  console.log(`  ${chalk.green('✓')} ${label} → ${chalk.dim(d.path!)} ${chalk.dim('(operator-supplied)')}`);
      else if (d.state === 'not-installed') console.log(`  ${chalk.dim('·')} ${label} — not installed`);
      else if (!d.supported)              console.log(`  ${chalk.dim('·')} ${label} — no build for this platform`);
      else console.log(`  ${chalk.red('✗')} ${label} — ${d.state}, reinstall with \`chat-recall detectors install ${d.name}\``);
    }
    console.log();
    console.log(chalk.dim('Builtin in-process detection runs for every user and needs none of this.'));
  });

detectors
  .command('install [name]')
  .description('Download + verify a pinned detector into ~/.chat-recall/bin (default: both)')
  .option('--force', 'Re-download even if the pinned version is already installed')
  .action(async (name: string | undefined, opts: { force?: boolean }) => {
    const { installDetector, DETECTOR_MANIFEST } = await import('@chat-recall/engine/core/detector-install.js');
    const names = name ? [name] : Object.keys(DETECTOR_MANIFEST);
    const valid = Object.keys(DETECTOR_MANIFEST);
    let failed = false;
    for (const n of names) {
      if (!valid.includes(n)) {
        console.error(chalk.red(`unknown detector "${n}" — expected one of: ${valid.join(', ')}`));
        failed = true;
        continue;
      }
      try {
        const r = await installDetector(n as 'gitleaks' | 'trufflehog', { force: opts.force });
        console.log(r.installed
          ? chalk.green(`✓ ${r.name} ${r.version} installed → ${r.path}`)
          : chalk.dim(`· ${r.name} ${r.version} already installed and verified → ${r.path}`));
        if (r.installed) console.log(chalk.dim(`  sha256 ${r.binarySha256}`));
      } catch (err) {
        failed = true;
        console.error(chalk.red(`${n} install failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
    if (failed) process.exit(1);
    console.log();
    console.log(chalk.dim('Enable them with CHAT_RECALL_EXTERNAL_SCANNERS=1. They enrich the findings'));
    console.log(chalk.dim('dashboard; they are not what redacts your data before it syncs.'));
  });

detectors
  .command('remove [name]')
  .description('Remove detectors chat-recall installed (never touches your own binaries)')
  .action(async (name: string | undefined) => {
    const { removeDetector, DETECTOR_MANIFEST, managedDetectorPath } = await import('@chat-recall/engine/core/detector-install.js');
    for (const n of (name ? [name] : Object.keys(DETECTOR_MANIFEST))) {
      if (!(n in DETECTOR_MANIFEST)) { console.error(chalk.red(`unknown detector "${n}"`)); continue; }
      const removed = removeDetector(n as 'gitleaks' | 'trufflehog');
      console.log(removed
        ? chalk.green(`✓ removed ${n}`)
        : chalk.dim(`· nothing to remove at ${managedDetectorPath(n as 'gitleaks' | 'trufflehog')}`));
    }
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
  .command('pull')
  .description('Install artifacts this device is missing, from the server (cross-device setup)')
  .option('--types <list>', 'comma-separated subset: mcp')
  .option('--dry-run', 'report what would change, write nothing')
  .action(async (options: { types?: string; dryRun?: boolean }) => {
    const { loadAllCredentials } = await import('./sync-client.js');
    const { executePull } = await import('@chat-recall/engine/core/toolkit-pull.js');
    const { hostname } = await import('node:os');

    const targets = loadAllCredentials();
    if (targets.length === 0) {
      console.error(chalk.red('Not logged in.'), 'Run `chat-recall login <server-url>` first.');
      process.exit(1);
    }

    // Every logged-in server, so a self-host target and the hosted one both
    // contribute. Rows collide by MCP name and the planner keeps the richest.
    const rows: RemoteArtifactRow[] = [];
    for (const t of targets) {
      for (const type of ['mcp', 'skill', 'agent', 'command', 'instructions']) {
        try {
          const res = await fetch(`${t.serverUrl}/api/toolkit/browse/${type}?limit=1000`, {
            headers: t.token ? { authorization: `Bearer ${t.token}` } : {},
          });
          if (!res.ok) continue;
          const body = await res.json() as { items?: RemoteArtifactRow[] };
          for (const it of body.items || []) rows.push(it);
        } catch (err) {
          console.log(chalk.dim(`  (${t.serverUrl} ${type}: ${err instanceof Error ? err.message : err})`));
        }
      }
    }
    if (rows.length === 0) {
      console.log('Nothing on the server to pull. Run `chat-recall index` on the device that has your setup.');
      return;
    }

    const types = options.types
      ? options.types.split(',').map(x => x.trim()).filter(Boolean) as Array<'skill' | 'mcp' | 'command' | 'agent' | 'instructions'>
      : undefined;
    const report = executePull(rows, { thisDeviceId: hostname(), types, dryRun: options.dryRun });

    const written = report.outcomes.filter(o => o.status === 'written');
    const present = report.outcomes.filter(o => o.status === 'present');
    const failed = report.outcomes.filter(o => o.status === 'failed');
    const skipped = report.outcomes.filter(o => o.status === 'skipped');

    for (const o of written) {
      // Say when the command was re-pointed at this machine's copy — the entry
      // is NOT byte-identical to the one on the source device, and a silent
      // rewrite is the kind of difference that confuses the next debugging run.
      const note = o.rewrittenCommand ? chalk.cyan(`  [using this machine's ${o.rewrittenCommand}]`) : '';
      console.log(chalk.green(`  + ${o.type} ${o.name} → ${o.tool}`) + chalk.dim(`  ${o.path || '(dry run)'}`) + note);
    }
    for (const o of failed) console.log(chalk.red(`  ✗ ${o.type} ${o.name} → ${o.tool}: ${o.reason}`));
    for (const o of skipped) console.log(chalk.yellow(`  ~ ${o.type} ${o.name} → ${o.tool}: ${o.reason}`));

    console.log(chalk.bold(
      `${options.dryRun ? 'Would install' : 'Installed'}: ${written.length}`
      + ` · already present: ${present.length}`
      + ` · failed: ${failed.length}`
      + ` · skipped: ${skipped.length}`,
    ));

    // Env values never leave the source machine, so say which ones to set here
    // rather than leaving a registration that fails on first use.
    const envVars = [...new Set(written.flatMap(o => o.needsEnv || []))].sort();
    if (envVars.length) {
      console.log('');
      console.log(chalk.yellow.bold('Set these environment variables — their values were never uploaded:'));
      for (const v of envVars) console.log(`  ${v}`);
    }

    // NAME what could not travel. A partial sync reported as a success is why
    // nobody checks a sync report twice.
    if (report.unsupported.length) {
      console.log('');
      console.log(chalk.dim('Not installable from the server yet:'));
      for (const u of report.unsupported) {
        console.log(chalk.dim(`  ${u.type} (${u.rows} on the server) — ${u.reason}`));
      }
      console.log(chalk.dim('  Those need artifact content upload; the server holds an inventory only.'));
    }
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

// ── Per-project team sharing ────────────────────────────────────────────
// Default is private: teammates see your work on a project only after you
// share it. Backed by the data-plane /api/shares (device-token capable).

program
  .command('shares')
  .description('List the projects you share with your team')
  .action(async () => {
    try {
      const { shares } = await serverGet<{ shares: Array<{ projectId: string; scope: string; sharedAt: number }> }>('/api/shares');
      if (!shares.length) { console.log(chalk.gray('You are not sharing any projects. Share one with'), chalk.bold('chat-recall share <project_id>')); return; }
      console.log(chalk.bold(`Shared projects (${shares.length}):`));
      for (const s of shares) console.log(`  ${chalk.cyan(s.projectId)}  ${chalk.gray(s.scope)}`);
    } catch (e) { console.error(chalk.red(e instanceof Error ? e.message : String(e))); process.exit(1); }
  });

program
  .command('share <project_id>')
  .description('Share a project with your team (teammates can then see your work on it)')
  .action(async (projectId: string) => {
    try {
      await serverPost('/api/shares', { project_id: projectId });
      console.log(chalk.green('✓ shared'), chalk.cyan(projectId), chalk.gray('with your team'));
    } catch (e) { console.error(chalk.red(e instanceof Error ? e.message : String(e))); process.exit(1); }
  });

program
  .command('unshare <project_id>')
  .description('Stop sharing a project with your team')
  .action(async (projectId: string) => {
    try {
      const r = await serverDelete<{ removed: boolean }>('/api/shares', { project_id: projectId });
      console.log(r.removed ? chalk.green('✓ unshared') : chalk.yellow('was not shared'), chalk.cyan(projectId));
    } catch (e) { console.error(chalk.red(e instanceof Error ? e.message : String(e))); process.exit(1); }
  });

// ── Collaborative tasks (board lives in the web UI; the CLI syncs a
//    TEAM_TASKS.md in your repo for the terminal / coding-agent workflow) ──
type CliTeamTask = { id: string; title: string; status: string; assigneeSub: string | null; projectId: string };

const tasks = program.command('tasks').description('Collaborative team tasks');

tasks
  .command('list')
  .description('List team tasks assigned to you')
  .action(async () => {
    try {
      const { tasks } = await serverGet<{ tasks: CliTeamTask[] }>('/api/tasks?assignee=@me');
      if (!tasks.length) { console.log(chalk.gray('No tasks assigned to you.')); return; }
      for (const t of tasks) console.log(`  [${t.status}] ${t.title}  ${chalk.gray(t.id)}${t.projectId ? chalk.gray(' · ' + t.projectId) : ''}`);
    } catch (e) { console.error(chalk.red(e instanceof Error ? e.message : String(e))); process.exit(1); }
  });

tasks
  .command('pull [dir]')
  .description('Write TEAM_TASKS.md for your tasks in this project (default: cwd)')
  .option('-f, --force', 'overwrite even if the local file has unpushed edits')
  .action(async (dir: string | undefined, opts: { force?: boolean }) => {
    const cwd = dir || process.cwd();
    try {
      const { resolveProjectId } = await import('@chat-recall/engine/core/project-resolver.js');
      const { renderTeamTasksMd, parseTeamTasksFile } = await import('./project-tasks.js');
      const { writeFileSync, readFileSync, existsSync } = await import('node:fs');
      const { join } = await import('node:path');
      const file = join(cwd, 'TEAM_TASKS.md');
      // Clobber guard: don't silently discard unpushed local edits.
      if (!opts.force && existsSync(file) && parseTeamTasksFile(readFileSync(file, 'utf8')).length > 0) {
        console.error(chalk.red('TEAM_TASKS.md has unpushed edits.'), 'Run', chalk.bold('chat-recall tasks push'), 'first, or', chalk.bold('tasks pull --force'), 'to discard.');
        process.exit(1);
      }
      const resolved = resolveProjectId(cwd);
      const pid = resolved && resolved.source !== 'ignored' ? resolved.id : '';
      // Fetch ALL my assigned tasks, then keep this project's + un-projected
      // ones (the web board creates tasks with no project) — so pull is never
      // empty on the main creation path.
      const { tasks } = await serverGet<{ tasks: CliTeamTask[] }>('/api/tasks?assignee=@me');
      const mine = tasks.filter((t) => !pid || !t.projectId || t.projectId === pid);
      writeFileSync(file, renderTeamTasksMd(mine));
      console.log(chalk.green('✓ wrote'), 'TEAM_TASKS.md', chalk.gray(`(${mine.length} task(s))`), '— edit, then', chalk.bold('chat-recall tasks push'));
    } catch (e) { console.error(chalk.red(e instanceof Error ? e.message : String(e))); process.exit(1); }
  });

tasks
  .command('push [dir]')
  .description('Push TEAM_TASKS.md status edits back to the team')
  .action(async (dir?: string) => {
    const cwd = dir || process.cwd();
    try {
      const { parseTeamTasksFile } = await import('./project-tasks.js');
      const { readFileSync, existsSync } = await import('node:fs');
      const { join } = await import('node:path');
      const file = join(cwd, 'TEAM_TASKS.md');
      if (!existsSync(file)) { console.error(chalk.red('no TEAM_TASKS.md here —'), 'run', chalk.bold('chat-recall tasks pull'), 'first'); process.exit(1); }
      const edits = parseTeamTasksFile(readFileSync(file, 'utf8'));
      let n = 0;
      for (const e of edits) { await serverPatch(`/api/tasks/${encodeURIComponent(e.id)}`, { status: e.intent }); n++; }
      console.log(n ? chalk.green(`✓ pushed ${n} status change(s)`) : chalk.gray('no changes to push'));
    } catch (e) { console.error(chalk.red(e instanceof Error ? e.message : String(e))); process.exit(1); }
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
    const m = await mergePullResult({ pulled: r.pulled, removed: r.removed });
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
  .option('--tool <tool>', 'Target tool: claude|gemini|opencode|codex|agy|cursor|cross_tool', 'cross_tool')
  .option('--pinned-to <glob>', 'Limit which projects pull this artifact')
  .action(async (type: string, name: string, file: string, opts: { tool: string; pinnedTo?: string }) => runTeam('team publish', async () => {
    const validTypes = ['skill','command','agent','mcp','plan','plugin','instructions','hook'] as const;
    if (!(validTypes as readonly string[]).includes(type)) {
      console.error(chalk.red(`Invalid type: ${type}. Must be one of: ${validTypes.join(', ')}`));
      process.exit(1);
    }
    const validTools = ['claude','gemini','opencode','codex','agy','cursor','cross_tool'] as const;
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

/**
 * Resolve the vault passphrase, most explicit source first:
 *   --passphrase → --passphrase-env → OS keyring → interactive prompt.
 *
 * The keyring step is what lets the unattended daemon decrypt at all; a human
 * at a terminal still gets the prompt when nothing is stored. `noKeyring` is for
 * `vault enable`, which must ask the human rather than silently reuse whatever
 * is already stored.
 */
async function resolvePassphrase(opts: { passphrase?: string; envVar?: string; noKeyring?: boolean }): Promise<string> {
  if (opts.passphrase) return opts.passphrase;
  if (opts.envVar) {
    const v = process.env[opts.envVar];
    if (v) return v;
    console.error(chalk.red(`Env var ${opts.envVar} is not set.`));
    process.exit(1);
  }
  if (!opts.noKeyring) {
    try {
      const { keyringGet } = await import('./keyring.js');
      const stored = keyringGet();
      if (stored) return stored;
    } catch { /* no keyring here — fall through to the prompt */ }
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
  .option('--no-keyring', "Don't store the passphrase in the OS keyring (the background daemon then cannot decrypt)")
  .action(async (opts: { passphrase?: string; passphraseEnv?: string; existingSalt?: string; keyring?: boolean }) => runVault('vault enable', async () => {
    // noKeyring: enabling must ask the human, not silently adopt a stored value.
    const passphrase = await resolvePassphrase({ passphrase: opts.passphrase, envVar: opts.passphraseEnv, noKeyring: true });
    const { vaultEnable, vaultEnableWithRemote, VaultPassphraseMismatchError } =
      await import('@chat-recall/engine/core/vault-client.js');

    // Default path: take the salt from the workspace, so a second machine needs
    // nothing but the passphrase. --existing-salt stays for offline/manual use.
    const cred = loadAllCredentials()[0];
    let r: { keyId: string; saltHex: string; saltSource?: 'server' | 'local' };
    if (opts.existingSalt || !cred?.token) {
      r = vaultEnable(passphrase, { existingSaltHex: opts.existingSalt });
    } else {
      try {
        r = await vaultEnableWithRemote(passphrase, { baseUrl: cred.serverUrl, token: cred.token });
      } catch (err) {
        if (err instanceof VaultPassphraseMismatchError) {
          console.error(chalk.red(`vault enable: ${err.message}`));
          process.exit(1);
        }
        throw err;
      }
    }
    console.log(chalk.green('✓ Vault enabled on this device.'));
    console.log(chalk.dim(`  keyId: ${r.keyId}`));
    console.log(chalk.dim(`  salt:  ${r.saltHex}`)
      + (r.saltSource === 'server' ? chalk.dim('  (from your workspace)') : ''));

    // Hand the passphrase to the OS keyring: without it the watch daemon has no
    // way to decrypt, so cross-device artifacts would only ever apply while a
    // human was sitting at a terminal. Never falls back to a file on disk — a
    // machine with no keyring is told, not silently downgraded.
    if (opts.keyring === false) {
      console.log(chalk.yellow('  keyring: skipped (--no-keyring) — the background daemon will not be able to decrypt.'));
    } else {
      const { keyringSet, probeKeyring } = await import('./keyring.js');
      try {
        keyringSet(passphrase);
        console.log(chalk.dim(`  keyring: stored (${probeKeyring().backend}) — the daemon can decrypt unattended.`));
      } catch (err) {
        console.log(chalk.yellow(`  keyring: unavailable — ${err instanceof Error ? err.message : err}`));
        console.log(chalk.yellow('  The vault still works for foreground commands; cross-device artifacts will not apply on this machine.'));
      }
    }
    console.log();
    if (r.saltSource === 'server') {
      console.log(chalk.dim('This device joined your existing vault — same passphrase, same key.'));
    } else {
      console.log(chalk.yellow('To set up another device, run there:'));
      console.log('  chat-recall vault enable');
      console.log(chalk.dim('  (it picks up this workspace\'s salt automatically — only the passphrase is needed)'));
    }
    console.log(chalk.yellow('Lose the passphrase = lose encrypted history. There is no recovery.'));
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
  .description('Show whether the Vault is enabled, salt fingerprint, last sync time, and whether this machine can decrypt unattended')
  .action(async () => runVault('vault status', async () => {
    const { vaultStatus } = await import('@chat-recall/engine/core/vault-client.js');
    const { probeKeyring, keyringGet } = await import('./keyring.js');
    const s = vaultStatus();

    // Report the keyring even when the vault is off: "can this machine decrypt
    // in the background?" is the question that decides whether cross-device
    // artifacts will ever apply here, and it must never be a silent no.
    const probe = probeKeyring();
    const reportKeyring = () => {
      if (!probe.available) {
        console.log(chalk.yellow(`  keyring:      unavailable (${probe.backend}) — cross-device artifacts will not apply on this machine`));
        if (probe.hint) console.log(chalk.dim(`                ${probe.hint}`));
        return;
      }
      let stored = false;
      try { stored = keyringGet() !== null; } catch { stored = false; }
      console.log(stored
        ? chalk.dim(`  keyring:      ${probe.backend}, passphrase stored — the daemon can decrypt unattended`)
        : chalk.yellow(`  keyring:      ${probe.backend}, no passphrase stored — run \`chat-recall vault enable\` to let the daemon decrypt`));
    };

    if (!s.enabled) {
      console.log(chalk.dim('Vault: disabled. Run `chat-recall vault enable`.'));
      reportKeyring();
      return;
    }
    console.log(chalk.green('Vault: enabled'));
    console.log(chalk.dim(`  keyId:        ${s.keyId ?? '(unknown — re-enable)'}`));
    console.log(chalk.dim(`  salt:         ${s.saltHex ? s.saltHex.slice(0, 16) + '…' : '(missing)'}`));
    console.log(chalk.dim(`  lastSyncAt:   ${s.lastSyncAt ? new Date(s.lastSyncAt).toISOString() : 'never'}`));
    console.log(chalk.dim(`  syncTools:    ${s.syncTools.join(', ')}`));
    console.log(chalk.dim(`  excludeProj:  ${s.excludeProjects.length ? s.excludeProjects.join(', ') : '(none)'}`));
    reportKeyring();
  }));

vault
  .command('forget')
  .description('Remove the stored passphrase from this machine\'s OS keyring (the vault stays enabled; the daemon stops being able to decrypt)')
  .action(async () => runVault('vault forget', async () => {
    const { keyringDelete } = await import('./keyring.js');
    console.log(keyringDelete()
      ? chalk.green('✓ Passphrase removed from the OS keyring.')
      : chalk.dim('Nothing stored in the OS keyring.'));
  }));

program
  .command('install-hooks')
  .description('Install Claude Code hooks (Stop + PreCompact + UserPromptSubmit + SessionEnd + SessionStart) into every Claude profile')
  .option('--uninstall', 'Remove hooks instead of installing them')
  .option('--no-resume-hint', "Don't install the UserPromptSubmit resume-hint hook")
  .option('--no-escalate', "Don't install the SessionEnd learnings-escalation hook")
  .option('--no-wakeup', "Don't install the SessionStart wake-up hook")
  .action(async (opts: { uninstall?: boolean; resumeHint?: boolean; escalate?: boolean; wakeup?: boolean }) => {
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
    const sourceEscalateHook = findHook('chat_recall_escalate_hook.sh');
    const sourceWakeupHook = findHook('chat_recall_wakeup_hook.sh');
    if (!sourceSaveHook) {
      console.error(chalk.red('Could not locate chat_recall_save_hook.sh in the package.'));
      process.exit(1);
    }

    const hooksDir = getHooksDir();
    const installedSaveHook = join(hooksDir, 'chat_recall_save_hook.sh');
    const installedResumeHook = join(hooksDir, 'chat_recall_resume_hook.sh');
    const installedEscalateHook = join(hooksDir, 'chat_recall_escalate_hook.sh');
    const installedWakeupHook = join(hooksDir, 'chat_recall_wakeup_hook.sh');

    /**
     * True when this profile's settings.json ALREADY registers our SessionStart
     * hook. Claude reads hooks from settings.json as well as hooks.json, so
     * adding a second registration would inject the wake-up bundle twice per
     * session. Hand-wired setups predate this command — respect them.
     */
    const wakeupWiredInSettings = (home: string): boolean => {
      const settings = join(home, 'settings.json');
      if (!existsSync(settings)) return false;
      try {
        const cfg = JSON.parse(readFileSync(settings, 'utf-8'));
        const arr = Array.isArray(cfg.hooks?.SessionStart) ? cfg.hooks.SessionStart : [];
        return arr.some((h: any) => (h?.hooks?.[0]?.command || '').includes('chat_recall_wakeup_hook'));
      } catch { return false; }
    };
    // EVERY Claude profile gets the registration, not only the primary home.
    // A profile selected by CLAUDE_CONFIG_DIR reads its own hooks.json, so
    // registering in ~/.claude alone means the hooks never fire there while
    // that profile's sessions index normally — nothing looks broken.
    const hookConfigFiles = claudeHookConfigFiles();

    // Read one profile's hooks.json, or start fresh.
    const readHookConfig = (file: string): any => {
      if (!existsSync(file)) return { hooks: {} };
      try {
        const c = JSON.parse(readFileSync(file, 'utf-8'));
        if (!c.hooks || typeof c.hooks !== 'object') c.hooks = {};
        return c;
      } catch (err) {
        console.error(chalk.red(`Could not parse ${file}: ${err}`));
        console.error(chalk.dim('Fix the file or move it aside before re-running.'));
        process.exit(1);
      }
    };

    // Identify our entries by command path. Three scripts now: save + resume + escalate.
    const matchesOurs = (h: any) => {
      const cmd = h?.hooks?.[0]?.command;
      return typeof cmd === 'string' && (
        cmd.includes('chat_recall_save_hook.sh') ||
        cmd.includes('chat_recall_resume_hook.sh') ||
        cmd.includes('chat_recall_escalate_hook.sh') ||
        cmd.includes('chat_recall_wakeup_hook.sh')
      );
    };

    // SessionStart joins the list every loop below iterates, so a reinstall or
    // an uninstall reaches the wake-up registration too.
    const HOOK_EVENTS = ['Stop', 'PreCompact', 'UserPromptSubmit', 'SessionEnd', 'SessionStart'];

    if (opts.uninstall) {
      let total = 0;
      for (const hooksJson of hookConfigFiles) {
        const config = readHookConfig(hooksJson);
        let removed = 0;
        for (const event of HOOK_EVENTS) {
          const arr = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
          const filtered = arr.filter((h: any) => !matchesOurs(h));
          removed += arr.length - filtered.length;
          if (filtered.length) config.hooks[event] = filtered;
          else delete config.hooks[event];
        }
        if (removed === 0 && !existsSync(hooksJson)) continue;
        writeFileSync(hooksJson, JSON.stringify(config, null, 2) + '\n');
        total += removed;
        console.log(chalk.green(`✓ Removed ${removed} chat-recall hook entr${removed === 1 ? 'y' : 'ies'} from ${hooksJson}`));
      }
      if (total === 0) console.log(chalk.dim('No chat-recall hook entries were registered.'));
      console.log(chalk.dim(`  (Hook scripts left in ${hooksDir} — delete manually if you want.)`));
      return;
    }

    // WINDOWS: refuse rather than install something that cannot run.
    //
    // The hooks are POSIX shell scripts. Claude Code on Windows runs a hook
    // command through cmd.exe, which cannot execute a .sh — so installing here
    // registered five hook events (Stop, PreCompact, UserPromptSubmit,
    // SessionEnd, SessionStart) that errored on EVERY interaction, forever,
    // while `doctor` cheerfully reported them installed and healthy. A broken
    // hook on every turn is worse than no hook at all, and a wrong green check
    // is worse than both.
    if (process.platform === 'win32') {
      console.log(chalk.yellow('Hooks are not installed on Windows.'));
      console.log(chalk.dim('  They are POSIX shell scripts, and Claude Code runs hook commands through'));
      console.log(chalk.dim('  cmd.exe, which cannot execute them. Registering them would put an error on'));
      console.log(chalk.dim('  every turn instead of saving anything.'));
      console.log(chalk.dim(''));
      console.log(chalk.dim('  Everything else works: indexing, sync, search and the MCP server are'));
      console.log(chalk.dim('  unaffected. Hooks only add automatic fact-saving and the wake-up bundle,'));
      console.log(chalk.dim('  and you can get the same context by calling recall_wake_up from the agent.'));
      console.log(chalk.dim(''));
      console.log(chalk.dim('  Under WSL, run this from inside the WSL shell and it installs normally.'));
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

    const installEscalate = opts.escalate !== false && !!sourceEscalateHook;
    if (installEscalate) {
      copyFileSync(sourceEscalateHook!, installedEscalateHook);
      chmodSync(installedEscalateHook, 0o755);
    }

    const installWakeup = opts.wakeup !== false && !!sourceWakeupHook;
    if (installWakeup) {
      copyFileSync(sourceWakeupHook!, installedWakeupHook);
      chmodSync(installedWakeupHook, 0o755);
    }

    const stopEntry = { matcher: '', hooks: [{ type: 'command', command: installedSaveHook }] };
    // Quoted: the path contains the user's home directory, and a space in it
    // ("C:/Users/First Last", "/Users/First Last") would split the command.
    const precompactEntry = { matcher: '', hooks: [{ type: 'command', command: `"${installedSaveHook}" --precompact` }] };
    const resumeEntry = { matcher: '', hooks: [{ type: 'command', command: installedResumeHook }] };
    // The escalate script detaches its own background work and exits
    // immediately, so session end is never delayed by network writes.
    const escalateEntry = { matcher: '', hooks: [{ type: 'command', command: installedEscalateHook }] };
    // `startup|clear` only: a RESUMED session already carries its context, so
    // re-injecting the wake-up bundle there is duplicate tokens for no gain.
    const wakeupEntry = { matcher: 'startup|clear', hooks: [{ type: 'command', command: installedWakeupHook }] };

    const events: Array<[string, any]> = [
      ['Stop', stopEntry],
      ['PreCompact', precompactEntry],
    ];
    if (installResume) events.push(['UserPromptSubmit', resumeEntry]);
    if (installEscalate) events.push(['SessionEnd', escalateEntry]);

    // Always strip our prior UserPromptSubmit/SessionEnd entries too — even
    // when reinstalling with those hooks disabled, so we don't leave orphan
    // registrations behind.
    const wakeupSkipped: string[] = [];
    for (const hooksJson of hookConfigFiles) {
      const config = readHookConfig(hooksJson);
      // Per-profile: only register SessionStart where settings.json has not
      // already wired it, so a hand-configured profile keeps ONE registration.
      const home = dirname(hooksJson);
      const alreadyWired = wakeupWiredInSettings(home);
      if (alreadyWired) wakeupSkipped.push(join(home, 'settings.json'));
      const perProfile = installWakeup && !alreadyWired
        ? [...events, ['SessionStart', wakeupEntry] as [string, any]]
        : events;
      for (const event of HOOK_EVENTS) {
        const arr = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
        const without = arr.filter((h: any) => !matchesOurs(h));
        const wanted = perProfile.find(([e]) => e === event);
        if (wanted) without.push(wanted[1]);
        if (without.length) config.hooks[event] = without;
        else delete config.hooks[event];
      }
      mkdirSync(dirname(hooksJson), { recursive: true });
      writeFileSync(hooksJson, JSON.stringify(config, null, 2) + '\n');
    }
    const saveSz = statSync(installedSaveHook).size;
    console.log(chalk.green(`✓ Installed chat-recall save hook (${saveSz} bytes)`));
    if (installResume) {
      const resumeSz = statSync(installedResumeHook).size;
      console.log(chalk.green(`✓ Installed chat-recall resume-hint hook (${resumeSz} bytes)`));
    }
    if (installEscalate) {
      const escalateSz = statSync(installedEscalateHook).size;
      console.log(chalk.green(`✓ Installed chat-recall learnings-escalation hook (${escalateSz} bytes)`));
    }
    if (installWakeup) {
      const wakeupSz = statSync(installedWakeupHook).size;
      console.log(chalk.green(`✓ Installed chat-recall wake-up hook (${wakeupSz} bytes)`));
      for (const f of wakeupSkipped) {
        console.log(chalk.dim(`  (SessionStart already wired in ${f} — left as is, not duplicated)`));
      }
    }
    console.log(chalk.dim(`  scripts:   ${hooksDir}`));
    for (const [i, f] of hookConfigFiles.entries()) {
      console.log(chalk.dim(`  ${i === 0 ? 'config:   ' : '          '} ${f}`));
    }
    console.log(chalk.dim(`  events:    Stop, PreCompact${installResume ? ', UserPromptSubmit' : ''}${installEscalate ? ', SessionEnd' : ''}${installWakeup ? ', SessionStart' : ''}`));
    console.log();
    console.log(chalk.dim('Run `chat-recall install-hooks --uninstall` to remove later.'));
    if (!installResume) {
      console.log(chalk.dim('(--no-resume-hint passed — UserPromptSubmit hook skipped)'));
    }
    if (!installEscalate) {
      console.log(chalk.dim('(--no-escalate passed — SessionEnd hook skipped)'));
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
        // Always (re)install — installService() reloads/restarts the daemon, so
        // an upgrade run (installer, `service install` after `npm i -g`) loads
        // the NEW binary. Skipping when "already running" was a real bug: the
        // updated binary sat on disk while the old daemon kept running old code.
        const wasRunning = isServiceRunning();
        const paths = installService();
        console.log(chalk.green(wasRunning
          ? `✓ chat-recall-watch service restarted with the current binary (${platformName()}).`
          : `✓ chat-recall-watch service installed and started (${platformName()}).`));
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
  opts: {
    token?: string; issuer?: string; clientId?: string; team?: string; deviceId?: string; check?: boolean;
    /** Emit the device prompt as JSON on stdout instead of prose, so a parent
     *  process (the MCP) can relay the link and code to the user. */
    promptJson?: boolean;
    /** True when `init` is driving this. It syncs immediately afterwards, so the
     *  "now run sync" line below would tell someone to do a thing that already
     *  happened — and it is the LAST line they read, so it reads as the next
     *  step rather than as a stale afterthought. Standalone `login` still gets
     *  it, because there it is genuinely what to do next. */
    fromInit?: boolean;
  },
): Promise<void> {
  const { saveCredentials, loadAllCredentials } = await import('./sync-client.js');
  const base = serverUrl.replace(/\/+$/, '');

  /** Prove a token works against this server BEFORE persisting it. */
  const verifyToken = async (token: string): Promise<{ ok: boolean; status?: number; error?: string }> => {
    try {
      const res = await fetch(`${base}/api/status`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      return { ok: res.ok, status: res.status };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  // Self-host escape hatch: token supplied directly, no OIDC.
  if (opts.token) {
    const token = opts.token.trim();
    // A masked copy out of the UI ("ct_12345678…") is the classic failure here.
    // Non-ASCII in the token would otherwise be saved silently and crash every
    // later sync inside fetch() with an opaque "ByteString" error.
    if (/[^\x21-\x7e]/.test(token)) {
      console.error(chalk.red('login failed: the token contains non-ASCII characters — this looks like a masked/truncated copy (e.g. "ct_12345678…").'));
      console.error(chalk.dim('Use the Copy button next to the token in the dashboard and paste the full line.'));
      process.exit(1);
    }
    const check = await verifyToken(token);
    if (!check.ok) {
      if (check.status === 401 || check.status === 403) {
        console.error(chalk.red(`login failed: ${base} rejected the token (HTTP ${check.status}).`));
        console.error(chalk.dim('Tokens are shown once — mint a fresh one (Account → Connect your machine) and copy the whole line.'));
      } else {
        console.error(chalk.red(`login failed: could not verify the token against ${base}:`), check.error || `HTTP ${check.status}`);
      }
      process.exit(1);
    }
    saveCredentials({ serverUrl, token });
    console.log(chalk.green('✓ Logged in.') + chalk.dim(`  server: ${serverUrl} (token verified)`));
    return;
  }

  // Idempotent login: a working credential for this server already on disk wins
  // — the installer re-runs `login <origin>` unconditionally (e.g. on upgrade),
  // and that must not force a second token dance.
  const existing = loadAllCredentials().find((t) => t.serverUrl.replace(/\/+$/, '') === base);
  if (existing && (await verifyToken(existing.token)).ok) {
    console.log(chalk.green('✓ Already connected.') + chalk.dim(`  server: ${serverUrl} (existing token verified)`));
    return;
  }
  // Local self-host (AUTH_PROVIDER=none) needs NO token: a tenant-scoped request
  // with no auth resolves to the single 'default' tenant — which is also what the
  // no-auth dashboard reads, so collector and dashboard always agree. Detect it
  // (a no-auth /api/status returns 200; an auth-required server returns 401) and
  // save a tokenless target instead of forcing the OIDC flow. Runs under --check
  // too: connecting to a no-auth server is free, so "connected" is the answer.
  try {
    const probe = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(8000) });
    if (probe.status === 200) {
      saveCredentials({ serverUrl, token: '' });
      console.log(chalk.green('✓ Logged in.') + chalk.dim(`  ${serverUrl} (local server — no auth, no token needed)`));
      return;
    }
  } catch { /* unreachable or not a no-auth server — fall through to OIDC */ }

  // --check: report-only probe for scripts (the installer). Exit 1 without
  // starting any interactive flow when no working credential exists.
  if (opts.check) {
    console.error(chalk.dim(`Not connected to ${serverUrl}.`));
    process.exit(1);
  }

  try {
    const { deviceLogin, betterAuthDeviceLogin } = await import('./device-auth.js');
    // Learn HOW to log in from the target server: `authProvider` picks the
    // flow (better-auth → the server's own device endpoints; keycloak → the
    // realm device flow at `oidcIssuer`). No hardcoded default anywhere. A
    // no-auth server returns provider 'none' → deviceLogin surfaces a clear
    // "use --token" message instead of hitting someone's realm.
    let issuer = opts.issuer;
    let authProvider: string | undefined;
    if (!issuer) {
      try {
        const caps = await fetch(`${base}/api/capabilities`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json()) as { authProvider?: string; oidcIssuer?: string | null };
        authProvider = caps?.authProvider;
        if (caps?.oidcIssuer) issuer = caps.oidcIssuer;
      } catch { /* fall through — deviceLogin surfaces the missing-issuer error */ }
    }
    const onPrompt = (p: { url: string; userCode: string; verificationUri: string }) => {
      if (opts.promptJson) {
        // ONE line, flushed immediately: the parent reads it to learn the link
        // while this process keeps polling for the approval.
        console.log(JSON.stringify({ prompt: p }));
        return;
      }
      console.log();
      console.log(chalk.bold('To log in, open:'));
      console.log('  ' + chalk.cyan(p.url));
      console.log(chalk.dim(`  (if prompted, enter code: ${chalk.bold(p.userCode)} at ${p.verificationUri})`));
      console.log(chalk.dim('After approving, come back to THIS terminal — it finishes the login by itself.'));
      console.log(chalk.dim('Waiting for approval…'));
    };
    const tokens = authProvider === 'better-auth'
      ? await betterAuthDeviceLogin(base, onPrompt)
      : await deviceLogin({ issuer, clientId: opts.clientId }, onPrompt);

    const authHdr = { authorization: `Bearer ${tokens.accessToken}`, 'content-type': 'application/json' };

    // Which team? Use --team, else the user's sole team; a brand-new user
    // (zero teams) gets a workspace auto-created — same as the web onboarding.
    // Bouncing them to "run `team create`, then re-run login" mid-funnel is a
    // dead end for the one-command install.
    const me = await fetch(`${base}/api/me`, { headers: authHdr }).then((r) => r.json() as Promise<{ user?: { email?: string }; teams: { team_slug: string; name: string }[] }>);
    const teams = me.teams || [];
    let slug = opts.team;
    if (!slug) {
      if (teams.length === 1) slug = teams[0].team_slug;
      else if (teams.length === 0) {
        const name = me.user?.email?.split('@')[0]?.replace(/[^a-z0-9]/gi, '') || 'workspace';
        const created = await fetch(`${base}/api/teams`, { method: 'POST', headers: authHdr, body: JSON.stringify({ name }) });
        if (!created.ok) throw new Error(`workspace create failed: HTTP ${created.status} ${await created.text().catch(() => '')}`);
        slug = ((await created.json()) as { slug: string }).slug;
        console.log(chalk.dim(`Created workspace "${name}" (${slug}) — you're its owner.`));
      }
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
    if (!opts.fromInit) {
      console.log(chalk.dim('Run `chat-recall sync` to push redacted conversations.'));
    }
  } catch (err) {
    console.error(chalk.red('login failed:'), err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

// ── Exclusions: what never leaves this machine ─────────────────────────
// The sync/privacy settings are machine-owned (~/.chat-recall/settings) by
// design — decisions about what uploads happen where the data is. The
// dashboard can't edit them in server mode, so the CLI is the interface.
const exclude = program
  .command('exclude')
  .description('Control what never leaves this machine (per-tool, per-project). Bare `exclude` lists the current rules.');

exclude
  .command('list', { isDefault: true })
  .description('Show current exclusions')
  .action(async () => {
    const { loadSettings } = await import('@chat-recall/engine/core/settings.js');
    const s = loadSettings();
    console.log(chalk.bold('Sync exclusions') + chalk.dim(' (~/.chat-recall/settings/settings.json)'));
    console.log(`  tools:    ${s.sync.excludeTools.length ? s.sync.excludeTools.join(', ') : chalk.dim('none')}`);
    console.log(`  projects: ${s.sync.excludeProjects.length ? '' : chalk.dim('none')}`);
    for (const p of s.sync.excludeProjects) console.log(`    ${p}`);
    const deny = s.privacy.projectDenylist || [];
    console.log(`  index denylist (never even indexed): ${deny.length ? '' : chalk.dim('none')}`);
    for (const p of deny) console.log(`    ${p}`);
    console.log(chalk.dim('\nPersonal folders (Pictures, Music, Documents, Desktop, Downloads, …) are'));
    console.log(chalk.dim('skipped from code indexing by default. Opt one back in: `chat-recall include project <path>`.'));
    const inc = s.sync.includeProjects || [];
    if (inc.length) { console.log(`  personal paths opted back in:`); for (const p of inc) console.log(`    ${p}`); }
  });

// `include` re-permits a personal folder (Pictures/Music/Documents/…) that
// code-index discovery skips by default. Opt-in only — the default is privacy.
const include = program
  .command('include')
  .description('Opt a personal folder (Pictures/Music/Documents/…) back into code indexing. Bare `include` lists opted-in paths.');

include
  .command('list', { isDefault: true })
  .description('Show paths opted back into indexing')
  .action(async () => {
    const { loadSettings } = await import('@chat-recall/engine/core/settings.js');
    const inc = loadSettings().sync.includeProjects || [];
    console.log(chalk.bold('Personal paths opted back into code indexing'));
    if (!inc.length) console.log(chalk.dim('  none — personal folders are all skipped'));
    for (const p of inc) console.log(`  ${p}`);
  });

include
  .command('project <path>')
  .description('Re-permit a path under a personal folder (substring match; e.g. ~/Documents/code)')
  .action(async (path: string) => {
    const { loadSettings, saveSettings } = await import('@chat-recall/engine/core/settings.js');
    const { resolve } = await import('node:path');
    const { homedir } = await import('node:os');
    const abs = resolve(path.replace(/^~(?=\/|$)/, homedir()));
    const s = loadSettings();
    s.sync.includeProjects = s.sync.includeProjects || [];
    if (s.sync.includeProjects.includes(abs)) { console.log(chalk.dim(`Already included: ${abs}`)); return; }
    s.sync.includeProjects.push(abs);
    saveSettings(s);
    console.log(chalk.green(`✓ Included ${abs}`) + chalk.dim(' — code indexing may now walk it (takes effect next discovery tick).'));
  });

include
  .command('remove <path>')
  .description('Undo an opt-in (personal folder goes back to skipped)')
  .action(async (path: string) => {
    const { loadSettings, saveSettings } = await import('@chat-recall/engine/core/settings.js');
    const { resolve } = await import('node:path');
    const { homedir } = await import('node:os');
    const abs = resolve(path.replace(/^~(?=\/|$)/, homedir()));
    const s = loadSettings();
    const before = (s.sync.includeProjects || []).length;
    s.sync.includeProjects = (s.sync.includeProjects || []).filter((p) => p !== path && p !== abs);
    if (s.sync.includeProjects.length === before) { console.error(chalk.red(`Not in the include list: ${path}`)); process.exit(1); }
    saveSettings(s);
    console.log(chalk.green(`✓ Removed ${path}`) + chalk.dim(' — back to skipped.'));
  });

// ── Retention: how long the SERVER keeps what you sent ────────────────────
// The third data control, beside `exclude` (what never goes) and `delete` (undo
// one thing). This one acts later and unattended, which is exactly why it prints
// the count and the warning before it will arm, and why shortening a window
// needs a typed number rather than a keystroke.
const retention = program
  .command('retention')
  .description('How long the server keeps your synced sessions. Bare `retention` shows the current window.');

retention
  .command('show', { isDefault: true })
  .description('Show the window and how many sessions it would delete')
  .action(async () => {
    const t = requireTarget();
    const r = await serverGet<{ days: number; wouldDelete: number; min: number; max: number; warning: string }>('/api/data/retention');
    console.log(chalk.bold('Retention') + chalk.dim(`  (server: ${t.base})`));
    if (!r.days) {
      console.log(`  window: ${chalk.green('none')} — the server keeps everything you sync`);
    } else {
      console.log(`  window: ${chalk.yellow(`${r.days} days`)}`);
      console.log(`  sessions currently outside it: ${r.wouldDelete}`);
    }
    console.log(chalk.dim(`  Set one: chat-recall retention set <${r.min}-${r.max}>   ·   clear it: chat-recall retention set 0`));
  });

retention
  .command('set <days>')
  .description('Set the window in days, or 0 to keep everything. Prints what it would delete and asks first.')
  .option('--yes', 'Skip the confirmation (for scripts). The warning still prints.', false)
  .action(async (daysArg: string, opts: { yes?: boolean }) => {
    requireTarget();
    const days = Number(daysArg);
    if (!Number.isInteger(days) || days < 0) {
      console.error(chalk.red(`'${daysArg}' is not a whole number of days.`));
      process.exit(1);
    }

    // Preview against the CANDIDATE window, not the current one: the number that
    // matters is what THIS change would remove.
    const preview = await serverGet<{ wouldDelete: number; warning: string; min: number; max: number }>(
      `/api/data/retention?days=${days}`,
    );

    if (days === 0) {
      await serverPost('/api/data/retention', { days: 0 });
      console.log(chalk.green('✓ Window cleared') + chalk.dim(' — the server keeps everything you sync.'));
      return;
    }

    if (preview.wouldDelete > 0) {
      console.log();
      console.log(chalk.yellow(`This deletes ${preview.wouldDelete} session(s) from the server, and keeps deleting`));
      console.log(chalk.yellow(`anything older than ${days} days from now on.`));
      console.log();
      // The conditional half of the recovery story, said out loud. "Just re-sync"
      // is only true while the transcript still exists on a machine you have.
      console.log(chalk.dim('  Re-syncing can restore a session ONLY if its transcript is still on a'));
      console.log(chalk.dim('  machine you have. For a laptop you no longer own, history your AI tool'));
      console.log(chalk.dim('  has rotated, or files you deleted, our copy is the only copy.'));
      console.log(chalk.dim('  Take one first if you want it:  chat-recall export'));
      console.log();
      if (!opts.yes) {
        if (!process.stdin.isTTY) {
          console.error(chalk.red('Refusing: this would delete data and there is no terminal to confirm at.'));
          console.error(chalk.dim('Pass --yes if you mean it.'));
          process.exit(1);
        }
        const { createInterface } = await import('node:readline/promises');
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        // The COUNT, typed. A y/n on a number this size is a reflex; retyping the
        // number is reading it.
        const answer = (await rl.question(`Type ${preview.wouldDelete} to confirm: `)).trim();
        rl.close();
        if (answer !== String(preview.wouldDelete)) {
          console.log(chalk.dim('Cancelled — nothing changed.'));
          return;
        }
      }
    }

    const res = await serverPost<{ days: number; wouldDelete: number }>(
      '/api/data/retention', { days, acknowledge: true },
    );
    console.log(chalk.green(`✓ Window set to ${res.days} days`)
      + chalk.dim(` — ${res.wouldDelete} session(s) will be removed on the next sweep.`));
  });

// ── Selective sync: opt-in project allowlist ───────────────────────────────
// The inverse of `exclude`: with mode 'only', ONLY the listed projects sync.
const syncOnly = program
  .command('sync-only')
  .description("Opt-in sync: ship ONLY chosen projects. Bare `sync-only` shows the mode + allowlist.");

syncOnly
  .command('list', { isDefault: true })
  .description('Show the sync mode and allowlisted projects')
  .action(async () => {
    const { loadSettings } = await import('@chat-recall/engine/core/settings.js');
    const s = loadSettings();
    const mode = s.sync.syncMode ?? 'all';
    console.log(chalk.bold('Selective sync') + chalk.dim(' (~/.chat-recall/settings/settings.json)'));
    console.log(`  mode: ${mode === 'only' ? chalk.yellow('only (allowlist)') : chalk.green('all (default)')}`);
    const list = s.sync.syncOnlyProjects ?? [];
    console.log(`  projects: ${list.length ? '' : chalk.dim('none')}`);
    for (const p of list) console.log(`    ${p}`);
    if (mode === 'only' && list.length === 0) console.log(chalk.red('  ⚠ mode is "only" but the allowlist is empty → NOTHING syncs.'));
    console.log(chalk.dim('\nList ids with `chat-recall projects`, then `chat-recall sync-only add <id>`.'));
  });

syncOnly
  .command('add <project>')
  .description('Add a project id (git:…/ws:…/path:…) or path substring to the allowlist (switches mode to "only")')
  .action(async (project: string) => {
    const { loadSettings, saveSettings } = await import('@chat-recall/engine/core/settings.js');
    const s = loadSettings();
    s.sync.syncOnlyProjects = s.sync.syncOnlyProjects || [];
    if (!s.sync.syncOnlyProjects.includes(project)) s.sync.syncOnlyProjects.push(project);
    s.sync.syncMode = 'only';
    saveSettings(s);
    console.log(chalk.green(`✓ Added ${project}`) + chalk.dim(' — mode is now "only"; next sync ships only allowlisted projects.'));
  });

syncOnly
  .command('remove <project>')
  .description('Remove a project from the allowlist')
  .action(async (project: string) => {
    const { loadSettings, saveSettings } = await import('@chat-recall/engine/core/settings.js');
    const s = loadSettings();
    const before = (s.sync.syncOnlyProjects || []).length;
    s.sync.syncOnlyProjects = (s.sync.syncOnlyProjects || []).filter((p) => p !== project);
    if (s.sync.syncOnlyProjects.length === before) { console.error(chalk.red(`Not in the allowlist: ${project}`)); process.exit(1); }
    saveSettings(s);
    console.log(chalk.green(`✓ Removed ${project}`));
  });

syncOnly
  .command('all')
  .description('Switch back to syncing ALL non-excluded projects (keeps the list, just disables opt-in mode)')
  .action(async () => {
    const { loadSettings, saveSettings } = await import('@chat-recall/engine/core/settings.js');
    const s = loadSettings();
    s.sync.syncMode = 'all';
    saveSettings(s);
    console.log(chalk.green('✓ Sync mode: all') + chalk.dim(' — every non-excluded project syncs again.'));
  });

program
  .command('projects')
  .description('List distinct project ids discovered on this machine (for `sync-only add`)')
  .action(async () => {
    const { listAvailableBackends } = await import('@chat-recall/engine/core/tool-backend.js');
    const { resolveProjectId } = await import('@chat-recall/engine/core/project-resolver.js');
    const counts = new Map<string, number>();
    for (const b of listAvailableBackends()) {
      let refs: Array<{ projectPath?: string }> = [];
      try { refs = b.listSessions() as any; } catch { /* backend unavailable */ }
      for (const r of refs) {
        const res = resolveProjectId(r.projectPath || '');
        if (res.source === 'ignored') continue;
        counts.set(res.id, (counts.get(res.id) || 0) + 1);
      }
    }
    const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    if (!rows.length) { console.log(chalk.dim('No projects discovered.')); return; }
    console.log(chalk.bold('Discovered projects') + chalk.dim('  (id · sessions)'));
    for (const [id, n] of rows) console.log(`  ${chalk.cyan(id)} ${chalk.dim('· ' + n)}`);
  });

exclude
  .command('project <path>')
  .description('Exclude a project path from syncing (substring match on the project path; e.g. ~/.claude-pr-bot)')
  .action(async (path: string) => {
    const { loadSettings, saveSettings } = await import('@chat-recall/engine/core/settings.js');
    const { resolve } = await import('node:path');
    const { homedir } = await import('node:os');
    const abs = resolve(path.replace(/^~(?=\/|$)/, homedir()));
    const s = loadSettings();
    if (s.sync.excludeProjects.includes(abs)) {
      console.log(chalk.dim(`Already excluded: ${abs}`));
      return;
    }
    s.sync.excludeProjects.push(abs);
    saveSettings(s);
    console.log(chalk.green(`✓ Excluded ${abs}`) + chalk.dim(' — takes effect next sync; already-synced rows stay until deleted.'));
  });

exclude
  .command('tool <tool>')
  .description('Exclude an AI tool entirely (claude | gemini | codex | opencode | agy | cursor)')
  .action(async (tool: string) => {
    const valid = ['claude', 'gemini', 'codex', 'opencode', 'agy', 'cursor'];
    if (!valid.includes(tool)) {
      console.error(chalk.red(`Unknown tool '${tool}'.`) + chalk.dim(` Use one of: ${valid.join(' | ')}`));
      process.exit(1);
    }
    const { loadSettings, saveSettings } = await import('@chat-recall/engine/core/settings.js');
    const s = loadSettings();
    if (s.sync.excludeTools.includes(tool as never)) {
      console.log(chalk.dim(`Already excluded: ${tool}`));
      return;
    }
    s.sync.excludeTools.push(tool as never);
    saveSettings(s);
    console.log(chalk.green(`✓ Excluded ${tool}`) + chalk.dim(' — nothing from it leaves this machine from the next sync on.'));
  });

exclude
  .command('remove <value>')
  .description('Remove an exclusion (tool name or project path)')
  .action(async (value: string) => {
    const { loadSettings, saveSettings } = await import('@chat-recall/engine/core/settings.js');
    const { resolve } = await import('node:path');
    const { homedir } = await import('node:os');
    const abs = resolve(value.replace(/^~(?=\/|$)/, homedir()));
    const s = loadSettings();
    const beforeTools = s.sync.excludeTools.length;
    const beforeProjects = s.sync.excludeProjects.length;
    s.sync.excludeTools = s.sync.excludeTools.filter((t) => t !== value);
    s.sync.excludeProjects = s.sync.excludeProjects.filter((p) => p !== value && p !== abs);
    if (s.sync.excludeTools.length === beforeTools && s.sync.excludeProjects.length === beforeProjects) {
      console.error(chalk.red(`No exclusion matches '${value}'.`) + chalk.dim(' See: chat-recall exclude list'));
      process.exit(1);
    }
    saveSettings(s);
    console.log(chalk.green(`✓ Removed ${value}`));
  });

program
  .command('login [server-url]')
  .description(`Log in (device flow) and mint a sync device token → ~/.chat-recall/credentials.json (0600). Defaults to ${DEFAULT_SERVER}.`)
  .option('--token <token>', 'Self-host: skip OIDC and save this device token directly')
  .option('--check', 'Report-only: exit 0 if a working credential for this server exists, 1 otherwise (never interactive)')
  .option('--issuer <url>', 'OIDC issuer URL (default: learned from the server via /api/capabilities)')
  .option('--client-id <id>', 'OIDC client id (default: chat-recall-web)')
  .option('--team <slug>', 'Team to mint the device token for (default: your only team)')
  .option('--device-id <id>', 'Device id for this machine (default: hostname)')
  // Machine-readable prompt, for a caller that cannot show a terminal — the MCP
  // spawns this and relays the link into the conversation, which is the only
  // channel a user of an npx-installed MCP actually sees.
  .option('--prompt-json', 'Print the device prompt as one JSON line on stdout, then wait for approval', false)
  .action((serverUrl: string | undefined, opts: { token?: string; check?: boolean; issuer?: string; clientId?: string; team?: string; deviceId?: string; promptJson?: boolean }) =>
    runLogin(serverUrl || DEFAULT_SERVER, opts));

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
          // lock-held is routine writer election (another sync IS running right
          // now — e.g. the watch daemon), not a failure: exit 0 so wrappers like
          // the installer don't report a broken first sync.
          if (r.skipped === 'lock-held') {
            console.log(chalk.dim('Another sync is already running (MCP tick or watch daemon) — your data is on its way.'));
            return;
          }
          const msg = {
            'no-credentials': 'Not logged in — run `chat-recall login <server-url>` first.',
            'paused': 'Sync is paused in settings — re-run `chat-recall login <server-url>` to resume.',
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

program
  .command('update')
  .description('Update this CLI now from the server you sync to (same-origin, checksum-pinned) and report exactly why if it cannot')
  .action(async () => {
    const { runAutoUpdate } = await import('./auto-update.js');
    const { refreshUpdateCheck } = await import('./update-notice.js');
    const { cliVersion } = await import('./http.js');
    const targets = loadAllCredentials();
    if (!targets.length) {
      console.error(chalk.red('Not logged in — run `chat-recall login <server-url>` first.'));
      process.exit(1);
    }
    // "Nothing to do" and "tried and failed" are completely different answers;
    // the whole point of this command is that the second one stops being silent.
    let installFailed = false;
    for (const cred of targets) {
      const base = cred.serverUrl.replace(/\/+$/, '');
      const headers: Record<string, string> = cred.token ? { authorization: `Bearer ${cred.token}` } : {};
      const r = await runAutoUpdate(base, headers, cliVersion());
      if (r.updated) { console.log(chalk.green(`✓ ${r.reason}`) + chalk.dim(` (${base})`)); continue; }
      const benign = /already current|no CLI release|disabled/.test(r.reason);
      // Only an install/download/checksum failure points at npm — an unreachable
      // server is a different problem and deserves no misleading hint.
      if (/install failed|download failed|checksum/.test(r.reason)) installFailed = true;
      console.log((benign ? chalk.dim('• ') : chalk.red('✗ ')) + r.reason + chalk.dim(` (${base})`));
    }
    await refreshUpdateCheck(true);
    if (installFailed) {
      console.log(chalk.dim('\nThe update was available but did not install — usually npm cannot write the global prefix. Retry with:'));
      console.log(chalk.dim(`  npm install -g chat-recall   (or re-run the installer: curl -fsSL ${targets[0].serverUrl.replace(/\/+$/, '')}/install | sh)`));
    }
  });

// One stderr line when the server we sync to serves a newer CLI. Auto-update
// handles this silently in the happy path; this is the channel for when it
// can't (client too old to self-update, or `npm i -g` failing every retry) —
// otherwise a stale machine is invisible until someone audits it by hand.
program.hook('preAction', () => { printUpdateNotice(); });

program.parse();
