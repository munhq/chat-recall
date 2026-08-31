/**
 * Where each AI tool keeps its MCP server list, and how to write ours into it.
 *
 * `chat-recall init` used to configure ONE file (`~/.mcp.json`) while the same
 * command detected five tools and the product promised memory across all of
 * them. A Codex user therefore installed cross-tool memory and got no recall
 * tools inside Codex — the promise failed at the only step the user could not
 * see. This module is the single place that knows the per-client answer, so
 * `init`, `doctor` and any future installer stay in agreement.
 *
 * Formats differ, so each target declares its own writer:
 *   - `mcpServers`  — a JSON object keyed by server name (Claude Code, Cursor,
 *                     Gemini CLI). Gemini keeps other top-level settings in the
 *                     same file, so the merge must preserve unknown keys.
 *   - `opencode`    — JSON, but the key is `mcp`, the command is an argv ARRAY,
 *                     and env lives under `environment`.
 *   - `codexToml`   — TOML: `[mcp_servers.<name>]` plus a nested `.env` table.
 *
 * The TOML writer is deliberately a block splice rather than a parse/serialise
 * round trip: `~/.codex/config.toml` is hand-maintained by the user (model,
 * approval policy, per-project trust), and a naive re-serialise would reorder
 * or drop their comments.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

/** The MCP server name we register under, in every client. */
export const MCP_SERVER_NAME = 'chat-recall';

export type McpClientId = 'claude' | 'codex' | 'gemini' | 'opencode' | 'cursor' | 'agy';

/** What to launch. `args` is omitted for a bin on PATH. */
export interface McpLaunchSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Read-only tools a client may call without asking. Ignored by clients that have no such concept. */
  alwaysAllow?: string[];
}

export type McpRegisterState =
  /** No entry existed; we wrote one. */
  | 'created'
  /** An entry existed but pointed somewhere else; we repaired it. */
  | 'repaired'
  /** The entry already matches what we would write. */
  | 'current'
  /** The config file could not be parsed, so we left it alone. */
  | 'unparseable';

export interface McpRegisterResult {
  id: McpClientId;
  label: string;
  path: string;
  state: McpRegisterState;
  /** Set when state is 'unparseable'. */
  error?: string;
}

interface McpClientTarget {
  readonly id: McpClientId;
  readonly label: string;
  /** Binary name, for callers that detect tools on PATH. */
  readonly bin: string;
  /** The file that holds this client's MCP server list. */
  configPath(home: string): string;
  /**
   * Does this machine look like it uses the client? A missing config file is
   * not proof of absence — every one of these tools creates its config lazily
   * — so a present home directory counts too.
   */
  isPresent(home: string): boolean;
  register(spec: McpLaunchSpec, home: string): McpRegisterResult;
}

function envHome(varName: string, fallback: string): string {
  const v = process.env[varName];
  return v && v.trim() ? v.trim() : fallback;
}

function writeFileMkdir(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

/**
 * Read a client's JSON config, treating an EMPTY file as an empty object.
 *
 * `JSON.parse('')` throws "Unexpected end of JSON input", which the callers
 * correctly refuse to overwrite — the rule being that a stray comma in a user's
 * settings must not cost them their configuration. But an empty file holds no
 * configuration to lose, and it is a state these files legitimately reach: a
 * tool that touches its config on first run before writing anything, an
 * interrupted write, an editor that saved an empty buffer.
 *
 * Measured on a real machine: Antigravity's ~/.gemini/config/mcp_config.json
 * was reported "left alone — the file does not parse", so init finished with
 * that one client silently unwired, and the message named neither the reason
 * nor anything the user could act on.
 *
 * Whitespace counts as empty. Anything else that fails to parse still throws,
 * and the caller still refuses to touch it.
 */
function readJsonObject(path: string): Record<string, unknown> {
  const raw = readFileSync(path, 'utf-8');
  if (raw.trim() === '') return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

/* ─────────────────────────── JSON: mcpServers ─────────────────────────── */

/**
 * Merge into `{ mcpServers: { 'chat-recall': … } }`, preserving every other key
 * in the file and any `alwaysAllow` list the user has curated by hand.
 */
function registerMcpServersJson(
  target: { id: McpClientId; label: string },
  path: string,
  spec: McpLaunchSpec,
): McpRegisterResult {
  let cfg: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      cfg = readJsonObject(path);
    } catch (err) {
      // Never clobber a file we cannot read: a stray comma in a user's settings
      // must not cost them their whole configuration.
      return { id: target.id, label: target.label, path, state: 'unparseable', error: String(err) };
    }
  }
  const servers = (cfg.mcpServers || {}) as Record<string, unknown>;
  const existing = servers[MCP_SERVER_NAME] as
    | { command?: string; args?: string[]; env?: Record<string, string>; alwaysAllow?: string[];
        disabled?: boolean }
    | undefined;

  const entry: Record<string, unknown> = {
    command: spec.command,
    ...(spec.args ? { args: spec.args } : {}),
  };
  if (spec.alwaysAllow) entry.alwaysAllow = existing?.alwaysAllow ?? spec.alwaysAllow;
  if (spec.env) entry.env = { ...existing?.env, ...spec.env };

  /* A `disabled: true` entry is not a configured one.
   *
   * Same defect as OpenCode's `enabled: false`, found by sweeping every client
   * with deliberately broken shapes rather than waiting for the next report:
   * all four `mcpServers` clients answered "already configured" for an entry
   * carrying `disabled: true`, and then no tools appeared.
   *
   * Cursor and Gemini honour the key. Claude Code does not — it keeps its
   * opt-outs in `disabledMcpServers` in ~/.claude.json — so there the key is
   * meaningless and dropping it is harmless tidying. Repairing in both cases
   * beats reasoning about which client is reading which field, and it matches
   * what `init` is for: the user just asked for this server to work. */
  const isCurrent = !!existing
    && !existing.disabled
    && existing.command === spec.command
    && JSON.stringify(existing.args ?? null) === JSON.stringify(spec.args ?? null)
    && Object.entries(spec.env ?? {}).every(([k, v]) => existing.env?.[k] === v);
  if (isCurrent) return { id: target.id, label: target.label, path, state: 'current' };

  servers[MCP_SERVER_NAME] = entry;
  cfg.mcpServers = servers;
  writeFileMkdir(path, JSON.stringify(cfg, null, 2) + '\n');
  return { id: target.id, label: target.label, path, state: existing ? 'repaired' : 'created' };
}

/* ───────────────────────────── JSON: opencode ─────────────────────────── */

/**
 * OpenCode keys its servers under `mcp`, takes the command as an argv array,
 * and needs `type: 'local'` plus `enabled: true` before it will spawn one.
 */
function registerOpencodeJson(path: string, spec: McpLaunchSpec): McpRegisterResult {
  const id: McpClientId = 'opencode';
  const label = 'OpenCode';
  let cfg: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      cfg = readJsonObject(path);
    } catch (err) {
      return { id, label, path, state: 'unparseable', error: String(err) };
    }
  }
  if (!cfg.$schema) cfg.$schema = 'https://opencode.ai/config.json';
  const mcp = (cfg.mcp || {}) as Record<string, unknown>;
  const existing = mcp[MCP_SERVER_NAME] as
    | { type?: string; command?: string[]; environment?: Record<string, string>; enabled?: boolean }
    | undefined;

  const argv = [spec.command, ...(spec.args ?? [])];
  const entry: Record<string, unknown> = { type: 'local', command: argv, enabled: true };
  if (spec.env) entry.environment = { ...existing?.environment, ...spec.env };

  /* "Already configured" must mean OpenCode WILL SPAWN IT, not "our key is in
   * the file".
   *
   * This checked the command, the env, and that `enabled` was not literally
   * false — and skipped the two fields OpenCode actually gates on. An entry
   * written by an older version, or hand-edited, could have the right command
   * and no `type`, and init would report "already configured" while OpenCode
   * silently refused to start it. The one report a user gets was the one thing
   * that could not be true.
   *
   * `type` and `enabled` are now compared against the exact values we write, so
   * anything short of a spawnable entry is repaired instead of blessed.
   * Reported by a user whose laptop said "already configured" and had no
   * chat-recall tools in OpenCode. */
  const isCurrent = !!existing
    && existing.type === 'local'
    && existing.enabled === true
    && JSON.stringify(existing.command ?? null) === JSON.stringify(argv)
    && Object.entries(spec.env ?? {}).every(([k, v]) => existing.environment?.[k] === v);
  if (isCurrent) return { id, label, path, state: 'current' };

  mcp[MCP_SERVER_NAME] = entry;
  cfg.mcp = mcp;
  writeFileMkdir(path, JSON.stringify(cfg, null, 2) + '\n');
  return { id, label, path, state: existing ? 'repaired' : 'created' };
}

/* ─────────────────────────────── TOML: codex ──────────────────────────── */

const CODEX_HEADER = `[mcp_servers.${MCP_SERVER_NAME}]`;

/** Render our entry as TOML. Only strings appear here, so quoting stays simple. */
function codexBlock(spec: McpLaunchSpec): string {
  const lines = [CODEX_HEADER, `command = ${JSON.stringify(spec.command)}`];
  if (spec.args?.length) lines.push(`args = [${spec.args.map((a) => JSON.stringify(a)).join(', ')}]`);
  const env = Object.entries(spec.env ?? {});
  if (env.length) {
    lines.push(`[mcp_servers.${MCP_SERVER_NAME}.env]`);
    for (const [k, v] of env) lines.push(`${k} = ${JSON.stringify(v)}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Splice our block into `config.toml`. The block runs from its header to the
 * next top-level table that is not one of ours (`[mcp_servers.chat-recall.env]`
 * belongs to us), so a user's other tables and comments survive untouched.
 */
function registerCodexToml(path: string, spec: McpLaunchSpec): McpRegisterResult {
  const id: McpClientId = 'codex';
  const label = 'Codex';
  const block = codexBlock(spec);
  const prev = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  const lines = prev.length ? prev.split('\n') : [];

  const start = lines.findIndex((l) => l.trim() === CODEX_HEADER);
  if (start === -1) {
    const body = prev.length
      ? prev.replace(/\n*$/, '\n') + '\n' + block
      : block;
    writeFileMkdir(path, body);
    return { id, label, path, state: 'created' };
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t.startsWith('[')) continue;
    if (t.startsWith(`[mcp_servers.${MCP_SERVER_NAME}.`)) continue;
    end = i;
    break;
  }
  const current = lines.slice(start, end).join('\n').replace(/\n*$/, '\n');
  if (current === block) return { id, label, path, state: 'current' };

  const next = [...lines.slice(0, start), ...block.replace(/\n$/, '').split('\n'), ...lines.slice(end)];
  writeFileMkdir(path, next.join('\n').replace(/\n*$/, '\n'));
  return { id, label, path, state: 'repaired' };
}

/* ──────────────────────────────── targets ─────────────────────────────── */

export const MCP_CLIENTS: readonly McpClientTarget[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    configPath: (home) => join(home, '.mcp.json'),
    // Claude Code is the reference client and `init`'s historical target, so we
    // always write it — a fresh machine has no ~/.claude yet on first install.
    isPresent: () => true,
    register(spec, home) {
      return registerMcpServersJson(this, this.configPath(home), spec);
    },
  },
  {
    id: 'codex',
    label: 'Codex',
    bin: 'codex',
    configPath: (home) => join(envHome('CHAT_RECALL_CODEX_HOME', join(home, '.codex')), 'config.toml'),
    isPresent(home) {
      const p = this.configPath(home);
      return existsSync(p) || existsSync(dirname(p));
    },
    register(spec, home) {
      return registerCodexToml(this.configPath(home), spec);
    },
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    bin: 'gemini',
    configPath: (home) => join(envHome('CHAT_RECALL_GEMINI_HOME', join(home, '.gemini')), 'settings.json'),
    isPresent(home) {
      const p = this.configPath(home);
      return existsSync(p) || existsSync(dirname(p));
    },
    register(spec, home) {
      return registerMcpServersJson(this, this.configPath(home), spec);
    },
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    bin: 'opencode',
    configPath: (home) => join(envHome('XDG_CONFIG_HOME', join(home, '.config')), 'opencode', 'opencode.json'),
    isPresent(home) {
      const p = this.configPath(home);
      return existsSync(p) || existsSync(dirname(p));
    },
    register(spec, home) {
      return registerOpencodeJson(this.configPath(home), spec);
    },
  },
  {
    // Antigravity keeps its MCP config under the Gemini config dir, NOT in a
    // dir of its own — the same sharing it does for skills.
    id: 'agy',
    label: 'Antigravity',
    bin: 'agy',
    configPath: (home) => join(home, '.gemini', 'config', 'mcp_config.json'),
    isPresent(home) {
      // Keyed on Antigravity's OWN home, not on the config dir. The config
      // lives under ~/.gemini, which Gemini CLI creates on its own — probing
      // that would claim Antigravity is installed on every Gemini machine.
      return existsSync(join(home, '.gemini', 'antigravity-cli'))
        || existsSync(this.configPath(home));
    },
    register(spec, home) {
      return registerMcpServersJson(this, this.configPath(home), spec);
    },
  },
  {
    id: 'cursor',
    label: 'Cursor',
    bin: 'cursor',
    configPath: (home) => join(home, '.cursor', 'mcp.json'),
    isPresent(home) {
      const p = this.configPath(home);
      return existsSync(p) || existsSync(dirname(p));
    },
    register(spec, home) {
      return registerMcpServersJson(this, this.configPath(home), spec);
    },
  },
];

export function getMcpClient(id: McpClientId): McpClientTarget {
  const t = MCP_CLIENTS.find((c) => c.id === id);
  if (!t) throw new Error(`unknown MCP client: ${id}`);
  return t;
}

/**
 * Register the server in every client this machine appears to use.
 *
 * `extraIds` forces a client that has no config directory yet — `init` detects
 * binaries on PATH, and a tool installed but never run still deserves the entry.
 */
export function registerMcpEverywhere(
  spec: McpLaunchSpec,
  opts: { home?: string; extraIds?: readonly McpClientId[] } = {},
): McpRegisterResult[] {
  const home = opts.home ?? homedir();
  const forced = new Set(opts.extraIds ?? []);
  return MCP_CLIENTS
    .filter((c) => c.isPresent(home) || forced.has(c.id))
    .map((c) => c.register(spec, home));
}

/** Read-only view for `doctor`: which clients carry the entry, and where. */
export function inspectMcpClients(opts: { home?: string } = {}): Array<{
  id: McpClientId;
  label: string;
  path: string;
  present: boolean;
  registered: boolean;
}> {
  const home = opts.home ?? homedir();
  return MCP_CLIENTS.map((c) => {
    const path = c.configPath(home);
    let registered = false;
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, 'utf-8');
        registered = c.id === 'codex'
          ? raw.includes(CODEX_HEADER)
          : !!((JSON.parse(raw) as { mcpServers?: Record<string, unknown>; mcp?: Record<string, unknown> })
            .mcpServers?.[MCP_SERVER_NAME]
            ?? (JSON.parse(raw) as { mcp?: Record<string, unknown> }).mcp?.[MCP_SERVER_NAME]);
      } catch { registered = false; }
    }
    return { id: c.id, label: c.label, path, present: c.isPresent(home), registered };
  });
}
