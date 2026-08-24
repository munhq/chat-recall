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

import { SUPPORTED_TARGETS, readMcpEntry, writeMcpEntry, type TargetTool, type SyncType } from './toolkit-sync.js';

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
}

/** Rows the server holds for types whose bytes it never received. */
const NOT_REBUILDABLE: Record<string, string> = {
  skill: 'a skill is a directory of files, and file content is not uploaded',
  agent: 'only a short body preview is uploaded, not the agent body',
  command: 'command bodies are not uploaded',
  instructions: 'project-scoped, and file content is not uploaded',
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
): { mcps: Array<{ name: string; spec: McpSpec; tools: TargetTool[] }>; unsupported: PullReport['unsupported'] } {
  const wanted = opts.types;
  const seenUnsupported = new Map<string, number>();
  // One entry per MCP NAME. The same server is registered in several tools, so
  // the rows collide by name — the richest spec wins, because an older client
  // may have uploaded a row without one.
  const byName = new Map<string, McpSpec>();

  for (const row of rows) {
    const type = row.source_type;
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
  const unsupported = [...seenUnsupported.entries()].map(([type, count]) => ({
    type, rows: count, reason: NOT_REBUILDABLE[type],
  }));
  return { mcps, unsupported };
}

/** Execute a pull. `dryRun` reports what would change and writes nothing. */
export function executePull(
  rows: RemoteArtifactRow[],
  opts: { thisDeviceId?: string; types?: SyncType[]; dryRun?: boolean } = {},
): PullReport {
  const { mcps, unsupported } = planPull(rows, opts);
  const outcomes: PullOutcome[] = [];

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
      if (opts.dryRun) {
        outcomes.push({ type: 'mcp', name, tool, status: 'written', reason: 'dry run', needsEnv: built.needsEnv });
        continue;
      }
      const r = writeMcpEntry(tool, name, built.entry);
      if (r.ok) outcomes.push({ type: 'mcp', name, tool, status: 'written', path: r.targetPath, needsEnv: built.needsEnv });
      else if (r.status === 409) outcomes.push({ type: 'mcp', name, tool, status: 'present' });
      else outcomes.push({ type: 'mcp', name, tool, status: 'failed', reason: r.error });
    }
  }
  return { outcomes, unsupported };
}
