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
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
  const cmd = (entry as { hooks?: Array<{ command?: unknown }> })?.hooks?.[0]?.command;
  if (typeof cmd !== 'string') return false;
  if (cmd.includes('chat_recall_task_hook.sh')) return true;
  return cmd.includes('task-hook') && (cmd.includes('--claim') || cmd.includes('--close'));
}

/** The `[event, entry]` pairs for a hooks.json. */
export function boardHookEntries(
  execPath: string,
  cliEntry: string,
): Array<[string, { matcher: string; hooks: Array<{ type: string; command: string }> }]> {
  return BOARD_HOOKS.map(({ event, mode }) => [
    event,
    { matcher: '', hooks: [{ type: 'command', command: boardHookCommand(execPath, cliEntry, mode) }] },
  ] as [string, { matcher: string; hooks: Array<{ type: string; command: string }> }]);
}

/**
 * Merge the board hooks into one already-parsed hooks.json object.
 *
 * Every prior entry of ours is dropped first, so a reinstall after an upgrade
 * replaces a stale bundle path instead of stacking a second registration.
 * Entries that are not ours are untouched: a profile carries the resume hint on
 * the same event.
 */
export function mergeBoardHooks(
  config: { hooks?: Record<string, unknown[]> },
  execPath: string,
  cliEntry: string,
): void {
  if (!config.hooks || typeof config.hooks !== 'object') config.hooks = {};
  const entries = boardHookEntries(execPath, cliEntry);
  for (const { event } of BOARD_HOOKS) {
    const current = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
    const kept = current.filter((h) => !isBoardHookEntry(h));
    for (const [ev, entry] of entries) if (ev === event) kept.push(entry);
    config.hooks[event] = kept;
  }
}

/** Drop the board hooks from one already-parsed hooks.json object. */
export function removeBoardHooks(config: { hooks?: Record<string, unknown[]> }): number {
  if (!config.hooks) return 0;
  let removed = 0;
  for (const { event } of BOARD_HOOKS) {
    const current = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
    const kept = current.filter((h) => !isBoardHookEntry(h));
    removed += current.length - kept.length;
    if (kept.length) config.hooks[event] = kept;
    else delete config.hooks[event];
  }
  return removed;
}

/** Read a hooks.json, tolerating an absent or unreadable file. */
function readConfig(file: string): { hooks?: Record<string, unknown[]> } {
  if (!existsSync(file)) return { hooks: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { hooks?: Record<string, unknown[]> };
    if (!parsed.hooks || typeof parsed.hooks !== 'object') parsed.hooks = {};
    return parsed;
  } catch { return { hooks: {} }; }
}

/**
 * Register the board hooks in every given hooks.json.
 *
 * Returns the files it wrote. A file it cannot parse is skipped rather than
 * overwritten: another tool's config is not ours to replace.
 */
export function registerBoardHooks(files: string[], execPath: string, cliEntry: string): string[] {
  const written: string[] = [];
  for (const file of files) {
    if (existsSync(file)) {
      try { JSON.parse(readFileSync(file, 'utf-8')); } catch { continue; }
    }
    const config = readConfig(file);
    mergeBoardHooks(config, execPath, cliEntry);
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
      written.push(file);
    } catch { /* a read-only profile directory is not a reason to fail setup */ }
  }
  return written;
}

/** Resolve the CLI entry that a hook should run. */
export function resolveCliEntry(distDir: string): string {
  const bundled = join(distDir, 'cli.js');
  return existsSync(bundled) ? bundled : join(distDir, 'cli.ts');
}
