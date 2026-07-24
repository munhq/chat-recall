/**
 * Install the bundled chat-recall Agent Skills into every local AI tool.
 *
 * chat-recall ships a set of SKILL.md skills (../skills, bundled in the npm
 * package) that teach any agent when/how to use the recall_* MCP tools. Every
 * supported tool reads the SAME SKILL.md shape from its own skills dir, so one
 * set covers Claude Code, Gemini, Codex, OpenCode and Antigravity. We drop the
 * files straight into each tool's dir (the only mechanism that works across all
 * of them — Claude *plugins* are Claude-only).
 *
 * Idempotent + updatable + uninstallable despite drop-in having no native
 * versioning: each installed skill dir gets a `.chat-recall-managed` marker
 * holding the version. We only ever overwrite/remove dirs that carry OUR marker,
 * so a user's own skill of the same name is never clobbered.
 */
import { readdirSync, existsSync, mkdirSync, rmSync, cpSync, writeFileSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { claudeBackend } from '@chat-recall/engine/core/backends/claude.js';
import { geminiBackend } from '@chat-recall/engine/core/backends/gemini.js';
import { opencodeBackend } from '@chat-recall/engine/core/backends/opencode.js';
import { codexBackend } from '@chat-recall/engine/core/backends/codex.js';
import { agyBackend } from '@chat-recall/engine/core/backends/agy.js';
// NOTE: Antigravity (agy) has no skills dir of its own — it reads Gemini's
// ~/.gemini/skills (same decision as team-merge.installPathFor). So the Gemini
// target covers agy; we surface agy only for the "available" hint.

const MARKER = '.chat-recall-managed';

/** Bundled skills source dir: <package-root>/skills (dist/install-skills.js → ..). */
export function skillsSourceDir(): string {
  return join(import.meta.dirname, '..', 'skills');
}

function version(): string {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')).version || '0.0.0';
  } catch { return '0.0.0'; }
}

/** The skill directory names we ship (any dir under skills/ containing SKILL.md). */
export function bundledSkillNames(): string[] {
  const src = skillsSourceDir();
  if (!existsSync(src)) return [];
  return readdirSync(src, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(src, e.name, 'SKILL.md')))
    .map((e) => e.name)
    .sort();
}

export interface SkillTarget { id: string; label: string; dir: string; available: boolean; }

/** Per-tool skills dir. agy keeps its own (~/.gemini/antigravity-cli/skills) AND
 *  we also cover ~/.agents/skills (tool-neutral) so any future consumer sees them. */
export function skillTargets(): SkillTarget[] {
  return [
    // Per-tool dirs ONLY. We deliberately do NOT also write ~/.agents/skills:
    // some tools (e.g. Gemini) read BOTH ~/.agents/skills and their own dir, so
    // installing to both produces "skill conflict" duplicate warnings. Every tool
    // we support has its own dir, so per-tool coverage is complete.
    // Antigravity (agy) has no dir of its own — it reads Gemini's ~/.gemini/skills
    // (same mapping as team-merge), so the Gemini target covers it.
    { id: 'claude',   label: 'Claude Code',  dir: claudeBackend.skillsDir(),   available: claudeBackend.isAvailable() },
    { id: 'gemini',   label: 'Gemini CLI / Antigravity', dir: geminiBackend.skillsDir(), available: geminiBackend.isAvailable() || agyBackend.isAvailable() },
    { id: 'codex',    label: 'Codex',        dir: codexBackend.skillsDir(),    available: codexBackend.isAvailable() },
    { id: 'opencode', label: 'OpenCode',     dir: opencodeBackend.skillsDir(), available: opencodeBackend.isAvailable() },
  ];
}

/** True if a dir is a chat-recall-managed skill (safe to overwrite/remove). */
function isManaged(dir: string): boolean {
  return existsSync(join(dir, MARKER));
}

export interface InstallResult {
  version: string;
  perTarget: Array<{ id: string; label: string; dir: string; installed: string[]; skippedUserOwned: string[]; available: boolean }>;
}

/** Install (or update) the bundled skills into every target tool.
 *  @param onlyAvailable install only to tools detected on this machine (default true). */
export function installSkills(opts: { onlyAvailable?: boolean } = {}): InstallResult {
  const onlyAvailable = opts.onlyAvailable ?? true;
  const src = skillsSourceDir();
  const names = bundledSkillNames();
  const v = version();
  const perTarget: InstallResult['perTarget'] = [];

  for (const t of skillTargets()) {
    const installed: string[] = [];
    const skippedUserOwned: string[] = [];
    if (onlyAvailable && !t.available) { perTarget.push({ ...t, installed, skippedUserOwned }); continue; }
    for (const name of names) {
      const dest = join(t.dir, name);
      // Never clobber a user's own skill that happens to share the name.
      if (existsSync(dest) && !isManaged(dest)) { skippedUserOwned.push(name); continue; }
      mkdirSync(t.dir, { recursive: true });
      rmSync(dest, { recursive: true, force: true });
      cpSync(join(src, name), dest, { recursive: true });
      writeFileSync(join(dest, MARKER), `${v}\n`);
      installed.push(name);
    }
    perTarget.push({ ...t, installed, skippedUserOwned });
  }
  return { version: v, perTarget };
}

export interface UninstallResult { perTarget: Array<{ id: string; label: string; removed: string[] }>; }

/** Remove only chat-recall-managed skills (identified by the marker). */
export function uninstallSkills(): UninstallResult {
  const names = new Set(bundledSkillNames());
  const perTarget: UninstallResult['perTarget'] = [];
  for (const t of skillTargets()) {
    const removed: string[] = [];
    if (!existsSync(t.dir)) { perTarget.push({ id: t.id, label: t.label, removed }); continue; }
    for (const entry of readdirSync(t.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(t.dir, entry.name);
      // Remove anything we manage; restrict to our known names as a safety belt.
      if (isManaged(dir) && (names.has(entry.name) || entry.name.startsWith('chat-recall'))) {
        rmSync(dir, { recursive: true, force: true });
        removed.push(entry.name);
      }
    }
    perTarget.push({ id: t.id, label: t.label, removed });
  }
  return { perTarget };
}

/** True if any AVAILABLE tool is missing a bundled skill or has an out-of-date
 *  version. The MCP boot uses this to refresh only when needed (cheap: stat a
 *  marker per skill), so it doesn't churn the disk on every tool launch. */
export function skillsNeedRefresh(): boolean {
  const cur = version();
  const names = bundledSkillNames();
  if (names.length === 0) return false;
  for (const t of skillTargets()) {
    if (!t.available) continue;
    for (const name of names) {
      const marker = join(t.dir, name, MARKER);
      if (!existsSync(marker)) return true;
      try { if (readFileSync(marker, 'utf-8').trim() !== cur) return true; } catch { return true; }
    }
  }
  return false;
}

/** For `doctor`: which tools have the current skill version installed. */
export function skillStatus(): Array<{ id: string; label: string; available: boolean; installed: number; version: string | null }> {
  const names = bundledSkillNames();
  const cur = version();
  return skillTargets().map((t) => {
    let installed = 0; let ver: string | null = null;
    for (const name of names) {
      const marker = join(t.dir, name, MARKER);
      if (existsSync(marker)) {
        installed++;
        try { ver = readFileSync(marker, 'utf-8').trim(); } catch { /* ignore */ }
      }
    }
    return { id: t.id, label: t.label, available: t.available, installed, version: installed === names.length ? ver : (installed ? `${ver} (partial)` : null) };
  }).filter((s) => s.available || s.installed > 0);
}

// Silence unused import in some toolchains; statSync kept for future mtime checks.
void statSync;
