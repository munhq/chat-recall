/**
 * Whether this session asked for chat-recall's channel, and why.
 *
 * Claude Code delivers a channel notification into a session as if the user had
 * typed it, which is the only way to reach a session that is idle: no hook runs,
 * so nothing else can. It is off unless the session names our server on the
 * command line, and the session cannot ask us: the MCP server sees neither the
 * client's arguments nor its own, only its parent's.
 *
 * So this reads the argument lists of the processes above us. `claude` is the
 * parent of the MCP server (or of a shell that runs the hook), and the flag is
 * on its command line, where `/proc` and `ps` both show it.
 *
 * Three ways in, most specific first:
 *
 *   CHAT_RECALL_CHANNEL=1   the session wants it (also what a test or a wrapper sets)
 *   CHAT_RECALL_CHANNEL=0   never, whatever the command line says
 *   --channels server:chat-recall
 *   --dangerously-load-development-channels server:chat-recall
 *
 * The second flag is the one that works today: a plain MCP server is not on the
 * approved-channels allowlist, so `--channels` alone is refused and the flag it
 * names is never registered. Both are read because the allowlist is Anthropic's
 * to change, and the day chat-recall is on it, the plain form starts working
 * with no change here.
 *
 * Nothing here imports the engine: the relay calls it before it decides how to
 * serve a session, and the relay's whole point is not to pay for the engine.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** The argument that names our server, in both spellings Claude Code accepts. */
const OURS = new Set(['server:chat-recall', 'chat-recall']);

/** The two flags whose value list names the servers of a session. */
const FLAGS = new Set(['--channels', '--dangerously-load-development-channels']);

/**
 * Does this argument list name chat-recall as a channel server?
 *
 * Each flag takes a list that runs until the next argument starting with `-`.
 * The list can also hold `plugin:<name>@<marketplace>` and, when the prompt
 * follows the flag, the prompt itself: a token only matches on an exact name.
 */
export function listsOurServer(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    if (!FLAGS.has(args[i])) continue;
    for (let j = i + 1; j < args.length && !args[j].startsWith('-'); j += 1) {
      if (OURS.has(args[j])) return true;
    }
  }
  return false;
}

/** The command line of a process, or null when it is gone or unreadable. */
export function commandLineOf(pid: number): string[] | null {
  try {
    const parts = readFileSync(`/proc/${pid}/cmdline`, 'utf-8').split('\0').filter(Boolean);
    if (parts.length) return parts;
  } catch { /* not Linux, or the process is gone */ }
  // Windows has no `ps -o`; Git Bash's `ps` prints its usage to stderr instead,
  // which is why the hook guards on the platform too.
  if (process.platform === 'win32') return null;
  try {
    const out = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out ? out.split(/\s+/) : null;
  } catch { return null; }
}

/** The parent of a process, or null at pid 1 and on Windows. */
function parentOf(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    return ppid > 1 ? ppid : null;
  } catch { /* not Linux, or the process is gone */ }
  if (process.platform === 'win32') return null;
  try {
    const ppid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim());
    return Number.isInteger(ppid) && ppid > 1 ? ppid : null;
  } catch { return null; }
}

/**
 * The command lines above this process: the parent, then the grandparent.
 *
 * Two, for the same reason the message hook watches two: Claude Code may run us
 * through a shell, and that shell can outlive the Claude process that started
 * it. Deeper would reach a terminal multiplexer or an editor, whose flags say
 * nothing about this session.
 */
export function ancestorPids(from = process.ppid, depth = 2): number[] {
  const out: number[] = [];
  let pid: number | null = from;
  for (let i = 0; i < depth && pid !== null; i += 1) {
    out.push(pid);
    pid = parentOf(pid);
  }
  return out;
}

export function ancestorCommandLines(pids: readonly number[] = ancestorPids()): string[][] {
  const out: string[][] = [];
  for (const pid of pids) {
    const argv = commandLineOf(pid);
    if (argv) out.push(argv);
  }
  return out;
}

export interface ChannelDecision {
  enabled: boolean;
  /** Why, for CHAT_RECALL_MESSAGE_HOOK_DEBUG and the log. */
  reason: string;
}

/** Whether this session wants channel delivery. */
export function channelDecision(
  env: NodeJS.ProcessEnv = process.env,
  args: readonly string[] = process.argv.slice(2),
  ancestors: () => string[][] = ancestorCommandLines,
): ChannelDecision {
  const asked = env.CHAT_RECALL_CHANNEL;
  if (asked === '0') return { enabled: false, reason: 'CHAT_RECALL_CHANNEL=0' };
  if (asked === '1') return { enabled: true, reason: 'CHAT_RECALL_CHANNEL=1' };
  if (asked !== undefined && asked !== '') return { enabled: false, reason: `CHAT_RECALL_CHANNEL=${asked} is neither 0 nor 1` };
  if (listsOurServer(args)) return { enabled: true, reason: 'our own --channels flag' };
  if (ancestors().some(listsOurServer)) return { enabled: true, reason: 'a --channels flag above us' };
  return { enabled: false, reason: 'no channel flag' };
}
