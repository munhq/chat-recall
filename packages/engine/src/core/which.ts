/**
 * "Is this program on PATH, and where?" — on all three platforms, without a shell.
 *
 * Every caller used to spawn `command -v <name>` or `which <name>`. Neither is
 * a Windows command: cmd.exe answers "'command' is not recognized", the probe
 * throws, and the catch reads that as "not installed". So on Windows the CLI
 * decided that codeindex was absent, that `chat-recall-mcp` was not on PATH,
 * and that the user had no AI tools installed at all — while all of them were
 * sitting there. Silent, and impossible to diagnose from the outside.
 *
 * Resolving PATH ourselves fixes that and removes the spawn. `which` is also
 * not guaranteed on a minimal Linux image, and each probe cost a process.
 *
 * Windows notes: executability is the file extension, not a mode bit, so we try
 * each suffix in PATHEXT; PATH entries may be quoted; and the current directory
 * is implicitly searched first by cmd.exe — deliberately NOT reproduced here,
 * because resolving a binary out of the working directory is how you execute
 * something a repo dropped there.
 */
import { existsSync, statSync, accessSync, constants } from 'node:fs';
import { join, isAbsolute, delimiter, sep } from 'node:path';

const isWindows = process.platform === 'win32';

function executable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
  } catch {
    return false;
  }
  // Windows has no execute bit; being a file with an executable extension is
  // the whole test, and X_OK there reports success for anything readable.
  if (isWindows) return true;
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Candidate filenames for `name`, honouring PATHEXT on Windows. */
function candidates(name: string): string[] {
  if (!isWindows) return [name];
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean);
  // An explicit extension the user already gave us must win outright.
  if (exts.some((e) => name.toLowerCase().endsWith(e.toLowerCase()))) return [name];
  return exts.map((e) => name + e);
}

/**
 * Absolute path to `name` if it is runnable, else null.
 *
 * A name containing a path separator is treated as a path, not a PATH lookup —
 * the same rule every shell uses.
 */
export function resolveOnPath(name: string): string | null {
  if (!name) return null;

  if (name.includes('/') || (isWindows && name.includes(sep)) || isAbsolute(name)) {
    for (const c of candidates(name)) if (executable(c)) return c;
    return null;
  }

  for (const raw of (process.env.PATH || '').split(delimiter)) {
    // Windows PATH entries are sometimes quoted; an empty entry means CWD on
    // POSIX, which we skip for the same reason as above.
    const dir = raw.replace(/^"(.*)"$/, '$1');
    if (!dir) continue;
    for (const c of candidates(name)) {
      const full = join(dir, c);
      if (existsSync(full) && executable(full)) return full;
    }
  }
  return null;
}

/** True when `name` is runnable from PATH. */
export function isOnPath(name: string): boolean {
  return resolveOnPath(name) !== null;
}
