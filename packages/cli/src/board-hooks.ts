/**
 * Registration for the two board hooks, on every platform.
 *
 * The other five hooks are POSIX shell scripts, and `install-hooks` refuses to
 * register any of them on Windows: Claude Code runs a hook command through
 * cmd.exe, which cannot execute a `.sh`. Registering them there put an error on
 * every interaction.
 *
 * These two need no shell. The work is `chat-recall task-hook`, a CLI command
 * that reads the hook payload on stdin, so the registered command is the CLI
 * itself — node plus the bundle path, both quoted. cmd.exe and sh run that
 * string identically, so a Windows user gets the board loop that a mac and
 * Linux user get.
 *
 * Registration is also the only reason the loop reaches anyone: `init` never
 * installed hooks, so until now the board moved for whoever had separately run
 * `chat-recall install-hooks`.
 *
 * The message hook is registered the same way, for the same reason. It is its
 * own small bundle (`dist/message-hook.js`) because it runs on every tool call,
 * and the full CLI takes about 0.4 s to start.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

type HookEntry = { matcher: string; hooks: Array<{ type: string; command: string }> };
type HookConfig = { hooks?: Record<string, unknown[]> };

/** The command string of a hooks.json entry, or null for a malformed one. */
function entryCommand(entry: unknown): string | null {
  const cmd = (entry as { hooks?: Array<{ command?: unknown }> })?.hooks?.[0]?.command;
  return typeof cmd === 'string' ? cmd : null;
}

/** The two events the board loop needs, and the flag each one passes. */
export const BOARD_HOOKS: ReadonlyArray<{ event: string; mode: 'claim' | 'close' }> = [
  { event: 'UserPromptSubmit', mode: 'claim' },
  { event: 'SessionEnd', mode: 'close' },
];

/**
 * The command Claude Code runs for one half of the loop.
 *
 * Both paths are quoted because either can contain a space — a Windows home
 * directory ("C:\\Users\\First Last") reaches here, and an unquoted command
 * splits at it.
 */
export function boardHookCommand(execPath: string, cliEntry: string, mode: 'claim' | 'close'): string {
  return `"${execPath}" "${cliEntry}" task-hook --${mode}`;
}

/**
 * True when this hooks.json entry is one of ours.
 *
 * It answers for two shapes. The first is the CLI command above. The second is
 * `chat_recall_task_hook.sh`, a wrapper that shipped briefly and did nothing
 * but pipe stdin to that same command — a registration pointing at it survives
 * an upgrade, and the script it names is gone, so it must be recognised to be
 * cleaned up.
 */
export function isBoardHookEntry(entry: unknown): boolean {
  const cmd = entryCommand(entry);
  if (cmd === null) return false;
  if (cmd.includes('chat_recall_task_hook.sh')) return true;
  return cmd.includes('task-hook') && (cmd.includes('--claim') || cmd.includes('--close'));
}

/** The `[event, entry]` pairs for a hooks.json. */
export function boardHookEntries(execPath: string, cliEntry: string): Array<[string, HookEntry]> {
  return BOARD_HOOKS.map(({ event, mode }) => [
    event,
    { matcher: '', hooks: [{ type: 'command', command: boardHookCommand(execPath, cliEntry, mode) }] },
  ] as [string, HookEntry]);
}

/**
 * The events the message hook handles. SessionStart tells the session its own
 * id; the prompt, the tool call and the turn end deliver what waits for it;
 * SessionEnd marks it ended so a parent stops waiting for it.
 */
export const MESSAGE_HOOK_EVENTS: readonly string[] = [
  'SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd',
];

/** The command Claude Code runs for the message hook. Both paths quoted, as above. */
export function messageHookCommand(execPath: string, hookEntry: string): string {
  return `"${execPath}" "${hookEntry}"`;
}

/** True when this hooks.json entry is the message hook. */
export function isMessageHookEntry(entry: unknown): boolean {
  const cmd = entryCommand(entry);
  return cmd !== null && /message-hook\.(js|ts)"?$/.test(cmd.trim());
}

/** The `[event, entry]` pairs for the message hook. */
export function messageHookEntries(execPath: string, hookEntry: string): Array<[string, HookEntry]> {
  const command = messageHookCommand(execPath, hookEntry);
  return MESSAGE_HOOK_EVENTS.map((event) => [event, { matcher: '', hooks: [{ type: 'command', command }] }] as [string, HookEntry]);
}

/**
 * Replace our entries for these events in one parsed hooks.json.
 *
 * Every prior entry of ours is dropped first, so a reinstall after an upgrade
 * replaces a stale bundle path instead of stacking a second registration.
 * Entries that are not ours are untouched.
 */
function mergeEntries(config: HookConfig, events: readonly string[], entries: Array<[string, HookEntry]>, ours: (e: unknown) => boolean): void {
  if (!config.hooks || typeof config.hooks !== 'object') config.hooks = {};
  for (const event of events) {
    const current = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
    const kept = current.filter((h) => !ours(h));
    for (const [ev, entry] of entries) if (ev === event) kept.push(entry);
    config.hooks[event] = kept;
  }
}

/** Drop our entries for these events; returns how many it removed. */
function removeEntries(config: HookConfig, events: readonly string[], ours: (e: unknown) => boolean): number {
  if (!config.hooks) return 0;
  let removed = 0;
  for (const event of events) {
    const current = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
    const kept = current.filter((h) => !ours(h));
    removed += current.length - kept.length;
    if (kept.length) config.hooks[event] = kept;
    else delete config.hooks[event];
  }
  return removed;
}

/** Merge the board hooks into one already-parsed hooks.json object. */
export function mergeBoardHooks(config: HookConfig, execPath: string, cliEntry: string): void {
  mergeEntries(config, BOARD_HOOKS.map((h) => h.event), boardHookEntries(execPath, cliEntry), isBoardHookEntry);
}

/** Drop the board hooks from one already-parsed hooks.json object. */
export function removeBoardHooks(config: HookConfig): number {
  return removeEntries(config, BOARD_HOOKS.map((h) => h.event), isBoardHookEntry);
}

/** Merge the message hook into one already-parsed hooks.json object. */
export function mergeMessageHooks(config: HookConfig, execPath: string, hookEntry: string): void {
  mergeEntries(config, MESSAGE_HOOK_EVENTS, messageHookEntries(execPath, hookEntry), isMessageHookEntry);
}

/** Drop the message hook from one already-parsed hooks.json object. */
export function removeMessageHooks(config: HookConfig): number {
  return removeEntries(config, MESSAGE_HOOK_EVENTS, isMessageHookEntry);
}

/** Read a hooks.json, tolerating an absent or unreadable file. */
function readConfig(file: string): HookConfig {
  if (!existsSync(file)) return { hooks: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { hooks?: Record<string, unknown[]> };
    if (!parsed.hooks || typeof parsed.hooks !== 'object') parsed.hooks = {};
    return parsed;
  } catch { return { hooks: {} }; }
}

/**
 * Apply one change to every given hooks.json.
 *
 * Returns the files it wrote. A file it cannot parse is skipped rather than
 * overwritten: another tool's config is not ours to replace.
 */
function writeConfigs(files: string[], change: (config: HookConfig) => void): string[] {
  const written: string[] = [];
  for (const file of files) {
    if (existsSync(file)) {
      try { JSON.parse(readFileSync(file, 'utf-8')); } catch { continue; }
    }
    const config = readConfig(file);
    change(config);
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
      written.push(file);
    } catch { /* a read-only profile directory is not a reason to fail setup */ }
  }
  return written;
}

/** Register the board hooks in every given hooks.json. */
export function registerBoardHooks(files: string[], execPath: string, cliEntry: string): string[] {
  return writeConfigs(files, (c) => mergeBoardHooks(c, execPath, cliEntry));
}

/** Register the message hook in every given hooks.json. */
export function registerMessageHooks(files: string[], execPath: string, hookEntry: string): string[] {
  return writeConfigs(files, (c) => mergeMessageHooks(c, execPath, hookEntry));
}

/** Resolve the CLI entry that a hook should run. */
export function resolveCliEntry(distDir: string): string {
  const bundled = join(distDir, 'cli.js');
  return existsSync(bundled) ? bundled : join(distDir, 'cli.ts');
}

/** Resolve the message hook bundle that sits beside the CLI. */
export function resolveMessageHookEntry(distDir: string): string {
  const bundled = join(distDir, 'message-hook.js');
  return existsSync(bundled) ? bundled : join(distDir, 'message-hook.ts');
}
