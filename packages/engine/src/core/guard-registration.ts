/**
 * Registering the guard in the four tools that are not Claude Code.
 *
 * `chat-recall guard` already speaks every harness (see guard-adapters.ts).
 * What kept it to one tool was registration: each harness stores its
 * pre-execution hook in its own file, in its own shape, and install-hooks only
 * knew Claude's. So the guard ran on one of the five tools a user has open.
 *
 * Each entry below states the file it writes and the shape that file wants.
 * The merge functions take a parsed config and return a new one, so the CLI
 * owns the reading and writing and these stay testable without a filesystem.
 *
 *   codex     ~/.codex/hooks.json                   PreToolUse, Claude's shape
 *   agy       ~/.gemini/antigravity-cli/hooks.json  PreToolUse, keyed by a name
 *   cursor    ~/.cursor/hooks.json                  beforeShellExecution + afterFileEdit
 *   opencode  ~/.config/opencode/plugins/*.js       a plugin module, loaded on startup
 *
 * Codex requires the user to trust a hook before it runs — `/hooks` in its TUI
 * — so writing the file is the first of two steps there, and the installer says
 * so. Cursor sees a shell command before it runs and a file edit only after, so
 * an import added in an edit is reported once it is written.
 */

import { homedir } from 'os';
import { join } from 'path';
import { codexBackend, agyBackend, cursorBackend } from './backends/index.js';

export type GuardTool = 'codex' | 'agy' | 'cursor' | 'opencode';

/** The name our entries carry, so a re-install replaces them and leaves the rest. */
export const GUARD_ID = 'chat-recall-guard';

/** Antigravity tool names that can introduce a dependency. */
const AGY_MATCHER = 'run_command|write_to_file|replace_file_content|multi_replace_file_content';
/** Codex reports Bash for shell and apply_patch for edits, with Edit/Write as aliases. */
const CODEX_MATCHER = 'Bash|apply_patch|Edit|Write';

/** Seconds a harness waits for the guard before it gives up on it. */
const TIMEOUT_SECS = 8;

export interface GuardTarget {
  tool: GuardTool;
  /** Name a person reads in the installer's output. */
  label: string;
  /** The file this tool reads its hooks from. */
  configPath: string;
  /**
   * The tool's own directory. A machine without it gets no file written for
   * it, so installing never creates config for a tool nobody has.
   */
  homeDir: string;
  /** What the user still has to do by hand, when anything. */
  note?: string;
}

/** OpenCode's config directory, XDG-aware. */
export function opencodeConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() ? xdg : join(homedir(), '.config');
  return join(base, 'opencode');
}

/** Where OpenCode loads a global plugin from. */
export function opencodePluginDir(): string {
  return join(opencodeConfigDir(), 'plugins');
}

export function guardTargets(): GuardTarget[] {
  return [
    {
      tool: 'codex',
      label: 'Codex',
      configPath: join(codexBackend.homeDir(), 'hooks.json'),
      homeDir: codexBackend.homeDir(),
      note: 'Codex runs a hook only after you trust it — open Codex and run /hooks once.',
    },
    {
      tool: 'agy',
      label: 'Antigravity',
      configPath: join(agyBackend.homeDir(), 'hooks.json'),
      homeDir: agyBackend.homeDir(),
    },
    {
      tool: 'cursor',
      label: 'Cursor',
      configPath: join(cursorBackend.homeDir(), 'hooks.json'),
      homeDir: cursorBackend.homeDir(),
      note: 'Cursor checks a shell command before it runs and a file edit after it is written.',
    },
    {
      tool: 'opencode',
      label: 'OpenCode',
      configPath: join(opencodePluginDir(), 'chat-recall-guard.js'),
      homeDir: opencodeConfigDir(),
      note: 'OpenCode plugin hooks do not fire for subagent tool calls, so a delegating agent bypasses this.',
    },
  ];
}

/** The file name of the per-tool wrapper that names the harness. */
export function guardWrapperName(tool: GuardTool): string {
  return `chat_recall_guard_${tool}.sh`;
}

/**
 * A wrapper that runs the guard and tells it which harness called it.
 *
 * Each tool gets its own one-line script, and the registration is that
 * script's absolute path with no arguments and no environment prefix. The
 * harnesses differ on how they run the string they are given — a shell string,
 * an argv split, a direct spawn — and a bare path is the only form all of them
 * execute.
 */
export function guardWrapperSource(tool: GuardTool, hookPath: string): string {
  return `#!/bin/sh
# Written by \`chat-recall install-hooks\`. Re-running replaces it.
CHAT_RECALL_GUARD_HARNESS=${tool}
export CHAT_RECALL_GUARD_HARNESS
exec ${JSON.stringify(hookPath)} "$@"
`;
}

/**
 * What a tool's config records: the wrapper's absolute path.
 *
 * Quoted only when the path contains a space. A bare path runs under both
 * execution models these tools use — a shell string and an argv split — while
 * quotes only survive the shell one, which is also the only model that can run
 * a path with a space in it at all.
 */
export function guardCommand(wrapperPath: string): string {
  return wrapperPath.includes(' ') ? `"${wrapperPath}"` : wrapperPath;
}

const isOurs = (cmd: unknown): boolean =>
  typeof cmd === 'string' && cmd.includes('chat_recall_guard');

const asArray = (v: unknown): any[] => (Array.isArray(v) ? v : []);

/** Codex: { hooks: { PreToolUse: [ { matcher, hooks: [ {type, command} ] } ] } } */
function mergeCodex(config: any, command: string): any {
  const c = config && typeof config === 'object' ? { ...config } : {};
  const hooks = c.hooks && typeof c.hooks === 'object' ? { ...c.hooks } : {};
  const kept = asArray(hooks.PreToolUse).filter((e) => !asArray(e?.hooks).some((h: any) => isOurs(h?.command)));
  kept.push({
    matcher: CODEX_MATCHER,
    hooks: [{ type: 'command', command, statusMessage: 'chat-recall: checking decisions', timeout: TIMEOUT_SECS }],
  });
  hooks.PreToolUse = kept;
  c.hooks = hooks;
  return c;
}

function stripCodex(config: any): { config: any; removed: number } {
  const c = config && typeof config === 'object' ? { ...config } : {};
  const hooks = c.hooks && typeof c.hooks === 'object' ? { ...c.hooks } : {};
  const before = asArray(hooks.PreToolUse);
  const kept = before.filter((e) => !asArray(e?.hooks).some((h: any) => isOurs(h?.command)));
  if (kept.length) hooks.PreToolUse = kept;
  else delete hooks.PreToolUse;
  c.hooks = hooks;
  return { config: c, removed: before.length - kept.length };
}

/** Antigravity: top-level keys name a hook group, and ours owns one key. */
function mergeAgy(config: any, command: string): any {
  const c = config && typeof config === 'object' ? { ...config } : {};
  c[GUARD_ID] = {
    enabled: true,
    PreToolUse: [{
      matcher: AGY_MATCHER,
      hooks: [{ type: 'command', command, timeout: TIMEOUT_SECS }],
    }],
  };
  return c;
}

function stripAgy(config: any): { config: any; removed: number } {
  const c = config && typeof config === 'object' ? { ...config } : {};
  const had = Object.prototype.hasOwnProperty.call(c, GUARD_ID) ? 1 : 0;
  delete c[GUARD_ID];
  return { config: c, removed: had };
}

/** Cursor: { version: 1, hooks: { beforeShellExecution: [...], afterFileEdit: [...] } } */
function mergeCursor(config: any, command: string): any {
  const c = config && typeof config === 'object' ? { ...config } : {};
  c.version = typeof c.version === 'number' ? c.version : 1;
  const hooks = c.hooks && typeof c.hooks === 'object' ? { ...c.hooks } : {};
  for (const event of ['beforeShellExecution', 'afterFileEdit']) {
    const kept = asArray(hooks[event]).filter((e) => !isOurs(e?.command));
    kept.push({ command });
    hooks[event] = kept;
  }
  c.hooks = hooks;
  return c;
}

function stripCursor(config: any): { config: any; removed: number } {
  const c = config && typeof config === 'object' ? { ...config } : {};
  const hooks = c.hooks && typeof c.hooks === 'object' ? { ...c.hooks } : {};
  let removed = 0;
  for (const event of ['beforeShellExecution', 'afterFileEdit']) {
    const before = asArray(hooks[event]);
    const kept = before.filter((e) => !isOurs(e?.command));
    removed += before.length - kept.length;
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  c.hooks = hooks;
  return { config: c, removed };
}

/**
 * Merge our guard entry into one tool's parsed config.
 *
 * Every merge drops our own prior entry first, so re-running the installer
 * leaves one registration, and touches nothing whose command is not ours.
 */
export function registerGuard(tool: Exclude<GuardTool, 'opencode'>, config: unknown, command: string): any {
  switch (tool) {
    case 'codex': return mergeCodex(config, command);
    case 'agy': return mergeAgy(config, command);
    case 'cursor': return mergeCursor(config, command);
  }
}

/** Remove our guard entry from one tool's parsed config. */
export function unregisterGuard(tool: Exclude<GuardTool, 'opencode'>, config: unknown): { config: any; removed: number } {
  switch (tool) {
    case 'codex': return stripCodex(config);
    case 'agy': return stripAgy(config);
    case 'cursor': return stripCursor(config);
  }
}

/**
 * The OpenCode plugin, as the file it is written to.
 *
 * OpenCode loads a plugin as a module and calls its hooks in-process, so this
 * one shells out to the same script the other four run and reads its verdict
 * off stdout. `tool.execute.before` returns void, and a throw is what blocks —
 * so a warning is printed and the call proceeds.
 */
export function opencodePluginSource(hookPath: string): string {
  return `// Written by \`chat-recall install-hooks\`. Re-running replaces it.
//
// Sends each tool call to the same guard the other harnesses run, and prints
// what it says. Blocking is opt-in: set CHAT_RECALL_GUARD_ENFORCE=1 and a
// finding throws, which is how an OpenCode plugin stops a call.
import { spawn } from "child_process";

const HOOK = ${JSON.stringify(hookPath)};

function ask(payload) {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(HOOK, {
      env: { ...process.env, CHAT_RECALL_GUARD_HARNESS: "opencode" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const done = setTimeout(() => { child.kill(); resolve(null); }, ${TIMEOUT_SECS * 1000});
    child.stdout.on("data", (c) => { out += c; });
    child.on("error", () => { clearTimeout(done); resolve(null); });
    child.on("close", () => {
      clearTimeout(done);
      try { resolve(out.trim() ? JSON.parse(out) : null); } catch { resolve(null); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

export const ChatRecallGuard = async () => ({
  "tool.execute.before": async (input, output) => {
    const verdict = await ask({ tool: input?.tool, args: output?.args });
    if (!verdict || !verdict.message) return;
    if (verdict.block) throw new Error(verdict.message);
    console.error(verdict.message);
  },
});
`;
}
