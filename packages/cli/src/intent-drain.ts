/**
 * Cross-tool sync intent drainer (Model B, local executor side).
 *
 * The web UI (local or SaaS) enqueues intents on the server. This runs on the
 * user's machine — where the actual `~/.claude` / `~/.config/opencode` dirs
 * live — polls each logged-in server for pending intents, performs the
 * filesystem copy via the engine executor, and acks status back.
 *
 * Invoked on a short interval from the watch daemon, and once via the
 * `chat-recall toolkit drain` command.
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { fetchWithTimeout } from './http.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadAllCredentials, syncIncremental } from './sync-client.js';
// Concrete module, NOT the engine barrel: the barrel statically re-exports
// MemoryIndex -> @lancedb/lancedb, and a static barrel import hoists that
// native dep to boot-time in the published bundle (breaks fresh installs).
import {
  executeSyncAll, executeCopy,
  type SyncType, type TargetTool as SyncTargetTool,
} from '@chat-recall/engine/core/toolkit-sync.js';
import {
  instructionsFilename, instructionsPath, type ToolId,
} from '@chat-recall/engine/core/artifact-codec.js';
import { claudeBackend } from '@chat-recall/engine/core/backends/claude.js';
import { codexBackend } from '@chat-recall/engine/core/backends/codex.js';
import { cursorBackend } from '@chat-recall/engine/core/backends/cursor.js';
import { opencodeBackend } from '@chat-recall/engine/core/backends/opencode.js';
import { agyBackend } from '@chat-recall/engine/core/backends/agy.js';
import { pushProjectTaskStatuses } from './project-tasks.js';

export interface PendingIntent {
  id: string;
  kind: 'copy' | 'sync_all' | 'pull' | 'code_apply' | 'recheck_session';
  artifact_type: string | null;
  name: string | null;
  from_tool: string | null;
  to_tool: string | null;
}

/** Every instruction filename a project may carry, in precedence order. */
const INSTRUCTION_FILENAMES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'];

/** The tools and the instruction file each one reads. */
const INSTRUCTION_TOOLS: { id: ToolId; isAvailable: () => boolean }[] = [
  { id: 'claude', isAvailable: () => claudeBackend.isAvailable() },
  { id: 'codex', isAvailable: () => codexBackend.isAvailable() },
  { id: 'cursor', isAvailable: () => cursorBackend.isAvailable() },
  { id: 'opencode', isAvailable: () => opencodeBackend.isAvailable() },
  { id: 'agy', isAvailable: () => agyBackend.isAvailable() },
];

/**
 * Every instruction file a recommendation rule should reach.
 *
 * This used to be CLAUDE.md and nothing else, in both scopes. A rule is
 * guidance for whatever agent is about to edit the repo, and the filename is
 * per tool — CLAUDE.md for Claude Code, AGENTS.md for Codex, Cursor and
 * OpenCode, GEMINI.md for Gemini and Antigravity — so a Codex user got the
 * rule written into a file their tool never opens, and silently kept the
 * behaviour the rule existed to stop.
 *
 * Project scope: every one of those files the project ALREADY has. Writing to
 * a file that exists is never a surprise. Only when the project has none do we
 * create, and then only for the tools installed on this machine.
 *
 * Global scope: the user-level file of each installed tool.
 *
 * Claude is the fallback in both, for a machine where nothing is detected.
 */
export function instructionTargets(rootPath: string | undefined, isGlobal: boolean): string[] {
  const installed = INSTRUCTION_TOOLS.filter((t) => {
    try { return t.isAvailable(); } catch { return false; }
  });
  const tools = installed.length ? installed : [INSTRUCTION_TOOLS[0]];
  if (isGlobal) return [...new Set(tools.map((t) => instructionsPath(t.id)))];
  if (!rootPath) return [];
  /* GEMINI.md is in this list and no tool maps to it. Antigravity reads BOTH
   * AGENTS.md (the cross-tool file, which is what instructionsFilename gives
   * it) and GEMINI.md (its own override, which wins on a conflict). A project
   * carrying a GEMINI.md is telling Antigravity something, and a rule that
   * skipped it would be overridden by whatever is in there. */
  const present = INSTRUCTION_FILENAMES.map((f) => join(rootPath, f)).filter((p) => existsSync(p));
  if (present.length) return present;
  return [...new Set(tools.map((t) => join(rootPath, instructionsFilename(t.id))))];
}

/** Apply a code recommendation locally: append a rule to every instruction
 *  file the relevant tools read (idempotent — a file that already contains the
 *  exact rule is skipped). */
export function applyCodeRecommendation(intent: PendingIntent): { status: 'done' | 'error'; result: string } {
  try {
    const meta = JSON.parse(intent.name || '{}') as { rootPath?: string; filename?: string; content?: string; global?: boolean; payload?: { text?: string; global?: boolean } };
    if (intent.artifact_type === 'write_tasks_file') {
      if (!meta.rootPath || !meta.content) return { status: 'error', result: JSON.stringify({ error: 'missing rootPath or content' }) };
      const file = join(meta.rootPath, meta.filename || 'CODE_TASKS.md');
      writeFileSync(file, meta.content);   // overwrite — it's a regenerated task list
      return { status: 'done', result: JSON.stringify({ wrote: file }) };
    }
    if (intent.artifact_type === 'append_claude_md') {
      const text = meta.payload?.text?.trim();
      const isGlobal = Boolean(meta.global || meta.payload?.global);
      if (!text) return { status: 'error', result: JSON.stringify({ error: 'missing text' }) };
      if (!isGlobal && !meta.rootPath) return { status: 'error', result: JSON.stringify({ error: 'missing rootPath' }) };
      const targets = instructionTargets(meta.rootPath, isGlobal);
      if (!targets.length) return { status: 'error', result: JSON.stringify({ error: 'no instruction file to write' }) };
      const appended: string[] = [];
      const skipped: string[] = [];
      for (const file of targets) {
        const dir = file.slice(0, file.lastIndexOf('/'));
        try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
        const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
        if (existing.includes(text)) { skipped.push(file); continue; }
        const block = `${existing && !existing.endsWith('\n') ? '\n' : ''}\n## Rule (added by chat-recall recommendation)\n${text}\n`;
        if (existing) appendFileSync(file, block);
        else writeFileSync(file, `# ${(meta.rootPath?.split('/').pop()) || 'Global'} instructions\n${block}`);
        appended.push(file);
      }
      // One shape in both cases. An earlier version returned a STRING under
      // `skipped` when nothing was appended and an ARRAY otherwise, so a
      // caller reading result.skipped.length got 24 for "rule already present".
      return { status: 'done', result: JSON.stringify({ appended, skipped }) };
    }
    return { status: 'error', result: JSON.stringify({ error: `unsupported code_apply action: ${intent.artifact_type}` }) };
  } catch (e) {
    return { status: 'error', result: JSON.stringify({ error: e instanceof Error ? e.message : 'failed' }) };
  }
}

export interface DrainResult {
  processed: number;
  done: number;
  errored: number;
}

/** Run one intent and return the (status, result-json) to ack with. */
/**
 * Install what the account holds onto THIS machine, from one server.
 *
 * Fetches the toolkit inventory and hands it to the engine's executor. Only an
 * inventory travels, so what can actually be rebuilt is decided there — see
 * toolkit-pull.ts. A type the server cannot reconstruct is reported, never
 * silently dropped.
 */
async function runPull(
  base: string,
  opts: { types?: SyncType[]; name?: string },
): Promise<{ status: 'done' | 'error'; result: string }> {
  const { executePull } = await import('@chat-recall/engine/core/toolkit-pull.js');
  const { hostname } = await import('node:os');
  const creds = loadAllCredentials().find((c) => c.serverUrl.replace(/\/+$/, '') === base.replace(/\/+$/, ''));
  const headers = creds?.token ? { authorization: `Bearer ${creds.token}` } : {};

  const wanted = opts.types?.length ? opts.types : (['mcp', 'skill', 'command', 'agent', 'instructions'] as SyncType[]);
  const rows: Array<{ id: string; title: string; source_type: string; extra_json?: string | null }> = [];
  for (const type of wanted) {
    try {
      const res = await fetchWithTimeout(`${base}/api/toolkit/browse/${type}?limit=1000`, { headers });
      if (!res.ok) continue;
      const body = (await res.json()) as { items?: Array<{ id: string; title: string; source_type: string; extra_json?: string | null }> };
      for (const it of body.items || []) rows.push(it);
    } catch { /* one type failing must not abort the rest */ }
  }

  const filtered = opts.name
    ? rows.filter((r) => {
        try { return (JSON.parse(r.extra_json || '{}').mcpName || r.title) === opts.name; }
        catch { return r.title === opts.name; }
      })
    : rows;

  const report = executePull(filtered, { thisDeviceId: hostname(), types: wanted });
  const written = report.outcomes.filter((o) => o.status === 'written');
  const failed = report.outcomes.filter((o) => o.status === 'failed');
  return {
    // A skip is a reported outcome, not a failure — the artifact genuinely
    // cannot be installed here and the reason travels back with the ack.
    status: failed.length > 0 ? 'error' : 'done',
    result: JSON.stringify({
      installed: written.length,
      present: report.outcomes.filter((o) => o.status === 'present').length,
      skipped: report.outcomes.filter((o) => o.status === 'skipped').map((o) => `${o.name}: ${o.reason}`).slice(0, 20),
      failed: failed.map((o) => `${o.name}: ${o.reason}`).slice(0, 20),
      needsEnv: [...new Set(written.flatMap((o) => o.needsEnv || []))],
      unsupported: report.unsupported,
    }),
  };
}

async function runIntent(intent: PendingIntent, ctx: { base: string }): Promise<{ status: 'done' | 'error'; result: string }> {
  try {
    if (intent.kind === 'recheck_session') {
      // The server has a thin/absent copy of this session and is asking us to
      // re-verify from THIS machine (disk + shadow = the fullest local truth)
      // and re-push if we have more. repairSession does exactly that, scoped to
      // the requesting server, writing (not a dry run).
      const id = intent.name;
      if (!id) return { status: 'error', result: JSON.stringify({ error: 'recheck missing session id' }) };
      const { repairSession } = await import('./repair.js');
      const r = await repairSession(id, { dryRun: false, server: ctx.base });
      return { status: r.status === 'error' ? 'error' : 'done', result: JSON.stringify(r) };
    }
    if (intent.kind === 'code_apply') {
      return applyCodeRecommendation(intent);
    }
    if (intent.kind === 'pull') {
      // CROSS-DEVICE. `sync_all` copies between tools on THIS disk; `pull`
      // installs what the account has, sourced from the server — the only
      // kind that can set up a machine that has nothing yet.
      const types = (intent.artifact_type || '')
        .split(',').map((t) => t.trim()).filter(Boolean) as SyncType[];
      const r = await runPull(ctx.base, {
        types: types.length ? types : undefined,
        name: intent.name || undefined,
      });
      return r;
    }
    if (intent.kind === 'sync_all') {
      const report = await executeSyncAll();
      const status = report.failed.length > 0 ? 'error' : 'done';
      return { status, result: JSON.stringify({ copied: report.copied.length, skipped: report.skipped.length, failed: report.failed }) };
    }
    // copy
    if (!intent.artifact_type || !intent.name || !intent.from_tool || !intent.to_tool) {
      return { status: 'error', result: JSON.stringify({ error: 'copy intent missing fields' }) };
    }
    const r = await executeCopy(intent.artifact_type as SyncType, intent.name, intent.from_tool, intent.to_tool as SyncTargetTool);
    // 409 (already exists) is a benign skip, not a failure.
    const status = r.ok || r.status === 409 ? 'done' : 'error';
    return { status, result: JSON.stringify(r) };
  } catch (e) {
    return { status: 'error', result: JSON.stringify({ error: e instanceof Error ? e.message : 'failed' }) };
  }
}

import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

let ownVersion = '0.0.0';
try {
  const dir = dirname(fileURLToPath(import.meta.url));
  ownVersion = (JSON.parse(readFileSync(join(dir, '../package.json'), 'utf-8')) as { version?: string }).version || ownVersion;
} catch {
  try {
    // @ts-ignore
    if (typeof __CLI_VERSION__ === 'string') ownVersion = __CLI_VERSION__;
  } catch {}
}

/**
 * Poll every logged-in server once, execute pending intents locally, ack each.
 * Best-effort: network failures are swallowed (the intent stays pending and is
 * retried on the next drain since it was never acked).
 */
export async function drainSyncIntents(opts: { verbose?: boolean } = {}): Promise<DrainResult> {
  const out: DrainResult = { processed: 0, done: 0, errored: 0 };
  for (const cred of loadAllCredentials()) {
    const base = cred.serverUrl.replace(/\/+$/, '');
    const authHeaders: Record<string, string> = cred.token ? { authorization: `Bearer ${cred.token}` } : {};

    let pending: PendingIntent[];
    try {
      const res = await fetchWithTimeout(`${base}/api/sync-intents/pending`, { headers: authHeaders });
      if (!res.ok) continue;
      const data = (await res.json()) as { intents?: PendingIntent[]; cli?: { version: string; sha256: string } | null };
      pending = data.intents || [];

      if (data.cli && data.cli.version) {
        const { planAutoUpdate, runAutoUpdate, sweepStaleStaging } = await import('./auto-update.js');
        const plan = planAutoUpdate(base, { cli: data.cli }, ownVersion, process.env.CHAT_RECALL_AUTO_UPDATE);
        sweepStaleStaging();
        if (plan.update) {
          void runAutoUpdate(base, authHeaders, ownVersion).catch(() => {});
        }
      }
    } catch {
      continue; // server unreachable — try again next tick
    }

    for (const intent of pending) {
      const { status, result } = await runIntent(intent, { base });
      out.processed++;
      if (status === 'done') out.done++; else out.errored++;
      if (opts.verbose) {
        const label = intent.kind === 'sync_all' ? 'sync_all'
          : intent.kind === 'pull' ? `pull ${intent.artifact_type || 'all'}${intent.name ? ` "${intent.name}"` : ''}`
          : intent.kind === 'recheck_session' ? `recheck ${intent.name}`
          : `${intent.artifact_type} "${intent.name}" ${intent.from_tool}→${intent.to_tool}`;
        console.error(`[sync-intent] ${label}: ${status}`);
      }
      try {
        await fetchWithTimeout(`${base}/api/sync-intents/${intent.id}/ack`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders },
          body: JSON.stringify({ status, result }),
        });
      } catch {
        // Ack failed — leave it; it'll be re-pulled and re-run (copy is
        // idempotent: an already-present target acks as a 409 skip).
      }
    }

    // Read-back: push any SECURITY_TASKS.md / CODE_TASKS.md edits (checkbox/
    // status) up to the server — the file→server half of the two-way sync.
    try {
      await pushProjectTaskStatuses(base, authHeaders, { verbose: opts.verbose });
    } catch { /* never let read-back abort the drain */ }
  }

  if (out.processed > 0) {
    try {
      await syncIncremental({ scope: 'changed' });
    } catch { /* best-effort */ }
  }

  return out;
}
