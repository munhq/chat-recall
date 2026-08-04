/**
 * Which discovered transcript homes are actually synced.
 *
 * Discovery (home-discovery.ts) answers "what exists". This answers "what did
 * the operator agree to send". They are deliberately separate, because the
 * interesting cases are the ones where the answer is no: `~/.claude-work` holds
 * an employer's sessions, and a personal chat-recall workspace is the wrong
 * place for them unless someone says otherwise.
 *
 * ── The rules ────────────────────────────────────────────────────────────
 *  - The PRIMARY home for a tool (default location, or an explicit
 *    `claudeHome`/`CHAT_RECALL_*_HOME` override) is implicitly approved. It is
 *    the thing the user installed chat-recall to sync; prompting for it would be
 *    theatre.
 *  - Any ADDITIONAL home needs an explicit decision. Undecided ⇒ PENDING ⇒ not
 *    synced. Silence must never mean "we uploaded your work account".
 *  - Decisions live in settings on the machine that owns the path. The dashboard
 *    can flip one, but only for a home the client already reported — the server
 *    never names a filesystem path.
 *
 * ── Why upgrades are grandfathered ───────────────────────────────────────
 * Before this existed, every `~/.claude-*` sibling was discovered and synced
 * automatically. Switching to opt-in would silently stop syncing homes that had
 * been syncing for months — the exact silent-loss class this whole area has been
 * spent fixing. So on first run the legacy set is written into `approvedHomes`
 * once, and only homes the OLD discovery would have missed start out pending.
 */

import { existsSync, readdirSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { loadSettings, saveSettings } from './settings.js';

export type HomeDecision = 'primary' | 'approved' | 'declined' | 'pending';

/** Resolve to a stable form so `~/x`, `~/x/` and a symlink all compare equal. */
export function normalizeHomePath(p: string): string {
  const expanded = p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
  const trimmed = expanded.replace(/[/\\]+$/, '');
  try { return realpathSync(trimmed); } catch { return trimmed; }
}

/**
 * The set the OLD discovery would have returned: the default home plus every
 * `~/.claude-*` sibling that has a projects/ dir. Reimplemented here rather than
 * imported from tool-paths, which would create a cycle (tool-paths consults
 * approval). Small and frozen by definition — it only has to describe what
 * shipped before, so it never needs to change again.
 */
function legacyAutoSyncedHomes(): string[] {
  const home = homedir();
  const out: string[] = [];
  const add = (dir: string, marker: string) => {
    if (!existsSync(join(dir, marker))) return;
    const n = normalizeHomePath(dir);
    if (!out.includes(n)) out.push(n);
  };

  // Every tool's sibling pattern that the SHIPPED code auto-synced: `<base>` plus
  // `<base>-*`. Covering only Claude here would have silently stopped syncing
  // gemini/codex/antigravity/opencode profiles that the previous release picked
  // up automatically — the same silent-loss class, introduced by the fix for it.
  const bases: Array<{ base: string; marker: string }> = [
    { base: join(home, '.claude'), marker: 'projects' },
    { base: join(home, '.gemini'), marker: 'tmp' },
    { base: join(home, '.codex'),  marker: 'sessions' },
    { base: join(home, '.gemini', 'antigravity-cli'), marker: 'brain' },
    { base: join(home, '.local', 'share', 'opencode'), marker: 'opencode.db' },
  ];

  for (const { base, marker } of bases) {
    add(base, marker);
    const parent = dirname(base);
    const leaf = base.slice(parent.length + 1);
    try {
      for (const e of readdirSync(parent, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        if (e.name === leaf || !e.name.startsWith(leaf + '-')) continue;
        if (e.name === '.claude-code') continue;   // not a transcript home
        add(join(parent, e.name), marker);
      }
    } catch { /* parent unreadable — base only */ }
  }
  return out;
}

/**
 * One-shot: record the legacy auto-synced homes as approved so an upgrade does
 * not change what flows. Idempotent — guarded by `homesGrandfathered`.
 */
export function grandfatherLegacyHomes(): { seeded: string[] } {
  let s;
  try { s = loadSettings(); } catch { return { seeded: [] }; }
  if (s.sources.homesGrandfathered) return { seeded: [] };

  const legacy = legacyAutoSyncedHomes();
  const approved = new Set((s.sources.approvedHomes ?? []).map(normalizeHomePath));
  const seeded: string[] = [];
  for (const p of legacy) {
    if (!approved.has(p)) { approved.add(p); seeded.push(p); }
  }
  s.sources.approvedHomes = [...approved];
  s.sources.homesGrandfathered = true;
  try { saveSettings(s); } catch { return { seeded: [] }; }
  return { seeded };
}

const dirOf = (filePath: string): string => dirname(filePath);

/** Explicit per-tool primary overrides — implicitly approved. */
function primaryHomes(): string[] {
  const home = homedir();
  const env = process.env;
  let s;
  try { s = loadSettings().sources; } catch { s = undefined as never; }
  // OpenCode's primary is a DB FILE, so its home is the containing directory —
  // omitting it made the default OpenCode location read as `pending`, i.e. the
  // tool a user installed would silently not sync.
  const opencodeDb = env.CHAT_RECALL_OPENCODE_DB || s?.opencodeDbPath
    || join(home, '.local', 'share', 'opencode', 'opencode.db');
  const candidates = [
    env.CHAT_RECALL_CLAUDE_HOME || s?.claudeHome || join(home, '.claude'),
    env.CHAT_RECALL_GEMINI_HOME || s?.geminiHome || join(home, '.gemini'),
    env.CHAT_RECALL_CODEX_HOME  || s?.codexHome  || join(home, '.codex'),
    env.CHAT_RECALL_AGY_HOME    || s?.agyHome    || join(home, '.gemini', 'antigravity-cli'),
    dirOf(opencodeDb),
  ];
  return candidates.map(normalizeHomePath);
}

/** What has the operator decided about this home? */
export function homeDecision(path: string): HomeDecision {
  const p = normalizeHomePath(path);
  if (primaryHomes().includes(p)) return 'primary';
  let s;
  try { s = loadSettings().sources; } catch { return 'pending'; }
  if ((s.declinedHomes ?? []).map(normalizeHomePath).includes(p)) return 'declined';
  if ((s.approvedHomes ?? []).map(normalizeHomePath).includes(p)) return 'approved';
  // An explicitly-listed extra home is a decision the user already made.
  if ((s.extraClaudeHomes ?? []).map(normalizeHomePath).includes(p)) return 'approved';
  return 'pending';
}

/** Will this home be synced? Primary and approved yes; pending and declined no. */
export function isHomeSynced(path: string): boolean {
  const d = homeDecision(path);
  return d === 'primary' || d === 'approved';
}

function setDecision(path: string, decision: 'approved' | 'declined'): boolean {
  const p = normalizeHomePath(path);
  let s;
  try { s = loadSettings(); } catch { return false; }
  const approved = new Set((s.sources.approvedHomes ?? []).map(normalizeHomePath));
  const declined = new Set((s.sources.declinedHomes ?? []).map(normalizeHomePath));
  // A decision replaces the previous one — approve then decline must not leave
  // the path in both sets, where the "declined wins" rule would make an approval
  // look silently ineffective.
  approved.delete(p);
  declined.delete(p);
  (decision === 'approved' ? approved : declined).add(p);
  s.sources.approvedHomes = [...approved];
  s.sources.declinedHomes = [...declined];
  try { saveSettings(s); } catch { return false; }
  return true;
}

export function approveHome(path: string): boolean { return setDecision(path, 'approved'); }
export function declineHome(path: string): boolean { return setDecision(path, 'declined'); }

/** Forget a decision, returning the home to PENDING. */
export function resetHomeDecision(path: string): boolean {
  const p = normalizeHomePath(path);
  let s;
  try { s = loadSettings(); } catch { return false; }
  s.sources.approvedHomes = (s.sources.approvedHomes ?? []).filter((x) => normalizeHomePath(x) !== p);
  s.sources.declinedHomes = (s.sources.declinedHomes ?? []).filter((x) => normalizeHomePath(x) !== p);
  try { saveSettings(s); } catch { return false; }
  return true;
}
