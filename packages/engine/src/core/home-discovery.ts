/**
 * Find every transcript home on this machine — by SIGNATURE, not by name.
 *
 * ── Why the old approach fails a paying customer ─────────────────────────
 * Discovery matched `~/.claude-*` siblings. That works only if the user happens
 * to name their profile the way we guessed. A second profile at `~/work-claude`,
 * or anywhere under `%APPDATA%` on Windows, got ZERO coverage with no error, no
 * listing and no hint — the failure mode that stranded a whole work session
 * here for a day before a human noticed.
 *
 * A home is identifiable by what it CONTAINS, and that is stable across
 * platforms and naming choices:
 *
 *   claude    <home>/projects/<project>/<uuid>.jsonl
 *   codex     <home>/sessions/YYYY/MM/DD/rollout-*.jsonl
 *   gemini    <home>/tmp/<project>/chats/session-*.json[l]
 *   agy       <home>/brain/<id>/.system_generated/logs/*.jsonl
 *   opencode  <dir>/opencode.db
 *
 * ── Three signals, cheapest and most reliable first ──────────────────────
 *  1. DECLARED — where the user actually configured a profile: our own env,
 *     shell rc files, and (Windows) the user environment. `CLAUDE_CONFIG_DIR`
 *     is how a second profile comes into existence, so this finds deliberate
 *     setups directly rather than inferring them.
 *  2. SIGNATURE SCAN — bounded walk of the platform's real config roots.
 *  3. RUNNING TOOL — a live process's env is ground truth for "where is it
 *     writing right now". Cheap on Linux (/proc), best-effort elsewhere.
 *
 * Everything is bounded: fixed root list, shallow depth, skip-list for the
 * directories that make a naive scan take minutes. This runs at onboarding and
 * on a slow daemon timer, never on the sync hot path.
 */

import { execFileSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'fs';
import { homedir, platform as osPlatform } from 'os';
import { join } from 'path';

export type HomeTool = 'claude' | 'codex' | 'gemini' | 'agy' | 'opencode';

export interface DiscoveredHome {
  tool: HomeTool;
  /** Absolute, realpath-resolved directory (for opencode, the db's directory). */
  path: string;
  /** How we found it — shown to the user, because "you configured this" and
   *  "we found this on disk" deserve different levels of trust. */
  via: 'declared' | 'signature' | 'running-process';
  /** Transcript count, so the operator can see what is at stake. */
  sessions: number;
}

/** Depth limit for the signature walk. Homes sit at most 2 levels under a
 *  config root in every layout we support; deeper is someone else's data. */
const MAX_DEPTH = 2;

/** Directories that turn a shallow scan into a slow one, or that never contain
 *  a transcript home. Skipped by exact name at any level. */
const SKIP = new Set([
  'node_modules', '.git', '.cache', 'Caches', 'CachedData', '.Trash', 'Trash',
  'Downloads', 'Pictures', 'Music', 'Movies', 'Videos', 'Library/Caches',
  'AppData/Local/Temp', 'Temp', 'tmp', 'venv', '.venv', '__pycache__',
  'Applications', 'System', 'Windows', 'Program Files', 'Program Files (x86)',
]);

/** Config roots worth scanning, per platform. Ordered: the likeliest first. */
export function candidateRoots(plat: NodeJS.Platform = osPlatform(), env = process.env): string[] {
  const home = homedir();
  const roots: string[] = [home];
  const add = (p?: string) => { if (p && !roots.includes(p)) roots.push(p); };

  if (plat === 'win32') {
    add(env.APPDATA);
    add(env.LOCALAPPDATA);
    add(env.USERPROFILE);
  } else if (plat === 'darwin') {
    add(join(home, 'Library', 'Application Support'));
    add(env.XDG_CONFIG_HOME);
  } else {
    add(env.XDG_CONFIG_HOME || join(home, '.config'));
    add(env.XDG_DATA_HOME || join(home, '.local', 'share'));
  }
  return roots.filter((r) => existsSync(r));
}

/** Does `dir` look like a home for `tool`? Structural test, no name matching. */
export function identifyHome(dir: string): HomeTool | null {
  const has = (...parts: string[]) => existsSync(join(dir, ...parts));
  // Claude: projects/ with at least one project dir holding a .jsonl.
  if (has('projects') && dirHasTranscript(join(dir, 'projects'), (f) => f.endsWith('.jsonl'), 2)) return 'claude';
  // Codex: sessions/YYYY/MM/DD/rollout-*.jsonl — the `rollout-` prefix is
  // load-bearing. Matching any sessions/**/*.jsonl claimed ~/.local/share/goose
  // (Block's Goose, flat sessions/<timestamp>.jsonl) as a Codex home on a real
  // machine. Misidentifying an unrelated tool's data as ours to sync is the
  // worst possible false positive here, so the test is the specific filename.
  if (has('sessions') && dirHasTranscript(join(dir, 'sessions'), (f) => f.startsWith('rollout-') && f.endsWith('.jsonl'), 4)) return 'codex';
  // Gemini: tmp/<project>/chats/session-*
  if (has('tmp') && dirHasTranscript(join(dir, 'tmp'), (f) => f.startsWith('session-'), 3)) return 'gemini';
  // Antigravity: brain/<id>/.system_generated/logs/*.jsonl
  if (has('brain') && dirHasTranscript(join(dir, 'brain'), (f) => f.endsWith('.jsonl'), 4)) return 'agy';
  // OpenCode: the db file itself.
  if (has('opencode.db')) return 'opencode';
  return null;
}

/** Shallow existence probe — stops at the FIRST match, so a huge home costs
 *  the same as an empty one. */
function dirHasTranscript(root: string, match: (f: string) => boolean, depth: number): boolean {
  if (depth <= 0) return false;
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    if (e.isFile() && match(e.name)) return true;
    if (e.isDirectory() && dirHasTranscript(join(root, e.name), match, depth - 1)) return true;
  }
  return false;
}

/** Count transcripts under a home, bounded so a 10k-session home stays cheap. */
function countSessions(dir: string, tool: HomeTool): number {
  const spec: Record<HomeTool, { sub: string; depth: number; match: (f: string) => boolean }> = {
    claude:   { sub: 'projects', depth: 2, match: (f) => f.endsWith('.jsonl') && f !== 'sessions-index.json' },
    codex:    { sub: 'sessions', depth: 4, match: (f) => f.startsWith('rollout-') && f.endsWith('.jsonl') },
    gemini:   { sub: 'tmp',      depth: 3, match: (f) => f.startsWith('session-') },
    agy:      { sub: 'brain',    depth: 4, match: (f) => f.endsWith('.jsonl') },
    opencode: { sub: '',         depth: 0, match: () => false },
  };
  const s = spec[tool];
  if (!s.sub) return 0;                      // opencode: rows, not files
  let n = 0;
  const walk = (d: string, depth: number) => {
    if (depth < 0 || n > 100_000) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      if (e.isDirectory()) walk(join(d, e.name), depth - 1);
      else if (s.match(e.name)) n++;
    }
  };
  walk(join(dir, s.sub), s.depth);
  return n;
}

/**
 * The session ids stored in ONE home.
 *
 * Needed because the server does not record which folder a session came from —
 * so "delete everything you uploaded from my work folder" can only be answered
 * by the machine that owns the path. Without this, declining a folder stops
 * FUTURE uploads but leaves prior ones in place, which makes "keep my work data
 * out of here" unenforceable after the fact.
 *
 * Claude/Codex/Gemini/Antigravity name their transcripts after the session id, so
 * the filename is the answer. OpenCode keys sessions by row and would need the
 * db opened, so it returns empty rather than guessing.
 */
export function sessionIdsInHome(dir: string, tool: HomeTool): string[] {
  const out = new Set<string>();
  const spec: Record<HomeTool, { sub: string; depth: number; idOf: (f: string) => string | null }> = {
    claude: { sub: 'projects', depth: 2,
      idOf: (f) => (f.endsWith('.jsonl') && f !== 'sessions-index.json' ? f.slice(0, -6) : null) },
    codex: { sub: 'sessions', depth: 4,
      // rollout-<iso>-<uuid>.jsonl — the id is the trailing uuid.
      idOf: (f) => {
        if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) return null;
        const m = f.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
        return m ? `codex_${m[1]}` : null;
      } },
    gemini: { sub: 'tmp', depth: 3,
      idOf: (f) => (f.startsWith('session-') ? `gemini_${f.replace(/\.jsonl?$/, '')}` : null) },
    agy: { sub: 'brain', depth: 1, idOf: () => null },   // id is the DIRECTORY name
    opencode: { sub: '', depth: 0, idOf: () => null },   // rows, not files
  };
  const s = spec[tool];
  if (!s.sub) return [];

  // Antigravity names the session DIR, not the file.
  if (tool === 'agy') {
    try {
      for (const e of readdirSync(join(dir, 'brain'), { withFileTypes: true })) {
        if (e.isDirectory()) out.add(`agy_${e.name}`);
      }
    } catch { /* unreadable */ }
    return [...out];
  }

  const walk = (d: string, depth: number) => {
    if (depth < 0) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      if (e.isDirectory()) { walk(join(d, e.name), depth - 1); continue; }
      const id = s.idOf(e.name);
      if (id) out.add(id);
    }
  };
  walk(join(dir, s.sub), s.depth);
  return [...out];
}

/** Signal 1 — paths the USER declared, which is the strongest evidence. */
export function declaredHomes(env = process.env, plat: NodeJS.Platform = osPlatform()): string[] {
  const out: string[] = [];
  const add = (p?: string | null) => {
    if (!p) return;
    const t = p.trim().replace(/^["']|["']$/g, '');
    if (t && !out.includes(t)) out.push(t);
  };

  // Our own environment, and the tools' own override vars.
  add(env.CLAUDE_CONFIG_DIR);
  add(env.CHAT_RECALL_CLAUDE_HOME);
  add(env.CHAT_RECALL_CODEX_HOME);
  add(env.CHAT_RECALL_GEMINI_HOME);
  add(env.CHAT_RECALL_AGY_HOME);
  for (const d of (env.CLAUDE_DIRS || '').split(',')) add(d);

  if (plat === 'win32') {
    // User-scoped environment, where a Windows user sets a profile var.
    try {
      const out2 = execFileSync('powershell', ['-NoProfile', '-Command',
        "[Environment]::GetEnvironmentVariable('CLAUDE_CONFIG_DIR','User')"],
        { encoding: 'utf-8', timeout: 10_000 }).trim();
      add(out2);
    } catch { /* powershell unavailable — other signals still apply */ }
    return out;
  }

  // Shell rc files: where a profile is actually configured on unix.
  const home = homedir();
  const rcs = ['.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.profile']
    .map((f) => join(home, f))
    .concat([join(home, '.config', 'fish', 'config.fish')]);
  for (const rc of rcs) {
    let text: string;
    try { text = readFileSync(rc, 'utf-8'); } catch { continue; }
    for (const m of text.matchAll(/CLAUDE_CONFIG_DIR\s*[= ]\s*["']?([^"'\s;]+)/g)) add(m[1]);
    for (const m of text.matchAll(/CLAUDE_DIRS\s*[= ]\s*["']?([^"'\s;]+)/g)) {
      for (const d of m[1].split(',')) add(d);
    }
  }
  return out.map((p) => (p.startsWith('~') ? join(home, p.slice(1)) : p));
}

/** Signal 3 — a live tool process knows exactly where it is writing. */
export function runningToolHomes(plat: NodeJS.Platform = osPlatform()): string[] {
  const out: string[] = [];
  if (plat === 'linux') {
    let pids: string[];
    try { pids = readdirSync('/proc').filter((p) => /^\d+$/.test(p)); } catch { return out; }
    for (const pid of pids) {
      let env: string;
      try { env = readFileSync(`/proc/${pid}/environ`, 'utf-8'); } catch { continue; }
      for (const kv of env.split('\0')) {
        if (kv.startsWith('CLAUDE_CONFIG_DIR=')) {
          const v = kv.slice('CLAUDE_CONFIG_DIR='.length).trim();
          if (v && !out.includes(v)) out.push(v);
        }
      }
    }
    return out;
  }
  if (plat === 'darwin') {
    // `ps eww` exposes the environment of the CURRENT user's processes.
    try {
      const ps = execFileSync('ps', ['eww', '-o', 'command', '-u', String(process.getuid?.() ?? '')], {
        encoding: 'utf-8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024,
      });
      for (const m of ps.matchAll(/CLAUDE_CONFIG_DIR=(\S+)/g)) {
        if (!out.includes(m[1])) out.push(m[1]);
      }
    } catch { /* restricted — other signals still apply */ }
    return out;
  }
  // Windows: reading another process's environment needs native calls we do not
  // want to take a dependency on. The declared + signature signals cover it.
  return out;
}

/**
 * Every transcript home on this machine, deduped by realpath.
 *
 * `declared` wins over `signature` for the same path, because "the user told us"
 * is worth more than "we found it", and the UI shows that difference.
 */
export function discoverHomes(opts: {
  plat?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  includeRunning?: boolean;
} = {}): DiscoveredHome[] {
  const plat = opts.plat ?? osPlatform();
  const env = opts.env ?? process.env;
  const found = new Map<string, DiscoveredHome>();

  const consider = (dir: string, via: DiscoveredHome['via']) => {
    let real: string;
    try { real = realpathSync(dir); } catch { return; }
    try { if (!statSync(real).isDirectory()) return; } catch { return; }
    const tool = identifyHome(real);
    if (!tool) return;
    const prior = found.get(real);
    if (prior && !(via === 'declared' && prior.via !== 'declared')) return;
    found.set(real, { tool, path: real, via, sessions: countSessions(real, tool) });
  };

  // 1. Declared — strongest signal, and cheap.
  for (const d of declaredHomes(env, plat)) consider(d, 'declared');

  // 2. Signature scan of the platform's config roots.
  for (const root of candidateRoots(plat, env)) {
    consider(root, 'signature');                       // the root itself may BE a home
    walkForHomes(root, MAX_DEPTH, (d) => consider(d, 'signature'));
  }

  // 3. Live processes.
  if (opts.includeRunning !== false) {
    for (const d of runningToolHomes(plat)) consider(d, 'running-process');
  }

  return [...found.values()].sort((a, b) =>
    a.tool.localeCompare(b.tool) || b.sessions - a.sessions || a.path.localeCompare(b.path));
}

function walkForHomes(dir: string, depth: number, visit: (d: string) => void): void {
  if (depth <= 0) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory() || SKIP.has(e.name)) continue;
    const child = join(dir, e.name);
    visit(child);
    walkForHomes(child, depth - 1, visit);
  }
}
