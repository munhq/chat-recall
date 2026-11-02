/**
 * The AI processes that run on this machine right now, and the folder each one
 * is in.
 *
 * A session reports itself to chat-recall at its first prompt, so a tool that
 * is open and typed nothing into is invisible: that is exactly the opencode TUI
 * a coordinator cannot find. `/proc` shows the process and its folder before
 * any session exists. Linux only; other platforms return an empty list and the
 * status view leaves the section out.
 */
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';

/** The commands a person runs an AI coding session with. */
const AI_COMMANDS = new Set(['opencode', 'claude']);

export interface LocalAiProcess {
  pid: number;
  /** The command name, e.g. `opencode`. */
  command: string;
  /** The folder the process runs in, from /proc/<pid>/cwd. */
  cwd: string;
}

/**
 * Same command in the same folder once. A TUI, the service it talks to and its
 * helper processes share a folder; the status view wants one line for it.
 */
function dedupe(processes: LocalAiProcess[]): LocalAiProcess[] {
  const seen = new Map<string, LocalAiProcess>();
  for (const p of processes) {
    const key = `${p.command}\u0000${p.cwd}`;
    if (!seen.has(key)) seen.set(key, p);
  }
  return [...seen.values()].sort((a, b) => a.command.localeCompare(b.command) || a.cwd.localeCompare(b.cwd));
}

/**
 * The AI processes of this machine, oldest pid first within a folder. Never
 * throws: a machine without /proc, or a process that exits mid-read, gives an
 * empty or shorter list.
 */
export async function localAiProcesses(): Promise<LocalAiProcess[]> {
  if (process.platform !== 'linux') return [];
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return [];
  }
  const out: LocalAiProcess[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    let command: string;
    try {
      // comm is at most 15 characters, which holds both names.
      command = readFileSync(`/proc/${pid}/comm`, 'utf-8').trim();
    } catch {
      continue;
    }
    if (!AI_COMMANDS.has(command)) continue;
    let cwd: string;
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      continue;
    }
    // A deleted folder reads as "/path (deleted)"; the session's own report is
    // the better address in that case, and this one is not a real folder.
    if (!cwd || cwd.endsWith(' (deleted)')) continue;
    out.push({ pid, command, cwd });
  }
  return dedupe(out);
}
