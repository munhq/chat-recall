/**
 * Cross-device toolkit pull: materialise artifacts this machine is missing.
 *
 * WHAT THIS SOLVES. `toolkit sync` fans artifacts out between the tools on ONE
 * machine. It reads the local disk and writes the local disk, so a second
 * device gets nothing — the toolkit was upload-only, and the web matrix showing
 * "device A has 45 MCPs" was a report, not a sync. Setting up a new machine
 * meant registering every MCP in every tool by hand.
 *
 * WHAT CAN AND CANNOT BE REBUILT REMOTELY. The server stores an inventory row
 * per artifact, not the artifact's bytes:
 *
 *   mcp          → REBUILDABLE. A registration is a config entry, and
 *                  `extra.spec` carries the whole entry (command, args, url,
 *                  full allow-list, env variable NAMES).
 *   skill        → not rebuildable. A skill is a directory of files, and no
 *                  file content is uploaded.
 *   agent        → not rebuildable. Only a 200-char body preview is uploaded.
 *   command      → not rebuildable, and not inventoried at all today.
 *   instructions → not rebuildable (project-scoped, and no content uploaded).
 *
 * So this pulls MCPs, and reports every other type as a NAMED skip rather than
 * pretending the device is in sync. A silent partial sync is worse than none:
 * the user stops checking.
 *
 * ENV VALUES NEVER TRAVEL. `spec.envKeys` holds variable names only, so a
 * rebuilt entry names the variables and the caller tells the user which ones
 * to set. A registration that silently lost its API key would fail at first
 * use, far from the cause.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join, basename, isAbsolute } from 'node:path';

import { SOURCE_PRECEDENCE, SUPPORTED_TARGETS, readMcpEntry, writeMcpEntry, skillsDirFor, type TargetTool, type SyncType } from './toolkit-sync.js';

/** Is `p` an executable file that exists here? */
function isExecutableFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}

/** First match for a bare command name on this machine's PATH. */
function onPath(name: string): string | null {
  const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean);
  for (const d of dirs) {
    const candidate = join(d, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Make one command portable to THIS machine, or refuse.
 *
 * WHY THIS IS NOT OPTIONAL. 40 of 183 registrations on the machine that
 * uploaded them name an ABSOLUTE path — `/home/<user>/.local/bin/some-mcp`,
 * a release binary inside a checkout, a dev `dist/mcp.js`. None of those paths
 * exist on a second machine, and its home directory is not even the same shape
 * (`/Users/...` vs `/home/...`). Installing them verbatim would register 40
 * servers that fail to spawn, in five tools each, and the AI tool reports that
 * as a broken MCP rather than as a bad path.
 *
 * So: keep the path when it resolves here; otherwise fall back to the bare
 * name if this machine has its own copy on PATH (the common case — the same
 * tool installed to a different prefix); otherwise refuse and say which
 * command is missing. A named refusal is the useful outcome: it tells the user
 * what to install.
 */
export function portableCommand(cmd: string): { command: string; rewritten: boolean } | { missing: string } {
  if (!isAbsolute(cmd)) {
    // A bare name must still be resolvable, or the entry cannot work.
    return onPath(cmd) ? { command: cmd, rewritten: false } : { missing: cmd };
  }
  if (isExecutableFile(cmd)) return { command: cmd, rewritten: false };
  const base = basename(cmd);
  if (onPath(base)) return { command: base, rewritten: true };
  return { missing: cmd };
}

/** One inventory row as the server returns it. */
export interface RemoteArtifactRow {
  id: string;
  title: string;
  source_type: string;
  extra_json?: string | null;
  content_preview?: string | null;
}

export interface PullOutcome {
  type: SyncType;
  name: string;
  tool: TargetTool;
  status: 'written' | 'present' | 'skipped' | 'failed';
  reason?: string;
  path?: string;
  /** Env variables the rebuilt entry needs, whose values never left the source machine. */
  needsEnv?: string[];
  /** Set when the source machine's absolute path was replaced by this machine's copy. */
  rewrittenCommand?: string;
  /** Set when a credential was stripped from the body before upload, so the file needs an edit. */
  redactedContent?: boolean;
}

export interface PullReport {
  outcomes: PullOutcome[];
  /** Types the server cannot reconstruct, with the count of rows seen. */
  unsupported: Array<{ type: string; rows: number; reason: string }>;
}

interface McpSpec {
  command?: string | string[];
  args?: string[];
  url?: string;
  type?: string;
  enabled?: boolean;
  alwaysAllow?: string[];
  envKeys?: string[];
  /** Set when an inline credential was stripped before upload; see mcps-source.ts. */
  secretsRedacted?: boolean;
}

/** Rows the server holds for types whose bytes it never received. */
const NOT_REBUILDABLE: Record<string, string> = {
  // Agents and commands differ in FORMAT per tool (markdown vs TOML), and the
  // stored body is in its source tool's format — writing it verbatim into a
  // tool that expects the other one produces a file the tool silently ignores.
  // Converting between them needs the codec, which is the next piece.
  agent: 'the stored body is in its source tool\'s format; cross-format conversion is not wired up yet',
  command: 'the stored body is in its source tool\'s format; cross-format conversion is not wired up yet',
  instructions: 'project-scoped — it belongs to a repo, not to a machine',
};

/**
 * Build the config entry `writeMcpEntry` expects from a stored spec.
 *
 * Returns null when the row predates `spec` — an older client uploaded only the
 * flattened `command` preview, and splitting that back into command + args
 * means guessing at quoting. Refusing is correct: a wrong entry looks
 * installed and never works.
 */
export function entryFromSpec(spec: McpSpec | null | undefined): { entry: Record<string, unknown>; needsEnv: string[] } | null {
  if (!spec) return null;
  const entry: Record<string, unknown> = {};
  if (spec.url) entry.url = spec.url;
  else if (Array.isArray(spec.command) && spec.command.length) entry.command = spec.command;
  else if (typeof spec.command === 'string' && spec.command) {
    entry.command = spec.command;
    if (spec.args?.length) entry.args = spec.args;
  } else return null;   // neither a url nor a command: nothing to register

  if (spec.alwaysAllow?.length) entry.alwaysAllow = spec.alwaysAllow;
  const needsEnv = spec.envKeys?.slice() || [];
  // Name the variables so the tool config is shaped correctly; the VALUES are
  // the user's to supply, and an empty string is honest about that.
  if (needsEnv.length) entry.env = Object.fromEntries(needsEnv.map(k => [k, '']));
  return { entry, needsEnv };
}

function parseExtra(row: RemoteArtifactRow): Record<string, unknown> {
  try { return JSON.parse(row.extra_json || '{}') as Record<string, unknown>; }
  catch { return {}; }
}

/**
 * Materialise every MCP the server knows about into every tool that lacks it.
 *
 * `thisDeviceId` skips rows this machine itself uploaded — not for correctness
 * (an existing entry is detected anyway) but so the report reads as "nothing to
 * do" instead of listing the user's own registrations back at them.
 */
export function planPull(
  rows: RemoteArtifactRow[],
  opts: { thisDeviceId?: string; types?: SyncType[] } = {},
): {
  mcps: Array<{ name: string; spec: McpSpec; tools: TargetTool[] }>;
  skills: Array<{ name: string; body: string; truncated: boolean; redacted: boolean; tools: TargetTool[] }>;
  unsupported: PullReport['unsupported'];
} {
  const wanted = opts.types;
  const seenUnsupported = new Map<string, number>();
  // One entry per MCP NAME. The same server is registered in several tools, so
  // the rows collide by name — the richest spec wins, because an older client
  // may have uploaded a row without one.
  const byName = new Map<string, McpSpec>();
  const skillsByName = new Map<string, { body: string; rank: number; truncated: boolean; redacted: boolean }>();

  for (const row of rows) {
    const type = row.source_type;
    if (type === 'skill') {
      if (wanted && !wanted.includes('skill')) continue;
      const extra = parseExtra(row);
      const name = (extra.skillName as string) || row.title;
      const body = extra.body;
      // A row without a body predates the full-body upload. Refusing is
      // correct: rebuilding a skill from its 2000-char search chunk would
      // write a TRUNCATED skill that looks installed and quietly misbehaves.
      if (!name || typeof body !== 'string' || !body.trim()) {
        seenUnsupported.set('skill', (seenUnsupported.get('skill') || 0) + 1);
        continue;
      }
      // The SAME skill name exists in several tools with different content, so
      // the rows collide and one has to win. Picking the longest body was
      // arbitrary and non-deterministic across machines — it installed a
      // 19KB copy where the source of truth was the 16KB one. Use the
      // precedence order the local fan-out already uses, so both paths agree
      // on which tool owns a name.
      const tool = String(extra.tool || '');
      const rank = SOURCE_PRECEDENCE.skill.indexOf(tool as TargetTool);
      const prev = skillsByName.get(name);
      if (!prev || (rank >= 0 && (prev.rank < 0 || rank < prev.rank))) {
        skillsByName.set(name, {
          body, rank,
          truncated: extra.bodyTruncated === true,
          redacted: extra.bodySecretsRedacted === true,
        });
      }
      continue;
    }
    if (type !== 'mcp') {
      if (NOT_REBUILDABLE[type]) seenUnsupported.set(type, (seenUnsupported.get(type) || 0) + 1);
      continue;
    }
    if (wanted && !wanted.includes('mcp')) continue;
    const extra = parseExtra(row);
    const name = (extra.mcpName as string) || row.title;
    if (!name) continue;
    const spec = (extra.spec as McpSpec) || null;
    if (!spec) continue;
    const prev = byName.get(name);
    // Prefer the spec that can actually be rebuilt, then the more complete one.
    const score = (s: McpSpec | undefined) =>
      !s ? -1 : (entryFromSpec(s) ? 10 : 0) + (s.alwaysAllow?.length || 0) + (s.envKeys?.length || 0);
    if (!prev || score(spec) > score(prev)) byName.set(name, spec);
  }

  const targets = SUPPORTED_TARGETS.mcp;
  const mcps = [...byName.entries()].map(([name, spec]) => ({ name, spec, tools: targets }));
  const skills = [...skillsByName.entries()].map(([name, v]) => ({
    name, body: v.body, truncated: v.truncated, redacted: v.redacted, tools: SUPPORTED_TARGETS.skill,
  }));
  const unsupported = [...seenUnsupported.entries()].map(([type, count]) => ({
    type,
    rows: count,
    reason: NOT_REBUILDABLE[type]
      ?? 'the stored rows carry no full body — re-index on the device that has them',
  }));
  return { mcps, skills, unsupported };
}

/** Execute a pull. `dryRun` reports what would change and writes nothing. */
export function executePull(
  rows: RemoteArtifactRow[],
  opts: { thisDeviceId?: string; types?: SyncType[]; dryRun?: boolean } = {},
): PullReport {
  const { mcps, skills, unsupported } = planPull(rows, opts);
  const outcomes: PullOutcome[] = [];

  for (const { name, body, truncated, redacted, tools } of skills) {
    for (const tool of tools) {
      const dir = join(skillsDirFor(tool), name);
      const file = join(dir, 'SKILL.md');
      // NEVER overwrite. The local copy may be edited, and a skill the user
      // changed here is more valuable than the account's version of it.
      if (existsSync(file)) { outcomes.push({ type: 'skill', name, tool, status: 'present' }); continue; }
      if (truncated) {
        outcomes.push({ type: 'skill', name, tool, status: 'skipped', reason: 'the stored body was truncated — installing it would write a corrupted skill' });
        continue;
      }
      if (opts.dryRun) { outcomes.push({ type: 'skill', name, tool, status: 'written', reason: 'dry run', redactedContent: redacted }); continue; }
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, body);
        // Flagged, not hidden: a placeholder sits where the credential was, so
        // the skill needs an edit before its example commands will run.
        outcomes.push({ type: 'skill', name, tool, status: 'written', path: file, redactedContent: redacted });
      } catch (e) {
        outcomes.push({ type: 'skill', name, tool, status: 'failed', reason: e instanceof Error ? e.message : 'write failed' });
      }
    }
  }

  for (const { name, spec, tools } of mcps) {
    const built = entryFromSpec(spec);
    for (const tool of tools) {
      if (!built) {
        outcomes.push({ type: 'mcp', name, tool, status: 'skipped', reason: 'stored row has no rebuildable spec (re-index on the source device)' });
        continue;
      }
      // Already registered here? Leave it alone — the local entry may carry
      // real env values that this rebuild cannot supply.
      if (readMcpEntry(tool, name)) {
        outcomes.push({ type: 'mcp', name, tool, status: 'present' });
        continue;
      }

      // An entry whose secret was stripped on upload cannot work as written.
      // Installing it would produce a server that fails to connect on a fresh
      // machine, which reads as "chat-recall installed a broken MCP".
      if (spec.secretsRedacted) {
        outcomes.push({
          type: 'mcp', name, tool, status: 'skipped',
          reason: 'its command contains a secret, which is never uploaded — register this one by hand',
        });
        continue;
      }

      // The source machine's paths are not this machine's paths.
      const entry = { ...built.entry };
      let rewrittenCommand: string | undefined;
      if (!entry.url) {
        const raw = Array.isArray(entry.command) ? (entry.command as string[])[0] : entry.command as string;
        const port = portableCommand(raw);
        if ('missing' in port) {
          outcomes.push({ type: 'mcp', name, tool, status: 'skipped', reason: `not installed here: ${port.missing}` });
          continue;
        }
        if (port.rewritten) {
          rewrittenCommand = port.command;
          if (Array.isArray(entry.command)) entry.command = [port.command, ...(entry.command as string[]).slice(1)];
          else entry.command = port.command;
        }
      }

      if (opts.dryRun) {
        outcomes.push({ type: 'mcp', name, tool, status: 'written', reason: 'dry run', needsEnv: built.needsEnv, rewrittenCommand });
        continue;
      }
      const r = writeMcpEntry(tool, name, entry);
      if (r.ok) outcomes.push({ type: 'mcp', name, tool, status: 'written', path: r.targetPath, needsEnv: built.needsEnv, rewrittenCommand });
      else if (r.status === 409) outcomes.push({ type: 'mcp', name, tool, status: 'present' });
      else outcomes.push({ type: 'mcp', name, tool, status: 'failed', reason: r.error });
    }
  }
  return { outcomes, unsupported };
}
