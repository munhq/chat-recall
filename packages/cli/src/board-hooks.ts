/**
 * The commands for the two board hooks and the message hook, on every
 * platform. install-hooks.ts writes them into each profile's settings.json.
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
import { existsSync } from 'node:fs';
import { join } from 'node:path';

type HookEntry = { matcher: string; hooks: Array<{ type: string; command: string }> };

/** The command string of a hook entry, or null for a malformed one. */
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
 * True when this hook entry is one of ours.
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

/** The `[event, entry]` pairs for a settings.json. */
export function boardHookEntries(execPath: string, cliEntry: string): Array<[string, HookEntry]> {
  return BOARD_HOOKS.map(({ event, mode }) => [
    event,
    { matcher: '', hooks: [{ type: 'command', command: boardHookCommand(execPath, cliEntry, mode) }] },
  ] as [string, HookEntry]);
}

/**
 * The events of the message hook's turn runs. SessionStart tells the session
 * its own id; the prompt and the turn end deliver what already waits;
 * SessionEnd marks the session ended so a parent stops waiting for it.
 */
export const MESSAGE_HOOK_EVENTS: readonly string[] = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'];

/**
 * The events that start the waiter. It runs in the background (asyncRewake)
 * until a message arrives, then exits 2 and Claude Code wakes the session; the
 * turn that follows ends in a Stop, which starts the next waiter.
 */
export const MESSAGE_WAITER_EVENTS: readonly string[] = ['SessionStart', 'UserPromptSubmit', 'Stop'];

/** The command Claude Code runs for the message hook. Both paths quoted, as above. */
export function messageHookCommand(execPath: string, hookEntry: string, waiter = false): string {
  return `"${execPath}" "${hookEntry}"${waiter ? ' --wait' : ''}`;
}

/** True when this hook entry is the message hook, its turn run or its waiter. */
export function isMessageHookEntry(entry: unknown): boolean {
  const cmd = entryCommand(entry);
  return cmd !== null && /message-hook\.(js|ts)"?( --wait)?$/.test(cmd.trim());
}

/** True when this hook entry is the waiter. */
export function isMessageWaiterEntry(entry: unknown): boolean {
  return isMessageHookEntry(entry) && /--wait$/.test(entryCommand(entry)!.trim());
}

type HookCommand = { type: string; command: string; asyncRewake?: boolean };

/** The `[event, entry]` pairs for the message hook: the turn runs, then the waiters. */
export function messageHookEntries(execPath: string, hookEntry: string): Array<[string, { matcher: string; hooks: HookCommand[] }]> {
  const turn = messageHookCommand(execPath, hookEntry);
  const waiter = messageHookCommand(execPath, hookEntry, true);
  return [
    ...MESSAGE_HOOK_EVENTS.map((event) => [event, { matcher: '', hooks: [{ type: 'command', command: turn }] }] as [string, { matcher: string; hooks: HookCommand[] }]),
    ...MESSAGE_WAITER_EVENTS.map((event) => [event, { matcher: '', hooks: [{ type: 'command', command: waiter, asyncRewake: true }] }] as [string, { matcher: string; hooks: HookCommand[] }]),
  ];
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
