#!/usr/bin/env node
/**
 * MCP server for chat-recall.
 *
 * Exposes chat recall as tools that can be used by Claude Code.
 */

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { resumeCommandFor } from '../core/resume-command.js';
import { resolveProjectId } from '../core/project-resolver.js';
import { config } from 'dotenv';
import {
  buildHttpError, stalenessBanner, trialEndingBanner, type SyncState,
} from './diagnostics.js';
import { loginInstruction } from './login-prompt.js';
import {
  currentCredentials, withCredentials, setMultiTenantMode, isMultiTenant,
} from './credential-context.js';
export { withCredentials, setMultiTenantMode };
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'node:url';

// KEEP THIS IMPORT LIST LEAN. The MCP is a thin collector — every read goes
// to the server; local compute moved server-side in the thin-collector
// migration. Dead engine imports here aren't just clutter: they drag heavy
// engine modules (once the whole store layer, incl. lancedb + pino) into the
// published bundle, which broke every fresh `npm i -g chat-recall`.
import { formatContext } from '../core/context.js';
import { getIdentityFilePath, getDataDir } from '../core/paths.js';
import { envCredentials } from '../core/credentials-env.js';
import { liveScanModifiedFiles } from '../core/live-session-scan.js';
// Side-effect import: registers the four ToolBackend implementations so
// getBackendForId(...) works everywhere downstream.
import '../core/backends/index.js';
import { getBackendForId } from '../core/tool-backend.js';
import { markPrompt } from '../core/session-sentiment.js';
import { statusEmoji } from '../core/outcome-display.js';
import { sanitizeQuery } from '../core/query-sanitizer.js';
import { getWAL } from '../core/write-ahead-log.js';
import { isOnPath } from '../core/which.js';
import { readCollectorHealth, judgeHealth, progressLine } from '../core/collector-health.js';
import {
  INSTRUCTION_KINDS, SEVERITIES, sevRank, taskBody,
  partitionRecs, actionToImprovement, recToImprovement, isOpenAction,
  rankImprovements, rankInstructions,
  type EngineRec, type EngineAction, type Improvement,
} from './recommendation-merge.js';

// ── Host hooks ──────────────────────────────────────────────────────────
//
// Two things this tool surface needs are properties of the HOST, not of the
// tools: running an index over the caller's own disk, and reporting a tool
// error to the operator's telemetry. Both are trivially available to the stdio
// CLI (it IS the user's machine) and meaningless to the remote /mcp server (its
// disk is nobody's transcripts, and its telemetry is the server's own).
//
// So the surface declares what it needs and the host supplies it. The defaults
// are the remote answers, because the remote host is the one that supplies
// nothing — a missing injection must degrade to an honest message, never to a
// crash or to a silent no-op that looks like success.

type IndexRunner = (force: boolean) => Promise<string>;
let indexRunner: IndexRunner | null = null;

/** Supply the local indexer. The CLI entry point calls this at boot; the remote
 *  server deliberately does not. */
export function setIndexRunner(fn: IndexRunner | null): void { indexRunner = fn; }

/**
 * What a local-only tool says when a REMOTE caller reaches it by name.
 *
 * One sentence, one place, because there are two of these and they must not
 * drift into telling the user two different stories about the same limit.
 */
function localOnlyRefusal(tool: string): string {
  return `${tool} runs on YOUR machine, not on the server — this connection has no access to your files. `
    + 'Install the chat-recall CLI and run it there; everything it collects syncs here and stays searchable from this connection.';
}

/**
 * What to say when the account has NO HISTORY AT ALL.
 *
 * This is the first thing a connector user ever reads, and it used to be
 * "No sessions on the server yet — run `chat-recall sync` on your machines."
 * That sentence assumes the CLI is already installed and names the wrong command
 * for a first-timer. Someone who connected from claude.ai has installed nothing,
 * so they were told to run a command they do not have, to fix a state they had
 * no way to understand — and the honest read of that is "this product is
 * broken", when in fact the account is simply new.
 *
 * The distinction that matters, and the reason this is a function rather than a
 * constant: an empty result because a FILTER matched nothing is a completely
 * different message from an empty result because nothing was ever indexed. Only
 * the second one should tell someone to go and install something.
 *
 * Kept to one place so the twelve or so empty paths cannot drift into telling
 * the same person three different stories about the same state.
 */
function emptyIndexHint(): string {
  // Two audiences read this, and the difference is whether the agent has a
  // shell. In Claude Code or Cursor it does — so give it a command it can just
  // RUN, and the whole gap closes without the user typing anything. On claude.ai
  // it does not, and the same two lines are what the user needs to be told.
  // Short, because a wall of text gets summarised away and the commands with it.
  // Written as a PROCEDURE the agent executes, not a paragraph it summarises.
  //
  // Most clients that reach this are coding agents with a shell — Claude Code,
  // Cursor, Codex. Told plainly and in order, the agent does the whole setup and
  // the user clicks once. A paragraph gets compressed into "you need to install
  // the CLI" and the commands vanish with it, which is why this is numbered and
  // why the commands sit on their own lines.
  //
  // Step 2 cannot be automated away: `init` opens a browser approval, and that
  // is the point — it is what links the machine to an account without a token
  // being pasted around. The agent should expect it and say so rather than
  // treating the wait as a hang.
  return isMultiTenant()
    ? 'No coding history in this account yet — normal for a new one, not an error. '
      + 'The account already exists and the free trial is running; there is nothing to sign up for. '
      + 'The transcripts live on the user\'s own machine, so they must be indexed there.\n\n'
      + 'IF YOU HAVE A SHELL, DO THIS NOW — it is the whole setup:\n'
      + '  1. npm install -g chat-recall\n'
      + '  2. chat-recall init\n'
      + '     Prints a URL and waits. Tell the user to open it and approve — one click, same account,\n'
      + '     not a second signup. Do not kill the command while it waits.\n'
      + '  3. It then indexes this machine\'s Claude Code, Codex, Gemini CLI, OpenCode, Antigravity and\n'
      + '     Cursor sessions, redacts secrets locally, and syncs them.\n'
      + '  4. Call recall_status to confirm, then retry what you were asked.\n'
      + 'If you have no shell, give the user steps 1 and 2 verbatim.\n\n'
      + 'Meanwhile this connection already works for memory created here — facts, decisions, tasks and '
      + 'diary entries persist across conversations right now.'
    : 'Nothing has been indexed yet. Run `chat-recall init` (first time) or `chat-recall index` to collect '
      + 'this machine\'s sessions and sync them.';
}

/** Test-only handle on the message above. It is the first thing a connector user
 *  reads, and it has already regressed once, so it is asserted directly rather
 *  than reached through a tool call that needs a server. */
export const __emptyIndexHintForTest = (): string => emptyIndexHint();

async function runIndexChild(force: boolean): Promise<string> {
  if (!indexRunner) {
    return 'Indexing runs on YOUR machine, not on the server — this connection has no access to your transcripts. '
      + 'Install the CLI and run `chat-recall index` (or `chat-recall init` for first-time setup) on the machine '
      + 'whose history you want searchable here.';
  }
  return indexRunner(force);
}

type EventReporter = (kind: string, opts: { tool?: string; message?: string }) => void;
let eventReporter: EventReporter | null = null;

/** Supply the telemetry sink. Absent, tool errors are simply not reported —
 *  which is correct for a host that has no operator to report them to. */
export function setEventReporter(fn: EventReporter | null): void { eventReporter = fn; }

function reportClientEvent(kind: string, opts: { tool?: string; message?: string } = {}): void {
  try { eventReporter?.(kind, opts); } catch { /* telemetry must never fail a tool */ }
}

type UpdateNotice = () => string | null;
let updateNoticeFn: UpdateNotice | null = null;

/** Supply the "your CLI is out of date" line for recall_status. Local hosts
 *  only — see the call site. */
export function setUpdateNotice(fn: UpdateNotice | null): void { updateNoticeFn = fn; }

function updateNotice(): string | null {
  try { return updateNoticeFn ? updateNoticeFn() : null; } catch { return null; }
}


// Load .env configuration.
//
// quiet: dotenv 17 prints "[dotenv@17.x] injecting env …" ON STDOUT, and stdout
// here IS the JSON-RPC channel. Clients that don't tolerate junk lines fail the
// handshake outright — Antigravity/Gemini report `calling "initialize": invalid
// character 'd' looking for beginning of value` (it parses the leading '[' as a
// JSON array, then hits the 'd' of "dotenv"). Claude Code happened to skip the
// line, which is why this hid for so long.
config({ quiet: true });

/**
 * Cached check for whether the codeindex companion is available. We only run
 * this once per process (cheap PATH lookup) and use the result to decide
 * whether to append "tip: call codeindex find_symbol/read_symbol on these
 * files" hints to file-related tool responses.
 *
 * The cache is intentionally permissive: if the user installs codeindex while
 * the MCP server is running, they'll see the hint after the next mcp restart.
 * Trade-off: avoid a `which` syscall on every tool invocation.
 */
let _codeindexAvailable: boolean | null = null;
function codeindexAvailable(): boolean {
  if (_codeindexAvailable !== null) return _codeindexAvailable;
  try {
    if (!isOnPath('codeindex')) throw new Error('codeindex not on PATH');
    _codeindexAvailable = true;
  } catch {
    _codeindexAvailable = false;
  }
  return _codeindexAvailable;
}

/**
 * Append a one-line hint to a tool-result text body when codeindex is on PATH.
 * The agent sees both MCP servers but doesn't always know they compose — this
 * makes the connection explicit at the point where it'd actually be useful.
 */
function withCodeindexHint(body: string, kind: 'files' | 'session'): string {
  if (!codeindexAvailable()) return body;
  const hints: Record<string, string> = {
    files:      '\n\n_Tip: codeindex is also installed — call `find_symbol` or `get_outline` on these files for current symbol-level detail._',
    session:    '\n\n_Tip: codeindex is also installed — call `get_outline` on each file for its current symbol structure._',
  };
  return body + hints[kind];
}

// ── Remote scope (chat-recall server) ───────────────────────────────
// When the user has run `chat-recall login`, search tools can query the
// synced server instead of the local index — cross-device (and team)
// recall from inside the agent. Local stays the default: it's offline,
// faster, and always present.

function remoteCredentials(): { base: string; token: string } | null {
  // FIRST, ahead of both env and disk: the credentials of the caller whose
  // request we are inside. Set only by the remote /mcp endpoint, where one
  // process serves many people and the identity arrives per request in an OAuth
  // bearer token — see ./credential-context.ts. Under stdio there is no store
  // and this is null, so the local product's resolution order is untouched.
  //
  // The order is not a preference, it is a safety property: if env were
  // consulted first, a server that happened to have CHAT_RECALL_TOKEN set would
  // answer every remote caller out of that one account.
  const ambient = currentCredentials();
  if (ambient) return ambient;

  // A container has no credentials file and cannot run a login, so an explicit
  // CHAT_RECALL_TOKEN outranks the disk. This is what lets Glama and the Docker
  // MCP catalog run this server at all.
  const fromEnv = envCredentials();
  if (fromEnv) return { base: fromEnv.serverUrl, token: fromEnv.token };

  try {
    const raw = readFileSync(join(getDataDir(), 'credentials.json'), 'utf-8');
    const parsed = JSON.parse(raw) as {
      targets?: Array<{ serverUrl?: string; token?: string }>;
      primary?: string;
      serverUrl?: string; token?: string;
    };
    // Multi-target format ({targets:[...]}). Recall READS from one server, and
    // the default is the REMOTE (SaaS) one. A localhost/dev login must never
    // hijack recall — that pointed reads at an empty dev instance while the
    // real data lived on the cloud. Resolution order:
    //   1. CHAT_RECALL_SERVER env  — explicit override
    //   2. configured `primary`    — set by init/login/`chat-recall use`
    //   3. the first remote (non-localhost) target  — SaaS by default
    //   4. the first target        — pure self-host (localhost is the only login)
    if (Array.isArray(parsed.targets) && parsed.targets.length) {
      const valid = parsed.targets.filter((t) => t?.serverUrl);
      if (!valid.length) return null;
      const norm = (u: string) => u.replace(/\/+$/, '');
      const isLocal = (u: string) => /\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)\b/.test(u);
      const byUrl = (u?: string) => u ? valid.find((t) => norm(t.serverUrl!) === norm(u)) : undefined;
      const remotes = valid.filter((t) => !isLocal(t.serverUrl!));
      const pick =
        byUrl(process.env.CHAT_RECALL_SERVER) ??
        byUrl(parsed.primary) ??
        remotes[0] ??
        valid[0];
      return pick?.serverUrl ? { base: norm(pick.serverUrl), token: pick.token || '' } : null;
    }
    // Legacy single-target format. Empty token is valid (tokenless self-host).
    if (parsed.serverUrl) return { base: parsed.serverUrl.replace(/\/+$/, ''), token: parsed.token || '' };
    return null;
  } catch { return null; }
}

/**
 * Uniform HTTP-error shape for server responses: status + a short actionable
 * hint. Deliberately does NOT echo the raw response body — server error pages
 * / stack traces are noise (and a potential info leak) in a tool result.
 */
async function remotePost<T>(path: string, body: unknown): Promise<T> {
  const cred = remoteCredentials();
  if (!cred) throw new Error('scope "server" needs a login — run `chat-recall login <server-url>` first.');
  const res = await fetch(cred.base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cred.token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await buildHttpError(path, res);
  return res.json() as Promise<T>;
}

async function remoteGet<T>(path: string): Promise<T> {
  const cred = remoteCredentials();
  if (!cred) throw new Error('scope "server" needs a login — run `chat-recall login <server-url>` first.');
  const res = await fetch(cred.base + path, {
    headers: { authorization: `Bearer ${cred.token}` },
  });
  if (!res.ok) throw await buildHttpError(path, res);
  return res.json() as Promise<T>;
}

async function remotePatch<T>(path: string, body: unknown): Promise<T> {
  const cred = remoteCredentials();
  if (!cred) throw new Error('scope "server" needs a login — run `chat-recall login <server-url>` first.');
  const res = await fetch(cred.base + path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cred.token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await buildHttpError(path, res);
  return res.json() as Promise<T>;
}

async function remoteDelete<T>(path: string): Promise<T> {
  const cred = remoteCredentials();
  if (!cred) throw new Error('scope "server" needs a login — run `chat-recall login <server-url>` first.');
  const res = await fetch(cred.base + path, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${cred.token}` },
  });
  if (!res.ok) throw await buildHttpError(path, res);
  return res.json() as Promise<T>;
}

/**
 * Throw the uniform "you must log in" error when no credentials exist.
 * Every server-backed tool calls this at entry so the agent always gets the
 * same actionable message instead of a raw fetch failure.
 */
function requireRemote(): { base: string; token: string } {
  const cred = remoteCredentials();
  if (!cred) {
    // Not a dead end any more. The old message named `chat-recall login`, which
    // an npx-installed MCP user does not have on PATH — so the single
    // instruction we gave was `command not found`. loginInstruction() starts a
    // real device-code sign-in and hands back the link and code to show.
    throw new Error(loginInstruction());
  }
  return cred;
}

/** GET with a query string built from params (undefined/null values are dropped). */
async function remoteGetQS<T>(path: string, params: Record<string, string | number | boolean | undefined | null>): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const query = qs.toString();
  return remoteGet<T>(query ? `${path}?${query}` : path);
}

/**
 * GET that does NOT throw on 202/404 — the conversation deep-dive endpoints
 * answer 202 "pending-sync" (the session's compute hasn't been shipped from its
 * machine yet) or 404 (unknown session). Returns the status so the caller can
 * render a friendly message instead of a stack trace.
 */
/**
 * Which code-indexed projects to fan out over: the one named, else every
 * project on the server. Returns [] when nothing is indexed — the normal state
 * on a fresh install — so callers fall back to account scope rather than error.
 *
 * I/O, so it lives here rather than in ./recommendation-merge.ts, which is pure.
 */
async function codeProjectIds(project?: string): Promise<string[]> {
  if (project) return [project];
  try {
    const { projects } = await remoteGet<{ projects: Array<{ projectId: string }> }>('/api/code/projects');
    return (projects ?? []).map((p) => p.projectId);
  } catch {
    return [];
  }
}

async function remoteGetSoft<T>(path: string, params: Record<string, string | number | boolean | undefined | null> = {}): Promise<{ status: number; data: T | null; message?: string }> {
  const cred = requireRemote();
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const q = qs.toString();
  const res = await fetch(cred.base + (q ? `${path}?${q}` : path), { headers: { authorization: `Bearer ${cred.token}` } });
  // 202 pending-sync, 404 unknown, 409 ambiguous short-id prefix. 409 carries a
  // `candidates` list (the sessions the prefix matched) — fold it into the
  // message so the user sees the choices and can re-run with a longer prefix,
  // instead of the prefix expander's work surfacing as a raw `HTTP 409` throw.
  if (res.status === 202 || res.status === 404 || res.status === 409) {
    const body = await res.json().catch(() => ({})) as { message?: string; error?: string; candidates?: string[] };
    let message = body.message ?? body.error;
    if (Array.isArray(body.candidates) && body.candidates.length) {
      message = `${message ?? 'Ambiguous session id prefix.'}\nCandidates:\n${body.candidates.map((c) => `  • ${c}`).join('\n')}\nRe-run with a longer prefix or the full id.`;
    }
    return { status: res.status, data: null, message };
  }
  if (!res.ok) throw await buildHttpError(path, res);
  return { status: res.status, data: (await res.json()) as T };
}

// Tool schemas
const RecallSearchSchema = z.object({
  query: z.string().optional().describe('What you\'re looking for (e.g., "OAuth implementation", "React hooks"). Required unless like_session is set.'),
  like_session: z.string().optional()
    .describe('Find sessions similar to this session id (uses its first prompt / preview as the search text, excludes itself, groups results by project). Takes precedence over query.'),
  include_outcome: z.boolean().optional().default(false)
    .describe('Append a per-result outcome one-liner (shipped/interrupted/abandoned + edit stats) so you can judge at a glance whether resuming each hit is worth it.'),
  top_k: z.number().optional().default(5).describe('Number of results to return'),
  project_filter: z.string().optional().describe('Optional filter by project path substring'),
});

const RecallIndexSchema = z.object({
  force: z.boolean().optional().default(false).describe('Force re-index all sessions'),
});

const RecallShowSchema = z.object({
  session_id: z.string().describe('Session ID from search results'),
  around_line: z.number().optional().describe('Optional line number to show context around'),
  max_messages: z.number().optional().default(10).describe('Maximum messages to return'),
  from_end: z.number().optional()
    .describe('Return the last N messages of the session. Mutually exclusive with around_line.'),
  include_code: z.boolean().optional().default(false)
    .describe('Keep code blocks in assistant messages instead of replacing them with [code block].'),
});

const RecallRecentSchema = z.object({
  project_filter: z.string().optional().describe('Filter by project name (e.g., "acme", "poly")'),
  limit: z.number().optional().default(10).describe('Number of recent sessions to show'),
  since_hours: z.number().optional()
    .describe('Only include sessions modified in the last N hours. Combine with limit for "last 6h, top 20".'),
});

const RecallRenameSchema = z.object({
  session_id: z.string().describe('Session ID to name (from recall_recent / recall_search).'),
  name: z.string().describe('The name to give this conversation. Pass an empty string to clear it and revert to the auto title.'),
});

/**
 * The two SCOPE-NARROWING tools.
 *
 * Everything else an agent can call either reads, or adds something a user can
 * remove. These two remove data and change what syncs — which is exactly why
 * they belong in the agent, because "forget that conversation" and "stop syncing
 * this repo" are said mid-conversation, not in a dashboard. The rule that makes
 * them safe is directional: an agent may NARROW what we hold and never widen it.
 * There is deliberately no tool that removes an exclusion, widens the allowlist
 * or lengthens a retention window.
 *
 * `confirm` is required rather than implied. Annotations (destructiveHint) are
 * advisory — a host may ignore them, and `alwaysAllow` is the user's own file to
 * edit — so the only host-independent brake is an argument the model has to pass
 * on purpose. It is the same shape as the typed count in `chat-recall retention`
 * and the typed phrase in the dashboard.
 */
const RecallForgetSchema = z.object({
  session_id: z.string().describe('Session ID to delete everywhere (from recall_recent / recall_search).'),
  confirm: z.literal(true).describe('Must be true. Only pass it when the user has actually asked for this conversation to be deleted.'),
});

const RecallExcludePathSchema = z.object({
  path: z.string().min(1).describe('Absolute path (or a distinctive part of one) to stop syncing.'),
  confirm: z.literal(true).describe('Must be true. Only pass it when the user has actually asked to stop syncing this path.'),
});

const RecallEditsTimelineSchema = z.object({
  since_hours: z.number().optional().default(24)
    .describe('Time window in hours. Defaults to 24h.'),
  limit: z.number().optional().default(100).describe('Maximum edit rows to return'),
  pattern: z.string().optional().describe('Optional substring filter on file path'),
  project_filter: z.string().optional()
    .describe('Filter by project name (matched against the encoded project directory name)'),
  include_reads: z.boolean().optional().default(false)
    .describe('Include read-type tool calls in addition to write/edit ones'),
  tools: z.array(z.enum(['claude', 'gemini', 'opencode', 'codex', 'agy', 'cursor'])).optional()
    .describe('Restrict to a subset of AI tools. Default: every tool this machine has.'),
  group_by_repo: z.boolean().optional().default(false)
    .describe('Group output by detected git repo root instead of returning a flat list. Useful when a single session touched multiple repos.'),
  view: z.enum(['timeline', 'summary']).optional().default('timeline')
    .describe('timeline = the chronological edit rows; summary = an aggregated rollup over the same window'),
  group_by: z.enum(['session']).optional()
    .describe('"session" = aggregate edits per session instead of a flat timeline — answers "which sessions touched files matching X?" (pass `pattern` + a wide `since_hours`, e.g. 720 for 30 days).'),
});

const RecallContextSchema = z.object({
  session_id: z.string().describe('Session ID to get context from'),
  include_turns: z.boolean().optional().default(false)
    .describe('Append an in-order turn-by-turn dump (user/assistant/tool calls/tool results) for full reasoning visibility.'),
  turns_limit: z.number().optional().default(60)
    .describe('Maximum turns to include when include_turns is true.'),
});

const RecallSummarySchema = z.object({
  session_id: z.string().describe('Session ID to get summary for'),
  rich: z.boolean().optional().default(true)
    .describe('Include the structured outcome (decisions, blockers, claim vs reaction, status). Set false for the legacy short summary only.'),
});

const RecallDiffSchema = z.object({
  session_id: z.string().describe('Session ID to replay edits for'),
  file: z.string().optional().describe('Only return the diff for this absolute file path'),
  context_only: z.boolean().optional().default(false)
    .describe('Skip the full unified diff bodies and return only file-level stats (lines added/removed, reverted flag)'),
  files_only: z.boolean().optional().default(false)
    .describe('Return just the list of files the session touched (grouped by extension, with tools used) — no diffs, no stats. Answers "which files did session X actually touch?".'),
  max_diff_chars: z.number().optional().default(4000)
    .describe('Truncate each per-file unified diff at this many characters in the rendered output'),
});

const RecallCommitsSchema = z.object({
  session_id: z.string().describe('Session ID whose edit window to look up commits for'),
  buffer_minutes: z.number().optional().default(30)
    .describe('Pad the session window by this many minutes on each side to catch commits made just after edits'),
});

const RecallMarkersSchema = z.object({
  session_id: z.string().describe('Session ID to mark prompts in'),
  limit: z.number().optional().default(200).describe('Maximum prompts to mark'),
});

const RecallMemorySearchSchema = z.object({
  query: z.string().describe('What you\'re looking for across all memory types'),
  top_k: z.number().optional().default(10).describe('Number of results'),
  source_types: z.array(z.enum(['session', 'plan', 'task', 'claude_md', 'paste', 'history', 'diary'])).optional()
    .describe('Filter by source types (default: all)'),
  project_filter: z.string().optional().describe('Filter by project path'),
  semantic: z.boolean().optional().default(false)
    .describe('Reserved and currently ignored: the semantic tier is switched off server-side, so every search runs keyword FTS.'),
});

const RecallSmartResumeSchema = z.object({
  // OPTIONAL, because the question this tool answers is "continue where we left
  // off" and whoever asks it does not have a session id. Requiring one made the
  // routing advice ("continue" -> recall_smart_resume) impossible to follow: the
  // agent had to call recall_recent first, and a bare call failed with a zod
  // error about a missing field rather than doing the obvious thing.
  session_id: z.string().optional()
    .describe('Session to resume. Omit for the most recent one.'),
  project_filter: z.string().optional()
    .describe('When session_id is omitted, resume the latest session from this project (path or name substring).'),
});

// ── Tools added to close the UI↔MCP gap ─────────────────────────────
// Several server endpoints existed with no MCP tool at all — two of them
// (`/api/subagents/search`, `/api/files/redundant`) were written explicitly as
// "the server surface for the MCP tool" and then never wired up.

const RecallSubagentSearchSchema = z.object({
  query: z.string().describe('Text to find inside subagent transcripts (explore/compact/aside sub-tasks)'),
  session_id: z.string().optional().describe('Restrict to one session'),
  kind: z.string().optional().describe('Restrict to one subagent kind'),
  limit: z.number().optional().default(20),
});

const RecallRedundantFilesSchema = z.object({
  filename: z.string().describe('Filename you are about to create — scored against files you have written before'),
  project: z.string().optional().describe('Restrict to one project'),
  limit: z.number().optional().default(20),
});

const RecallHealAuditSchema = z.object({
  since_hours: z.number().optional().describe('Bound the scan to sessions touched in the last N hours'),
  apply: z.boolean().optional().default(false)
    .describe('Actually heal (default false = read-only audit). Healing only ever makes a conversation FULLER.'),
});

const RecallMemoryItemSchema = z.object({
  // Must match VALID_SOURCE_TYPES in routes/memory.ts:30 — the item/browse/links
  // routes 400 on anything else. A wider enum here just produced HTTP 400s.
  source_type: z.enum(['session', 'plan', 'task', 'claude_md', 'paste', 'history', 'diary'])
    .describe('Which memory source type'),
  id: z.string().optional().describe('Item id. Omit with mode=browse to list the type.'),
  mode: z.enum(['item', 'content', 'links', 'browse']).optional().default('item')
    .describe('item = metadata, content = full text, links = related items, browse = list the source type'),
  limit: z.number().optional().default(50).describe('browse mode only'),
});

const RecallRegenerateSummarySchema = z.object({
  session_id: z.string().describe('Session whose AI summary should be regenerated'),
});

const RecallOutcomeSummarySchema = z.object({
  days: z.number().optional().default(7).describe('Window in days (1-90)'),
});

const RecallSharesSchema = z.object({
  scope: z.enum(['mine', 'all']).optional().default('mine')
    .describe('mine = projects you shared into the team; all = every share visible to you'),
});

const RecallReclassifySchema = z.object({});

const RecallProjectContextSchema = z.object({
  project_path: z.string().describe('Project path, name substring, OR a stable project_id ("git:github.com/me/repo", "ws:name", "git-local:<sha1>", "user:<custom>")'),
  limit: z.number().optional().default(5).describe('Number of recent sessions to include'),
  tasks: z.number().optional().default(20).describe('Max open tasks to list'),
  plans: z.number().optional().default(20).describe('Max plans to list'),
});

const RecallWeeklyDigestSchema = z.object({
  weeks_back: z.number().optional().default(0).describe('0 = current week, 1 = last week, etc.'),
});

const RecallTeamActivitySchema = z.object({
  project: z.string().optional().describe('Filter to one project_id (e.g. "git:github.com/org/repo")'),
  member: z.string().optional().describe('Filter to one teammate by their user id (sub)'),
  since_days: z.number().optional().describe('Only activity in the last N days'),
});

// Two vocabularies, deliberately different.
//
// FILTER is every status a card can actually hold, so an agent can ask "what
// was rejected?". SETTABLE is what an AGENT may write, and it is smaller by two:
//   - 'rejected' is the user's verdict alone. An agent that disagrees with a
//     card says so and lets the user reject it; it never rejects for them.
//   - 'blocked' is retired. Nothing has ever written it, and the board has no
//     column for it — an agent setting it would make the card vanish from the
//     UI entirely, because byStatus() never queries that bucket.
const TASK_STATUS_FILTER = ['todo', 'in_progress', 'done', 'rejected'] as const;
const TASK_STATUS_SETTABLE = ['todo', 'in_progress', 'done'] as const;
const RecallTasksSchema = z.object({
  mine: z.boolean().optional().describe('Only tasks assigned to me'),
  project: z.string().optional().describe('Filter to one project_id'),
  status: z.enum(TASK_STATUS_FILTER).optional().describe('Filter by status'),
  detail: z.boolean().optional()
    .describe('Return the full brief per task — the fix, the file locations and the agent prompt — plus how to claim and close one. Use this when you intend to DO the tasks, not just list them.'),
});
const RecallTaskCreateSchema = z.object({
  title: z.string().describe('Task title'),
  description: z.string().optional(),
  project: z.string().optional().describe('project_id this task belongs to'),
  assignee: z.string().optional().describe("Teammate user id (sub) to assign; omit to leave unassigned"),
  due: z.number().optional().describe('Due date, epoch milliseconds. Set one when the work is time-bound; omit otherwise.'),
  linked_finding_id: z.string().optional().describe('The code finding this task comes from (ca_…) — lets the card auto-close and dedupe.'),
});
const RecallTaskUpdateSchema = z.object({
  id: z.string().describe('Task id (t_…)'),
  status: z.enum(TASK_STATUS_SETTABLE).optional(),
  assignee: z.string().optional().describe('Reassign to this user id (sub); empty string unassigns'),
  title: z.string().optional(),
  comment: z.string().optional().describe('Add a comment to the task'),
  linked_session_id: z.string().nullable().optional()
    .describe('Session id to attach to the task (null detaches). Pass YOUR OWN current session id when you start working on the task.'),
});
const RecallTaskCommentSchema = z.object({
  task_id: z.string().describe('Task id (t_…) from recall_tasks'),
  body: z.string().describe('The comment text'),
});

// ── Knowledge Graph Schemas ──────────────────────────────────────

const RecallKGQuerySchema = z.object({
  entity: z.string().describe('Entity name to query (e.g., "Alice", "chat-recall", "PostgreSQL")'),
  as_of: z.string().optional().describe('Date filter — only facts valid at this date (YYYY-MM-DD)'),
  direction: z.enum(['outgoing', 'incoming', 'both']).optional().default('both'),
});

const RecallKGAddSchema = z.object({
  subject: z.string().describe('The entity doing/being something'),
  predicate: z.string().describe('Relationship type (e.g., "uses", "works_on", "prefers")'),
  object: z.string().describe('The entity being connected to'),
  valid_from: z.string().optional().describe('When this became true (YYYY-MM-DD)'),
  source_session: z.string().optional().describe('Session ID where this was learned'),
});

const RecallKGInvalidateSchema = z.object({
  subject: z.string().describe('Entity'),
  predicate: z.string().describe('Relationship'),
  object: z.string().describe('Connected entity'),
  ended: z.string().optional().describe('When it stopped being true (YYYY-MM-DD, default: today)'),
});

const RecallKGTimelineSchema = z.object({
  entity: z.string().optional().describe('Entity to get timeline for (omit for full timeline)'),
  limit: z.number().optional().default(50),
});

const RecallKGStatsSchema = z.object({});

// ── Diary Schemas ────────────────────────────────────────────────

const RecallDiaryWriteSchema = z.object({
  agent_name: z.string().describe('Your name — each agent gets their own diary'),
  entry: z.string().describe('What happened, what you learned, what matters'),
  topic: z.string().optional().default('general').describe('Topic tag'),
  session_id: z.string().optional().describe('Current session ID (for linking)'),
  project_path: z.string().optional().describe('Project path (for context)'),
});

const RecallDiaryReadSchema = z.object({
  agent_name: z.string().describe('Agent name to read diary for'),
  last_n: z.number().optional().default(10).describe('Number of recent entries'),
});

// ── Code intelligence (codeindex merge) ──
const RecallCodeIndexSchema = z.object({
  path: z.string().optional().describe('Repo path to index (default: current working directory)'),
});
const RecallCodeProjectsSchema = z.object({});
const RecallCodeFindingsSchema = z.object({
  project: z.string().optional().describe('Project id (omit for all). Get ids from recall_code_projects.'),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
  category: z.string().optional().describe('security|literal|clone|duplication|dead_code|coupling|cycle'),
  limit: z.number().optional().default(50),
  view: z.enum(['findings', 'summary', 'hotspots', 'file-sessions']).optional().default('findings')
    .describe('findings = the list; summary = counts by severity/category; hotspots = churn-ranked files; file-sessions = which sessions actually touched `file` (turns a hotspot into a navigable cause)'),
  file: z.string().optional().describe('view=file-sessions only: repo-relative path'),
});
const RecallCodeActionsSchema = z.object({
  project: z.string().optional().describe('Project id (omit for all)'),
  status: z.enum(['suggested', 'queued', 'done', 'dismissed']).optional(),
  limit: z.number().optional().default(30),
});
const RecallRecommendationsSchema = z.object({
  scope: z.enum(['account', 'project']).optional().default('account')
    .describe('account = recommendations from YOUR chat-recall data (leaked secrets + session behaviour). project = behavior × code recommendations for one code-indexed project (requires `project`).'),
  project: z.string().optional().describe('Project id (from recall_code_projects). Required when scope is "project".'),
});

// ── Aggregated views over the recommendation engines ────────────────────────
// Neither tool computes anything of its own. They fan out over the SAME
// endpoints recall_recommendations and recall_code_actions already use, then
// merge the results into the one question each tool answers. Adding a new
// recommendation kind in engine/core/code/recommendations.ts surfaces here for
// free; there is no second copy of the ranking to keep in step.

const RecallClaudeSuggestionsSchema = z.object({
  project: z.string().optional()
    .describe('Limit to one code-indexed project id. Omit to merge account-level suggestions with every project you have indexed.'),
  include_projects: z.boolean().optional().default(true)
    .describe('Fan out over code-indexed projects as well as account scope. Set false for account-only, which needs no code index.'),
  kind: z.enum(INSTRUCTION_KINDS).optional()
    .describe('rule = a CLAUDE.md line to add; skill = a skill to install. Omit for both.'),
});

const RecallImprovementsSchema = z.object({
  project: z.string().optional().describe('Limit to one code-indexed project id.'),
  min_severity: z.enum(SEVERITIES).optional().default('low')
    .describe('Drop anything below this severity. Code actions carry a numeric pri and are mapped onto the same scale.'),
  limit: z.number().optional().default(30).describe('Maximum improvements to return, after ranking.'),
  create_tasks: z.boolean().optional().default(false)
    .describe('Create one team task per returned improvement on the shared board. Off by default: this tool is a read by default, and writes only when you ask.'),
  assignee: z.string().optional().describe('create_tasks only: teammate user id (sub) to assign every created task to.'),
});



// ── New tools (user-prompts, decision-record) ──

const RecallUserPromptsSchema = z.object({
  session_id: z.string().optional().describe('If set, only that session\'s prompts'),
  since_days: z.number().optional().default(7).describe('When session_id is omitted, look back this many days'),
  limit: z.number().optional().default(50).describe('Maximum prompts to return'),
  with_markers: z.boolean().optional().default(true)
    .describe('Tag each prompt with sentiment / corrective markers (interrupt, frustrated, correction, approval, …). Set false to revert to legacy text-only output.'),
});

const RecallDecisionRecordSchema = z.object({
  subject: z.string().describe('What the decision is about (e.g., "chat-recall", "auth strategy")'),
  decision: z.string().describe('The decision itself in plain words (e.g., "use Postgres full-text search as the default backend")'),
  reason: z.string().optional().describe('Why this was decided — short rationale'),
  importance: z.number().min(1).max(5).optional().default(4)
    .describe('1–5; the classifier surfaces 4+ in wake-up context'),
  session_id: z.string().optional().describe('Session this decision was made in (for traceability)'),
  agent_name: z.string().optional().default('agent').describe('Who recorded the decision (for diary linkage)'),
});

// ── Analytics summary + wake-up ────────────────────────────────────────────

const RecallAnalyticsSummarySchema = z.object({
  // No required inputs — returns the same summary the dashboard renders.
  view: z.enum(['summary', 'patterns']).optional().default('summary')
    .describe('summary = spend/activity rollup; patterns = behavioural patterns across sessions'),
});

const RecallWakeUpSchema = z.object({
  max_facts: z.number().optional().default(10)
    .describe('How many high-importance classifier hits to include'),
  max_kg_facts: z.number().optional().default(15)
    .describe('How many current knowledge-graph facts to include'),
  identity: z.string().optional()
    .describe('Optional override for the identity blurb. Defaults to <data dir>/identity.txt or "AI coding assistant"'),
  project_filter: z.string().optional()
    .describe('Scope facts, KG entities and the task count to a project (substring match against project_path / entity name). Without this, facts are global and bleed across unrelated projects.'),
  // Alias. Its sibling tools (recall_tasks, recall_project_context) all take
  // `project`, and passing that here used to be silently ignored: no error, and
  // a WHOLE-TENANT answer that looks exactly like a scoped one. That is the
  // failure this tool exists to prevent — being told about another project's
  // backlog — so accepting both names is worth more than naming purity.
  project: z.string().optional()
    .describe('Alias for project_filter.'),
});

// ── KV (third memory primitive) ────────────────────────────────────────────

const RecallSetSchema = z.object({
  key: z.string().describe('Key name (e.g. "current-pr", "default-test-runner")'),
  value: z.string().describe('Value to store. Plain string. JSON-encode if you need structure.'),
  scope: z.string().optional().default('default')
    .describe('Namespace. Use a project path or "global" / "session-<id>" to avoid collisions across contexts.'),
});

const RecallGetSchema = z.object({
  key: z.string().optional()
    .describe('Key name. Omit to LIST the keys in the scope instead (omit scope too to list across all scopes).'),
  scope: z.string().optional()
    .describe('Namespace. Defaults to "default" when reading a key; when listing (no key), omit to list across all scopes.'),
  limit: z.number().optional().default(50).describe('Max entries when listing (no key given).'),
});

// ── Security / Secret Findings Schemas ─────────────────────────────

const RecallSecuritySummarySchema = z.object({
  include_dismissed: z.boolean().optional().default(false)
    .describe('Show secrets the user already marked as rotated / false_positive / dismissed'),
  top_k: z.number().optional().default(20).describe('Max distinct secrets to return'),
  group_by: z.enum(['detector', 'rule', 'project', 'trend', 'sessions']).optional().default('detector')
    .describe('detector = the default action-required view; rule / project = findings grouped that way; trend = daily counts; sessions = one row per session with findings'),
  days: z.number().optional().default(30).describe('group_by=trend only: window in days (1-365)'),
  min_detectors: z.number().optional().describe('group_by=sessions only: require at least N detectors agreeing (signal vs noise)'),
});

const RecallSecuritySessionSchema = z.object({
  session_id: z.string().describe('Session ID from search results or the security dashboard'),
});

const RecallRecommendationApplySchema = z.object({
  id: z.string().describe('Recommendation id (the `id` field from recall_recommendations)'),
  project: z.string().describe('Project id the recommendation belongs to (from recall_code_projects)'),
});

const RecallRecommendationDismissSchema = z.object({
  id: z.string().describe('Recommendation id from recall_recommendations'),
  project: z.string().describe('Project id the recommendation belongs to'),
  reason: z.string().describe('Why it does not apply here. Required — a dismissal changes how the AI treats this repo, and an unexplained one cannot be reviewed later.'),
  undo: z.boolean().optional().describe('Put a previously dismissed recommendation back on the list.'),
});

const RecallProjectLabelSchema = z.object({
  project: z.string().describe('Project id (from recall_code_projects)'),
  label: z.enum(['poc', 'production', 'engineering', 'none'])
    .describe('poc = may reset its db and move fast. production = protect data, no destructive steps. engineering = raise the bar on tests and review. none = clear the label.'),
});

const RecallSecurityDismissSchema = z.object({
  preview: z.string().describe('The masked secret preview (e.g. "************************ZeMa")'),
  status: z.enum(['rotated', 'false_positive', 'dismissed', 'undismissed'])
    .describe('Why this finding is no longer actionable — or `undismissed` to put it BACK on the action-required list (the inverse this tool was missing).'),
  reason: z.string().optional().describe('Optional note'),
});

const TOOLKIT_TYPES = ['mcp', 'skill', 'command', 'agent', 'instructions'] as const;

const RecallToolkitStatusSchema = z.object({
  type: z.enum(TOOLKIT_TYPES).optional()
    .describe('Restrict to one artifact type. Omit for every type.'),
});

const RecallToolkitSyncSchema = z.object({
  types: z.array(z.enum(TOOLKIT_TYPES)).optional()
    .describe('Which artifact types to install. Omit for all of them.'),
  name: z.string().optional()
    .describe('Install ONE named artifact. Requires exactly one entry in `types`.'),
  device: z.string().optional()
    .describe('Hostname of the machine to install on. Omit to target EVERY device on the account.'),
  scope: z.enum(['pull', 'fan_out']).optional().default('pull')
    .describe('pull = install what the account has onto the device(s), from the server (cross-device). fan_out = copy what a device already has between its own tools (single-machine).'),
});

const RecallSecurityRulesSchema = z.object({
  action: z.enum(['list', 'test']).optional().default('list')
    .describe('list = return tenant rules; test = try a regex against sample text (does not persist)'),
  name: z.string().optional().describe('For test: rule name'),
  regex: z.string().optional().describe('For test: regex to evaluate'),
  sample: z.string().optional().describe('For test: text to match against'),
});



/**
 * The version this server reports to clients, supplied by the HOST.
 *
 * It used to be read from `../package.json` relative to this file, which
 * resolved to the CLI's manifest while the tool surface lived in that package.
 * It no longer does: from packages/engine that path is the ENGINE's manifest,
 * which carries a different version entirely (0.4.8 against the CLI's 0.5.12).
 * The failure was not the crash that exposed it — it was that the next resolve
 * would have quietly advertised the wrong version to every client forever.
 *
 * Neither manifest is the right answer in general, because the version a caller
 * cares about is the version of the THING SERVING THEM: the installed CLI over
 * stdio, the deployed server over /mcp. So the host states it.
 */
const DEFAULT_VERSION = '0.0.0-unset';
let serverVersion = DEFAULT_VERSION;

/** Set the reported version. Call BEFORE createMcpServer(); after that the
 *  value is baked into the instance the client sees. */
export function setServerVersion(version: string): void {
  if (version) serverVersion = version;
}

/**
 * Build an MCP Server with every tool handler attached.
 *
 * A factory rather than a module-level singleton because the two hosts differ:
 * stdio needs exactly one, for the life of the process; the remote endpoint
 * needs one per authenticated session, since the SDK ties transport state to
 * the instance. A shared singleton there would cross-wire sessions.
 */
export function createMcpServer(): Server {
  const s = new Server(
    { name: 'chat-recall', version: serverVersion },
    { capabilities: { tools: {} } },
  );
  attachHandlers(s);
  return s;
}

/**
 * The tools an agent sees by default.
 *
 * 53 tools is a lot to put in front of a model. Tool choice degrades as the list
 * grows — some clients truncate it, and all of them get worse at picking when a
 * dozen names could plausibly match a request. The routing hints in these
 * descriptions help, but they cannot undo the size.
 *
 * So the default is LEAN: the tools that answer the questions people actually
 * ask — resume, search, read a session, see what changed, remember a fact. The
 * rest are administrative, aggregate or niche, and stay one env var away:
 *
 *   CHAT_RECALL_MCP_PROFILE=full   every tool, as before
 *   CHAT_RECALL_MCP_PROFILE=lean   the default
 *
 * Nothing is removed. Every handler still works if a client calls it by name
 * from a cached list, which is why this filters the LISTING and not the switch.
 * An unlisted tool that still answers is strictly better than a 404 for someone
 * whose client cached yesterday's list.
 */
const LEAN_TOOLS = new Set([
  // Resume and cold start — the reason most people reach for this at all.
  'recall_smart_resume', 'recall_wake_up', 'recall_recent',
  // Find things.
  'recall_search', 'recall_memory_search', 'recall_user_prompts',
  // Read one session.
  'recall_context', 'recall_summary', 'recall_show',
  // What changed.
  'recall_edits_timeline', 'recall_diff', 'recall_commits',
  // Project state and tasks.
  'recall_project_context', 'recall_tasks', 'recall_task_create', 'recall_task_update',
  // Durable memory.
  'recall_kg_query', 'recall_kg_add', 'recall_decision_record',
  'recall_diary_write', 'recall_diary_read',
  // Health, and the one that pays out on day one.
  'recall_status', 'recall_index', 'recall_security_summary',
  // The two REMOVE tools. They are here for the same reason as the rest — they
  // answer something a person says mid-conversation ("forget that", "stop
  // syncing this repo") — and a privacy control the agent cannot see is a
  // dashboard feature wearing an MCP badge. They shipped outside this set and
  // the e2e harness proved them working under CHAT_RECALL_MCP_PROFILE=full,
  // which is the one profile no user runs.
  //
  // Cost: two names on a 25-name list. Brake: `confirm: true` is a
  // z.literal(true), and both are kept out of the alwaysAllow list `init`
  // writes, so the host prompts every time. Neither depends on the listing.
  'recall_forget', 'recall_exclude_path',
]);

function toolProfile(): 'lean' | 'full' {
  return (process.env.CHAT_RECALL_MCP_PROFILE || '').toLowerCase() === 'full' ? 'full' : 'lean';
}

/**
 * The tools that CHANGE something. Everything absent from this set only reads,
 * which is what `readOnlyHint` then tells the client.
 *
 * Without annotations a host cannot tell `recall_search` from
 * `recall_kg_invalidate`, so it must treat 50 read tools as if each one could
 * mutate the user's memory — every call needs a prompt, and the product feels
 * broken on day one. Keep this list honest: a read tool wrongly marked
 * read-only is a lie the host acts on.
 */
const WRITE_TOOLS = new Set<string>([
  'recall_forget',             // deletes a session everywhere, with a tombstone
  'recall_exclude_path',       // changes what syncs, here and on the account
  'recall_index',              // indexes and ships new rows
  'recall_code_index',         // runs the analyzer, then syncs findings
  'recall_kg_add',
  'recall_kg_invalidate',
  'recall_diary_write',
  'recall_decision_record',
  'recall_set',
  'recall_task_create',
  'recall_task_update',
  'recall_task_comment',
  'recall_security_dismiss',
  'recall_recommendation_apply',    // queues a CLAUDE.md edit / sets a label
  'recall_recommendation_dismiss',  // retires advice for this project
  'recall_project_label',           // changes the guardrails every session reads
  'recall_reclassify',         // rewrites classifier tags on indexed chunks
  'recall_regenerate_summary', // overwrites a stored summary
  'recall_rename_session',     // overwrites the session name
]);

/** Writes that OVERWRITE or retire earlier state, rather than only adding to it. */
const DESTRUCTIVE_TOOLS = new Set<string>([
  // The two scope-narrowing tools. recall_forget has no undo at all; excluding a
  // path changes what leaves the machine until someone removes the rule by hand.
  'recall_forget',
  'recall_exclude_path',
  'recall_kg_invalidate',
  'recall_recommendation_dismiss',  // retires advice; undo exists but it is a decision
  'recall_reclassify',
  'recall_regenerate_summary',
  'recall_rename_session',
  'recall_security_dismiss',
]);

/** Writes where calling twice with the same input leaves the same state. */
const IDEMPOTENT_TOOLS = new Set<string>([
  'recall_set',
  'recall_recommendation_dismiss',
  'recall_project_label',
  'recall_kg_invalidate',
  'recall_rename_session',
  'recall_security_dismiss',
  'recall_reclassify',
  'recall_task_update',
]);

/**
 * A display title, derived from the tool name instead of hand-typed. A table of
 * 54 titles rots the moment someone renames a tool; this cannot disagree.
 */
function toolTitle(name: string): string {
  const words = name.replace(/^recall_/, '').replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

type ToolDef = { name: string; description: string; inputSchema: unknown };

/**
 * Attach MCP tool annotations. `openWorldHint` is true for every tool: they all
 * reach the chat-recall server, so none of them is a closed local computation.
 */
function annotate(t: ToolDef): ToolDef & { annotations: Record<string, unknown> } {
  const writes = WRITE_TOOLS.has(t.name);
  return {
    ...t,
    annotations: {
      title: toolTitle(t.name),
      readOnlyHint: !writes,
      destructiveHint: DESTRUCTIVE_TOOLS.has(t.name),
      idempotentHint: writes ? IDEMPOTENT_TOOLS.has(t.name) : true,
      openWorldHint: true,
    },
  };
}

// List available tools
function attachHandlers(server: Server): void {
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const all: Array<{ name: string; description: string; inputSchema: unknown }> = [
      {
        name: 'recall_search',
        description: `Search for relevant past sessions to resume.

Find past conversations matching your current task. Returns session IDs that
can be used to resume that session in the tool that produced it.

Three modes on one tool:
- \`query\` — free-text search ("I'm working on X, what past work is relevant?").
- \`like_session\` — find sessions similar to an existing session id (uses its
  first prompt as the search text, excludes itself, groups hits by project).
- \`include_outcome: true\` — append a per-result outcome one-liner (shipped /
  interrupted / abandoned + edit stats) to judge whether each hit is worth resuming.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What you\'re looking for (e.g., "OAuth implementation"). Required unless like_session is set.' },
            like_session: { type: 'string', description: 'Find sessions similar to this session id instead of a free-text query.' },
            include_outcome: { type: 'boolean', default: false, description: 'Append per-result outcome one-liners (status + edit stats).' },
            top_k: { type: 'number', default: 5, description: 'Number of results to return' },
            project_filter: { type: 'string', description: 'Optional filter by project path substring' },
            skip_ranking: { type: 'boolean', default: false, description: 'Skip Claude ranking for faster results' },
            provider: { type: 'string', enum: ['ollama', 'gemini'], default: 'ollama', description: 'Embedding provider' },
            scope: { type: 'string', enum: ['local', 'server'], default: 'local', description: 'Accepted for back-compat; search always runs against the synced server.' },
          },
        },
      },
      {
        name: 'recall_index',
        description: `Index all Claude Code sessions for semantic search.

Scans ~/.claude/projects/ and creates embeddings for all sessions.
By default, only indexes new or changed sessions.`,
        inputSchema: {
          type: 'object',
          properties: {
            force: { type: 'boolean', default: false, description: 'Force re-index all sessions' },
            provider: { type: 'string', enum: ['ollama', 'gemini'], default: 'ollama', description: 'Embedding provider' },
          },
        },
      },
      {
        name: 'recall_status',
        description: 'Show index status and statistics: synced sessions, chunks, freshness, top projects, plus the full memory-system breakdown (items/chunks per source type, per AI tool, link count).',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'recall_show',
        description: `Get conversation content from a specific session — or the full text of a plan.

Use this after recall_search to get full context from a session. Also accepts a
plan id (the plan filename without .md, as returned by
recall_memory_search(source_types:['plan'])) and renders the complete plan text.

Set \`from_end: N\` to fetch the last N messages (no line-number guessing).
Set \`include_code: true\` to keep code blocks instead of redacting them — useful
when the user is asking "what did we change?" and the diffs/SQL/commands matter.`,
        inputSchema: {
          type: 'object',
          properties: {
            session_id:    { type: 'string', description: 'Session ID from search results, or a plan id (filename without .md)' },
            around_line:   { type: 'number', description: 'Optional line number to show context around' },
            max_messages:  { type: 'number', default: 10, description: 'Maximum messages to return' },
            from_end:      { type: 'number', description: 'Return the last N messages (alternative to around_line).' },
            include_code:  { type: 'boolean', default: false, description: 'Keep code blocks in assistant messages.' },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'recall_recent',
        description: `List recent sessions across every AI tool chat-recall indexes.

Shows your most recent conversations across all projects or filtered by project.
Use this when the user says "continue our last conversation" or wants to see recent work.

Pass \`since_hours: N\` to restrict to sessions modified in the last N hours.`,
        inputSchema: {
          type: 'object',
          properties: {
            project_filter: { type: 'string', description: 'Filter by project name (e.g., "acme", "poly")' },
            limit:          { type: 'number', default: 10, description: 'Number of recent sessions to show' },
            since_hours:    { type: 'number', description: 'Only include sessions modified in the last N hours.' },
            scope:          { type: 'string', enum: ['local', 'server'], default: 'local', description: 'server = synced cross-device history (needs chat-recall login).' },
          },
        },
      },
      {
        name: 'recall_forget',
        description: `Delete one conversation from chat-recall, everywhere, permanently.

Use it when the user says "forget this conversation", "delete that session", "remove what we discussed
about X" — anything that asks for a conversation to stop existing on the server.

WHAT IT DOES: purges the session on every server this machine is logged in to, and tombstones the id so
no later sync can bring it back. The AI tool's own transcript file on the user's disk is NOT touched —
tell them that, because it is usually what they mean to keep.

IRREVERSIBLE. There is no undo and no tool that restores it. Only pass \`confirm: true\` when the user
has actually asked for this; do not infer it from a complaint about a conversation.`,
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Session ID to delete (from recall_recent / recall_search).' },
            confirm: { type: 'boolean', description: 'Must be true. Only when the user actually asked to delete it.' },
          },
          required: ['session_id', 'confirm'],
        },
      },
      {
        name: 'recall_exclude_path',
        description: `Stop syncing a project path. Nothing under it leaves the machine from the next sync on.

Use it when the user says "stop syncing this repo", "don't upload anything from ~/work/client", "keep this
project out of chat-recall".

WHAT IT DOES: adds the path to the exclusion rules — on this machine, and on the account so every device
the user syncs from honours it. Sessions ALREADY uploaded from that path stay until they are deleted; say
so, and offer recall_forget for the ones that matter.

There is deliberately no tool to REMOVE an exclusion: an agent may narrow what is synced, never widen it.
Undo it with \`chat-recall exclude remove <path>\` or in the dashboard.`,
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path (or a distinctive part of one) to stop syncing.' },
            confirm: { type: 'boolean', description: 'Must be true. Only when the user actually asked to stop syncing it.' },
          },
          required: ['path', 'confirm'],
        },
      },
      {
        name: 'recall_rename_session',
        description: `Give a conversation a memorable name — or rename it — so you (and the user) can find and resume it later.

Mirrors Claude Code's session naming (\`/rename\`). The name replaces the auto-generated summary in
recall_recent and the web UI. Use it when the user says "name this conversation X", "call this session Y",
or "rename this to Z". Pass an empty string to clear the name and revert to the auto title.

The name persists across re-syncs and summary regeneration (it's stored separately from the AI summary).`,
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Session ID to name (from recall_recent / recall_search).' },
            name:       { type: 'string', description: 'The name to give this conversation. Empty string clears it.' },
          },
          required: ['session_id', 'name'],
        },
      },
      {
        name: 'recall_edits_timeline',
        description: `Chronological list of file edits across recent sessions, spanning every AI tool
chat-recall indexes — Claude Code, Gemini CLI, OpenCode, Codex, Antigravity and Cursor.

Returns rows shaped like (timestamp, tool, session_id, project, file, op) sorted newest
first. Pulls live from each tool's native session store — Claude JSONL, Gemini chat
JSON, OpenCode SQLite — so the active session is included even though its metadata
hasn't been re-indexed yet.

Great for "what were we just changing?" — call with \`since_hours: 2\` to see the last
two hours of edits across every session and every AI tool.

Pass \`group_by: "session"\` (with \`pattern\` + a wide \`since_hours\`, e.g. 720) to
aggregate per session instead — "which sessions edited auth.rs in the last month?".`,
        inputSchema: {
          type: 'object',
          properties: {
            since_hours:    { type: 'number', default: 24, description: 'Time window in hours' },
            limit:          { type: 'number', default: 100, description: 'Maximum edit rows to return' },
            pattern:        { type: 'string', description: 'Optional substring filter on file path' },
            project_filter: { type: 'string', description: 'Filter by encoded project directory name' },
            include_reads:  { type: 'boolean', default: false, description: 'Include Read tool_uses too' },
            tools:          {
              type: 'array',
              items: { type: 'string', enum: ['claude', 'gemini', 'opencode', 'codex', 'agy', 'cursor'] },
              description: 'Restrict to specific AI tools. Default: every tool this machine has.',
            },
            group_by_repo:  { type: 'boolean', default: false, description: 'Group results by detected git repo root.' },
            view:           { type: 'string', enum: ['timeline', 'summary'], default: 'timeline', description: 'timeline = chronological edit rows; summary = aggregated rollup over the same window' },
            group_by:       { type: 'string', enum: ['session'], description: '"session" = aggregate edits per session (which sessions touched files matching pattern).' },
          },
        },
      },
      {
        name: 'recall_context',
        description: `Get structured context from a session for continuation.

Returns:
- Your requests/inputs
- Claude's work/decisions
- Key topics discussed
- Tools used and files changed
- Summary if available

Use this to understand what happened in a session before resuming.`,
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Session ID to get context from' },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'recall_summary',
        description: `Get the summary for a session — including its OUTCOME classification.

By default returns a *rich* summary that combines the AI summary (when available)
with the structured outcome derived from the transcript itself: status (shipped /
interrupted / abandoned / in_progress), the session window, decisions the agent
announced, blockers hit (tool errors, interrupts), edit/commit stats, prompt
markers, and the last assistant claim paired with the user's reaction to it
(so you can see whether "done!" was actually accepted or met with "wtf").
This is the triage call when scanning a session list — it answers the question
the AI summary doesn't: did this work actually land?
Pass \`rich: false\` to fall back to the legacy single-line AI summary only.`,
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Session ID to get summary for' },
            rich:       { type: 'boolean', default: true, description: 'Include structured outcome alongside AI summary' },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'recall_diff',
        description: `Replay a session's Edit/Write/MultiEdit/NotebookEdit tool calls into a unified
diff per file. Lets you see what the agent actually changed — not just that it
edited, but how — without grepping the raw transcript.

Detects reverts: when a file was edited but the final state matches the initial
state, the file is reported with \`reverted: true\` and a zero-line diff.

Pass \`file\` to focus on a single absolute path. Pass \`context_only: true\` for
just the per-file stats (lines added/removed) when you don't need the diff body.
Pass \`files_only: true\` for just the list of files the session touched (grouped
by extension, with tools used) — "which files did session X actually touch?".`,
        inputSchema: {
          type: 'object',
          properties: {
            session_id:     { type: 'string', description: 'Session ID to replay' },
            file:           { type: 'string', description: 'Absolute file path to focus on (optional)' },
            context_only:   { type: 'boolean', default: false, description: 'Skip diff bodies, return stats only' },
            files_only:     { type: 'boolean', default: false, description: 'Return just the file list (no diffs/stats)' },
            max_diff_chars: { type: 'number', default: 4000, description: 'Truncate each per-file unified diff' },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'recall_commits',
        description: `Find git commits that landed during a session's edit window, grouped by repo.

Multi-repo aware: a session that touched ~/code/example/infra and
~/code/example/api returns commits from each repo, with overlap shown
between commit-files and session-touched-files.

Use this to verify "shipped" claims — if the session edited 18 files but no
matching commit exists, work probably stayed local.`,
        inputSchema: {
          type: 'object',
          properties: {
            session_id:     { type: 'string', description: 'Session ID to look up commits for' },
            buffer_minutes: { type: 'number', default: 30, description: 'Window padding on each side' },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'recall_markers',
        description: `Tag every user prompt in a session with sentiment / corrective markers:

  • interrupt              — user hit ESC mid-response
  • frustrated             — caps, profanity, "wtf", "ffs"
  • correction             — "no", "stop", "don't" — negating the last action
  • approval               — "yes", "do it", "i approve"
  • question               — "why", "what", ends with ?
  • directive              — "use X", "implement Y", "build Z"
  • clarification_request  — "wdym", "explain", "what is"

Returns per-prompt markers + a session-level summary count. Use this to spot
sessions where things went sideways before reading the whole transcript.`,
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Session ID to mark prompts in' },
            limit:      { type: 'number', default: 200, description: 'Maximum prompts to return' },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'recall_memory_search',
        description: `Search across all memory types: sessions, plans, tasks, CLAUDE.md files, history, paste cache, and agent diaries.

Returns results from any memory source, ranked by relevance. Use source_types to filter.
Plans and tasks are found here (source_types: ['plan', 'task']); read a full plan
with recall_show (pass the plan id).`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What you\'re looking for across all memory types' },
            top_k: { type: 'number', default: 10, description: 'Number of results' },
            source_types: {
              type: 'array',
              items: { type: 'string', enum: ['session', 'plan', 'task', 'claude_md', 'paste', 'history', 'diary'] },
              description: 'Filter by source types (default: all)',
            },
            project_filter: { type: 'string', description: 'Filter by project path' },
            provider: { type: 'string', enum: ['ollama', 'gemini'], default: 'ollama' },
            scope: { type: 'string', enum: ['local', 'server'], default: 'local', description: 'server = synced cross-device history (needs chat-recall login).' },
            semantic: { type: 'boolean', default: false, description: 'Reserved and currently ignored: the semantic tier is switched off server-side, so every search runs keyword FTS.' },
          },
          required: ['query'],
        },
      },
      {
        name: 'recall_smart_resume',
        description: `Get structured resume context for a session — by default, the most recent one.

Call it with NO arguments to resume the latest session. That is the common case:
"continue", "pick up where we left off". Pass session_id only to resume a
specific one, or project_filter to take the latest from one project.

Returns:
- What was done (completed work, decisions made)
- What's pending (unfinished tasks, TODOs mentioned)
- Files modified with change summary
- Token/cost budget used
- Resume command

Use this instead of recall_context for a more actionable summary when resuming work.`,
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Session to resume. OMIT to resume the most recent session.' },
            project_filter: { type: 'string', description: 'With session_id omitted, resume the latest session from this project.' },
          },
        },
      },
      {
        name: 'recall_project_context',
        description: `Get the full project dossier as markdown — rich project context.

Aggregates everything the index knows about one project into a single report:
overview (from CLAUDE.md), tech stack (KG uses), architecture / deployment / security
sections (from CLAUDE.md), decisions log (KG chose/rejected), recent session activity
with summaries, open tasks, plans, agent diary conclusions, and cost rollup.

Accepts EITHER a project path / name substring (e.g. "api", "example-app",
"/home/user/code/example") OR a stable project_id:
  - "git:<host>/<owner>/<repo>"   (e.g. "git:github.com/owner/repo")
  - "ws:<name>"                   (workspace rollup)
  - "git-local:<sha1>"            (local-only git repo)
  - "user:<custom>"               (declared in ~/.chat-recall/projects.json)

Use at the START of a new session to understand what's been happening in a project.`,
        inputSchema: {
          type: 'object',
          properties: {
            project_path: { type: 'string', description: 'Project path, name substring, or project_id (git:/ws:/git-local:/user:)' },
            limit: { type: 'number', default: 5, description: 'Number of recent sessions to include' },
            tasks: { type: 'number', default: 20, description: 'Max open tasks to list' },
            plans: { type: 'number', default: 20, description: 'Max plans to list' },
          },
          required: ['project_path'],
        },
      },
      {
        name: 'recall_weekly_digest',
        description: `Get a weekly activity digest across all projects.

Returns:
- Session count, total cost, coding time
- Top projects by activity
- Cost trend vs previous week
- Open tasks across projects
- Git activity summary

Use to understand overall productivity and spending.`,
        inputSchema: {
          type: 'object',
          properties: {
            weeks_back: { type: 'number', default: 0, description: '0 = current week, 1 = last week' },
          },
        },
      },
      {
        name: 'recall_team_activity',
        description: `See what each teammate did, grouped by project — the team activity view.

Returns a per-member × per-project rollup (session counts + last activity) for
your team. Scoped to what you're allowed to see: your own work plus teammates'
work on projects they've shared into the team (private projects never appear).

Use for "what has the team been working on", "what did <teammate> do on <project>",
or standup/status. Filter by project, by member, or by recency (since_days).`,
        inputSchema: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Filter to one project_id' },
            member: { type: 'string', description: 'Filter to one teammate (user id / sub)' },
            since_days: { type: 'number', description: 'Only activity in the last N days' },
          },
        },
      },
      {
        name: 'recall_tasks',
        description: `List the task board — and, with detail, the work itself.

Without \`detail\`: one line per card (title, id, assignee). Use for "what's on
the team's plate", "my tasks", or to find a task id to update.

With \`detail: true\`: the full brief per open card — the fix, the file
locations and the agent prompt that the auto-filer already wrote — plus how to
claim a card and how it gets closed. Use that whenever you intend to DO the
work rather than report on it.

Closing is earned: 'done' is refused without a linked session. Rejecting is the
user's call, never yours.`,
        inputSchema: {
          type: 'object',
          properties: {
            mine: { type: 'boolean', description: 'Only tasks assigned to me' },
            project: { type: 'string', description: 'Filter to one project_id' },
            status: { type: 'string', enum: [...TASK_STATUS_FILTER], description: 'Filter by status' },
            detail: {
              type: 'boolean',
              description: 'Return the full brief per task — the fix, the file locations and the agent prompt — plus how to claim and close one. Use this when you intend to DO the tasks, not just list them.',
            },
          },
        },
      },
      {
        name: 'recall_task_create',
        description: `Create a collaborative team task. Optionally assign it to a teammate and
attach it to a project. Returns the new task id.

When you then START working on a task, use recall_task_update to set status
'in_progress' and link your current session (linked_session_id) — that is what
lets the board verify the work actually shipped.`,
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Task title' },
            description: { type: 'string' },
            project: { type: 'string', description: 'project_id this task belongs to' },
            assignee: { type: 'string', description: 'Teammate user id (sub) to assign' },
            due: { type: 'number', description: 'Due date, epoch milliseconds. Set one when the work is time-bound; omit otherwise.' },
            linked_finding_id: { type: 'string', description: 'The code finding this task comes from (ca_…). Setting it lets the card close itself when a re-index stops reporting the finding, and dedupes against an existing card for the same finding.' },
          },
          required: ['title'],
        },
      },
      {
        name: 'recall_task_update',
        description: `Update a team task: change status, reassign, rename, link a session, and/or
add a comment. Pass the task id (t_…) from recall_tasks.

WORKFLOW — do this whenever the user asks you to work on a task from the board:
1. When you start, set status 'in_progress' AND pass your own current session id
   as linked_session_id (the session id you know from your own context; this MCP
   server cannot see it). The board uses that link to show whether the linked
   session actually shipped — files, diff stats, commits.
2. When you finish, set status 'done'.`,
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Task id (t_…)' },
            status: { type: 'string', enum: [...TASK_STATUS_SETTABLE], description: "Set the card's state. There is no 'rejected' here on purpose: rejecting is the user's verdict, not yours." },
            assignee: { type: 'string', description: 'Reassign to this user id (sub)' },
            title: { type: 'string' },
            comment: { type: 'string', description: 'Add a comment' },
            linked_session_id: { type: 'string', description: 'Session id to attach — pass YOUR OWN current session id when you start working on this task, so the board can check whether the work shipped. Null detaches.' },
          },
          required: ['id'],
        },
      },
      {
        name: 'recall_task_comment',
        description: `Leave a progress note on a team task — a comment visible to everyone on the
board. Use it to record what you did, what is blocked, or why a status changed,
without editing the task itself. Pass the task id (t_…) from recall_tasks.`,
        inputSchema: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: 'Task id (t_…) from recall_tasks' },
            body: { type: 'string', description: 'The comment text' },
          },
          required: ['task_id', 'body'],
        },
      },
      // ── Knowledge Graph Tools ──────────────────────────────────
      {
        name: 'recall_kg_query',
        description: `Query the knowledge graph for an entity's relationships.

Returns typed facts with temporal validity. E.g. "example-app" → uses TypeScript, deploys to Kubernetes.
Filter by date with as_of to see what was true at a specific point in time.
Use this to VERIFY facts before asserting them.`,
        inputSchema: {
          type: 'object',
          properties: {
            entity: { type: 'string', description: 'Entity to query (e.g., "Alice", "chat-recall")' },
            as_of: { type: 'string', description: 'Date filter (YYYY-MM-DD, optional)' },
            direction: { type: 'string', enum: ['outgoing', 'incoming', 'both'], default: 'both' },
          },
          required: ['entity'],
        },
      },
      {
        name: 'recall_kg_add',
        description: `Add a fact to the knowledge graph. Subject → predicate → object with optional time window.

E.g. ("example-app", "uses", "Postgres", valid_from="2026-01-15")`,
        inputSchema: {
          type: 'object',
          properties: {
            subject: { type: 'string', description: 'The entity doing/being something' },
            predicate: { type: 'string', description: 'Relationship type (e.g., "uses", "works_on", "prefers")' },
            object: { type: 'string', description: 'The entity being connected to' },
            valid_from: { type: 'string', description: 'When this became true (YYYY-MM-DD, optional)' },
            source_session: { type: 'string', description: 'Session ID where this was learned (optional)' },
          },
          required: ['subject', 'predicate', 'object'],
        },
      },
      {
        name: 'recall_kg_invalidate',
        description: `Mark a fact as no longer true. Use when things change — tools replaced, decisions reversed, people leave.`,
        inputSchema: {
          type: 'object',
          properties: {
            subject: { type: 'string', description: 'Entity' },
            predicate: { type: 'string', description: 'Relationship' },
            object: { type: 'string', description: 'Connected entity' },
            ended: { type: 'string', description: 'When it stopped being true (YYYY-MM-DD, default: today)' },
          },
          required: ['subject', 'predicate', 'object'],
        },
      },
      {
        name: 'recall_kg_timeline',
        description: `Get chronological timeline of facts. Shows the story of an entity (or everything) in order.`,
        inputSchema: {
          type: 'object',
          properties: {
            entity: { type: 'string', description: 'Entity to get timeline for (optional)' },
            limit: { type: 'number', default: 50 },
          },
        },
      },
      {
        name: 'recall_kg_stats',
        description: 'Knowledge graph overview: entities, triples, current vs expired facts, relationship types.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      // ── Diary Tools ────────────────────────────────────────────
      {
        name: 'recall_diary_write',
        description: `Write to your agent diary. Record observations, decisions, what you worked on, what matters.

Each agent gets their own persistent diary across sessions. Use this at the end of sessions
or when you learn something important that should persist.`,
        inputSchema: {
          type: 'object',
          properties: {
            agent_name: { type: 'string', description: 'Your name — each agent gets their own diary' },
            entry: { type: 'string', description: 'What happened, what you learned, what matters' },
            topic: { type: 'string', default: 'general', description: 'Topic tag' },
            session_id: { type: 'string', description: 'Current session ID (for linking)' },
            project_path: { type: 'string', description: 'Project path (for context)' },
          },
          required: ['agent_name', 'entry'],
        },
      },
      {
        name: 'recall_diary_read',
        description: `Read your recent diary entries. See what past versions of yourself recorded across sessions.`,
        inputSchema: {
          type: 'object',
          properties: {
            agent_name: { type: 'string', description: 'Agent name to read diary for' },
            last_n: { type: 'number', default: 10, description: 'Number of recent entries' },
          },
          required: ['agent_name'],
        },
      },
      // ── Code intelligence (codeindex companion) ──
      // Registered ONLY when the codeindex binary is on PATH: recall_code_index
      // runs the analyzer locally, and the other three are its server-side
      // browse companions — without the binary the family is dead surface.
      ...(codeindexAvailable() ? [
        {
          name: 'recall_code_index',
          description: `Index a code repository with codeindex and sync its findings/hotspots/actions to your chat-recall server. Runs the codeindex analyzer LOCALLY (needs the repo files + git history), then ships the result. Use before recall_code_findings/actions if a repo hasn't been indexed yet.`,
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string', description: 'Repo path (default: cwd)' } },
          },
        },
        {
          name: 'recall_code_projects',
          description: `List code-indexed projects on your server with health score, finding count, and label (poc/production/engineering).`,
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'recall_code_findings',
          description: `List code findings (security / hardcoded literals / copy-paste clones / reinvention / dead code / coupling / cycles). Each finding carries a concrete, ready-to-run agent prompt that references codeindex tools. Filter by project/severity/category.`,
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Project id (omit for all)' },
              severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
              category: { type: 'string', description: 'security|literal|clone|duplication|dead_code|coupling|cycle' },
              limit: { type: 'number', default: 50 },
              view: { type: 'string', enum: ['findings', 'summary', 'hotspots', 'file-sessions'], default: 'findings', description: 'findings = the list; summary = counts by severity/category; hotspots = churn-ranked files; file-sessions = which sessions touched `file`' },
              file: { type: 'string', description: 'view=file-sessions only: repo-relative path' },
            },
          },
        },
        {
          name: 'recall_code_actions',
          description: `The ranked, actionable plan for a codebase — prioritised tasks synthesised from the findings, each with a ready agent prompt. This is the "what should I fix next" list. Filter by project/status.`,
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Project id (omit for all)' },
              status: { type: 'string', enum: ['suggested', 'queued', 'done', 'dismissed'] },
              limit: { type: 'number', default: 30 },
            },
          },
        },
      ] : []),
      {
        name: 'recall_recommendations',
        description: `Actionable recommendations, two scopes on one tool:

- scope "account" (default) — from YOUR chat-recall data: leaked secrets found by
  the scanner + session behaviour (unresolved/abandoned). Returns concrete
  CLAUDE.md rules to apply globally.
- scope "project" (requires \`project\`) — behavior × code recommendations for a
  code-indexed project. Concrete changes to apply: add a CLAUDE.md rule, install
  a skill, set a project label, or reset a POC db. Reasons over BOTH the code
  findings and how sessions in this project went (failed/abandoned, recurring
  corrections). Each has rationale + evidence + an apply-action.`,
        inputSchema: {
          type: 'object',
          properties: {
            scope: { type: 'string', enum: ['account', 'project'], default: 'account', description: 'account = your chat-recall data; project = one code-indexed project' },
            project: { type: 'string', description: 'Project id (from recall_code_projects). Required when scope is "project".' },
          },
        },
      },
      // ── Aggregated views over the recommendation engines ──
      // Registered UNGATED, unlike the recall_code_* family: they read findings
      // the SERVER already holds, so a machine without the codeindex binary can
      // still see them. Both degrade to account scope when no project is indexed.
      {
        name: 'recall_claude_suggestions',
        description: `Every finding that turns into an agent-instruction change, in one list — the
"what should I tell Claude about this?" view.

Merges the CLAUDE.md rules and skill installs from BOTH recommendation engines:
account scope (leaked secrets the scanner found + how your sessions actually
went) and every code-indexed project (code findings × session behaviour). Each
item carries the rationale, the evidence behind it, and the exact rule text to
paste.

This is the read side. To apply one, use the apply rail the recommendation
already names (recall_recommendations documents it) — this tool never edits a
CLAUDE.md itself.`,
        inputSchema: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Limit to one code-indexed project id (from recall_code_projects)' },
            include_projects: { type: 'boolean', default: true, description: 'Also fan out over code-indexed projects. false = account scope only.' },
            kind: { type: 'string', enum: [...INSTRUCTION_KINDS], description: 'rule = a CLAUDE.md line; skill = a skill to install. Omit for both.' },
          },
        },
      },
      {
        name: 'recall_improvements',
        description: `Every improvement worth doing, ranked highest-priority first — the "what should
I fix next, across everything" view.

Merges the ranked code actions (recall_code_actions) with the non-instruction
recommendations from account and project scope (focused reviews, project labels,
POC resets). Code actions carry a numeric \`pri\` and recommendations carry a
severity; both are mapped onto one scale so a single ordered list is honest.

Set \`create_tasks: true\` to open one task per improvement on the shared team
board (recall_tasks). It is off by default — this reads unless you ask it to
write.`,
        inputSchema: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Limit to one code-indexed project id' },
            min_severity: { type: 'string', enum: [...SEVERITIES], default: 'low', description: 'Drop anything below this severity' },
            limit: { type: 'number', default: 30, description: 'Maximum improvements to return, after ranking' },
            create_tasks: { type: 'boolean', default: false, description: 'Create one team task per returned improvement' },
            assignee: { type: 'string', description: 'create_tasks only: teammate user id (sub) to assign each task to' },
          },
        },
      },
      // ── User-prompts / decision-record ──
      {
        name: 'recall_user_prompts',
        description: `List the human-typed prompts from a session (or recent sessions). Tool results
and system banners are stripped — you get only what the user actually wrote. Useful for "what was
I asking yesterday?" or "what did I tell the agent in this session?".`,
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'If set, only that session\'s prompts' },
            since_days: { type: 'number', default: 7 },
            limit: { type: 'number', default: 50 },
          },
        },
      },
      {
        name: 'recall_decision_record',
        description: `Record an explicit decision so it shows up in wake-up context. Writes a KG triple
(subject → decided → decision) plus a diary entry. Use this when you and the user agree on
something non-obvious that future sessions should remember.`,
        inputSchema: {
          type: 'object',
          properties: {
            subject: { type: 'string', description: 'What the decision is about' },
            decision: { type: 'string', description: 'The decision itself' },
            reason: { type: 'string', description: 'Why this was decided' },
            importance: { type: 'number', minimum: 1, maximum: 5, default: 4 },
            session_id: { type: 'string' },
            agent_name: { type: 'string', default: 'agent' },
          },
          required: ['subject', 'decision'],
        },
      },
      {
        name: 'recall_analytics_summary',
        description: `Cross-tool spend & activity overview. Returns total sessions, total cost,
weekly delta, top tools/projects/models, and how many sessions had unknown pricing
(Gemini/Ollama/custom). Same data as the web Dashboard, available to the agent so it
can answer "how much have I spent this week" without you opening the UI.

\`view: "patterns"\` returns behavioural patterns across sessions instead of the spend rollup.`,
        inputSchema: {
          type: 'object',
          properties: {
            view: { type: 'string', enum: ['summary', 'patterns'], default: 'summary', description: 'summary = spend/activity rollup; patterns = behavioural patterns across sessions' },
          },
        },
      },
      {
        name: 'recall_wake_up',
        description: `Build startup context for an AI session: identity blurb + the top
classifier-flagged facts (decisions/preferences/milestones at importance >=4) +
current knowledge-graph facts. Replaces a manual context dump. Call this once at
the start of a session to "remember who you are and what's true right now".`,
        inputSchema: {
          type: 'object',
          properties: {
            max_facts: { type: 'number', default: 10 },
            max_kg_facts: { type: 'number', default: 15 },
            identity: { type: 'string' },
            project_filter: { type: 'string', description: 'Scope facts, KG entities and the task count to a project (substring match). Without it, facts are global.' },
            project: { type: 'string', description: 'Alias for project_filter — the name every sibling tool uses.' },
          },
        },
      },
      {
        name: 'recall_set',
        description: `Persist a small key/value pair across sessions. Use this for
state that doesn't fit the diary (narrative) or knowledge graph (entity-relationship facts) —
things like "current PR url", "branch I'm working on", "user's preferred test runner".
Scope namespaces keys so per-project state doesn't collide.`,
        inputSchema: {
          type: 'object',
          properties: {
            key:   { type: 'string', description: 'Key name' },
            value: { type: 'string', description: 'Value to store. JSON-encode if structured.' },
            scope: { type: 'string', default: 'default', description: 'Namespace' },
          },
          required: ['key', 'value'],
        },
      },
      {
        name: 'recall_get',
        description: `Read a key/value pair previously written with recall_set — or, when \`key\` is
omitted, LIST the recorded keys (in one scope, or across all scopes when \`scope\` is
also omitted). Use the list mode to discover what state has been recorded without
remembering specific keys.`,
        inputSchema: {
          type: 'object',
          properties: {
            key:   { type: 'string', description: 'Key name. Omit to list keys instead.' },
            scope: { type: 'string', description: 'Namespace (default "default" when reading; omit to list across all scopes)' },
            limit: { type: 'number', default: 50, description: 'Max entries in list mode' },
          },
        },
      },
      // ── Security / Secret Findings Tools ─────────────────────────
      {
        name: 'recall_security_summary',
        description: `Get a security overview from the synced chat-recall server.

Returns the action-required list of distinct leaked secrets (grouped by redacted
preview), plus per-detector totals and top rules. Use this when the user asks
"do we have any leaked secrets?" or "security findings" or "what should I rotate".

Call this first; then call recall_security_session for specific sessions.`,
        inputSchema: {
          type: 'object',
          properties: {
            include_dismissed: { type: 'boolean', default: false, description: 'Show previously dismissed findings' },
            top_k: { type: 'number', default: 20, description: 'Max distinct secrets to list' },
            group_by: { type: 'string', enum: ['detector', 'rule', 'project', 'trend', 'sessions'], default: 'detector', description: 'detector = action-required view; rule/project = grouped counts; trend = daily counts; sessions = one row per session with findings' },
            days: { type: 'number', default: 30, description: 'group_by=trend only: window in days (1-365)' },
            min_detectors: { type: 'number', description: 'group_by=sessions only: require N detectors agreeing' },
          },
        },
      },
      {
        name: 'recall_security_session',
        description: `Get secret findings for a specific session.

Use after recall_search or recall_security_summary to show exactly which lines
in a session matched which detector.`,
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Session ID from search results' },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'recall_recommendation_apply',
        description: `Apply a recommendation: add its rule to the repo's CLAUDE.md, or set the label it asks for.

Use it when a recommendation from recall_recommendations is right. You do not need
to ask permission for a CLAUDE.md rule — it is additive, visible in the diff, and
the user can delete a line. DO ask first for anything that changes what the AI is
allowed to do destructively.

A CLAUDE.md edit is queued for the machine that has the repo and lands within
about 45 seconds; only that machine has the file. A label applies immediately.
Applying twice is harmless.`,
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Recommendation id from recall_recommendations' },
            project: { type: 'string', description: 'Project id the recommendation belongs to' },
          },
          required: ['id', 'project'],
        },
      },
      {
        name: 'recall_recommendation_dismiss',
        description: `Say no to a recommendation for this project, with a reason.

Use it when advice does not apply to THIS repo — a reuse rule on a repo that is
deliberately duplicated per environment, a label on a scratch project. Dismissed
recommendations stop being offered for that project and no other.

TELL THE USER what you dismissed and why. This changes how future sessions treat
their codebase, and a reason nobody sees is a decision nobody can review. Pass
undo: true to put one back.`,
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Recommendation id from recall_recommendations' },
            project: { type: 'string', description: 'Project id the recommendation belongs to' },
            reason: { type: 'string', description: 'Why it does not apply here. Required.' },
            undo: { type: 'boolean', description: 'Restore a previously dismissed recommendation.' },
          },
          required: ['id', 'project', 'reason'],
        },
      },
      {
        name: 'recall_project_label',
        description: `Label a project POC, production or engineering — the guardrails every future session reads.

This is the highest-leverage single call in the surface: the label tells any
assistant working here whether it may reset a database and move fast (poc),
must protect data and avoid destructive steps (production), or should hold a
higher bar on tests and review (engineering).

ASK THE USER before setting 'production' or clearing a label. Both change what
other agents will consider permitted, and that is not yours to decide alone.`,
        inputSchema: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Project id from recall_code_projects' },
            label: { type: 'string', enum: ['poc', 'production', 'engineering', 'none'], description: 'none clears it' },
          },
          required: ['project', 'label'],
        },
      },
      {
        name: 'recall_security_dismiss',
        description: `Mark a secret finding as rotated, false_positive, or dismissed.

Use when the user confirms a key was rotated or that the match is not a real
secret. The dismissal syncs across devices.`,
        inputSchema: {
          type: 'object',
          properties: {
            preview: { type: 'string', description: 'Masked secret preview from the security dashboard' },
            status: { type: 'string', enum: ['rotated', 'false_positive', 'dismissed', 'undismissed'], description: 'Resolution status, or `undismissed` to put the finding back on the action-required list' },
            reason: { type: 'string', description: 'Optional note' },
          },
          required: ['preview', 'status'],
        },
      },
      {
        name: 'recall_toolkit_status',
        description: `Which MCP servers, skills, commands and agents exist, on which AI tool, on which device.

Use it before recall_toolkit_sync to see what is missing where, and after, to
confirm what landed. Counts are per (type, tool) and rows name the device that
uploaded them, so you can tell "my laptop has it" from "my desktop has it".

NOTE: the server holds an INVENTORY. MCP registrations carry enough to rebuild
elsewhere; skills and agents do not (their file content is not uploaded), and
this tool says which is which.`,
        inputSchema: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: [...TOOLKIT_TYPES], description: 'Restrict to one artifact type. Omit for every type.' },
          },
        },
      },
      {
        name: 'recall_toolkit_sync',
        description: `Install the account's MCP servers / skills / agents onto a device, or fan a device's own artifacts out across its tools.

TWO DIFFERENT OPERATIONS — pick with \`scope\`:

  scope: 'pull'     Install what the ACCOUNT has onto the target device, sourced
                    from the server. This is the cross-device one: it is what
                    sets up a new laptop. Omit \`device\` to target every device.

  scope: 'fan_out'  Copy what ONE device already has between that device's own
                    tools (claude → codex → cursor …). Single machine only; it
                    reads that machine's disk.

Examples:
  everything, everywhere        { }
  every MCP, everywhere         { types: ['mcp'] }
  every MCP on one machine      { types: ['mcp'], device: 'my-laptop' }
  one artifact                  { types: ['mcp'], name: 'acme-mcp' }
  fan a machine's own set out   { scope: 'fan_out', device: 'my-laptop' }

The work is QUEUED, not done inline: the target device performs it on its next
drain (the watch daemon polls, or run \`chat-recall toolkit drain\`). Only that
device can write its own config files, so nothing else could do it. Read the
outcome back with recall_toolkit_status.`,
        inputSchema: {
          type: 'object',
          properties: {
            types: { type: 'array', items: { type: 'string', enum: [...TOOLKIT_TYPES] }, description: 'Artifact types to install. Omit for all.' },
            name: { type: 'string', description: 'Install ONE named artifact. Requires exactly one entry in types.' },
            device: { type: 'string', description: 'Hostname of the target machine. Omit to target every device on the account.' },
            scope: { type: 'string', enum: ['pull', 'fan_out'], default: 'pull', description: "pull = install from the server (cross-device). fan_out = copy between one machine's own tools." },
          },
        },
      },
      {
        name: 'recall_security_rules',
        description: `List tenant custom secret-detection rules, or test a regex in the sandbox.

Tenant rules are configured in the chat-recall dashboard; this tool exposes them
to the agent and lets you test new regexes without persisting them.`,
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'test'], default: 'list', description: 'list = existing rules; test = regex sandbox' },
            name: { type: 'string', description: 'For test: rule name' },
            regex: { type: 'string', description: 'For test: regex to evaluate' },
            sample: { type: 'string', description: 'For test: text to match against' },
          },
        },
      },
      {
        name: 'recall_subagent_search',
        description: `Search inside SUBAGENT transcripts — the explore/compact/aside sub-tasks that run within a session and whose work never appears in the main conversation.

Use when a session's own turns don't contain what you remember: the finding may have come from a subagent. Indexed server-side, so it works across devices.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Text to find inside subagent transcripts' },
            session_id: { type: 'string', description: 'Restrict to one session' },
            kind: { type: 'string', description: 'Restrict to one subagent kind' },
            limit: { type: 'number', default: 20 },
          },
          required: ['query'],
        },
      },
      {
        name: 'recall_redundant_files',
        description: `Before creating a file, check whether you have written one like it before. Scores the filename against every file touched in your synced history.

Answers "have I built this already?" — the reinvention check.`,
        inputSchema: {
          type: 'object',
          properties: {
            filename: { type: 'string', description: 'Filename you are about to create' },
            project: { type: 'string', description: 'Restrict to one project' },
            limit: { type: 'number', default: 20 },
          },
          required: ['filename'],
        },
      },
      {
        name: 'recall_heal_audit',
        description: `Report how many of your sessions are DAMAGED — the rendered conversation is thinner than the shrink-protected raw archive, which happens when an upstream tool truncates a transcript in place (a resume/compaction rewrite, or a script mirroring a shorter file over a longer one).

This is the authoritative "0 remaining" check. Read-only by default; apply=true heals, and healing only ever makes a conversation FULLER.`,
        inputSchema: {
          type: 'object',
          properties: {
            since_hours: { type: 'number', description: 'Bound the scan to the last N hours. Default 168 (7 days). The scan is capped at 500 sessions so it returns within the request timeout; the reply reports what it did not cover.' },
            apply: { type: 'boolean', default: false, description: 'false = audit only; true = heal now' },
          },
        },
      },
      {
        name: 'recall_memory_item',
        description: `Fetch ONE memory item, its full text, or its links — or browse a whole source type.

Complements recall_memory_search: search finds candidates, this reads the specific item. mode=browse lists a type (e.g. every skill, every plan) without a query.`,
        inputSchema: {
          type: 'object',
          properties: {
            source_type: { type: 'string', enum: ['session', 'plan', 'task', 'claude_md', 'paste', 'history', 'diary'] },
            id: { type: 'string', description: 'Item id. Omit with mode=browse.' },
            mode: { type: 'string', enum: ['item', 'content', 'links', 'browse'], default: 'item', description: 'item = metadata, content = full text, links = related items, browse = list the type' },
            limit: { type: 'number', default: 50, description: 'browse mode only' },
          },
          required: ['source_type'],
        },
      },
      {
        name: 'recall_regenerate_summary',
        description: 'Force a fresh AI summary for one session — use when its stored summary is missing, stale, or plainly wrong.',
        inputSchema: {
          type: 'object',
          properties: { session_id: { type: 'string' } },
          required: ['session_id'],
        },
      },
      {
        name: 'recall_outcome_summary',
        description: 'Aggregate session outcomes (shipped / interrupted / abandoned / in_progress) over the last N days — "how much of my work actually landed?".',
        inputSchema: {
          type: 'object',
          properties: { days: { type: 'number', default: 7, description: '1-90' } },
        },
      },
      {
        name: 'recall_shares',
        description: 'Which projects are shared into your team. scope=mine for your own shares, scope=all for every share visible to you. Private by default — nothing is visible to teammates until shared.',
        inputSchema: {
          type: 'object',
          properties: { scope: { type: 'string', enum: ['mine', 'all'], default: 'mine' } },
        },
      },
      {
        name: 'recall_reclassify',
        description: 'Re-run the memory classifier over already-indexed chunks so classifier improvements reach old data. Idempotent — only rewrites tags that actually changed.',
        inputSchema: { type: 'object', properties: {} },
      },
  ];

  // Tools that read the CALLER'S OWN DISK, dropped when this process serves many
  // callers over /mcp. There, "the filesystem" is the server's, which holds
  // nobody's transcripts — so listing these would advertise a capability that
  // cannot work, and whose failure would look like success. The dispatch still
  // answers them by name with an explanation (runIndexChild's default), so a
  // client working from a cached list gets a sentence rather than a 404.
  const localOnly = new Set(['recall_index', 'recall_code_index']);
  const visible = isMultiTenant() ? all.filter((t) => !localOnly.has(t.name)) : all;

  if (toolProfile() === 'full') return { tools: visible.map(annotate) };

  // Lean: the everyday set, plus a signpost so neither the user nor the agent
  // has to guess that more exists. Without this line the omission looks like a
  // missing feature rather than a choice.
  const lean = visible.filter((t) => LEAN_TOOLS.has(t.name));
  const hidden = visible.length - lean.length;
  if (hidden > 0) {
    lean.push({
      name: 'recall_help',
      // The env-var advice only applies to a LOCAL server the user launches.
      // Over the remote endpoint the process is ours, so telling a connector
      // user to set CHAT_RECALL_MCP_PROFILE names a knob they cannot reach —
      // and the useful half of the sentence (they still work by name) got lost
      // behind it.
      description:
        `List the ${hidden} additional chat-recall tools that are not registered in this `
        + 'profile (analytics, knowledge-graph navigation, code intelligence, sharing, '
        + 'security triage, maintenance). Every one of them still WORKS if you call it by '
        + 'name — this profile shortens the LIST, not the surface, because tool choice '
        + 'degrades as the list grows.'
        + (isMultiTenant() ? '' : ' Set CHAT_RECALL_MCP_PROFILE=full to register them all up front.'),
      inputSchema: { type: 'object', properties: {} },
    });
  }
  return { tools: lean.map(annotate) };
});

/**
 * Entitlement state, for the staleness warning below. Cached per process.
 *
 * A lapsed tenant keeps READ access — searches still answer, and they answer from
 * a history that stopped growing the day the subscription ended. An agent has no
 * way to know that, so it reports "you never worked on that" about work done last
 * week. Silently wrong is the worst failure a memory product can have, and it is
 * the same defect as a paginated transcript claiming to be a whole session.
 *
 * One request per TTL, only when logged in, and every failure resolves to "no
 * warning" — an unreachable billing endpoint must never decorate every answer
 * with a scare it cannot substantiate.
 */
let syncStateCache: { at: number; state: SyncState | null } | null = null;
const SYNC_STATE_TTL_MS = 5 * 60 * 1000;

/**
 * The tenant's entitlement, cached per process. One request per TTL, only when
 * logged in, and every failure resolves to null so the banner stays silent
 * rather than guessing.
 */
async function syncState(): Promise<SyncState | null> {
  if (syncStateCache && Date.now() - syncStateCache.at < SYNC_STATE_TTL_MS) return syncStateCache.state;
  let state: SyncState | null = null;
  try {
    const cred = remoteCredentials();
    if (cred) {
      const res = await fetch(cred.base + '/api/billing', {
        headers: { authorization: `Bearer ${cred.token}` },
      });
      if (res.ok) {
        const b = await res.json() as Record<string, unknown>;
        if (typeof b.entitled === 'boolean') {
          state = {
            entitled: b.entitled,
            status: typeof b.status === 'string' ? b.status : 'unknown',
            periodEnd: typeof b.currentPeriodEnd === 'number' ? b.currentPeriodEnd : null,
            // Both server-computed, for the same reason `entitled` is: the days
            // left and "is this OUR no-card trial" are decisions the server
            // already makes (isNoCardTrial / trialDaysLeft), and a second copy
            // here would drift the moment either rule changes.
            onTrial: b.onTrial === true,
            trialDaysLeft: typeof b.trialDaysLeft === 'number' ? b.trialDaysLeft : null,
          };
        }
      }
    }
  } catch { /* leave null — no warning rather than a wrong one */ }
  syncStateCache = { at: Date.now(), state };
  return state;
}

/**
 * The trial countdown, at most ONCE per MCP process.
 *
 * Unlike the staleness banner, this fires while everything still works, so
 * repeating it on every tool call would attach a sales notice to fifty
 * consecutive answers and train the agent to ignore the banner slot — which is
 * the slot the genuine "your account is off" warning also uses.
 *
 * One process is one session under stdio, and the remote endpoint builds a fresh
 * server per request, so this reads as once-per-conversation on the host where
 * it matters. That is the right cadence for a deadline the user can act on at
 * any point in the next three days.
 */
let trialNoticeShown = false;
function trialCountdownOnce(state: SyncState | null): string | null {
  if (trialNoticeShown) return null;
  const cred = remoteCredentials();
  if (!cred) return null;
  const banner = trialEndingBanner(state, cred.base);
  if (banner) trialNoticeShown = true;
  return banner;
}

// Handle tool calls.
//
// The wrapper exists so the staleness warning has ONE insertion point instead of
// 133. Every successful read passes through here, and a write cannot: a write
// against a lapsed tenant is refused with a 402 upstream and never reaches this
// return path — so decorating everything that succeeds is exactly right.
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const result = await dispatchTool(request);
  try {
    // Two independent warnings share this one insertion point.
    //
    // The entitlement banner says "your plan limits what you can see". The
    // health banner says "your collector stopped shipping" — a different and
    // more urgent failure, and the one that went unreported for eight days
    // while the daemon aborted 4,851 times. An agent that knows the history is
    // stale can tell the user; an agent that does not will answer confidently
    // from data that stopped growing.
    const reported = readCollectorHealth();
    const health = judgeHealth(reported);
    // A walk in flight is NOT a fault, so it is its own line rather than a
    // warning. It answers the question a stale-looking answer raises during a
    // first sync — "is this broken, or is it still loading?" — which the product
    // previously could not answer at all.
    const progress = progressLine(reported);
    const state = await syncState();
    const banners = [
      health.ok ? null : `⚠ ${health.summary} Recent work may be missing from these answers.`
        + ` Tell the user, and suggest \`chat-recall doctor\`.`,
      progress ? `⏳ ${progress}. Older work may not be searchable yet.` : null,
      stalenessBanner(state),
      trialCountdownOnce(state),
    ].filter(Boolean) as string[];
    if (banners.length === 0) return result;
    const banner = banners.join('\n\n');
    const content = result.content;
    if (!Array.isArray(content) || !content.length) return result;
    // Prepended, not appended: an agent that truncates a long result must still
    // see it, and it changes how the whole answer should be read.
    return { ...result, content: [{ type: 'text', text: banner }, ...content] };
  } catch {
    return result;   // never let the warning break a working answer
  }
});
}   // end attachHandlers

/** What every tool handler returns. The index signature keeps it assignable to
 *  the SDK's own result union, which allows extra fields. */
interface ToolResult {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

async function dispatchTool(request: { params: { name: string; arguments?: unknown } }): Promise<ToolResult> {
  const { name, arguments: args } = request.params;

  try {
    // The codeindex family is only REGISTERED when the codeindex binary is on
    // PATH (see the tools list). Guard the handlers too, so a client that
    // cached an older tool list gets a clear message instead of a half-working
    // call that fails later at collect time.
    if (/^recall_code_(index|projects|findings|actions)$/.test(name) && !codeindexAvailable()) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name} — the codeindex companion binary is not installed. Install it (\`chat-recall init --with-codeindex\`) and restart the MCP server.` }] };
    }

    switch (name) {
      case 'recall_search': {
        const params = RecallSearchSchema.parse(args);

        // Thin collector: search always runs against the synced chat-recall
        // server (cross-device / team history). The `scope` param is accepted
        // for back-compat but ignored — there is no local index to query.
        requireRemote();

        // Outcome one-liner (opt-in via include_outcome) — same endpoint and
        // shape recall_summary consumes, rendered as a single triage line.
        type OutcomeLite = { status: string; reason: string; fileCount: number; totalLinesAdded: number; totalLinesRemoved: number };
        const outcomeEmoji = (s: string) =>
          s === 'shipped' ? '🚢' : s === 'interrupted' ? '⏸' : s === 'abandoned' ? '🪦' : s === 'in_progress' ? '🟡' : '❔';
        const outcomeLine = async (sessionId: string): Promise<string | null> => {
          try {
            const soft = await remoteGetSoft<OutcomeLite>(`/api/conversations/${encodeURIComponent(sessionId)}/outcome`);
            if (!soft.data) return null;
            const o = soft.data;
            return `**Outcome:** ${outcomeEmoji(o.status)} ${o.status} — ${o.reason} · ${o.fileCount} file(s) +${o.totalLinesAdded}/−${o.totalLinesRemoved}`;
          } catch { return null; } // best-effort: skip when not synced yet
        };

        // like_session mode: find sessions similar to an existing session —
        // derive the search text from its synced metadata, exclude itself,
        // and group hits by project.
        if (params.like_session) {
          const meta = await remoteGetSoft<{ contentPreview?: string; slug?: string }>(
            `/api/conversations/${encodeURIComponent(params.like_session)}/metadata`);
          if (!meta.data) {
            return { content: [{ type: 'text', text: meta.message || (meta.status === 404 ? `Session not found: ${params.like_session}` : `Session ${params.like_session} not synced yet.`) }] };
          }
          const searchText = meta.data.contentPreview || meta.data.slug || '';
          if (!searchText.trim()) {
            return { content: [{ type: 'text', text: `No search text could be derived from session ${params.like_session} — it has no synced prompt content. Pass a \`query\` instead.` }] };
          }
          const cleaned = sanitizeQuery(searchText).cleanQuery;
          type SearchResp = {
            results: Array<{ sessionId: string; score: number; projectPath: string; modified: string; title?: string; firstPrompt?: string; text?: string; matchedChunks?: Array<{ text: string }> }>;
          };
          const search = await remotePost<SearchResp>('/api/search', {
            query: cleaned,
            topK: params.top_k * 4,
            projectFilter: params.project_filter,
          });
          const filtered = (search.results || []).filter(r => r.sessionId !== params.like_session);
          const trimmed = filtered.slice(0, params.top_k);
          if (trimmed.length === 0) {
            return { content: [{ type: 'text', text: `No similar sessions found for "${cleaned.slice(0, 80)}".` }] };
          }

          // Group by project so the "5 projects, 3 of them did this" frame surfaces.
          const byProject = new Map<string, number>();
          for (const r of filtered) {
            const p = r.projectPath || '(unknown)';
            byProject.set(p, (byProject.get(p) || 0) + 1);
          }

          const lines = [
            `# Similar past work (${trimmed.length} session${trimmed.length === 1 ? '' : 's'} returned, ${filtered.length} total matches across ${byProject.size} project${byProject.size === 1 ? '' : 's'})`,
            '',
            '_Keyword (FTS) match against the synced server index._',
            '',
          ];
          for (const r of trimmed) {
            const date = (r.modified || '').slice(0, 10) || '?';
            const proj = (r.projectPath || '').split('/').slice(-2).join('/') || '(unknown)';
            const snippet = (r.matchedChunks?.[0]?.text || r.text || r.firstPrompt || r.title || '').replace(/\s+/g, ' ').trim().slice(0, 160);
            lines.push(`- **${r.sessionId.slice(0, 8)}** · ${proj} · ${date} · score ${r.score.toFixed(3)}`);
            if (snippet) lines.push(`  ${snippet}…`);
            if (params.include_outcome) {
              const ol = await outcomeLine(r.sessionId);
              if (ol) lines.push(`  ${ol}`);
            }
          }

          if (byProject.size > 1) {
            lines.push('', '## Project distribution');
            const sortedProjects = [...byProject.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
            for (const [proj, n] of sortedProjects) {
              const short = proj.split('/').slice(-2).join('/') || proj;
              lines.push(`- ${short} — ${n} session${n === 1 ? '' : 's'}`);
            }
          }
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        if (!params.query?.trim()) {
          return { content: [{ type: 'text', text: 'Provide `query` (free-text search) or `like_session` (find sessions similar to a session id).' }] };
        }

        // Sanitize query to prevent prompt injection
        const sanitized = sanitizeQuery(params.query);
        const searchQuery = sanitized.cleanQuery;

        const remote = await remotePost<{ results: Array<{ sessionId: string; score: number; projectPath: string; firstPrompt: string; summary?: string; matchedChunks?: Array<{ chunkType: string; text: string }> }>; count: number }>(
          '/api/search', { query: searchQuery, topK: params.top_k, projectFilter: params.project_filter },
        );
        if (!remote.results?.length) {
          // Two very different states share this branch, and conflating them is
          // how a brand-new account reads as a broken product: a query that
          // matched nothing, versus an account with nothing to match against.
          // Ask the server which one it is — /api/status is cheap and already
          // tenant-scoped — and only send someone to install a CLI in the
          // second case.
          let indexed = 1;
          try {
            const st = await remoteGet<{ totalChunks: number }>('/api/status');
            indexed = st.totalChunks ?? 1;
          } catch { /* unreachable status: assume there IS data and stay quiet */ }
          const text = indexed === 0
            ? emptyIndexHint()
            : `No matching sessions on the server for "${params.query}".`;
          return { content: [{ type: 'text', text }] };
        }
        const lines = [`# Server results for: "${params.query}"`, '_(synced history across your devices)_', ''];
        for (let i = 0; i < remote.results.length; i++) {
          const r = remote.results[i];
          const title = (r.firstPrompt || '(no prompt)').replace(/\n/g, ' ').slice(0, 100);
          lines.push(`## #${i + 1}: ${title}`);
          lines.push(`**Project:** ${r.projectPath || '(hashed)'}  ·  **Session:** \`${r.sessionId}\``);
          if (r.summary) lines.push(`**Summary:** ${r.summary.slice(0, 300)}`);
          const snippet = r.matchedChunks?.[0]?.text?.replace(/\n/g, ' ').slice(0, 240);
          if (snippet) lines.push(`> ${snippet}`);
          if (params.include_outcome) {
            const ol = await outcomeLine(r.sessionId);
            if (ol) lines.push(ol);
            { const rc = resumeCommandFor(r.sessionId); if (rc) lines.push(`**Resume:** \`${rc}\``); }
          }
          lines.push('');
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }
      
      case 'recall_index': {
        // Explicit, though runIndexChild's default already answers honestly when
        // no host supplied an indexer. Two reviewers read the unset-hook version
        // as "the server spawns a child process" — it never could — and a
        // security property nobody can see by reading the case arm is one that
        // gets removed by accident later.
        if (isMultiTenant()) {
          return { content: [{ type: 'text', text: localOnlyRefusal('recall_index') }] };
        }
        const params = RecallIndexSchema.parse(args);
        getWAL().log('index', { force: params.force });
        requireRemote();
        // Run the collect-and-ship in a CHILD process, NOT the MCP event loop.
        // A full walk over a large history (30k+ sessions: transcript parse +
        // base64 + KG) is memory-heavy; doing it in-process OOMs and kills the
        // MCP — dropping every tool mid-session (-32000). The child has its own
        // heap: if it dies, the tool server survives and reports the failure.
        const text = await runIndexChild(params.force);
        return { content: [{ type: 'text', text }] };
      }
      
      case 'recall_status': {
        requireRemote();
        // Three cheap server reads: /api/status (chunks + per-project session
        // counts), /api/status/sync (the trust-panel coverage: synced
        // sessions, raw archives, freshness), and /api/memory/status (the
        // memory-system breakdown formerly served by recall_memory_status:
        // items/chunks per source type, per tool, link count). Local
        // index-path / vector fields don't exist server-side and are dropped.
        const status = await remoteGet<{ totalChunks: number; totalSessions: number; projects: Record<string, number> }>('/api/status');
        const sync = await remoteGet<{ sessions: number; sourceTypes: Record<string, number>; rawArchived: number; newestSessionAgeMs: number | null }>('/api/status/sync');

        const lines = [
          'Chat-Recall Server Status',
          `Synced sessions: ${sync.sessions}`,
          `Indexed chunks: ${status.totalChunks}`,
          `Raw archives: ${sync.rawArchived}`,
        ];
        // "You are running an old CLI" had exactly one channel: a stderr line on
        // CLI invocations. But `init` no longer installs the watch daemon, so a
        // normal user runs the MCP server and nothing else — never sees that
        // line, never self-updates (the updater lives in the daemon), and
        // silently keeps a months-old collector. Say it where they actually are.
        {
          // Host-supplied: only a local CLI install HAS a version that can be
          // out of date. A remote connection is served by whatever the server
          // runs, so there is nothing for the caller to update and the hook is
          // deliberately left unset there.
          const notice = updateNotice();
          if (notice) lines.push('', `⚠ ${notice}`);
        }
        if (sync.newestSessionAgeMs !== null) {
          const mins = Math.round(sync.newestSessionAgeMs / 60000);
          lines.push(`Freshness: newest synced session ${mins} min ago`);
        }

        // Memory-system breakdown (absorbed from recall_memory_status).
        // Best-effort: an older server without /api/memory/status still gets
        // the basic status block plus the sync sourceTypes fallback.
        type MemoryStatus = {
          totalChunks: number; totalItems: number; linkCount: number;
          bySourceType: Record<string, { items: number; chunks: number }>;
          bySourceAndTool: Record<string, Record<string, number>>;
        };
        let memory: MemoryStatus | null = null;
        try { memory = await remoteGet<MemoryStatus>('/api/memory/status'); } catch { /* older server */ }

        if (memory) {
          lines.push(`Memory items: ${memory.totalItems} · links: ${memory.linkCount}`);
          const bySource = Object.entries(memory.bySourceType || {});
          if (bySource.length > 0) {
            lines.push('\nBy source type:');
            for (const [type, data] of bySource) {
              lines.push(`  ${type}: ${data.items} items, ${data.chunks} chunks`);
            }
          }
          const byTool = Object.entries(memory.bySourceAndTool || {});
          if (byTool.length > 0) {
            lines.push('\nBy source type and tool:');
            for (const [type, tools] of byTool) {
              const parts = Object.entries(tools).map(([t, n]) => `${t}: ${n}`).join(', ');
              lines.push(`  ${type}: ${parts}`);
            }
          }
        } else {
          const types = Object.entries(sync.sourceTypes).filter(([, n]) => Number(n) > 0);
          if (types.length > 0) {
            lines.push('\nBy source type:');
            for (const [type, n] of types) {
              lines.push(`  ${type}: ${n} items`);
            }
          }
        }

        const projects = Object.entries(status.projects || {}).sort((a, b) => b[1] - a[1]).slice(0, 10);
        if (projects.length > 0) {
          lines.push('\nTop projects:');
          for (const [proj, n] of projects) {
            lines.push(`  ${proj}: ${n} sessions`);
          }
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }
      
      case 'recall_show': {
        const params = RecallShowSchema.parse(args);

        // Server holds the full message list (rebuilt from synced chunks in
        // server mode, parsed transcript in local mode). limit=0 = whole
        // session; the server's `content` field is already display text.
        // `toolCalls` carries the agent's executed tool inputs (Bash command,
        // Edit/Write/Read file_path, …) — render them so tool-only turns are
        // not shown as blank. They are stored in the synced envelope and
        // returned by /api/conversations/:id.
        const soft = await remoteGetSoft<{ sessionId: string; messages: Array<{ line: number; role: string; content: string; toolCalls?: Array<{ name: string; input?: Record<string, unknown> }> }>; total: number }>(
          `/api/conversations/${encodeURIComponent(params.session_id)}`, { limit: 0 });
        if (!soft.data || soft.data.messages.length === 0) {
          // Not a known session — try it as a PLAN id (absorbed from
          // recall_plan_show). The content endpoint serves the plan from its
          // stored FTS chunks when there's no local file (the synced case).
          if (soft.status === 404 || !soft.data) {
            const plan = await remoteGetSoft<{ content: string }>(
              `/api/memory/item/plan/${encodeURIComponent(params.session_id)}/content`);
            if (plan.data) {
              return { content: [{ type: 'text', text: `# Plan: ${params.session_id}\n\n${plan.data.content}` }] };
            }
          }
          return { content: [{ type: 'text', text: soft.message || `Session (or plan) not found: ${params.session_id}` }] };
        }
        const messagesList = soft.data.messages;

        // Filter messages
        let displayMessages = messagesList;

        if (params.from_end !== undefined) {
          // Last N messages — no line-number guessing required.
          const n = Math.max(1, Math.min(params.from_end, messagesList.length));
          displayMessages = messagesList.slice(-n);
        } else if (params.around_line) {
          const window = Math.floor(params.max_messages / 2);
          const filtered = messagesList.filter(msg => Math.abs(msg.line - params.around_line!) <= window * 10);
          if (filtered.length > 0) {
            displayMessages = filtered.slice(0, params.max_messages);
          } else {
            displayMessages = messagesList.filter(msg => msg.line <= params.around_line! + 50).slice(-params.max_messages);
          }
        } else {
          displayMessages = messagesList.slice(0, params.max_messages);
        }

        // Format output. Per-message truncation grows when code blocks are
        // requested — diffs/SQL routinely overshoot 1500 chars.
        const truncAt = params.include_code ? 8000 : 1500;
        const output = [`Session: ${params.session_id}`];
        const lastMsg = messagesList[messagesList.length - 1];
        output.push(`Total messages: ${messagesList.length} (max line: ${lastMsg ? lastMsg.line : 0})`);
        if (params.from_end !== undefined) {
          output.push(`Showing last ${displayMessages.length} message(s).`);
        } else if (params.around_line) {
          output.push(`Showing ${displayMessages.length} around line ${params.around_line}.`);
        }
        output.push('');

        // Render a single tool_use as the exact command/file it acted on, so
        // "what did the agent run?" is answerable from recall_show instead of
        // showing the turn as blank. Bash → the command; file tools → the path.
        const fmtToolCall = (tc: { name: string; input?: Record<string, unknown> }): string => {
          const inp = tc.input || {};
          const oneLine = (v: unknown) => String(v).replace(/\s*\n\s*/g, ' ⏎ ');
          if (tc.name === 'Bash' && inp.command !== undefined) {
            const desc = inp.description ? `  # ${oneLine(inp.description)}` : '';
            let cmd = oneLine(inp.command);
            if (cmd.length > truncAt) cmd = cmd.slice(0, truncAt) + '...';
            return `[Bash]${desc}\n  $ ${cmd}`;
          }
          if (inp.file_path !== undefined) return `[${tc.name}] ${inp.file_path}`;
          let argStr = oneLine(JSON.stringify(inp));
          if (argStr.length > 300) argStr = argStr.slice(0, 300) + '...';
          return `[${tc.name}] ${argStr}`;
        };

        for (const msg of displayMessages) {
          output.push(`**${msg.role}** (line ${msg.line})`);
          let text = msg.content;
          if (text.length > truncAt) {
            text = text.slice(0, truncAt) + '...';
          }
          if (text.trim()) output.push(text);
          // Show the actual tool inputs the agent executed in this turn.
          for (const tc of (msg.toolCalls || [])) {
            output.push(fmtToolCall(tc));
          }
          if (!text.trim() && !(msg.toolCalls || []).length) output.push('_(empty)_');
          output.push('');
        }

        { const rc = resumeCommandFor(params.session_id); if (rc) output.push(`Resume: ${rc}`); }

        return { content: [{ type: 'text', text: output.join('\n') }] };
      }

      case 'recall_recent': {
        const params = RecallRecentSchema.parse(args);

        // Thin collector: recent sessions always come from the synced server.
        // The `scope` param is accepted for back-compat but ignored.
        requireRemote();
        const qs = new URLSearchParams({ limit: String(params.limit) });
        if (params.since_hours) qs.set('since_hours', String(params.since_hours));
        if (params.project_filter) qs.set('project', params.project_filter);
        const remote = await remoteGet<{ sessions: Array<{ sessionId: string; projectPath: string; modified: string; firstPrompt: string; summary?: string; tool?: string; userTitle?: string | null; toolTitle?: string | null }>; total: number }>(
          `/api/conversations/recent?${qs.toString()}`,
        );
        if (!remote.sessions?.length) {
          // Distinguish "filter matched nothing" from "no data at all" — the old
          // single message claimed the server was empty even when a too-narrow
          // project_filter was the real cause (1000+ sessions synced, 0 matched).
          const empty = (params.project_filter || params.since_hours)
            ? `No sessions match${params.project_filter ? ` project filter "${params.project_filter}"` : ''}${params.since_hours ? ` in the last ${params.since_hours}h` : ''}. The project filter is a case-insensitive substring of the project path — try a broader term, or drop it.`
            : emptyIndexHint();
          return { content: [{ type: 'text', text: empty }] };
        }
        const lines = [`# Recent sessions (server — ${remote.total} total synced)\n`];
        for (let i = 0; i < remote.sessions.length; i++) {
          const s = remote.sessions[i];
          const named = s.userTitle?.trim();
          const display = (named || s.toolTitle?.trim() || s.summary || s.firstPrompt || '(no prompt)').replace(/\n/g, ' ').slice(0, 120);
          lines.push(`## #${i + 1}: ${named ? `🏷️ ${display}` : display}`);
          lines.push(`**Tool:** ${s.tool || 'claude'}  ·  **Project:** ${s.projectPath || '(hashed)'}  ·  **Modified:** ${(s.modified || '').slice(0, 16).replace('T', ' ')}`);
          lines.push(`**Session ID:** \`${s.sessionId}\``);
          lines.push('');
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'recall_forget': {
        const params = RecallForgetSchema.parse(args);
        getWAL().log('forget', { session_id: params.session_id });
        requireRemote();
        const r = await remoteDelete<{ deleted: string; tombstoned: boolean }>(
          `/api/conversations/${encodeURIComponent(params.session_id)}`);
        return {
          content: [{
            type: 'text',
            text: `✓ Deleted session \`${r.deleted || params.session_id}\` from the server`
              + `${r.tombstoned ? ' and tombstoned it, so no later sync can bring it back' : ''}.\n`
              + 'The transcript on this machine is untouched — this only removed the copy chat-recall held.',
          }],
        };
      }

      case 'recall_exclude_path': {
        const params = RecallExcludePathSchema.parse(args);
        getWAL().log('exclude_path', { path: params.path });

        // BOTH sides, because they do different jobs. The local rule takes
        // effect on this machine's very next sync even if the server is
        // unreachable; the account rule is what makes the user's OTHER devices
        // honour it too. The sync client unions them, so writing both cannot
        // conflict — it can only make the exclusion apply sooner and wider.
        const written: string[] = [];
        if (!isMultiTenant()) {
          const { loadSettings, saveSettings } = await import('../core/settings.js');
          const settings = loadSettings();
          const abs = resolve(params.path.replace(/^~(?=\/|$)/, homedir()));
          if (!settings.sync.excludeProjects.includes(abs)) {
            settings.sync.excludeProjects.push(abs);
            saveSettings(settings);
          }
          written.push('this machine');
        }

        // The account-wide rule REPLACES the stored list, so read it, merge, and
        // write it back — posting only the new path would drop every rule the
        // user already had.
        try {
          const current = await remoteGet<{ excludeTools: string[]; excludeProjects: string[]; excludeSources: string[]; approveSources: string[] }>('/api/sync-config');
          if (!current.excludeProjects.includes(params.path)) {
            await remotePost('/api/sync-config', {
              ...current,
              excludeProjects: [...current.excludeProjects, params.path],
            });
          }
          written.push('your account (every device)');
        } catch (err) {
          // A local rule that landed is still worth reporting, and hiding the
          // server failure would leave the user believing their other machines
          // are covered when they are not.
          if (!written.length) throw err;
          return {
            content: [{
              type: 'text',
              text: `✓ Stopped syncing \`${params.path}\` from this machine.\n`
                + `⚠ Could not write the rule to your account (${err instanceof Error ? err.message : 'request failed'}), `
                + 'so your other devices are NOT covered yet. Retry, or add it in the dashboard.',
            }],
          };
        }

        return {
          content: [{
            type: 'text',
            text: `✓ Stopped syncing \`${params.path}\` — rule written to ${written.join(' and ')}.\n`
              + 'Sessions already uploaded from that path stay until they are deleted; '
              + 'use recall_forget for the ones that matter.',
          }],
        };
      }

      case 'recall_rename_session': {
        const params = RecallRenameSchema.parse(args);
        requireRemote();
        const r = await remotePatch<{ sessionId: string; userTitle: string | null }>(
          `/api/conversations/${encodeURIComponent(params.session_id)}`,
          { name: params.name });
        const text = r.userTitle
          ? `✓ Named session \`${params.session_id}\` → "${r.userTitle}"`
          : `✓ Cleared the name on session \`${params.session_id}\` (reverted to the auto title).`;
        return { content: [{ type: 'text', text }] };
      }

      case 'recall_context': {
        const params = RecallContextSchema.parse(args);

        // Server-backed: the message list + session metadata are enough to
        // rebuild the ConversationContext dump. Live-FS-only bits
        // (liveScanModifiedFiles) don't exist server-side — filesModified
        // comes from the metadata telemetry instead.
        const convo = await remoteGetSoft<{ sessionId: string; messages: Array<{ line: number; role: string; content: string }>; total: number }>(
          `/api/conversations/${encodeURIComponent(params.session_id)}`, { limit: 0 });
        if (!convo.data || convo.data.messages.length === 0) {
          return { content: [{ type: 'text', text: convo.message || `Session not found: ${params.session_id}` }] };
        }

        interface SessionMeta {
          tool: string; slug: string; durationMs: number; messageCount: number;
          filesModified: string[]; modelsUsed: string[]; toolsUsed: string[];
          inputTokens: number; outputTokens: number; cacheReadTokens: number; peakContextTokens: number;
          contentPreview: string;
        }
        let meta: SessionMeta | null = null;
        try {
          const m = await remoteGetSoft<SessionMeta>(`/api/conversations/${encodeURIComponent(params.session_id)}/metadata`);
          meta = m.data;
        } catch { /* metadata optional */ }

        // Decisions come from the synced structured outcome (not a live scan).
        let decisions: string[] = [];
        try {
          const o = await remoteGetSoft<{ decisions?: Array<{ text: string }> }>(`/api/conversations/${encodeURIComponent(params.session_id)}/outcome`);
          if (o.data?.decisions) decisions = o.data.decisions.map(d => d.text);
        } catch { /* outcome optional */ }

        const userInputs: string[] = [];
        const assistantWork: string[] = [];
        for (const msg of convo.data.messages) {
          const clipped = msg.content.length > 240 ? msg.content.slice(0, 240) + '…' : msg.content;
          if (msg.role === 'user') {
            userInputs.push(clipped.replace(/\n/g, ' '));
          } else {
            assistantWork.push(clipped.replace(/\n/g, ' '));
          }
        }

        let formatted = formatContext({
          sessionId: params.session_id,
          projectPath: '',
          created: '',
          modified: '',
          userInputs: userInputs.slice(0, 50),
          claudeWork: assistantWork.slice(0, 20),
          decisions,
          toolsUsed: meta?.toolsUsed ?? [],
          filesChanged: meta?.filesModified ?? [],
        });

        // Append token/cost metadata from the server's session telemetry.
        // Tools without per-session token counters (Gemini/OpenCode/Codex
        // report inputTokens=0) still get the section — with duration/
        // messages/files and an explicit "not reported" line instead of the
        // old silent omission, which read as "this data doesn't exist".
        if (meta) {
          const lines: string[] = ['## Context Budget'];
          if (meta.slug) lines.push(`Session: ${meta.slug}`);
          if (meta.durationMs > 0) {
            const mins = Math.round(meta.durationMs / 60000);
            lines.push(`Duration: ~${mins} min | ${meta.messageCount} messages`);
          }
          if (meta.inputTokens > 0) {
            lines.push(`Input: ${(meta.inputTokens / 1_000_000).toFixed(1)}M tokens | Output: ${(meta.outputTokens / 1000).toFixed(1)}k tokens`);
            lines.push(`Cache reads: ${(meta.cacheReadTokens / 1_000_000).toFixed(1)}M | Peak context: ${(meta.peakContextTokens / 1000).toFixed(0)}k`);
          } else {
            lines.push('Tokens/cost: not reported by this tool (Gemini/OpenCode/Codex transcripts carry no per-session token counters)');
          }
          if (meta.filesModified.length > 0) {
            lines.push(`Files modified: ${meta.filesModified.length}`);
          }
          if (meta.modelsUsed.length > 0) {
            lines.push(`Models: ${meta.modelsUsed.filter(x => x !== '<synthetic>').join(', ')}`);
          }
          // A bare header helps nobody — only append if something got added.
          if (lines.length > 1) formatted += '\n\n' + lines.join('\n');
        }

        // Optional: append an in-order message dump (server doesn't expose the
        // tool_use/tool_result granularity, so this is a user/assistant view).
        if (params.include_turns) {
          const lines: string[] = ['', '## Turn-by-turn'];
          for (const msg of convo.data.messages.slice(0, params.turns_limit)) {
            const role = msg.role === 'user' ? 'user' : 'assistant';
            const trimmed = msg.content.length > 400 ? msg.content.slice(0, 400) + '…' : msg.content;
            lines.push(`- **${role}** — ${trimmed.replace(/\n/g, ' ')}`);
          }
          formatted += '\n' + lines.join('\n');
        }

        return { content: [{ type: 'text', text: formatted }] };
      }

      case 'recall_summary': {
        const params = RecallSummarySchema.parse(args);

        // Server-backed: the structured outcome (status, decisions, blockers,
        // claim/reaction, prompt markers) plus the free-form AI summary, both
        // synced and served from the store. The AI narrative comes from the
        // metadata endpoint (`summary`, populated when the session's machine
        // shipped a generated summary); the structured part from /outcome.
        const aiSummary = await remoteGetSoft<{ summary?: string }>(`/api/conversations/${encodeURIComponent(params.session_id)}/metadata`)
          .then(r => r.data?.summary?.trim() || '')
          .catch(() => '');
        type Outcome = {
          found?: boolean; status: string; reason: string;
          startMs?: number; endMs?: number;
          fileCount: number; totalLinesAdded: number; totalLinesRemoved: number;
          commits: { totalCommits: number; repos: Array<{ repoName: string; commits: unknown[] }> };
          decisions: Array<{ text: string }>;
          blockers: Array<{ kind: string; text: string }>;
          claimReaction: { claim?: { text: string }; reaction?: { text: string; markers: string[] } };
          promptMarkers: { total: number; frustrated?: number; correction?: number; interrupt?: number; approval?: number; directive?: number; question?: number };
        };
        const soft = await remoteGetSoft<Outcome>(`/api/conversations/${encodeURIComponent(params.session_id)}/outcome`);
        if (!soft.data) {
          return { content: [{ type: 'text', text: soft.message || (soft.status === 404 ? `Session not found: ${params.session_id}` : `Summary not synced yet for ${params.session_id}.`) }] };
        }
        const outcome = soft.data;

        const statusEmoji =
          outcome.status === 'shipped' ? '🚢' :
          outcome.status === 'interrupted' ? '⏸' :
          outcome.status === 'abandoned' ? '🪦' :
          outcome.status === 'in_progress' ? '🟡' : '❔';

        // Legacy short mode: the AI summary if we have one, else the headline.
        if (!params.rich) {
          return { content: [{ type: 'text', text: [
            `# 📋 Summary`,
            '',
            `**Session:** ${params.session_id.substring(0, 8)}...`,
            aiSummary ? `\n${aiSummary}\n` : `**Status:** ${statusEmoji} ${outcome.status} — ${outcome.reason}`,
            '',
            '---',
            '',
            `**🔄 Resume:** \`${resumeCommandFor(params.session_id) ?? 'not resumable from a shell'}\``,
          ].join('\n') }] };
        }

        const lines: string[] = [];
        lines.push(`# 📋 Summary — ${params.session_id.substring(0, 8)}…`);
        lines.push('');
        if (aiSummary) { lines.push(aiSummary); lines.push(''); }

        // Status header line — most useful single signal.
        lines.push(`**Status:** ${statusEmoji} ${outcome.status} — ${outcome.reason}`);
        if (outcome.startMs && outcome.endMs) {
          const mins = Math.round((outcome.endMs - outcome.startMs) / 60000);
          lines.push(`**Window:** ${new Date(outcome.startMs).toISOString().slice(0, 16).replace('T', ' ')} → ${new Date(outcome.endMs).toISOString().slice(0, 16).replace('T', ' ')} (${mins} min)`);
        }
        if (outcome.fileCount > 0) {
          lines.push(`**Edits:** ${outcome.fileCount} file(s) · +${outcome.totalLinesAdded} / −${outcome.totalLinesRemoved} lines`);
        }
        if (outcome.commits.totalCommits > 0) {
          const repoNames = outcome.commits.repos.map(r => `${r.repoName} (${r.commits.length})`).join(', ');
          lines.push(`**Commits:** ${outcome.commits.totalCommits} across ${outcome.commits.repos.length} repo(s) — ${repoNames}`);
        }
        lines.push('');

        if (outcome.decisions.length > 0) {
          lines.push('## Decisions');
          for (const d of outcome.decisions.slice(0, 8)) {
            lines.push(`- ${d.text}`);
          }
          lines.push('');
        }
        if (outcome.blockers.length > 0) {
          lines.push('## Blockers');
          for (const b of outcome.blockers.slice(0, 8)) {
            const tag = b.kind === 'tool_error' ? '⚠ tool error' : b.kind === 'interrupt' ? '⏸ interrupt' : '⚠';
            lines.push(`- ${tag}: ${b.text}`);
          }
          lines.push('');
        }
        if (outcome.claimReaction.claim) {
          lines.push('## Last claim vs user reaction');
          lines.push(`- **claim:** ${outcome.claimReaction.claim.text.slice(0, 240)}`);
          if (outcome.claimReaction.reaction) {
            const r = outcome.claimReaction.reaction;
            const markers = r.markers.length ? ` _[${r.markers.join(', ')}]_` : '';
            lines.push(`- **reaction:** ${r.text.slice(0, 240)}${markers}`);
          } else {
            lines.push(`- **reaction:** _(no follow-up — session ended on this claim)_`);
          }
          lines.push('');
        }
        if (outcome.promptMarkers.total > 0) {
          const m = outcome.promptMarkers;
          const parts: string[] = [];
          if (m.frustrated) parts.push(`⚠ ${m.frustrated} frustrated`);
          if (m.correction) parts.push(`↩ ${m.correction} correction`);
          if (m.interrupt) parts.push(`⏸ ${m.interrupt} interrupt`);
          if (m.approval) parts.push(`✓ ${m.approval} approval`);
          if (m.directive) parts.push(`▸ ${m.directive} directive`);
          if (m.question) parts.push(`? ${m.question} question`);
          if (parts.length) {
            lines.push('## Prompt markers');
            lines.push(parts.join(' · '));
            lines.push('');
          }
        }

        lines.push('---');
        lines.push('');
        { const rc = resumeCommandFor(params.session_id); if (rc) lines.push(`**🔄 Resume:** \`${rc}\``); }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'recall_diff': {
        const params = RecallDiffSchema.parse(args);
        const soft = await remoteGetSoft<{ projectPath?: string; totalLinesAdded: number; totalLinesRemoved: number; files: Array<{ file: string; diff: string; linesAdded: number; linesRemoved: number; reverted: boolean; succeededEvents: number; failedEvents: number; initialKnown: boolean; events: Array<{ toolName?: string }> }> }>(
          `/api/conversations/${encodeURIComponent(params.session_id)}/diff`, { file: params.file });
        if (!soft.data) {
          return { content: [{ type: 'text', text: soft.message || (soft.status === 404 ? `Session not found: ${params.session_id}` : `Diff not synced yet for ${params.session_id}.`) }] };
        }
        const result = soft.data;
        const files = result.files;
        if (files.length === 0) {
          return { content: [{ type: 'text', text: params.files_only
            ? `Session ${params.session_id} exists but no file activity is recorded (no Edit/Write/MultiEdit/NotebookEdit tool_uses found).`
            : `No edits found${params.file ? ` for file ${params.file}` : ''} in session ${params.session_id}.` }] };
        }

        // files_only mode (absorbed from recall_session_files): just the list
        // of files the session touched, bucketed by extension, with the tools
        // used — no diff bodies, no per-file stats.
        if (params.files_only) {
          const fileNames = files.map(f => f.file);
          const tools = [...new Set(files.flatMap(f => (f.events || []).map(e => e.toolName).filter((t): t is string => !!t)))];

          // Bucket by extension to give the agent a quick "what kind of work was this".
          const byExt = new Map<string, string[]>();
          for (const f of fileNames) {
            const ext = f.includes('.') ? f.split('.').pop()!.toLowerCase() : '(no ext)';
            if (!byExt.has(ext)) byExt.set(ext, []);
            byExt.get(ext)!.push(f);
          }

          const lines = [
            `# Files touched in session ${params.session_id.slice(0, 8)}`,
            '',
            `**Project:** ${result.projectPath || '(unknown)'}`,
            `**Files modified:** ${fileNames.length}`,
            `**Tools used:** ${tools.join(', ') || '(none recorded)'}`,
            `**Source:** synced diff replay`,
            '',
            '## By extension',
          ];
          const sortedExts = [...byExt.entries()].sort((a, b) => b[1].length - a[1].length);
          for (const [ext, fs] of sortedExts) {
            lines.push(`### .${ext} (${fs.length})`);
            for (const f of fs.slice(0, 12)) lines.push(`- ${f}`);
            if (fs.length > 12) lines.push(`- …and ${fs.length - 12} more`);
          }
          return { content: [{ type: 'text', text: withCodeindexHint(lines.join('\n'), 'session') }] };
        }
        const lines: string[] = [];
        lines.push(`# 🧾 Diff — ${params.session_id.substring(0, 8)}…`);
        lines.push(`Total: ${files.length} file(s) · +${result.totalLinesAdded} / −${result.totalLinesRemoved} lines`);
        lines.push('');
        for (const f of files) {
          const flags: string[] = [];
          if (f.reverted) flags.push('🔁 reverted');
          if (!f.initialKnown) flags.push('⚠ initial content unknown');
          if (f.failedEvents > 0) flags.push(`✗ ${f.failedEvents} failed`);
          lines.push(`## \`${f.file}\``);
          lines.push(`+${f.linesAdded} / −${f.linesRemoved} · ${f.events.length} event(s) · ${f.succeededEvents} succeeded${flags.length ? ' · ' + flags.join(' · ') : ''}`);
          if (!params.context_only && f.diff) {
            const diff = f.diff.length > params.max_diff_chars
              ? f.diff.slice(0, params.max_diff_chars) + '\n…(truncated)'
              : f.diff;
            lines.push('');
            lines.push('```diff');
            lines.push(diff);
            lines.push('```');
          }
          lines.push('');
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'recall_commits': {
        const params = RecallCommitsSchema.parse(args);
        const soft = await remoteGetSoft<{ totalCommits: number; repos: Array<{ repoName: string; commits: Array<{ shortSha: string; authorIso: string; subject: string; matchedSessionFiles: string[]; linesAdded: number; linesRemoved: number; files: unknown[] }> }> }>(
          `/api/conversations/${encodeURIComponent(params.session_id)}/commits`, { buffer_minutes: params.buffer_minutes });
        if (!soft.data) {
          return { content: [{ type: 'text', text: soft.message || (soft.status === 404 ? `Session not found: ${params.session_id}` : `Commits not synced yet for ${params.session_id}.`) }] };
        }
        const result = soft.data;
        if (result.totalCommits === 0) {
          return { content: [{ type: 'text', text: `No commits in window for ${params.session_id} across ${result.repos.length} repo(s).\n\n_Edits stayed local or window was off — try increasing buffer_minutes._` }] };
        }
        const lines: string[] = [];
        lines.push(`# 🔖 Commits — ${params.session_id.substring(0, 8)}…`);
        lines.push(`${result.totalCommits} commit(s) across ${result.repos.length} repo(s) within window`);
        lines.push('');
        for (const r of result.repos) {
          lines.push(`## ${r.repoName} (${r.commits.length})`);
          for (const c of r.commits) {
            lines.push(`- \`${c.shortSha}\` ${c.authorIso.slice(0, 16).replace('T', ' ')} — ${c.subject}`);
            if (c.matchedSessionFiles.length > 0) {
              lines.push(`  _matches ${c.matchedSessionFiles.length} session file(s)_`);
            }
            lines.push(`  +${c.linesAdded} / −${c.linesRemoved} · ${c.files.length} file(s)`);
          }
          lines.push('');
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }


      case 'recall_markers': {
        const params = RecallMarkersSchema.parse(args);
        type MarkerPrompt = { ts?: number; tsIso?: string; line: number; markers: string[]; text: string };
        type MarkerSummary = { total: number; peakIntensity: number; frustrated?: number; correction?: number; interrupt?: number; approval?: number; directive?: number; question?: number; clarification_request?: number };
        const soft = await remoteGetSoft<{ prompts: MarkerPrompt[]; summary: MarkerSummary }>(
          `/api/conversations/${encodeURIComponent(params.session_id)}/markers`);
        if (!soft.data) {
          return { content: [{ type: 'text', text: soft.message || (soft.status === 404 ? `Session not found: ${params.session_id}` : `Markers not synced yet for ${params.session_id}.`) }] };
        }
        const prompts = soft.data.prompts.slice(0, params.limit);
        const summary = soft.data.summary;
        const lines: string[] = [];
        lines.push(`# 🎚 Prompt markers — ${params.session_id.substring(0, 8)}…`);
        lines.push(`${summary.total} prompt(s) · peak intensity ${summary.peakIntensity.toFixed(2)}`);
        const tally: string[] = [];
        if (summary.frustrated) tally.push(`⚠ ${summary.frustrated} frustrated`);
        if (summary.correction) tally.push(`↩ ${summary.correction} correction`);
        if (summary.interrupt) tally.push(`⏸ ${summary.interrupt} interrupt`);
        if (summary.approval) tally.push(`✓ ${summary.approval} approval`);
        if (summary.directive) tally.push(`▸ ${summary.directive} directive`);
        if (summary.question) tally.push(`? ${summary.question} question`);
        if (summary.clarification_request) tally.push(`◇ ${summary.clarification_request} clarify`);
        if (tally.length) lines.push(tally.join(' · '));
        lines.push('');
        for (const p of prompts) {
          const stamp = p.tsIso ? p.tsIso.slice(11, 19) : '';
          const tags = p.markers.length ? ` _[${p.markers.join(', ')}]_` : '';
          const snippet = p.text.length > 180 ? p.text.slice(0, 180) + '…' : p.text;
          lines.push(`- ${stamp} L${p.line}${tags}`);
          lines.push(`  ${snippet.replace(/\n/g, ' ')}`);
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }


      case 'recall_memory_search': {
        const params = RecallMemorySearchSchema.parse(args);

        // Sanitize query to prevent prompt injection
        const sanitizedMem = sanitizeQuery(params.query);
        const memSearchQuery = sanitizedMem.cleanQuery;

        // Thin collector: memory search always runs against the synced server.
        // The `scope` param is accepted for back-compat but ignored.
        requireRemote();
        const remote = await remotePost<{ results: Array<{ itemId: string; sourceType: string; title: string; text: string; score: number; projectPath?: string; mtime?: number; chunkType?: string; matchedChunks?: Array<{ chunkType?: string; text: string }> }>; count: number }>(
          '/api/memory/search', { query: memSearchQuery, topK: params.top_k, sourceTypes: params.source_types, projectIdFilter: params.project_filter, semantic: params.semantic },
        );
        if (!remote.results?.length) {
          return { content: [{ type: 'text', text: `No server-side matches for "${params.query}".` }] };
        }
        const lines = [`# Server memory search: "${params.query}"`, '_(synced history across your devices)_', ''];
        for (let i = 0; i < remote.results.length; i++) {
          const r = remote.results[i];
          // Memory-type tag (decision/milestone/…) parsed from chunk_type so the
          // caller can weight the hit without another lookup.
          const kind = r.chunkType?.match(/:(\w+):imp([0-9])/);
          const tag = kind ? ` · ${kind[1]} (imp${kind[2]})` : '';
          const when = r.mtime ? ` · ${new Date(r.mtime).toISOString().slice(0, 10)}` : '';
          lines.push(`## #${i + 1} [${r.sourceType}${tag}] ${(r.title || r.itemId).slice(0, 90)}`);
          // FULL item id + a ready-to-use fetch handle — so the AI can pull the
          // whole item without guessing the id (eliminates a second round trip).
          lines.push(`**id:** \`${r.itemId}\`${when}${r.projectPath ? ` · ${r.projectPath}` : ''}`);
          if (r.sourceType === 'session') lines.push(`_fetch: recall_context / recall_show "${r.itemId}"_`);
          // Up to 3 matched snippets (the server already returns them) instead of
          // one 300-char fragment — enough context to act on the spot.
          const snippets = (r.matchedChunks?.length ? r.matchedChunks.map((c) => c.text) : [r.text]).filter(Boolean).slice(0, 3);
          for (const s of snippets) lines.push(`- ${s.replace(/\n/g, ' ').trim().slice(0, 220)}`);
          lines.push('');
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }





      case 'recall_smart_resume': {
        const params = RecallSmartResumeSchema.parse(args);
        requireRemote();
        // No session id: take the newest one, which is what "continue" means.
        // Resolved through the same /recent endpoint recall_recent uses, so the
        // "latest" here and the top row there can never disagree.
        let sid = params.session_id;
        if (!sid) {
          const qs = new URLSearchParams({ limit: '1' });
          if (params.project_filter) qs.set('project', params.project_filter);
          const recent = await remoteGet<{ sessions: Array<{ sessionId: string }> }>(
            `/api/conversations/recent?${qs.toString()}`);
          sid = recent.sessions?.[0]?.sessionId;
          if (!sid) {
            return { content: [{ type: 'text', text: params.project_filter
              ? `No sessions found for project \`${params.project_filter}\` — nothing to resume.`
              : 'No sessions have synced yet, so there is nothing to resume. Run `chat-recall index` first.' }] };
          }
        }
        const enc = encodeURIComponent(sid);

        // Server-backed resume dossier, composed from the synced endpoints.
        // Works for ANY tool's session id (claude/gemini/opencode/codex/agy/cursor) — the
        // server resolves the id the same way for all of them.
        //
        // Telemetry + summary come from /metadata; the structured outcome
        // (status, decisions, blockers, claim/reaction) from /outcome; linked
        // tasks/plans from /related; and current project facts from the KG.
        // Data NOT reproduced from the old local version, because no server
        // endpoint exposes it (we don't fabricate it):
        //   - per-task completion counts (completed/total): /related's task
        //     links carry title only, never the task-list breakdown.
        //   - TODO/FIXME scraping from raw assistant text: the raw transcript
        //     never ships to the server, so there's nothing to scan.
        //   - git-log of commits during the session window: the server has no
        //     checkout of the producer's repo. Use `recall_commits` for the
        //     synced commit rollup if you need it.

        // ── Metadata (telemetry + AI summary) ─────────────────────────
        type Meta = {
          tool: string; slug: string; contentPreview: string;
          durationMs: number; messageCount: number;
          inputTokens: number; outputTokens: number; peakContextTokens: number;
          modelsUsed: string[]; filesModified: string[];
          estimatedCostUsd: number | null;
          // Present at runtime when the producer shipped a generated summary.
          summary?: string;
          project_path?: string; projectPath?: string;
        };
        const metaSoft = await remoteGetSoft<Meta>(`/api/conversations/${enc}/metadata`);
        if (!metaSoft.data) {
          return { content: [{ type: 'text', text:
            metaSoft.message || (metaSoft.status === 404
              ? `Session not found: ${sid}`
              : `Session not synced yet: ${sid} — it arrives with the next sync from its machine.`) }] };
        }
        const meta = metaSoft.data;

        // ── Outcome (status / decisions / blockers / claim-reaction) ──
        type Outcome = {
          status: string; reason: string;
          fileCount: number; totalLinesAdded: number; totalLinesRemoved: number;
          commits: { totalCommits: number; repos: Array<{ repoName: string; commits: unknown[] }> };
          decisions: Array<{ text: string }>;
          blockers: Array<{ kind: string; text: string }>;
          claimReaction: { claim?: { text: string }; reaction?: { text: string; markers: string[] } };
        };
        const outcomeSoft = await remoteGetSoft<Outcome>(`/api/conversations/${enc}/outcome`);
        const outcome = outcomeSoft.data; // null if 202 (not yet computed) / 404

        // ── Related (linked tasks/plans for this session) ─────────────
        type RelatedItem = { id: string; sourceType: string; title: string; contentPreview: string; linkType: string };
        type Related = {
          links: RelatedItem[];
          projectPlans: RelatedItem[];
          projectClaudeMd: RelatedItem | null;
        };
        const relatedSoft = await remoteGetSoft<Related>(`/api/conversations/${enc}/related`);
        const related = relatedSoft.data;
        const linkedTasks = (related?.links ?? []).filter(l => l.sourceType === 'task');

        // ── Build output ──────────────────────────────────────────────
        const lines: string[] = [];
        const projectPath = meta.project_path ?? meta.projectPath ?? '';
        const projName = projectPath ? (projectPath.split('/').pop() || projectPath) : '';
        const slug = meta.slug || meta.contentPreview?.slice(0, 60) || sid.slice(0, 8);
        const durationMin = meta.durationMs > 0 ? Math.round(meta.durationMs / 60000) : 0;
        const peakK = Math.round((meta.peakContextTokens || 0) / 1000);
        const peakPct = Math.round((meta.peakContextTokens || 0) / 200000 * 100); // 200k context assumed

        lines.push(`# Resume: ${slug}`);
        lines.push(`**Tool:** ${meta.tool || 'unknown'} | **Project:** ${projName || '(unknown)'} | **Duration:** ${durationMin}min | **Messages:** ${meta.messageCount || 0}`);
        lines.push('');

        // What happened — AI summary if the producer generated and synced one.
        if (meta.summary && meta.summary.trim()) {
          lines.push('## What Happened');
          lines.push(meta.summary.trim());
          lines.push('');
        }

        // Outcome — same shape `recall_outcome` consumes, so the two agree.
        if (outcome) {
          // Same status→emoji mapping as recall_outcome / recall_summary (the
          // server sends a plain string, not the engine's SessionStatus enum).
          const oEmoji =
            outcome.status === 'shipped' ? '🚢' :
            outcome.status === 'interrupted' ? '⏸' :
            outcome.status === 'abandoned' ? '🪦' :
            outcome.status === 'in_progress' ? '🟡' : '❔';
          lines.push('## Outcome');
          lines.push(`${oEmoji} **${outcome.status}** — ${outcome.reason}`);
          if (outcome.fileCount > 0) {
            lines.push(`Edits: ${outcome.fileCount} file(s) · +${outcome.totalLinesAdded} / −${outcome.totalLinesRemoved} lines`);
          }
          if (outcome.commits.totalCommits > 0) {
            lines.push(`Commits: ${outcome.commits.totalCommits} (${outcome.commits.repos.map(r => `${r.repoName}:${r.commits.length}`).join(', ')})`);
          }
          lines.push('');

          if (outcome.decisions.length > 0) {
            lines.push('## Decisions');
            for (const d of outcome.decisions.slice(0, 8)) lines.push(`- ${d.text.slice(0, 200)}`);
            lines.push('');
          }
          if (outcome.blockers.length > 0) {
            lines.push('## Blockers');
            for (const b of outcome.blockers.slice(0, 6)) lines.push(`- _${b.kind}_: ${b.text.slice(0, 200)}`);
            lines.push('');
          }
          if (outcome.claimReaction.claim) {
            lines.push('## Final claim vs reaction');
            lines.push(`- **claim:** ${outcome.claimReaction.claim.text.slice(0, 240)}`);
            if (outcome.claimReaction.reaction) {
              const r = outcome.claimReaction.reaction;
              const m = r.markers.length ? ` _[${r.markers.join(', ')}]_` : '';
              lines.push(`- **reaction:** ${r.text.slice(0, 240)}${m}`);
            } else {
              lines.push(`- **reaction:** _none — session ended on this claim_`);
            }
            lines.push('');
          }
        } else if (outcomeSoft.status === 202) {
          lines.push('## Outcome');
          lines.push(`_${outcomeSoft.message || 'Not computed yet — arrives with the next sync from this session\'s machine.'}_`);
          lines.push('');
        }

        // Known facts from the knowledge graph about this project.
        if (projName) {
          try {
            const kg = await remotePost<{ facts: Array<{ subject: string; predicate: string; object: string; direction: string; current: boolean }> }>(
              '/api/kg/query', { entity: projName, direction: 'both' });
            const currentFacts = (kg.facts ?? []).filter(f => f.current);
            if (currentFacts.length > 0) {
              lines.push('## Known Facts (Knowledge Graph)');
              for (const fact of currentFacts.slice(0, 15)) {
                const arrow = fact.direction === 'outgoing' ? '→' : '←';
                lines.push(`- ${fact.subject} ${arrow} **${fact.predicate}** ${arrow} ${fact.object}`);
              }
              lines.push('');
            }
          } catch { /* KG optional — skip if unavailable */ }
        }

        // Linked tasks/plans. /related exposes task LINKS (id + title) but not
        // the per-task completion breakdown, so we list them without inventing
        // a "(N/M done)" count we can't actually know server-side.
        if (linkedTasks.length > 0) {
          lines.push('## Linked Task Lists');
          for (const t of linkedTasks.slice(0, 10)) {
            const preview = t.contentPreview ? ` — ${t.contentPreview.slice(0, 100)}` : '';
            lines.push(`- ${t.title}${preview}`);
          }
          lines.push('_(per-task completion counts aren\'t exposed by the server — open the task list for the full breakdown.)_');
          lines.push('');
        }
        if (related && related.projectPlans.length > 0) {
          lines.push('## Project Plans');
          for (const p of related.projectPlans.slice(0, 6)) lines.push(`- ${p.title}`);
          lines.push('');
        }

        // Files modified (from synced telemetry).
        if (meta.filesModified && meta.filesModified.length > 0) {
          lines.push('## Files Modified');
          for (const f of meta.filesModified.slice(0, 15)) lines.push(`- ${f}`);
          lines.push('');
        }

        // Context budget.
        lines.push('## Context Budget');
        lines.push(`Input: ${((meta.inputTokens || 0) / 1_000_000).toFixed(1)}M | Output: ${((meta.outputTokens || 0) / 1000).toFixed(0)}k | Peak: ${peakK}k`);
        if (meta.estimatedCostUsd !== null && meta.estimatedCostUsd !== undefined) {
          lines.push(`Estimated cost: $${meta.estimatedCostUsd.toFixed(2)}`);
        }
        if (meta.modelsUsed && meta.modelsUsed.length > 0) {
          lines.push(`Models: ${meta.modelsUsed.filter(m => m !== '<synthetic>').join(', ')}`);
        }
        if (peakPct > 80) {
          lines.push(`**Warning:** Session used ${peakPct}% of context window`);
        }
        lines.push('');

        { const rc = resumeCommandFor(sid, meta.tool); if (rc) lines.push(`**Resume:** \`${rc}\``); }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'recall_project_context': {
        const params = RecallProjectContextSchema.parse(args);

        // Server-backed: the dossier route resolves EITHER a stable project_id
        // (git:/ws:/git-local:/user:) OR a path/name substring into a
        // project_id (via the engine's resolveProjectId) and aggregates
        // everything the synced index knows — recent sessions w/ summaries,
        // cost/token rollup, open tasks, plans, and current knowledge-graph
        // facts (decisions + tech stack). Absorbs the old recall_project_dossier
        // (which demanded an id) — both hit the same endpoint. Two of the old
        // local extras are intentionally NOT reproduced because no server
        // endpoint exposes them:
        //   - "Recent Git Commits": came from shelling out to `git log` on the
        //     local repo; the server has no checkout of the producer's repo.
        //   - "Related Work in Other Projects": a cross-project FTS sweep over
        //     the local index; the dossier endpoint is single-project scoped.
        // RESOLVE THE PATH HERE, NOT ON THE SERVER. `resolveProjectId` reads the
        // git remote of a directory, and the directory is on THIS machine — the
        // server has no checkout, so it used to fall back to `path:/home/…`,
        // match nothing, and return an empty-looking dossier for a project with
        // thousands of items. Only an existing local directory is resolved: a
        // bare name like `chat-recall` must travel intact so the server can
        // match it by name.
        const target = existsSync(params.project_path) && statSync(params.project_path).isDirectory()
          ? resolveProjectId(params.project_path).id
          : params.project_path;

        const dossier = await remoteGetQS<{ project_id: string; markdown: string }>(
          `/api/projects/${encodeURIComponent(target)}/dossier`,
          { sessions: params.limit, tasks: params.tasks, plans: params.plans },
        );
        return { content: [{ type: 'text', text: dossier.markdown }] };
      }

      case 'recall_weekly_digest': {
        const params = RecallWeeklyDigestSchema.parse(args);
        requireRemote();

        // Server-backed digest off the same analytics aggregate the dashboard
        // renders. The server computes per-week (Sunday-start, UTC) trends; we
        // pick the requested week from `weeklyTrends` / `periodComparison`.
        // For the CURRENT week, project/model breakdowns come from a second,
        // time-windowed analytics call (?since_hours=168) so they're genuinely
        // weekly. Historical weeks can't be windowed with a since-only filter,
        // so their breakdowns show all-time context, labelled as such. KG
        // stats and open-task scans are local-only and dropped.
        type Analytics = {
          summary: { totalSessions: number; totalCostUsd: number; totalDurationMin: number; totalCacheReadTokens: number; totalInputTokens: number; sessionsCostUpperBound?: number };
          projects: Array<{ name: string; sessions: number; totalCost: number; description?: string }>;
          models: Array<{ model: string; sessions: number }>;
          weeklyTrends: Array<{ week: string; cost: number; sessions: number; cacheRate: number }>;
          periodComparison: {
            thisWeek: { sessions: number; cost: number; cacheRate: number };
            lastWeek: { sessions: number; cost: number; cacheRate: number };
          };
        };
        const a = await remoteGet<Analytics>('/api/analytics');

        // Resolve which week the caller asked for. weeks_back 0/1 map directly
        // to periodComparison; older weeks come from the weeklyTrends series
        // (which is sorted ascending and capped at the last 12 weeks).
        const trendsDesc = [...(a.weeklyTrends || [])].reverse(); // newest first
        const weekLabel = params.weeks_back === 0
          ? 'This Week'
          : params.weeks_back === 1
            ? 'Last Week'
            : `${params.weeks_back} Weeks Ago`;

        let weekSessions = 0, weekCost = 0, weekCacheRate = 0, weekLabelDate = '';
        let prevSessions = 0, prevCost = 0;
        if (params.weeks_back === 0) {
          weekSessions = a.periodComparison.thisWeek.sessions;
          weekCost = a.periodComparison.thisWeek.cost;
          weekCacheRate = a.periodComparison.thisWeek.cacheRate;
          prevSessions = a.periodComparison.lastWeek.sessions;
          prevCost = a.periodComparison.lastWeek.cost;
          weekLabelDate = trendsDesc[0]?.week || '';
        } else if (params.weeks_back === 1) {
          weekSessions = a.periodComparison.lastWeek.sessions;
          weekCost = a.periodComparison.lastWeek.cost;
          weekCacheRate = a.periodComparison.lastWeek.cacheRate;
          const wk = trendsDesc[2];
          prevSessions = wk?.sessions || 0;
          prevCost = wk?.cost || 0;
          weekLabelDate = trendsDesc[1]?.week || '';
        } else {
          const wk = trendsDesc[params.weeks_back];
          const prev = trendsDesc[params.weeks_back + 1];
          weekSessions = wk?.sessions || 0;
          weekCost = wk?.cost || 0;
          weekCacheRate = wk?.cacheRate || 0;
          weekLabelDate = wk?.week || '';
          prevSessions = prev?.sessions || 0;
          prevCost = prev?.cost || 0;
        }

        const dateRange = weekLabelDate ? `week of ${weekLabelDate}` : '';
        const lines = [`# ${weekLabel}${dateRange ? `: ${dateRange}` : ''}\n`];

        if (weekSessions === 0 && weekCost === 0) {
          lines.push('No sessions found for this period.');
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        // Overview. "≤" when any mixed-model session inflates the figure —
        // those are billed entirely at their priciest model, so the total is
        // an upper bound, not measured spend.
        const costPrefix = (a.summary.sessionsCostUpperBound ?? 0) > 0 ? '≤' : '';
        lines.push(`**${weekSessions} sessions** · **${costPrefix}$${weekCost.toFixed(0)}**`);
        if (costPrefix) lines.push(`_(cost is an upper bound: ${a.summary.sessionsCostUpperBound} mixed-model session(s) billed at their priciest model)_`);
        if (weekCacheRate > 0) lines.push(`Cache hit rate: ${weekCacheRate}%`);
        lines.push('');

        // vs previous week
        const pctChange = prevCost > 0 ? Math.round(((weekCost - prevCost) / prevCost) * 100) : 0;
        const arrow = pctChange > 0 ? '+' : '';
        lines.push('## vs Previous Week\n');
        lines.push(`This period: ${weekSessions} sessions, $${weekCost.toFixed(0)}`);
        lines.push(`Prior period: ${prevSessions} sessions, $${prevCost.toFixed(0)}`);
        lines.push(`Change: ${arrow}${pctChange}%`);
        lines.push('');

        // Project/model breakdowns: genuinely week-scoped for the current
        // week, all-time (and labelled so) for historical weeks.
        let breakdown: Pick<Analytics, 'projects' | 'models'> = a;
        let breakdownLabel = 'all-time';
        if (params.weeks_back === 0) {
          try {
            breakdown = await remoteGet<Analytics>('/api/analytics?since_hours=168');
            breakdownLabel = 'this week';
          } catch { /* older server without since_hours — keep all-time */ }
        }

        if (breakdown.projects.length > 0) {
          lines.push(`## Top Projects (${breakdownLabel})\n`);
          for (const p of breakdown.projects.slice(0, 8)) {
            const desc = p.description ? ` — ${p.description.slice(0, 80)}` : '';
            lines.push(`**${p.name}** · ${p.sessions} sessions · $${p.totalCost.toFixed(0)}${desc}`);
          }
          lines.push('');
        }

        if (breakdown.models.length > 0) {
          lines.push(`## Models Used (${breakdownLabel})\n`);
          for (const m of breakdown.models) {
            const shortModel = m.model.replace(/^claude-/, '').replace(/^models\//, '');
            lines.push(`- ${shortModel}: ${m.sessions} sessions`);
          }
          lines.push('');
        }

        // Knowledge-graph snapshot (server-side) — re-added from the local digest.
        try {
          const kg = await remoteGet<{ entities: number; current_facts: number; relationship_types: string[] }>('/api/kg/stats');
          if (kg.entities > 0) {
            lines.push('## Knowledge Graph\n');
            lines.push(`${kg.entities} entities · ${kg.current_facts} current facts · ${kg.relationship_types.length} relationship types`);
            lines.push('');
          }
        } catch { /* kg optional */ }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'recall_team_activity': {
        const params = RecallTeamActivitySchema.parse(args);
        requireRemote();
        const qs: Record<string, string | number> = {};
        if (params.project) qs.project = params.project;
        if (params.member) qs.member = params.member;
        if (params.since_days && params.since_days > 0) qs.since = Date.now() - params.since_days * 86400000;
        type Activity = {
          activity: Array<{ authorSub: string | null; memberEmail: string | null; projectId: string; sessions: number; lastMtime: number }>;
        };
        const a = await remoteGetQS<Activity>('/api/activity', qs);
        if (!a.activity || a.activity.length === 0) {
          return { content: [{ type: 'text', text: 'No team activity visible — nothing has been shared into the team yet, or no sessions match the filter. (Teammates share a project with `chat-recall share <project>`.)' }] };
        }
        // Group by member for a readable "who did what, where" rollup.
        const byMember = new Map<string, Activity['activity']>();
        for (const r of a.activity) {
          const key = r.memberEmail || r.authorSub || 'unattributed';
          (byMember.get(key) ?? byMember.set(key, []).get(key)!).push(r);
        }
        const lines: string[] = ['# Team activity\n'];
        for (const [member, rows] of byMember) {
          const total = rows.reduce((n, r) => n + r.sessions, 0);
          lines.push(`## ${member} — ${total} session(s)`);
          for (const r of [...rows].sort((x, y) => y.lastMtime - x.lastMtime)) {
            const when = r.lastMtime ? new Date(r.lastMtime).toISOString().slice(0, 10) : '????';
            lines.push(`- ${r.projectId} · ${r.sessions} session(s) · last active ${when}`);
          }
          lines.push('');
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'recall_tasks': {
        const params = RecallTasksSchema.parse(args);
        requireRemote();
        const qs: Record<string, string> = {};
        if (params.mine) qs.assignee = '@me';
        if (params.project) qs.project = params.project;
        if (params.status) qs.status = params.status;
        type Task = {
          id: string; title: string; status: string; assigneeSub: string | null; projectId: string;
          updatedAt: number; description?: string; linkedSessionId?: string | null; linkedFindingId?: string | null;
        };
        const { tasks } = await remoteGetQS<{ tasks: Task[] }>('/api/tasks', qs);
        if (!tasks || tasks.length === 0) return { content: [{ type: 'text', text: 'No team tasks match.' }] };

        // The list used to be one line per card: title, id, assignee. The row
        // already carries the fix, the file locations and the agent prompt (the
        // auto-filer writes them into `description`), and all of it was thrown
        // away — so an agent could see that work existed and could not start it
        // without fetching every card one at a time. `detail` renders the brief.
        if (!params.detail) {
          const lines = tasks.map((t) =>
            `- [${t.status}] ${t.title}  \`${t.id}\`${t.projectId ? ` · ${t.projectId}` : ''}${t.assigneeSub ? ` · @${t.assigneeSub.slice(0, 8)}` : ' · unassigned'}`);
          return { content: [{ type: 'text', text:
            `# Team tasks (${tasks.length})\n\n${lines.join('\n')}\n\n`
            + `_Call again with \`detail: true\` for the full brief (fix, locations, agent prompt) so you can start work._` }] };
        }

        const open = tasks.filter((t) => t.status !== 'done' && t.status !== 'rejected');
        const claimed = open.filter((t) => t.status === 'in_progress');
        const blocks = open.map((t, i) => {
          const head = `## ${i + 1}. ${t.title}\n\n`
            + `- id: \`${t.id}\`  ·  status: ${t.status}`
            + `${t.projectId ? `  ·  project: ${t.projectId}` : ''}`
            + `${t.linkedSessionId ? `  ·  already claimed by session ${t.linkedSessionId.slice(0, 8)}` : ''}`;
          const body = (t.description || '').trim();
          return body ? `${head}\n\n${body}` : head;
        });
        const howTo = [
          '---',
          '',
          '### Working these tasks',
          '',
          '1. Claim one before you touch code: `recall_task_update` with `id`, `status: "in_progress"`',
          '   and `linked_session_id` set to YOUR current session id.',
          '2. Do the work. Each brief above carries the fix and, where the task came from a code finding,',
          '   an agent prompt written for exactly this.',
          '3. Close it with `recall_task_update` `status: "done"` and a `comment` saying what you changed.',
          '',
          'The session link is not bookkeeping: **done is refused without it**. A card asserts a problem',
          'exists in the code, so closing one asserts the code changed, and the board shows the files,',
          'lines and commits from your session as the evidence. A person cannot mark these done by hand.',
          '',
          'If a task is wrong — not a real problem, or not worth doing — do NOT close it. Tell the user;',
          'rejecting is their call, and it dismisses the finding so it stops being re-filed.',
          '',
          'Auto-filed cards also close themselves once a re-index no longer reports their finding, so a',
          'real fix ends the task either way.',
        ].join('\n');
        const header = `# Tasks ready to work (${open.length}${tasks.length !== open.length ? ` of ${tasks.length}` : ''})`
          + `${params.project ? ` · ${params.project}` : ''}`
          + `${claimed.length ? `\n\n_${claimed.length} already in progress — check the session link before starting one of those._` : ''}`;
        return { content: [{ type: 'text', text: `${header}\n\n${blocks.join('\n\n')}\n\n${howTo}` }] };
      }

      case 'recall_task_create': {
        const params = RecallTaskCreateSchema.parse(args);
        requireRemote();
        const { task, deduped } = await remotePost<{ task: { id: string; title: string }; deduped?: boolean }>('/api/tasks', {
          title: params.title, description: params.description, projectId: params.project,
          assigneeSub: params.assignee ?? null,
          due: params.due, linkedFindingId: params.linked_finding_id,
        });
        // Say when nothing was created. Filing a duplicate silently is how the
        // board filled with repeats: recall_improvements re-created the same
        // cards on every call because nothing linked them to their finding.
        return { content: [{ type: 'text', text: deduped
          ? `A task for that finding already exists: \`${task.id}\`: ${task.title}`
          : `Created task \`${task.id}\`: ${task.title}` }] };
      }

      case 'recall_task_update': {
        const params = RecallTaskUpdateSchema.parse(args);
        requireRemote();
        const patch: Record<string, unknown> = {};
        if (params.status) patch.status = params.status;
        if (params.assignee !== undefined) patch.assigneeSub = params.assignee || null;
        if (params.title) patch.title = params.title;
        if (params.linked_session_id !== undefined) patch.linkedSessionId = params.linked_session_id;
        let did = false;
        if (Object.keys(patch).length > 0) { await remotePatch(`/api/tasks/${encodeURIComponent(params.id)}`, patch); did = true; }
        if (params.comment) { await remotePost(`/api/tasks/${encodeURIComponent(params.id)}/comments`, { body: params.comment }); did = true; }
        if (!did) return { content: [{ type: 'text', text: 'Nothing to update — pass status, assignee, title, linked_session_id, and/or comment.' }] };
        return { content: [{ type: 'text', text: `Updated task ${params.id}.` }] };
      }

      case 'recall_task_comment': {
        const params = RecallTaskCommentSchema.parse(args);
        requireRemote();
        const { comment } = await remotePost<{ comment: { id: string; taskId: string } }>(
          `/api/tasks/${encodeURIComponent(params.task_id)}/comments`, { body: params.body });
        return { content: [{ type: 'text', text: `Commented on task ${comment.taskId} (comment ${comment.id}).` }] };
      }

      // ── Knowledge Graph Handlers ─────────────────────────────────

      case 'recall_kg_query': {
        const params = RecallKGQuerySchema.parse(args);
        requireRemote();
        const { facts } = await remotePost<{ facts: Array<{ subject: string; predicate: string; object: string; direction: string; current: boolean; valid_from?: string; valid_to?: string }> }>(
          '/api/kg/query', { entity: params.entity, as_of: params.as_of, direction: params.direction });

        if (facts.length === 0) {
          return { content: [{ type: 'text', text: `No facts found for entity: "${params.entity}"${params.as_of ? ` as of ${params.as_of}` : ''}` }] };
        }

        const lines = [`# Knowledge Graph: "${params.entity}"${params.as_of ? ` (as of ${params.as_of})` : ''}\n`];
        lines.push(`**Facts:** ${facts.length} (${facts.filter(f => f.current).length} current)\n`);

        for (const fact of facts) {
          const arrow = fact.direction === 'outgoing' ? '→' : '←';
          const status = fact.current ? '' : ' [expired]';
          const validity = fact.valid_from ? ` (${fact.valid_from}${fact.valid_to ? ' → ' + fact.valid_to : ' → now'})` : '';
          lines.push(`- ${fact.subject} ${arrow} **${fact.predicate}** ${arrow} ${fact.object}${validity}${status}`);
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'recall_kg_add': {
        const params = RecallKGAddSchema.parse(args);
        const wal = getWAL();
        wal.log('kg_add', { subject: params.subject, predicate: params.predicate, object: params.object, valid_from: params.valid_from });

        requireRemote();
        const { id: tripleId } = await remotePost<{ id: string }>('/api/kg/add', {
          subject: params.subject, predicate: params.predicate, object: params.object,
          valid_from: params.valid_from, source_session: params.source_session,
        });

        return { content: [{ type: 'text', text: `Added: ${params.subject} → ${params.predicate} → ${params.object} (id: ${tripleId})` }] };
      }

      case 'recall_kg_invalidate': {
        const params = RecallKGInvalidateSchema.parse(args);
        const wal = getWAL();
        wal.log('kg_invalidate', { subject: params.subject, predicate: params.predicate, object: params.object, ended: params.ended });

        requireRemote();
        const { invalidated: count } = await remotePost<{ invalidated: number }>('/api/kg/invalidate', {
          subject: params.subject, predicate: params.predicate, object: params.object, ended: params.ended,
        });

        const endDate = params.ended || new Date().toISOString().split('T')[0];
        return { content: [{ type: 'text', text: `Invalidated ${count} fact(s): ${params.subject} → ${params.predicate} → ${params.object} (ended: ${endDate})` }] };
      }

      case 'recall_kg_timeline': {
        const params = RecallKGTimelineSchema.parse(args);
        requireRemote();
        const { entries } = await remoteGetQS<{ entries: Array<{ subject: string; predicate: string; object: string; current: boolean; valid_from?: string }> }>(
          '/api/kg/timeline', { entity: params.entity, limit: params.limit });

        if (entries.length === 0) {
          return { content: [{ type: 'text', text: `No timeline entries found${params.entity ? ` for "${params.entity}"` : ''}.` }] };
        }

        const lines = [`# Timeline${params.entity ? `: ${params.entity}` : ''}\n`];
        for (const entry of entries) {
          const status = entry.current ? '' : ' [ended]';
          const from = entry.valid_from || '?';
          lines.push(`- **${from}** ${entry.subject} → ${entry.predicate} → ${entry.object}${status}`);
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'recall_kg_stats': {
        requireRemote();
        const s = await remoteGet<{ entities: number; triples: number; current_facts: number; expired_facts: number; relationship_types: string[] }>('/api/kg/stats');

        const lines = [
          '# Knowledge Graph Stats\n',
          `**Entities:** ${s.entities}`,
          `**Triples:** ${s.triples} (${s.current_facts} current, ${s.expired_facts} expired)`,
          '',
          `**Relationship types:** ${s.relationship_types.length > 0 ? s.relationship_types.join(', ') : 'none yet'}`,
        ];

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      // ── Diary Handlers ─────────────────────────────────────────

      case 'recall_diary_write': {
        const params = RecallDiaryWriteSchema.parse(args);
        const wal = getWAL();
        wal.log('diary_write', { agent: params.agent_name, topic: params.topic });

        requireRemote();
        const { id: entryId } = await remotePost<{ id: string }>('/api/diary/write', {
          agent_name: params.agent_name,
          topic: params.topic,
          entry: params.entry,
          session_id: params.session_id,
          project_path: params.project_path,
        });

        return { content: [{ type: 'text', text: `Diary entry saved: ${entryId}` }] };
      }

      case 'recall_diary_read': {
        const params = RecallDiaryReadSchema.parse(args);
        requireRemote();
        const { entries } = await remoteGetQS<{ entries: Array<{ timestamp?: string; topic: string; content: string }> }>(
          '/api/diary/read', { agent: params.agent_name, last_n: params.last_n });

        if (entries.length === 0) {
          return { content: [{ type: 'text', text: `No diary entries for agent "${params.agent_name}".` }] };
        }

        const lines = [`# Diary: ${params.agent_name} (${entries.length} entries)\n`];
        for (const entry of entries) {
          const date = entry.timestamp?.slice(0, 16).replace('T', ' ') || '?';
          lines.push(`## ${date} [${entry.topic}]`);
          lines.push(entry.content);
          lines.push('');
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      // ── Code intelligence (codeindex companion — gated: the case handlers
      // are only reachable when the tools are registered, i.e. when the
      // codeindex binary is on PATH; see the pre-switch guard) ──
      case 'recall_code_index': {
        const params = RecallCodeIndexSchema.parse(args);
        // Refused in the DISPATCH, not only dropped from the listing. Removing a
        // tool from tools/list stops a client OFFERING it; it does not stop one
        // CALLING it by name from a cached list. Here that gap was a real hole:
        // this handler resolves a caller-supplied path and runs the collector
        // over it, so on the remote endpoint a caller could have the SERVER
        // index the server's own filesystem and post the result into their own
        // tenant, then read it back with recall_code_findings.
        //
        // It was blocked only by an accident — the companion analyzer binary is
        // absent from the server image, so the pre-switch guard refused the
        // whole recall_code_* family. An accident is not a control: install that
        // binary for any reason and the hole opens with no code change.
        if (isMultiTenant()) {
          return { content: [{ type: 'text', text: localOnlyRefusal('recall_code_index') }] };
        }
        requireRemote();
        const { collectCode } = await import('../core/code/collector.js');
        const { resolve: resolvePath } = await import('node:path');
        const workspace = params.path ? resolvePath(params.path) : process.cwd();
        const result = await collectCode({ workspace });
        const resp = await remotePost<{ projectId: string; findings: number; hotspots: number; actions: number }>('/api/code/index', result);
        return { content: [{ type: 'text', text: `Indexed ${resp.projectId}: health ${result.project.health.score}/100, ${resp.findings} findings, ${resp.hotspots} hotspots, ${resp.actions} actions. Use recall_code_actions to see what to fix.` }] };
      }
      case 'recall_code_projects': {
        RecallCodeProjectsSchema.parse(args);
        requireRemote();
        const { projects } = await remoteGet<{ projects: Array<{ projectId: string; rootPath: string; health: { score: number; findings: number; hotspots: number }; label?: string | null; lastIndexedAt: number }> }>('/api/code/projects');
        if (!projects.length) return { content: [{ type: 'text', text: 'No code-indexed projects yet. Run recall_code_index in a repo.' }] };
        const lines = [`# Code projects (${projects.length})\n`];
        for (const p of projects) {
          lines.push(`## ${p.projectId}${p.label ? ` [${p.label}]` : ''}`);
          lines.push(`health ${p.health.score}/100 · ${p.health.findings} findings · ${p.health.hotspots} hotspots · ${p.rootPath}`);
          lines.push('');
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }
      case 'recall_code_findings': {
        const params = RecallCodeFindingsSchema.parse(args);
        requireRemote();

        // Sibling views of the same code index that had no MCP surface.
        if (params.view === 'summary') {
          const r = await remoteGetQS<Record<string, unknown>>('/api/code/summary', { project: params.project });
          return { content: [{ type: 'text', text: '# Code findings summary\n\n```json\n' + JSON.stringify(r, null, 2) + '\n```' }] };
        }
        if (params.view === 'hotspots') {
          const r = await remoteGetQS<{ hotspots: Array<{ file: string; churn?: number; commits?: number; score?: number }> }>(
            '/api/code/hotspots', { project: params.project, limit: params.limit });
          if (!r.hotspots?.length) return { content: [{ type: 'text', text: 'No hotspots recorded — run `chat-recall code index` in the repo.' }] };
          const lines = [`# Code hotspots (${r.hotspots.length})`, '_Churn-ranked; pair with view=file-sessions to see which sessions touched one._\n'];
          for (const h of r.hotspots) {
            lines.push(`- \`${h.file}\`${h.churn !== undefined ? ` · churn ${h.churn}` : ''}${h.commits !== undefined ? ` · ${h.commits} commits` : ''}${h.score !== undefined ? ` · score ${h.score}` : ''}`);
          }
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }
        if (params.view === 'file-sessions') {
          if (!params.file) return { content: [{ type: 'text', text: 'view=file-sessions needs `file` (repo-relative path) and `project`.' }] };
          const r = await remoteGetQS<{ sessions: Array<{ sessionId?: string; title?: string; status?: string }> }>(
            '/api/code/file-sessions', { project: params.project, file: params.file, limit: params.limit });
          if (!r.sessions?.length) return { content: [{ type: 'text', text: `No synced sessions edited \`${params.file}\`.` }] };
          const lines = [`# Sessions that touched \`${params.file}\` (${r.sessions.length})\n`];
          for (const s of r.sessions) lines.push(`- **${s.sessionId ?? '(unknown)'}**${s.status ? ` · ${s.status}` : ''}${s.title ? ` — ${s.title}` : ''}`);
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        const { findings } = await remoteGetQS<{ findings: Array<{ category: string; severity: string; file: string; line: number | null; title: string; why: string; agentPrompt: string }> }>(
          '/api/code/findings', { project: params.project, severity: params.severity, category: params.category, limit: params.limit });
        if (!findings.length) return { content: [{ type: 'text', text: 'No findings match.' }] };
        const lines = [`# Code findings (${findings.length})\n`];
        for (const f of findings) {
          lines.push(`## [${f.severity}] ${f.title} — ${f.file}${f.line ? ':' + f.line : ''}`);
          if (f.why) lines.push(`_${f.why}_`);
          lines.push('```\n' + f.agentPrompt + '\n```');
          lines.push('');
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }
      case 'recall_code_actions': {
        const params = RecallCodeActionsSchema.parse(args);
        requireRemote();
        const { actions } = await remoteGetQS<{ actions: Array<{ pri: number; category: string; title: string; fix: string; agentPrompt: string; status: string }> }>(
          '/api/code/actions', { project: params.project, status: params.status, limit: params.limit });
        if (!actions.length) return { content: [{ type: 'text', text: 'No actions. Run recall_code_index first, or all clear.' }] };
        const lines = [`# Action plan (${actions.length}) — prioritised\n`];
        for (const a of actions) {
          lines.push(`## P${a.pri} [${a.category}]${a.status !== 'suggested' ? ` (${a.status})` : ''} ${a.title}`);
          lines.push(a.fix);
          lines.push('```\n' + a.agentPrompt + '\n```');
          lines.push('');
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }


      case 'recall_recommendations': {
        const params = RecallRecommendationsSchema.parse(args);
        requireRemote();
        // `id` is load-bearing now: recall_recommendation_apply and _dismiss both
        // take it, and it was omitted from this type and from the rendered output,
        // so the two new tools would have had no way to name their target.
        type Rec = { id: string; kind: string; severity: string; title: string; rationale: string; evidence: string[]; action: { type: string; payload: any } };

        // scope "project" — behavior × code recommendations for one
        // code-indexed project (the old recall_code_recommendations).
        if (params.scope === 'project') {
          if (!params.project) {
            return { content: [{ type: 'text', text: 'scope "project" requires `project` (a project id from recall_code_projects).' }] };
          }
          const { recommendations } = await remoteGetQS<{ recommendations: Rec[] }>(
            '/api/code/recommendations', { project: params.project });
          if (!recommendations.length) return { content: [{ type: 'text', text: 'No recommendations — clean, or not enough signal yet.' }] };
          const lines = [`# Recommendations (${recommendations.length}) — behavior × code\n`];
          for (const r of recommendations) {
            lines.push(`## [${r.severity}] ${r.title} (${r.kind})`);
            lines.push(`- id: \`${r.id}\``);
            lines.push(r.rationale);
            if (r.evidence?.length) lines.push(`Evidence: ${r.evidence.join('; ')}`);
            if (r.action?.type === 'append_claude_md') lines.push('Apply → add to CLAUDE.md:\n```\n' + r.action.payload.text + '\n```');
            else lines.push(`Apply → ${r.action.type} ${JSON.stringify(r.action.payload)}`);
            lines.push('');
          }
          lines.push('---', '',
            '### Acting on these',
            '',
            'Apply one with `recall_recommendation_apply` (id + project). A CLAUDE.md rule is',
            'additive and reversible — take it without asking. A label or anything destructive:',
            'ask first.',
            '',
            'If one does not apply to this repo, `recall_recommendation_dismiss` with a reason,',
            'and TELL THE USER what you dismissed. Leaving it undismissed means every future',
            'session sees the same advice again.');
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        // scope "account" (default) — recommendations from YOUR chat-recall data.
        const { recommendations } = await remoteGet<{ recommendations: Rec[] }>('/api/recommendations');
        if (!recommendations.length) return { content: [{ type: 'text', text: 'No account recommendations — no leaked secrets and healthy session outcomes.' }] };
        const lines = [`# Account recommendations (${recommendations.length})\n`];
        for (const r of recommendations) {
          lines.push(`## [${r.severity}] ${r.title} (${r.kind})`);
          lines.push(r.rationale);
          if (r.evidence?.length) lines.push(`Evidence: ${r.evidence.join('; ')}`);
          if (r.action?.type === 'append_claude_md') lines.push('Apply → add to global CLAUDE.md:\n```\n' + r.action.payload.text + '\n```');
          lines.push('');
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      // ── Aggregated views over the recommendation engines ──
      // Both cases FAN OUT over the endpoints the single-scope tools already
      // call, then hand the results to ./recommendation-merge.ts. No ranking
      // and no rule text is computed here: this layer is I/O plus rendering.
      case 'recall_claude_suggestions': {
        const params = RecallClaudeSuggestionsSchema.parse(args);
        requireRemote();

        const rows: Array<{ scope: string; rec: EngineRec }> = [];
        // Account scope is unconditional: it needs no code index, so this tool
        // still answers on a machine that has never run codeindex.
        const acct = await remoteGet<{ recommendations: EngineRec[] }>('/api/recommendations');
        for (const rec of partitionRecs(acct.recommendations ?? []).instruction) {
          rows.push({ scope: 'account', rec });
        }

        if (params.include_projects) {
          for (const pid of await codeProjectIds(params.project)) {
            // One unreadable project must not sink the whole answer.
            try {
              const r = await remoteGetQS<{ recommendations: EngineRec[] }>('/api/code/recommendations', { project: pid });
              for (const rec of partitionRecs(r.recommendations ?? []).instruction) rows.push({ scope: pid, rec });
            } catch { /* skip this project; the others still answer */ }
          }
        }

        const picked = rankInstructions(params.kind ? rows.filter((x) => x.rec.kind === params.kind) : rows);
        if (!picked.length) {
          return { content: [{ type: 'text', text: 'No agent-instruction suggestions — no leaked secrets, healthy session outcomes, and nothing in the indexed code that warrants a new rule.' }] };
        }

        const lines = [
          `# Claude suggestions (${picked.length})`, '',
          'Each item is a change to your agent instructions, most severe first.', '',
        ];
        for (const { scope, rec } of picked) {
          lines.push(`## [${rec.severity}] ${rec.title}`);
          lines.push(`*${rec.kind} · scope: ${scope}*`);
          lines.push(rec.rationale);
          if (rec.evidence?.length) lines.push(`Evidence: ${rec.evidence.join('; ')}`);
          if (rec.action?.type === 'append_claude_md') {
            const target = scope === 'account' ? 'global ~/.claude/CLAUDE.md' : `${scope} CLAUDE.md`;
            lines.push(`Apply → append to ${target}:`);
            lines.push('```\n' + String((rec.action.payload as { text?: string }).text ?? '') + '\n```');
          } else {
            lines.push(`Apply → ${rec.action?.type} ${JSON.stringify(rec.action?.payload ?? {})}`);
          }
          lines.push('');
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'recall_improvements': {
        const params = RecallImprovementsSchema.parse(args);
        requireRemote();
        const items: Improvement[] = [];

        // 1. Ranked code actions — already priority-ordered by the collector.
        try {
          const { actions } = await remoteGetQS<{ actions: EngineAction[] }>(
            '/api/code/actions', { project: params.project, limit: 200 });
          for (const a of (actions ?? []).filter(isOpenAction)) items.push(actionToImprovement(a));
        } catch { /* no code index on this server yet — recommendations still answer */ }

        // 2. The non-instruction half of the recommendations: reviews, labels,
        //    resets. partitionRecs is what keeps this tool and
        //    recall_claude_suggestions from ever returning the same item twice.
        try {
          const acct = await remoteGet<{ recommendations: EngineRec[] }>('/api/recommendations');
          for (const rec of partitionRecs(acct.recommendations ?? []).improvement) {
            items.push(recToImprovement(rec, 'account'));
          }
        } catch { /* account recs unavailable */ }
        for (const pid of await codeProjectIds(params.project)) {
          try {
            const r = await remoteGetQS<{ recommendations: EngineRec[] }>('/api/code/recommendations', { project: pid });
            for (const rec of partitionRecs(r.recommendations ?? []).improvement) {
              items.push(recToImprovement(rec, pid));
            }
          } catch { /* skip unreadable project */ }
        }

        const ranked = rankImprovements(items, { minSeverity: params.min_severity, limit: params.limit });
        if (!ranked.length) {
          return { content: [{ type: 'text', text: `No improvements at severity ${params.min_severity} or above. Run recall_code_index in a repo to get code-level findings.` }] };
        }

        // Writes happen only on request, and only after the list is settled, so
        // a task is never opened for an item the caller did not see returned.
        const created: string[] = [];
        const failed: string[] = [];
        if (params.create_tasks) {
          for (const i of ranked) {
            try {
              const { task } = await remotePost<{ task: { id: string } }>('/api/tasks', {
                title: i.title.slice(0, 500),
                description: taskBody(i),
                projectId: i.project,
                assigneeSub: params.assignee ?? null,
              });
              created.push(task.id);
            } catch (e) {
              failed.push(`${i.title}: ${e instanceof Error ? e.message : 'failed'}`);
            }
          }
        }

        const lines = [`# Improvements (${ranked.length}) — highest priority first`, ''];
        if (params.create_tasks) {
          lines.push(`Created ${created.length} of ${ranked.length} task(s) on the shared board. List them with recall_tasks.`);
          if (failed.length) {
            lines.push('', 'Failed to create:');
            for (const f of failed) lines.push(`- ${f}`);
            lines.push('', 'The team board is licence-gated on self-host, so a 402/403 here means collaboration is not enabled.');
          }
          lines.push('');
        }
        for (const [n, i] of ranked.entries()) {
          lines.push(`## ${n + 1}. [${i.severity}] ${i.title}`);
          lines.push(`*${i.source}${i.project ? ` · ${i.project}` : ''}*`);
          lines.push(i.detail);
          if (i.where.length) lines.push(`Where: ${i.where.slice(0, 6).join('; ')}`);
          if (i.agentPrompt) lines.push('Agent prompt:\n```\n' + i.agentPrompt + '\n```');
          lines.push('');
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }


      // ── Edits timeline (chronological tool_use list across recent sessions) ──
      case 'recall_edits_timeline': {
        const params = RecallEditsTimelineSchema.parse(args);

        // Aggregated rollup over the same window — /api/edits/summary had no MCP
        // surface, so only the row-by-row view was reachable.
        if (params.view === 'summary') {
          requireRemote();
          const r = await remoteGetQS<Record<string, unknown>>('/api/edits/summary', {
            since_hours: params.since_hours,
            project: params.project_filter,
            tools: params.tools?.join(','),
          });
          return { content: [{ type: 'text', text: `# Edit summary — last ${params.since_hours}h\n\n\`\`\`json\n${JSON.stringify(r, null, 2)}\n\`\`\`` }] };
        }

        // group_by "session" (absorbed from recall_files_touched): aggregate
        // the edit rows per session — "which sessions touched files matching
        // X?". Same /api/edits/timeline source, grouped instead of flat.
        if (params.group_by === 'session') {
          type GEdit = { sessionId: string; projectPath: string; file: string; ts: number };
          const resp = await remoteGetQS<{ total: number; edits: GEdit[] }>('/api/edits/timeline', {
            since_hours: params.since_hours,
            pattern: params.pattern,
            project: params.project_filter,
            include_reads: params.include_reads,
            tools: params.tools?.join(','),
            limit: 1000,
          });

          type Match = { sessionId: string; project: string; mtime: number; matchedFiles: string[] };
          const matchesById = new Map<string, Match>();
          for (const e of resp.edits || []) {
            const existing = matchesById.get(e.sessionId);
            if (existing) {
              if (!existing.matchedFiles.includes(e.file)) existing.matchedFiles.push(e.file);
              if (e.ts > existing.mtime) existing.mtime = e.ts;
              continue;
            }
            matchesById.set(e.sessionId, {
              sessionId: e.sessionId,
              project: e.projectPath || '(unknown)',
              mtime: e.ts,
              matchedFiles: [e.file],
            });
          }

          const matches = [...matchesById.values()].sort((a, b) => b.mtime - a.mtime);
          const trimmed = matches.slice(0, params.limit);

          if (trimmed.length === 0) {
            return { content: [{ type: 'text', text: `No sessions in the last ${params.since_hours}h touched files${params.pattern ? ` matching "${params.pattern}"` : ''}.` }] };
          }

          const header = params.pattern ? `"${params.pattern}"` : 'any file';
          const lines = [`# Files touched: ${header} (${matches.length} session${matches.length === 1 ? '' : 's'} in last ${params.since_hours}h)\n`];
          for (const m of trimmed) {
            const date = new Date(m.mtime).toISOString().slice(0, 10);
            lines.push(`- **${m.sessionId}** ${date} — ${m.project}`);
            for (const f of m.matchedFiles.slice(0, 5)) lines.push(`  · ${f}`);
            if (m.matchedFiles.length > 5) lines.push(`  · …and ${m.matchedFiles.length - 5} more`);
          }
          return { content: [{ type: 'text', text: withCodeindexHint(lines.join('\n'), 'files') }] };
        }

        // Server-backed: /api/edits/timeline runs the same cached/live edit
        // scan the Activity panel uses (cache-first from synced diff rows,
        // live-fallback only in local mode). It applies include_reads,
        // tool/project/pattern filters, the limit cap, and group_by_repo
        // tallies server-side, so we just format its response.
        type Edit = {
          ts: number; tsIso?: string; sessionId: string; projectPath: string;
          repoRoot: string | null; repoName: string | null; file: string;
          op: string; toolName: string; tool: string; line?: number;
        };
        type TimelineResp = {
          sinceHours: number; total: number; truncated: boolean;
          byTool: Record<string, number>;
          byProject: Record<string, number>;
          byRepo?: Record<string, { name: string; count: number; sample: string }>;
          edits: Edit[];
        };
        const resp = await remoteGetQS<TimelineResp>('/api/edits/timeline', {
          since_hours: params.since_hours,
          limit: params.limit,
          pattern: params.pattern,
          project: params.project_filter,
          include_reads: params.include_reads,
          tools: params.tools?.join(','),
          group_by_repo: params.group_by_repo,
        });

        if (resp.total === 0) {
          return {
            content: [{
              type: 'text',
              text: `No file edits in the last ${params.since_hours}h` +
                    (params.pattern ? ` matching "${params.pattern}"` : '') +
                    (params.project_filter ? ` in project "${params.project_filter}"` : '') + '.',
            }],
          };
        }

        // Header tool tally — comes straight off the server (computed over
        // the full filtered set, not just the returned page).
        const toolSummary = Object.entries(resp.byTool)
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => `${n} ${k}`).join(' · ');

        const sid = (sessionId: string) =>
          (getBackendForId(sessionId)?.toRawId(sessionId) ?? sessionId).slice(0, 8);
        const fmtTs = (e: Edit) =>
          (e.tsIso || new Date(e.ts).toISOString()).replace('T', ' ').slice(0, 19);

        if (params.group_by_repo) {
          // The server returns the authoritative per-repo counts (over the full
          // filtered set) in `byRepo`; the actual edit rows are the returned
          // page (`edits`, already limit-capped server-side). Group the page by
          // repoRoot for the table bodies, fall back to byRepo counts for the
          // true per-repo totals.
          const byRepo = resp.byRepo || {};
          const rowsByRepo = new Map<string, Edit[]>();
          let unmatched = 0;
          for (const e of resp.edits) {
            if (!e.repoRoot) { unmatched++; continue; }
            if (!rowsByRepo.has(e.repoRoot)) rowsByRepo.set(e.repoRoot, []);
            rowsByRepo.get(e.repoRoot)!.push(e);
          }
          const repoOrder = Object.entries(byRepo)
            .sort((a, b) => b[1].count - a[1].count)
            .map(([repo]) => repo);
          // Include any repo present in the page but missing from byRepo (defensive).
          for (const repo of rowsByRepo.keys()) if (!repoOrder.includes(repo)) repoOrder.push(repo);

          const lines = [
            `# Edits timeline — last ${params.since_hours}h (${resp.total} edit${resp.total === 1 ? '' : 's'})`,
            `_${toolSummary}_`,
            `_${repoOrder.length} repo(s)${unmatched ? ` · ${unmatched} edit(s) outside any git repo` : ''}_`,
            '',
          ];
          for (const repo of repoOrder) {
            const repoName = byRepo[repo]?.name || repo.split('/').filter(Boolean).pop() || repo;
            const total = byRepo[repo]?.count ?? (rowsByRepo.get(repo)?.length ?? 0);
            const rows = rowsByRepo.get(repo) || [];
            lines.push(`## ${repoName}  \`${repo}\` — ${total} edit(s)`);
            lines.push('| Time (UTC) | Tool | Session | Op | File |');
            lines.push('|---|---|---|---|---|');
            for (const e of rows) {
              const rel = e.file.startsWith(repo + '/') ? e.file.slice(repo.length + 1) : e.file;
              lines.push(`| ${fmtTs(e)} | ${e.tool} | \`${sid(e.sessionId)}\` | ${e.op} | ${rel} |`);
            }
            if (total > rows.length) {
              lines.push('');
              lines.push(`…${total - rows.length} more in this repo (raise \`limit\`).`);
            }
            lines.push('');
          }
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        const lines = [
          `# Edits timeline — last ${params.since_hours}h (${resp.total} edit${resp.total === 1 ? '' : 's'})`,
          `_${toolSummary}_`,
          '',
          '| Time (UTC) | Tool | Session | Op | File | Project |',
          '|---|---|---|---|---|---|',
        ];
        for (const e of resp.edits) {
          lines.push(`| ${fmtTs(e)} | ${e.tool} | \`${sid(e.sessionId)}\` | ${e.op} | ${e.file} | ${e.projectPath} |`);
        }
        if (resp.total > resp.edits.length) {
          lines.push('');
          lines.push(`…${resp.total - resp.edits.length} more edits truncated (raise \`limit\`).`);
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      // ── User prompts only ─────────────────────────────────────
      case 'recall_user_prompts': {
        const params = RecallUserPromptsSchema.parse(args);
        requireRemote();

        // There's no dedicated user-prompts endpoint server-side — the user
        // prompts are derived from the markers compute, which the session's
        // machine ships at sync time. Each prompt already carries its
        // sentiment `markers`, so `with_markers` is rendered from the server's
        // data (no local markPrompt re-run needed).
        type MarkerPrompt = { line: number; ts?: number; tsIso?: string; markers: string[]; text: string };
        type MarkersResp = { prompts: MarkerPrompt[]; summary: unknown };

        const renderPrompts = (rows: Array<{ sessionId: string; line: number; tsIso?: string; markers: string[]; text: string }>): string => {
          const lines = [`# User prompts (${rows.length})\n`];
          for (const p of rows) {
            const t = p.tsIso?.slice(0, 16).replace('T', ' ') || '';
            const snippet = p.text.length > 240 ? p.text.slice(0, 240) + '…' : p.text;
            const markerSuffix = params.with_markers && p.markers.length ? ` _[${p.markers.join(', ')}]_` : '';
            lines.push(`- **${p.sessionId}** L${p.line}${t ? ` · ${t}` : ''}${markerSuffix}`);
            lines.push(`  ${snippet.replace(/\n/g, ' ')}`);
          }
          return lines.join('\n');
        };

        // Single-session lookup — one markers call.
        if (params.session_id) {
          const soft = await remoteGetSoft<MarkersResp>(`/api/conversations/${encodeURIComponent(params.session_id)}/markers`);
          if (!soft.data) {
            return { content: [{ type: 'text', text: soft.message || (soft.status === 404 ? `Session ${params.session_id} not found.` : `Prompts not synced yet for ${params.session_id}.`) }] };
          }
          const rows = soft.data.prompts
            .filter(p => p.text && p.text.trim())
            .slice(0, params.limit)
            .map(p => ({ sessionId: params.session_id!, line: p.line, tsIso: p.tsIso, markers: p.markers || [], text: p.text }));
          if (rows.length === 0) {
            return { content: [{ type: 'text', text: 'No user prompts found.' }] };
          }
          return { content: [{ type: 'text', text: renderPrompts(rows) }] };
        }

        // Cross-session mode — pull the recent feed inside the time window,
        // then fan markers per session (newest first) until we hit the limit.
        const sinceHours = params.since_days * 24;
        const recent = await remoteGetQS<{ sessions: Array<{ sessionId: string }> }>(
          '/api/conversations/recent', { limit: 200, since_hours: sinceHours });
        const sessionIds = (recent.sessions || []).map(s => s.sessionId);
        if (sessionIds.length === 0) {
          return { content: [{ type: 'text', text: 'No user prompts found.' }] };
        }

        const collected: Array<{ sessionId: string; line: number; tsIso?: string; markers: string[]; text: string }> = [];
        for (const sid of sessionIds) {
          if (collected.length >= params.limit) break;
          const soft = await remoteGetSoft<MarkersResp>(`/api/conversations/${encodeURIComponent(sid)}/markers`);
          if (!soft.data) continue; // not synced yet / 404 — skip
          for (const p of soft.data.prompts) {
            if (!p.text || !p.text.trim()) continue;
            collected.push({ sessionId: sid, line: p.line, tsIso: p.tsIso, markers: p.markers || [], text: p.text });
            if (collected.length >= params.limit) break;
          }
        }

        if (collected.length === 0) {
          return { content: [{ type: 'text', text: 'No user prompts found (none of the recent sessions have synced markers yet).' }] };
        }
        return { content: [{ type: 'text', text: renderPrompts(collected) }] };
      }

      // ── Decision recording ────────────────────────────────────
      case 'recall_decision_record': {
        const params = RecallDecisionRecordSchema.parse(args);
        const wal = getWAL();
        wal.log('decision_record', { subject: params.subject, importance: params.importance });

        const confidence = Math.min(1, params.importance / 5);

        // 1) Knowledge-graph triple — durable, queryable, time-validated.
        // Server-backed via POST /api/kg/add (tenant-scoped on the server).
        await remotePost<{ id: string }>('/api/kg/add', {
          subject: params.subject,
          predicate: 'decided',
          object: params.decision,
          confidence,
          source_session: params.session_id,
        });
        if (params.reason) {
          await remotePost<{ id: string }>('/api/kg/add', {
            subject: params.subject,
            predicate: 'because',
            object: params.reason,
            confidence,
            source_session: params.session_id,
          });
        }

        // 2) Diary entry — readable narrative for the agent's own future reads.
        // Server-backed via POST /api/diary/write (stored as a synced diary
        // memory item, read back through recall_diary_read).
        const diaryText = params.reason
          ? `Decided: ${params.decision}\nSubject: ${params.subject}\nWhy: ${params.reason}`
          : `Decided: ${params.decision}\nSubject: ${params.subject}`;
        const diary = await remotePost<{ id: string }>('/api/diary/write', {
          agent_name: params.agent_name,
          topic: 'decision',
          entry: diaryText,
          session_id: params.session_id,
        });

        return {
          content: [{
            type: 'text',
            text: `Decision recorded.\n- KG: ${params.subject} → decided → ${params.decision}\n- Diary entry: ${diary.id} (importance ${params.importance})`,
          }],
        };
      }

      // ── Analytics summary ──────────────────────────────────────
      case 'recall_analytics_summary': {
        const analyticsParams = RecallAnalyticsSummarySchema.parse(args ?? {});
        requireRemote();

        // Behavioural patterns across sessions — same analytics family, no MCP
        // surface until now.
        if (analyticsParams.view === 'patterns') {
          const r = await remoteGet<Record<string, unknown>>('/api/analytics/patterns');
          return { content: [{ type: 'text', text: '# Session patterns\n\n```json\n' + JSON.stringify(r, null, 2) + '\n```' }] };
        }

        // Same analytics aggregate the dashboard renders. The server already
        // computed all per-project / per-tool / per-model rollups (single
        // engine pricing source), so we just format its fields.
        type Analytics = {
          summary: { totalSessions: number; totalCostUsd: number; avgCostPerSession: number; sessionsWithoutPricing: number };
          projects: Array<{ name: string; sessions: number; totalCost: number }>;
          tools: Array<{ tool: string; sessions: number }>;
          models: Array<{ model: string; sessions: number }>;
          periodComparison: {
            thisWeek: { sessions: number; cost: number };
            lastWeek: { sessions: number; cost: number };
          };
        };
        const a = await remoteGet<Analytics>('/api/analytics');
        const s = a.summary;

        const topByCost = [...a.projects]
          .sort((x, y) => y.totalCost - x.totalCost).slice(0, 5)
          .map(p => `  ${p.name.padEnd(28)} $${p.totalCost.toFixed(2).padStart(8)}  (${p.sessions} sessions)`);
        const topTools = a.tools.slice(0, 5)
          .map(t => `  ${t.tool.padEnd(15)} ${t.sessions}`);
        const topModels = a.models.slice(0, 5)
          .map(m => `  ${m.model.padEnd(35)} ${m.sessions} sessions`);

        const weekNow = a.periodComparison.thisWeek.cost;
        const weekPrev = a.periodComparison.lastWeek.cost;
        const delta = weekPrev > 0 ? ((weekNow - weekPrev) / weekPrev) * 100 : null;
        const deltaStr = delta === null
          ? '(no prior-week data)'
          : `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}% vs last week`;

        const lines = [
          '# Analytics Summary',
          '',
          `**Total sessions:** ${s.totalSessions}`,
          `**Total cost (priced):** $${s.totalCostUsd.toFixed(2)}`,
          `**Avg / priced session:** $${s.avgCostPerSession.toFixed(2)}`,
          `**Sessions without pricing:** ${s.sessionsWithoutPricing} (Gemini / Ollama / custom — cost not estimated)`,
          '',
          `**This week:** $${weekNow.toFixed(2)} · ${deltaStr}`,
          '',
          '## Top projects by cost',
          ...(topByCost.length ? topByCost : ['  (none)']),
          '',
          '## Top tools used',
          ...(topTools.length ? topTools : ['  (none)']),
          '',
          '## Top models',
          ...(topModels.length ? topModels : ['  (none)']),
        ];
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }




      // ── KV store ───────────────────────────────────────────────
      case 'recall_set': {
        const params = RecallSetSchema.parse(args);
        const wal = getWAL();
        wal.log('kv_set', { scope: params.scope, key: params.key });

        requireRemote();
        await remotePost('/api/kv/set', { scope: params.scope, key: params.key, value: params.value });

        return { content: [{ type: 'text', text: `Set ${params.scope}:${params.key} (${params.value.length} chars)` }] };
      }

      case 'recall_get': {
        const params = RecallGetSchema.parse(args);
        requireRemote();

        // List mode (absorbed from recall_kv_list): no key → enumerate the
        // scope's entries; no scope either → list across ALL scopes.
        if (!params.key) {
          const { entries: rows } = await remoteGetQS<{ entries: Array<{ scope: string; key: string; value: string; updated_at: number }> }>(
            '/api/kv/list', { scope: params.scope, limit: params.limit });
          if (rows.length === 0) {
            return {
              content: [{
                type: 'text',
                text: params.scope ? `No keys in scope "${params.scope}".` : 'No KV entries yet.',
              }],
            };
          }
          const lines = [`# KV entries (${rows.length})\n`];
          for (const r of rows) {
            const preview = r.value.length > 80 ? r.value.slice(0, 80) + '…' : r.value;
            const ago = Math.floor((Date.now() - r.updated_at) / 1000);
            lines.push(`- **${r.scope}:${r.key}** — ${preview}  _(${ago}s ago)_`);
          }
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        const scope = params.scope ?? 'default';
        const { entry: row } = await remoteGetQS<{ entry: { value: string; updated_at: number } | null }>(
          '/api/kv/get', { scope, key: params.key });
        if (!row) return { content: [{ type: 'text', text: `(no value at ${scope}:${params.key})` }] };
        const ago = Math.floor((Date.now() - row.updated_at) / 1000);
        return {
          content: [{
            type: 'text',
            text: `${scope}:${params.key} (set ${ago}s ago)\n\n${row.value}`,
          }],
        };
      }


      // ── Wake-up context ────────────────────────────────────────
      case 'recall_wake_up': {
        const parsedWake = RecallWakeUpSchema.parse(args);
        const params = { ...parsedWake, project_filter: parsedWake.project_filter ?? parsedWake.project };

        // Identity: param > file > default. The file lets users seed a stable
        // self-description that survives across sessions ("I'm Adi's coding agent…").
        let identity = params.identity ?? 'AI coding assistant';
        // Never read the identity file when serving many callers: that file is
        // the SERVER's, so its contents would be handed to every remote caller
        // as their own identity. Empty in the shipped image, which makes this a
        // latent leak rather than a live one — and a latent leak is the kind
        // that ships.
        if (!params.identity && !isMultiTenant()) {
          const idFile = getIdentityFilePath();
          if (existsSync(idFile)) {
            try { identity = readFileSync(idFile, 'utf-8').trim() || identity; } catch {}
          }
        }

        const lines = [
          '# Wake-Up Context',
          '',
          '## Identity',
          identity,
          '',
        ];
        if (params.project_filter) {
          lines.push(`_Scoped to project filter: \`${params.project_filter}\`_`);
          lines.push('');
        }

        // High-importance facts (classifier-tagged) + current KG snapshot, both
        // computed server-side from the synced store (the collector has no local
        // index). Identity stays local above — it's a tiny per-machine file.
        requireRemote();
        const wake = await remoteGetQS<{
          highFacts: Array<{ type: string; text: string }>;
          kg: { stats: { entities?: number; current_facts?: number }; facts: Array<{ subject: string; predicate: string; object: string }> };
        }>('/api/memory/wake-up', {
          project_filter: params.project_filter, max_facts: params.max_facts, max_kg_facts: params.max_kg_facts,
        });

        const ot = (wake as { openTasks?: { total: number; auto: number } }).openTasks;
        if (ot && ot.total > 0) {
          const scope = (ot as { scope?: string }).scope;
          lines.push('## Task board');
          lines.push(`  ${ot.total} open task(s)${scope ? ` in \`${scope}\`` : ''}${ot.auto ? ` — ${ot.auto} auto-filed from code findings` : ''}.`);
          // The point of saying this at wake-up is that the agent can act on it
          // in one call. `detail: true` returns the fix, the locations and the
          // agent prompt per task, so there is nothing left to fetch.
          lines.push('  Offer to work them: `recall_tasks` with `detail: true`'
            + `${scope ? ` and \`project\`` : ''} returns each task's fix, file locations and agent prompt.`);
          lines.push('  Claim one before editing: `recall_task_update` with `status: "in_progress"` and your session id as `linked_session_id`.');
          lines.push('  You close them, not the user: `done` is refused without a linked session, because the board shows the diff behind it.');
          lines.push('');
        }

        if (wake.highFacts.length > 0) {
          lines.push('## High-importance facts');
          for (const c of wake.highFacts) lines.push(`  [${c.type}] ${c.text}`);
          lines.push('');
        } else if (params.project_filter) {
          lines.push('## High-importance facts');
          lines.push(`  _no classifier hits for project filter \`${params.project_filter}\`_`);
          lines.push('');
        }

        if (wake.kg.facts.length > 0) {
          lines.push('## Knowledge graph (current facts)');
          lines.push(`  ${wake.kg.stats.entities ?? 0} entities, ${wake.kg.stats.current_facts ?? 0} current facts`);
          for (const f of wake.kg.facts) lines.push(`  ${f.subject} → ${f.predicate} → ${f.object}`);
          lines.push('');
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }


      case 'recall_security_summary': {
        const params = RecallSecuritySummarySchema.parse(args);
        requireRemote();

        // Alternate groupings of the same findings — endpoints that existed with
        // no MCP surface at all. Kept as a `group_by` param rather than four more
        // tools, matching how recall_edits_timeline absorbs `group_by`.
        if (params.group_by !== 'detector') {
          // Field names below are the store's actual columns (pg.ts:477-500):
          // `occurrences`, `distinctSecrets`, `verified`, `sessions`,
          // `project_path`. Guessing them printed "undefined" in a live call.
          if (params.group_by === 'rule') {
            const r = await remoteGet<{ rules: Array<{ rule: string; detector?: string; occurrences?: number; distinctSecrets?: number; sessions?: number }> }>('/api/secrets/by-rule');
            const lines = ['# Secret findings by rule\n'];
            for (const x of r.rules ?? []) {
              lines.push(`- **${x.rule}**${x.detector ? ` (${x.detector})` : ''} — ${x.distinctSecrets ?? 0} distinct, ${x.occurrences ?? 0} occurrence(s) across ${x.sessions ?? 0} session(s)`);
            }
            if (!r.rules?.length) lines.push('_No findings._');
            return { content: [{ type: 'text', text: lines.join('\n') }] };
          }
          if (params.group_by === 'project') {
            const r = await remoteGet<{ projects: Array<{ project_path?: string; occurrences?: number; distinctSecrets?: number; verified?: number; sessions?: number }> }>('/api/secrets/by-project');
            const lines = ['# Secret findings by project\n'];
            for (const x of r.projects ?? []) {
              lines.push(`- **${x.project_path || '(unknown)'}** — ${x.distinctSecrets ?? 0} distinct${x.verified ? `, ${x.verified} verified live` : ''} across ${x.sessions ?? 0} session(s)`);
            }
            if (!r.projects?.length) lines.push('_No findings._');
            return { content: [{ type: 'text', text: lines.join('\n') }] };
          }
          if (params.group_by === 'trend') {
            const r = await remoteGetQS<{ days: number; trend: Array<{ day: string; occurrences?: number; distinctSecrets?: number; verified?: number }> }>(
              '/api/secrets/trend', { days: params.days });
            const lines = [`# Secret findings trend — last ${r.days ?? params.days}d\n`];
            for (const d of r.trend ?? []) {
              lines.push(`- ${d.day}: ${d.distinctSecrets ?? 0} distinct, ${d.occurrences ?? 0} occurrence(s)${d.verified ? `, ${d.verified} verified live` : ''}`);
            }
            if (!r.trend?.length) lines.push('_No data in window._');
            return { content: [{ type: 'text', text: lines.join('\n') }] };
          }
          // sessions
          const r = await remoteGetQS<{ sessions: Array<{ sessionId: string; total?: number; byDetector?: Record<string, number> }> }>(
            '/api/secrets/sessions', { min: params.min_detectors });
          const lines = ['# Sessions with secret findings\n'];
          for (const s of (r.sessions ?? []).slice(0, params.top_k)) {
            const det = s.byDetector ? Object.entries(s.byDetector).map(([k, n]) => `${k}:${n}`).join(' · ') : '';
            lines.push(`- **${s.sessionId}** — ${s.total ?? 0} finding(s)${det ? ` · ${det}` : ''}`);
          }
          if (!r.sessions?.length) lines.push('_No sessions with findings._');
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        const [summary, distinct] = await Promise.all([
          remoteGet<{ detectors: any[]; total: number; verified: number; bySeverity?: Record<string, number> }>('/api/secrets/summary'),
          remoteGetQS<any>('/api/secrets/distinct', { include_dismissed: params.include_dismissed }),
        ]);
        const lines = ['# Security findings summary'];
        lines.push(`Total findings: ${summary.total} · Verified live: ${summary.verified}`);
        if (summary.bySeverity) {
          const sev = Object.entries(summary.bySeverity).filter(([, n]) => n > 0).map(([k, n]) => `${k}: ${n}`).join(' · ');
          if (sev) lines.push(`By severity: ${sev}`);
        }
        const list = (distinct.secrets || []).slice(0, params.top_k);
        if (list.length === 0) {
          lines.push('\nNo actionable secrets found.');
        } else {
          lines.push(`\n## Action-required secrets (${list.length} shown)`);
          for (const s of list) {
            const rules = (s.rules as Array<{ detector: string; rule: string }>).map((r) => `${r.detector}/${r.rule}`).join(', ');
            lines.push(`- \`${s.preview}\` — ${rules} · ${s.sessionCount} session(s) · ${s.occurrences} occurrence(s)`);
          }
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'recall_security_session': {
        const params = RecallSecuritySessionSchema.parse(args);
        requireRemote();
        type SessionSecretFinding = { rule: string; line: number; preview: string; crossSessionCount: number };
        type SessionSecretResponse = { sessionId: string; total: number; byDetector: Record<string, SessionSecretFinding[]> };
        const data = await remoteGet<SessionSecretResponse>(`/api/secrets/session/${encodeURIComponent(params.session_id)}`);
        const lines = [`# Secret findings for ${data.sessionId}`, `Total: ${data.total}`];
        for (const [detector, findings] of Object.entries(data.byDetector)) {
          lines.push(`\n## ${detector}`);
          for (const f of findings) {
            lines.push(`- line ${f.line}: \`${f.preview}\` (${f.rule}) — appears in ${f.crossSessionCount} other session(s)`);
          }
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'recall_recommendation_apply': {
        const params = RecallRecommendationApplySchema.parse(args);
        requireRemote();
        const r = await remotePost<{ ok: boolean; applied?: boolean; queued?: boolean; message?: string }>(
          `/api/code/recommendations/${encodeURIComponent(params.id)}/apply`, { project: params.project });
        // The route distinguishes applied-now from queued-for-your-machine, and
        // the difference matters to the caller: a queued CLAUDE.md edit is not on
        // disk yet, so an agent that immediately reads the file would not see it.
        return { content: [{ type: 'text', text: r.message
          || (r.queued ? 'Queued for your machine — it lands on the next drain (~45s).' : 'Applied.') }] };
      }

      case 'recall_recommendation_dismiss': {
        const params = RecallRecommendationDismissSchema.parse(args);
        requireRemote();
        if (params.undo) {
          await remotePost(`/api/code/recommendations/${encodeURIComponent(params.id)}/undismiss`,
            { project: params.project });
          return { content: [{ type: 'text', text: `Restored ${params.id} — it will be offered again.` }] };
        }
        await remotePost(`/api/code/recommendations/${encodeURIComponent(params.id)}/dismiss`,
          { project: params.project, reason: params.reason });
        return { content: [{ type: 'text', text:
          `Dismissed ${params.id} for ${params.project}: ${params.reason}\n\n`
          + '_Tell the user — this changes how future sessions treat their repo._' }] };
      }

      case 'recall_project_label': {
        const params = RecallProjectLabelSchema.parse(args);
        requireRemote();
        const label = params.label === 'none' ? null : params.label;
        await remotePatch(`/api/code/projects/${encodeURIComponent(params.project)}/label`, { label });
        return { content: [{ type: 'text', text: label
          ? `${params.project} is now labelled ${label}. Every future session in this repo reads it.`
          : `Cleared the label on ${params.project}.` }] };
      }

      case 'recall_security_dismiss': {
        const params = RecallSecurityDismissSchema.parse(args);
        requireRemote();
        // The inverse operation existed server-side but had no MCP surface, so a
        // finding could be dismissed by an agent and never put back.
        if (params.status === 'undismissed') {
          await remotePost('/api/secrets/undismiss', { preview: params.preview });
          return { content: [{ type: 'text', text: `Restored \`${params.preview}\` to the action-required list.` }] };
        }
        await remotePost('/api/secrets/dismiss', {
          preview: params.preview,
          status: params.status,
          reason: params.reason ?? '',
        });
        return { content: [{ type: 'text', text: `Dismissed \`${params.preview}\` as ${params.status}.` }] };
      }

      case 'recall_toolkit_status': {
        const params = RecallToolkitStatusSchema.parse(args);
        requireRemote();
        const types = params.type ? [params.type] : [...TOOLKIT_TYPES];

        // Types the server cannot rebuild elsewhere. Saying so here stops an
        // agent queueing a skill sync that can never land, and then reporting
        // success because the queue accepted it.
        const REBUILDABLE: Record<string, string> = {
          mcp: 'yes — a registration is config, and the whole entry is stored',
          skill: 'yes — the full file is stored, so it can be written on any machine',
          agent: 'yes — the body is converted to each tool\'s own encoding (markdown or TOML)',
          command: 'yes — same as agents, converted per tool',
          instructions: 'no, deliberately — a CLAUDE.md belongs to a repo, not to a machine',
        };

        const lines: string[] = ['# Toolkit inventory', ''];
        for (const type of types) {
          let items: Array<{ title: string; extra_json?: string | null }> = [];
          try {
            const r = await remoteGetQS<{ items?: typeof items }>(`/api/toolkit/browse/${type}`, { limit: 1000 });
            items = r.items || [];
          } catch (err) {
            lines.push(`## ${type}`, `_could not read: ${err instanceof Error ? err.message : err}_`, '');
            continue;
          }
          const byTool = new Map<string, number>();
          const byDevice = new Map<string, number>();
          let rebuildable = 0;
          for (const it of items) {
            let e: Record<string, unknown> = {};
            try { e = JSON.parse(it.extra_json || '{}'); } catch { /* row without extra */ }
            byTool.set(String(e.tool || '?'), (byTool.get(String(e.tool || '?')) || 0) + 1);
            byDevice.set(String(e.syncedDeviceId || '?'), (byDevice.get(String(e.syncedDeviceId || '?')) || 0) + 1);
            if (type === 'mcp' && e.spec) rebuildable++;
            if ((type === 'skill' || type === 'agent' || type === 'command') && typeof e.body === 'string' && e.body) rebuildable++;
          }
          lines.push(`## ${type} — ${items.length}`);
          if (byTool.size) lines.push(`- by tool: ${[...byTool].map(([k, v]) => `${k} ${v}`).join(' · ')}`);
          if (byDevice.size) lines.push(`- by device: ${[...byDevice].map(([k, v]) => `${k} ${v}`).join(' · ')}`);
          lines.push(`- installable on another device: ${REBUILDABLE[type]}`);
          if (type === 'skill' || type === 'agent' || type === 'command') {
            lines.push(`- carrying a full body: ${rebuildable}/${items.length}`
              + (rebuildable < items.length ? ' — the rest need a re-index on their source device' : ''));
          }
          if (type === 'mcp') {
            lines.push(`- carrying a rebuild spec: ${rebuildable}/${items.length}`
              + (rebuildable < items.length ? ' — the rest need a re-index on their source device' : ''));
          }
          lines.push('');
        }
        lines.push('Queue an install with `recall_toolkit_sync`.');
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'recall_toolkit_sync': {
        const params = RecallToolkitSyncSchema.parse(args);
        requireRemote();
        if (params.name && (params.types?.length ?? 0) !== 1) {
          // A bare name is ambiguous — a skill and an MCP can share one.
          return { content: [{ type: 'text', text: 'A `name` needs exactly one entry in `types`, so the artifact is unambiguous.' }] };
        }
        if (params.scope === 'fan_out' && !params.device) {
          // fan_out reads one machine's disk, so "every device" is meaningless.
          return { content: [{ type: 'text', text: '`fan_out` copies between ONE machine\'s own tools — name the machine with `device`.' }] };
        }

        const body = params.scope === 'fan_out'
          ? { kind: 'sync_all', deviceId: params.device }
          : { kind: 'pull', types: params.types, name: params.name, deviceId: params.device ?? null };
        const r = await remotePost<{ ok?: boolean; id?: string; error?: string }>('/api/sync-intents', body);
        if (!r.id) return { content: [{ type: 'text', text: `Queue refused it: ${r.error || 'unknown error'}` }] };

        const what = params.name ? `"${params.name}"`
          : params.types?.length ? params.types.join(', ')
          : 'every artifact type';
        const where = params.device ? `on ${params.device}` : 'on every device on this account';
        return {
          content: [{
            type: 'text',
            text: [
              `Queued: ${params.scope === 'fan_out' ? 'fan out' : 'install'} ${what} ${where}.`,
              `Intent id: ${r.id}`,
              '',
              // The queue accepting is NOT the work happening. Saying so stops
              // an agent reporting success for something that has not run.
              'QUEUED, NOT DONE. Only the target device can write its own config',
              'files, so it performs this on its next drain — the watch daemon polls,',
              'or run `chat-recall toolkit drain` there to do it now.',
              '',
              'Check the result with `recall_toolkit_status`.',
            ].join('\n'),
          }],
        };
      }

      case 'recall_security_rules': {
        const params = RecallSecurityRulesSchema.parse(args);
        requireRemote();
        if (params.action === 'test') {
          if (!params.regex || params.sample === undefined) {
            return { content: [{ type: 'text', text: 'test action requires `regex` and `sample`.' }] };
          }
          const r = await remotePost<{ count: number; matches: Array<{ match: string; index: number }> }>('/api/secrets/rules/test', { regex: params.regex, sample: params.sample });
          const lines = [`Regex matches: ${r.count}`];
          for (const m of r.matches.slice(0, 20)) lines.push(`- index ${m.index}: \`${m.match}\``);
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }
        const data = await remoteGet<{ rules: Array<{ id: number; name: string; regex: string; severity: string; enabled: boolean; description?: string }> }>('/api/secrets/rules');
        const lines = ['# Tenant secret-detection rules'];
        for (const rule of data.rules) {
          lines.push(`- ${rule.enabled ? '✓' : '✗'} **${rule.name}** (${rule.severity}) \`${rule.regex}\`${rule.description ? ' — ' + rule.description : ''}`);
        }
        if (data.rules.length === 0) lines.push('_No custom rules configured._');
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'recall_subagent_search': {
        const params = RecallSubagentSearchSchema.parse(args);
        requireRemote();
        const clean = sanitizeQuery(params.query).cleanQuery;
        const data = await remoteGetQS<{ hits: Array<{ sessionId: string; subagent: string; kind: string; lineHits: number; sample: string }> }>(
          '/api/subagents/search',
          { query: clean, session_id: params.session_id, kind: params.kind, limit: params.limit },
        );
        if (!data.hits?.length) {
          return { content: [{ type: 'text', text: `No subagent transcripts match "${params.query}".` }] };
        }
        const lines = [`# Subagent matches for "${params.query}" (${data.hits.length})\n`];
        for (const h of data.hits) {
          lines.push(`- **${h.sessionId}** · ${h.kind} · ${h.lineHits} hit${h.lineHits === 1 ? '' : 's'}`);
          lines.push(`  ${h.sample.replace(/\n/g, ' ').slice(0, 240)}`);
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'recall_redundant_files': {
        const params = RecallRedundantFilesSchema.parse(args);
        requireRemote();
        const data = await remoteGetQS<{ hits: Array<{ file: string; sessionId: string; project: string; mtime: number; score: number; reason: string }> }>(
          '/api/files/redundant',
          { filename: params.filename, project: params.project, limit: params.limit },
        );
        if (!data.hits?.length) {
          return { content: [{ type: 'text', text: `No prior files resemble \`${params.filename}\` — looks new.` }] };
        }
        const lines = [`# Files resembling \`${params.filename}\` (${data.hits.length})`, '_You may have built this before._\n'];
        for (const h of data.hits) {
          const when = h.mtime ? new Date(h.mtime).toISOString().slice(0, 10) : '';
          lines.push(`- \`${h.file}\` — ${h.reason} (score ${h.score})`);
          lines.push(`  ${h.project || '(no project)'} · ${h.sessionId}${when ? ` · ${when}` : ''}`);
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'recall_heal_audit': {
        const params = RecallHealAuditSchema.parse(args);
        requireRemote();
        const r = await remoteGetQS<{ scanned: number; damaged: number; healed: number; healthy: number; applied: boolean; damagedIds?: string[]; sinceHours?: number; eligible?: number; truncated?: boolean; notScanned?: number }>(
          '/api/conversations/heal-audit',
          { since_hours: params.since_hours, apply: params.apply ? '1' : undefined },
        );
        const lines = [
          `# Transcript integrity${r.sinceHours ? ` (last ${r.sinceHours}h)` : ''}`,
          '',
          `- scanned: **${r.scanned}**`,
          `- healthy: **${r.healthy}**`,
          `- damaged: **${r.damaged}**${r.damaged ? ' — the archive holds more than the rendered view' : ' ✅'}`,
        ];
        // A CAP MUST NEVER BE SILENT. "0 damaged" over 500 of 15,000 sessions is
        // not "your history is intact", and an agent cannot tell the difference
        // unless the answer says so.
        if (r.truncated) {
          lines.push(
            `- **not scanned: ${r.notScanned}** of ${r.eligible} sessions in this window`,
            '',
            'This audit is capped so it answers within the request timeout. '
            + 'Narrow it with `since_hours` to cover a window completely; the hourly '
            + 'server sweep covers everything with no cap.',
          );
        }
        if (r.applied) lines.push(`- healed this run: **${r.healed}**`);
        else if (r.damaged) lines.push('', 'Re-run with `apply: true` to heal, or run `chat-recall repair`.');
        if (r.damagedIds?.length) {
          lines.push('', 'Damaged sessions:');
          for (const id of r.damagedIds.slice(0, 25)) lines.push(`- ${id}`);
          if (r.damagedIds.length > 25) lines.push(`- …and ${r.damagedIds.length - 25} more`);
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'recall_memory_item': {
        const params = RecallMemoryItemSchema.parse(args);
        requireRemote();
        const st = encodeURIComponent(params.source_type);

        if (params.mode === 'browse') {
          const data = await remoteGetQS<{ items: Array<{ id: string; title?: string; project_path?: string; mtime?: number }> }>(
            `/api/memory/browse/${st}`, { limit: params.limit });
          if (!data.items?.length) return { content: [{ type: 'text', text: `No ${params.source_type} items indexed.` }] };
          const lines = [`# ${params.source_type} items (${data.items.length})\n`];
          for (const it of data.items) {
            const when = it.mtime ? new Date(it.mtime).toISOString().slice(0, 10) : '';
            lines.push(`- **${it.id}**${it.title ? ` — ${it.title}` : ''}${when ? ` · ${when}` : ''}`);
          }
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        if (!params.id) {
          return { content: [{ type: 'text', text: 'id is required unless mode=browse.' }] };
        }
        const idEnc = encodeURIComponent(params.id);

        if (params.mode === 'links') {
          const soft = await remoteGetSoft<{ links: Array<{ from_type: string; from_id: string; to_type: string; to_id: string; link_type: string }> }>(
            `/api/memory/links/${st}/${idEnc}`);
          if (!soft.data) return { content: [{ type: 'text', text: soft.message || `No links for ${params.id}.` }] };
          const links = soft.data.links ?? [];
          if (!links.length) return { content: [{ type: 'text', text: `No links recorded for ${params.id}.` }] };
          const lines = [`# Links for ${params.source_type} ${params.id} (${links.length})\n`];
          for (const l of links) lines.push(`- ${l.from_type}:${l.from_id} —${l.link_type}→ ${l.to_type}:${l.to_id}`);
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        if (params.mode === 'content') {
          const soft = await remoteGetSoft<{ content?: string }>(`/api/memory/item/${st}/${idEnc}/content`);
          if (!soft.data?.content) return { content: [{ type: 'text', text: soft.message || `No content stored for ${params.id}.` }] };
          return { content: [{ type: 'text', text: soft.data.content }] };
        }

        const soft = await remoteGetSoft<Record<string, unknown>>(`/api/memory/item/${st}/${idEnc}`);
        if (!soft.data) return { content: [{ type: 'text', text: soft.message || `${params.source_type} ${params.id} not found.` }] };
        return { content: [{ type: 'text', text: '```json\n' + JSON.stringify(soft.data, null, 2) + '\n```' }] };
      }

      case 'recall_regenerate_summary': {
        const params = RecallRegenerateSummarySchema.parse(args);
        requireRemote();
        const r = await remotePost<{ ok?: boolean; summary?: string; message?: string; error?: string }>(
          `/api/conversations/${encodeURIComponent(params.session_id)}/regenerate-summary`, {});
        if (r.summary) {
          return { content: [{ type: 'text', text: `# Regenerated summary — ${params.session_id}\n\n${r.summary}` }] };
        }
        return { content: [{ type: 'text', text: r.message || r.error || 'Summary regeneration requested.' }] };
      }

      case 'recall_outcome_summary': {
        const params = RecallOutcomeSummarySchema.parse(args);
        requireRemote();
        const r = await remoteGetQS<Record<string, unknown>>('/api/conversations/outcome-summary', { days: params.days });
        return { content: [{ type: 'text', text: `# Session outcomes — last ${params.days}d\n\n\`\`\`json\n${JSON.stringify(r, null, 2)}\n\`\`\`` }] };
      }

      case 'recall_shares': {
        const params = RecallSharesSchema.parse(args);
        requireRemote();
        const path = params.scope === 'all' ? '/api/shares/all' : '/api/shares';
        const r = await remoteGet<{ shares?: Array<{ project_id?: string; projectId?: string; user_sub?: string }> }>(path);
        const shares = r.shares ?? [];
        if (!shares.length) {
          return { content: [{ type: 'text', text: params.scope === 'all' ? 'No projects are shared in your team.' : 'You have not shared any projects. Everything stays private until shared.' }] };
        }
        const lines = [`# Shared projects (${params.scope}, ${shares.length})\n`];
        for (const s of shares) lines.push(`- ${s.project_id ?? s.projectId ?? '(unknown)'}${s.user_sub ? ` · ${s.user_sub}` : ''}`);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'recall_reclassify': {
        RecallReclassifySchema.parse(args ?? {});
        requireRemote();
        const r = await remotePost<{ message?: string; scanned?: number; updated?: number; error?: string }>('/api/memory/reclassify', {});
        if (r.error) return { content: [{ type: 'text', text: `Reclassify unavailable: ${r.error}` }] };
        return { content: [{ type: 'text', text: `${r.message ?? 'Reclassify complete'} — scanned ${r.scanned ?? 0}, updated ${r.updated ?? 0}.` }] };
      }

      case 'recall_help': {
        // Advertised only in the lean profile, and it must answer honestly: the
        // unlisted tools are not disabled, just not put in front of the model.
        const lines = [
          '# chat-recall tools not registered in this profile',
          '',
          'They all still work — call them by name. To register every tool up front,',
          'set CHAT_RECALL_MCP_PROFILE=full and restart the MCP server.',
          '',
        ];
        const groups: Array<[string, string[]]> = [
          ['Aggregate views', ['recall_weekly_digest', 'recall_analytics_summary', 'recall_team_activity', 'recall_outcome_summary']],
          ['Task board', ['recall_task_comment']],
          ['Knowledge graph', ['recall_kg_timeline', 'recall_kg_stats', 'recall_kg_invalidate']],
          ['Session detail', ['recall_markers', 'recall_subagent_search', 'recall_memory_item', 'recall_rename_session', 'recall_regenerate_summary']],
          ['Code intelligence', ['recall_code_index', 'recall_code_projects', 'recall_code_findings', 'recall_code_actions']],
          ['Recommendations', ['recall_recommendations', 'recall_improvements', 'recall_claude_suggestions', 'recall_redundant_files']],
          ['Security triage', ['recall_security_session', 'recall_security_dismiss', 'recall_security_rules']],
          ['State + maintenance', ['recall_set', 'recall_get', 'recall_shares', 'recall_reclassify', 'recall_heal_audit']],
        ];
        for (const [label, names] of groups) {
          lines.push(`## ${label}`, names.map((n) => `- ${n}`).join('\n'), '');
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }
  } catch (err) {
    // Friendlier error surface. Network-level failures (undici throws
    // TypeError("fetch failed") when the socket can't be opened) get one
    // actionable line instead of a stack fragment; everything else keeps its
    // message (HTTP errors from remoteGet/Post are already status + hint,
    // never the raw response body).
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof TypeError && /fetch failed/i.test(msg)) {
      // Offline / server down — expected, not a bug. Don't report (the report
      // itself couldn't send anyway).
      return { content: [{ type: 'text', text: 'chat-recall server unreachable — is it up / are you logged in? (chat-recall login <url>)' }] };
    }
    // A real tool failure — surface it to the caller AND report it so the
    // operator sees recurring breakage per customer.
    reportClientEvent('tool_error', { tool: name, message: msg });
    return { content: [{ type: 'text', text: `Error: ${msg}` }] };
  }
}


// ── Exports ─────────────────────────────────────────────────────────────
// createMcpServer() builds an instance with every tool handler above attached.
// The stdio entry point makes one for the process; the remote endpoint makes one
// per authenticated session. `dispatchTool` is exported for tests and for a host
// that wants to call a tool without a transport at all.
export { dispatchTool };
