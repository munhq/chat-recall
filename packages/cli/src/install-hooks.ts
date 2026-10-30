/**
 * Install the chat-recall hooks into every Claude profile, and the decision
 * guard into the other AI tools.
 *
 * Claude Code reads hooks from `settings.json`. This module wrote them to
 * `<profile>/hooks.json`, which Claude Code does not read outside a plugin, so
 * no hook it registered ever ran: the save hook creates
 * `~/.claude/chat-recall-memory` on every Stop, and that directory did not
 * exist on a machine where the Stop hook had been registered for months.
 * Registration is in `settings.json` now, and our entries are removed from
 * `hooks.json`.
 *
 * Three callers: `init` (every user runs it), `install-hooks` (the explicit
 * command and its opt-outs), and the MCP server at start, which repairs a
 * profile that is missing hooks. The last one is what reaches a user who added
 * only the MCP server, from a marketplace button or a hand-written config.
 * `install-hooks --uninstall` records the choice, and the MCP server then
 * leaves the hooks out.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getHooksDir } from '@chat-recall/engine/core/paths.js';
import { claudeBackend } from '@chat-recall/engine/core/backends/claude.js';
import { claudeHomeDirs } from '@chat-recall/engine/core/tool-paths.js';
import {
  boardHookEntries, isBoardHookEntry, messageHookEntries, isMessageHookEntry, isMessageWaiterEntry,
  resolveCliEntry, resolveMessageHookEntry,
} from './board-hooks.js';
import { cliVersion } from './http.js';

/** Which hooks to install. Every one is on unless the user turned it off. */
export interface HookSelection {
  save: boolean;
  resume: boolean;
  escalate: boolean;
  wakeup: boolean;
  guard: boolean;
  taskBoard: boolean;
  messages: boolean;
}

export const ALL_HOOKS: HookSelection = {
  save: true, resume: true, escalate: true, wakeup: true, guard: true, taskBoard: true, messages: true,
};

/** The shell scripts, by the selection key that installs each one. */
const SCRIPTS = {
  save: 'chat_recall_save_hook.sh',
  resume: 'chat_recall_resume_hook.sh',
  escalate: 'chat_recall_escalate_hook.sh',
  wakeup: 'chat_recall_wakeup_hook.sh',
  guard: 'chat_recall_guard_hook.sh',
} as const;
type ScriptKey = keyof typeof SCRIPTS;

/** Every event an entry of ours can sit on. Uninstall and reinstall walk all of them. */
export const HOOK_EVENTS = ['Stop', 'PreCompact', 'UserPromptSubmit', 'SessionEnd', 'SessionStart', 'PreToolUse', 'PostToolUse'];

type Entry = { matcher: string; hooks: Array<Record<string, unknown>> };
type Config = { hooks?: Record<string, unknown[]>; [k: string]: unknown };

/** True for every hook entry chat-recall writes, in any version. */
export function isOurEntry(entry: unknown): boolean {
  const cmd = (entry as { hooks?: Array<{ command?: unknown }> })?.hooks?.[0]?.command;
  if (typeof cmd !== 'string') return false;
  return Object.values(SCRIPTS).some((s) => cmd.includes(s)) || isBoardHookEntry(entry) || isMessageHookEntry(entry);
}

/**
 * Every Claude profile's `settings.json`, deduped by real path.
 *
 * `CLAUDE_CONFIG_DIR=~/.claude-work` makes that directory the whole config root
 * for a session, so each profile needs its own registration. Only profiles that
 * are real installs (they have `projects/`) are returned.
 */
export function claudeSettingsFiles(): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const home of claudeHomeDirs()) {
    if (!existsSync(join(home, 'projects'))) continue;
    // Keyed by the file, so profiles that share one settings.json through a
    // symlink are written once.
    const file = join(home, 'settings.json');
    let key: string;
    try { key = realpathSync(file); } catch { key = file; }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  if (out.length === 0) out.push(claudeBackend.settingsFile());
  return out;
}

/** Find a bundled hook script: the package's hooks/ in a release, the repo's in a checkout. */
function findScript(distDir: string, name: string): string | undefined {
  return [
    join(distDir, '..', 'hooks', name),
    join(distDir, '..', '..', 'hooks', name),
    join(distDir, '..', '..', '..', 'hooks', name),
  ].find((p) => existsSync(p));
}

/** The `[event, entry]` pairs for a selection. */
export function hookEntries(
  sel: HookSelection,
  paths: { scripts: Partial<Record<ScriptKey, string>>; execPath: string; cliEntry: string; messageHookEntry: string },
): Array<[string, Entry]> {
  const cmd = (command: string, extra: Record<string, unknown> = {}): Entry['hooks'] => [{ type: 'command', command, ...extra }];
  const q = (p: string) => `"${p}"`;
  const out: Array<[string, Entry]> = [];
  const s = paths.scripts;
  if (sel.save && s.save) {
    out.push(['Stop', { matcher: '', hooks: cmd(q(s.save)) }]);
    out.push(['PreCompact', { matcher: '', hooks: cmd(`${q(s.save)} --precompact`) }]);
  }
  if (sel.resume && s.resume) out.push(['UserPromptSubmit', { matcher: '', hooks: cmd(q(s.resume)) }]);
  // The escalation detaches its own background work, so session end is never delayed.
  if (sel.escalate && s.escalate) out.push(['SessionEnd', { matcher: '', hooks: cmd(q(s.escalate)) }]);
  // `startup|clear` only: a resumed session already carries its context.
  if (sel.wakeup && s.wakeup) out.push(['SessionStart', { matcher: 'startup|clear', hooks: cmd(q(s.wakeup)) }]);
  // Only the tools that can introduce a dependency; matching everything would
  // start a process on every Read for a check that can never fire.
  if (sel.guard && s.guard) out.push(['PreToolUse', { matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit', hooks: cmd(q(s.guard)) }]);
  if (sel.taskBoard) out.push(...boardHookEntries(paths.execPath, paths.cliEntry));
  if (sel.messages) out.push(...messageHookEntries(paths.execPath, paths.messageHookEntry));
  return out;
}

/** Replace our entries in one parsed settings object; entries of other tools stay. */
export function mergeOurEntries(config: Config, entries: Array<[string, Entry]>): void {
  if (!config.hooks || typeof config.hooks !== 'object') config.hooks = {};
  const hooks = config.hooks;
  for (const event of HOOK_EVENTS) {
    const kept = (Array.isArray(hooks[event]) ? hooks[event] : []).filter((h) => !isOurEntry(h));
    for (const [ev, entry] of entries) if (ev === event) kept.push(entry);
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (!Object.keys(hooks).length) delete config.hooks;
}

/** Remove our entries from one parsed config; returns how many. */
export function removeOurEntries(config: Config): number {
  if (!config.hooks || typeof config.hooks !== 'object') return 0;
  let removed = 0;
  for (const event of Object.keys(config.hooks)) {
    const current = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
    const kept = current.filter((h) => !isOurEntry(h));
    removed += current.length - kept.length;
    if (kept.length) config.hooks[event] = kept;
    else delete config.hooks[event];
  }
  if (!Object.keys(config.hooks).length) delete config.hooks;
  return removed;
}

/** Read a JSON config. Absent → {}; unparseable → null, and the caller leaves the file alone. */
function readJson(file: string): Config | null {
  if (!existsSync(file)) return {};
  try {
    const v = JSON.parse(readFileSync(file, 'utf-8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Config : null;
  } catch { return null; }
}

/**
 * Write through a temp file and a rename. Claude Code watches settings.json
 * and reloads it while a session runs, so it must never read a half-written file.
 * The rename goes to the symlink's target: renaming onto the link itself would
 * replace a shared settings.json with a copy that stops being shared.
 */
function writeJsonAtomic(file: string, value: unknown): void {
  let target = file;
  try { target = realpathSync(file); } catch { /* a new file */ }
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.chat-recall-${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, target);
}

/** What `install.json` records: the version and selection installed, or an uninstall. */
interface InstallState { version: string; selection: HookSelection; uninstalled?: boolean }

function statePath(): string { return join(getHooksDir(), 'install.json'); }

function readState(): InstallState | null {
  try { return JSON.parse(readFileSync(statePath(), 'utf-8')) as InstallState; } catch { return null; }
}

export interface InstallReport {
  /** settings.json files written. */
  written: string[];
  /** settings.json files left alone because they do not parse. */
  skipped: string[];
  /** Old entries removed from hooks.json files. */
  migrated: number;
  /** Shell hooks left out because this platform cannot run them. */
  shellSkipped: boolean;
  scriptsDir: string;
  selection: HookSelection;
  guardTargets: Array<{ label: string; configPath: string; note?: string }>;
  /** The other AI tools that got the message hook. */
  messageTargets: Array<{ label: string; configPath: string; note?: string }>;
}

/**
 * Install the selected hooks in every profile. Idempotent: a second run
 * replaces our entries and adds no duplicate.
 *
 * On Windows the five shell hooks are left out: Claude Code runs a hook
 * command through cmd.exe, which cannot run a `.sh`. The board and message
 * hooks are node plus a bundle path, and install everywhere.
 */
export async function installHooks(distDir: string, sel: HookSelection = ALL_HOOKS): Promise<InstallReport> {
  const shellSkipped = process.platform === 'win32';
  const scriptsDir = getHooksDir();
  const scripts: Partial<Record<ScriptKey, string>> = {};
  if (!shellSkipped) {
    for (const key of Object.keys(SCRIPTS) as ScriptKey[]) {
      if (!sel[key]) continue;
      const source = findScript(distDir, SCRIPTS[key]);
      if (!source) continue;
      const target = join(scriptsDir, SCRIPTS[key]);
      copyFileSync(source, target);
      chmodSync(target, 0o755);
      scripts[key] = target;
    }
  }
  const entries = hookEntries(sel, {
    scripts, execPath: process.execPath,
    cliEntry: resolveCliEntry(distDir), messageHookEntry: resolveMessageHookEntry(distDir),
  });

  const report: InstallReport = {
    written: [], skipped: [], migrated: 0, shellSkipped, scriptsDir, selection: sel, guardTargets: [], messageTargets: [],
  };
  for (const settingsFile of claudeSettingsFiles()) {
    const config = readJson(settingsFile);
    if (!config) { report.skipped.push(settingsFile); continue; }
    mergeOurEntries(config, entries);
    writeJsonAtomic(settingsFile, config);
    report.written.push(settingsFile);
    report.migrated += migrateHooksJson(join(dirname(settingsFile), 'hooks.json'));
  }

  if (sel.guard && scripts.guard) report.guardTargets = await addGuardToOtherTools(scriptsDir, scripts.guard);
  // The other tools run the hook through a shell wrapper, as the guard does.
  if (sel.messages && !shellSkipped) {
    report.messageTargets = await addMessagesToOtherTools(scriptsDir, process.execPath, resolveMessageHookEntry(distDir));
  }

  writeJsonAtomic(statePath(), { version: cliVersion(), selection: sel } satisfies InstallState);
  return report;
}

/** Remove our entries from a profile's hooks.json, where earlier versions put them. */
function migrateHooksJson(file: string): number {
  if (!existsSync(file)) return 0;
  const config = readJson(file);
  if (!config) return 0;
  const removed = removeOurEntries(config);
  if (removed === 0) return 0;
  // A hooks.json that held only our entries is removed, not left as `{}`.
  if (!Object.keys(config).length) unlinkSync(file);
  else writeJsonAtomic(file, config);
  return removed;
}

export interface UninstallReport {
  removed: number;
  files: string[];
  guardRemoved: Array<{ label: string; configPath: string }>;
  messagesRemoved: Array<{ label: string; configPath: string }>;
}

/** Remove every chat-recall hook, and record the choice so the MCP server does not put them back. */
export async function uninstallHooks(): Promise<UninstallReport> {
  const report: UninstallReport = { removed: 0, files: [], guardRemoved: [], messagesRemoved: [] };
  for (const settingsFile of claudeSettingsFiles()) {
    for (const file of [settingsFile, join(dirname(settingsFile), 'hooks.json')]) {
      if (!existsSync(file)) continue;
      const config = readJson(file);
      if (!config) continue;
      const removed = removeOurEntries(config);
      if (!removed) continue;
      writeJsonAtomic(file, config);
      report.removed += removed;
      report.files.push(file);
    }
  }
  report.guardRemoved = await removeGuardFromOtherTools();
  report.messagesRemoved = await removeMessagesFromOtherTools();
  writeJsonAtomic(statePath(), { version: cliVersion(), selection: ALL_HOOKS, uninstalled: true } satisfies InstallState);
  return report;
}

/** The selection a profile is missing, judged by the message hook on SessionStart and PostToolUse. */
function profileMissingHooks(settingsFile: string, sel: HookSelection): boolean {
  const config = readJson(settingsFile);
  if (!config) return false;          // unparseable: not ours to repair
  const has = (event: string, test: (e: unknown) => boolean) =>
    (Array.isArray(config.hooks?.[event]) ? config.hooks![event] : []).some(test);
  if (sel.messages && !(has('Stop', isMessageWaiterEntry) && has('SessionStart', isMessageHookEntry))) return true;
  if (sel.taskBoard && !has('UserPromptSubmit', isBoardHookEntry)) return true;
  if (process.platform !== 'win32' && sel.save && !has('Stop', (e) => isOurEntry(e) && !isMessageHookEntry(e))) return true;
  return false;
}

/**
 * Install the hooks when this version has not installed them, or when a
 * profile is missing them. The MCP server calls this at every start.
 * Returns null when nothing was needed, or when the user uninstalled them.
 */
export async function ensureHooks(distDir: string): Promise<InstallReport | null> {
  const state = readState();
  if (state?.uninstalled) return null;
  const sel = { ...ALL_HOOKS, ...(state?.selection ?? {}) };
  const stale = !state || state.version !== cliVersion();
  if (!stale && !claudeSettingsFiles().some((f) => profileMissingHooks(f, sel))) return null;
  return installHooks(distDir, sel);
}

// ── The decision guard in the AI tools that are not Claude Code ──────────────
//
// `chat-recall guard` speaks all five harnesses; each of the other four keeps
// its pre-execution hook in its own file, in its own shape. A tool whose home
// directory is absent is skipped, so installing never leaves config behind for
// a tool nobody has.

async function addGuardToOtherTools(scriptsDir: string, guardScript: string): Promise<InstallReport['guardTargets']> {
  const reg = await import('@chat-recall/engine/core/guard-registration.js');
  const out: InstallReport['guardTargets'] = [];
  removeLegacyAgyGuard(reg);
  for (const target of reg.guardTargets()) {
    if (!existsSync(target.homeDir)) continue;
    const wrapper = join(scriptsDir, reg.guardWrapperName(target.tool));
    writeFileSync(wrapper, reg.guardWrapperSource(target.tool, guardScript));
    chmodSync(wrapper, 0o755);
    mkdirSync(dirname(target.configPath), { recursive: true });
    if (target.tool === 'opencode') {
      writeFileSync(target.configPath, reg.opencodePluginSource(wrapper));
    } else {
      const merged = reg.registerGuard(target.tool, readJson(target.configPath) ?? {}, reg.guardCommand(wrapper));
      writeJsonAtomic(target.configPath, merged);
    }
    out.push({ label: target.label, configPath: target.configPath, note: target.note });
  }
  return out;
}

async function removeGuardFromOtherTools(): Promise<UninstallReport['guardRemoved']> {
  const reg = await import('@chat-recall/engine/core/guard-registration.js');
  const out: UninstallReport['guardRemoved'] = [];
  removeLegacyAgyGuard(reg);
  for (const target of reg.guardTargets()) {
    if (!existsSync(target.configPath)) continue;
    if (target.tool === 'opencode') {
      // Only ours: install writes this marker on the first line.
      if (!readFileSync(target.configPath, 'utf-8').includes('chat-recall install-hooks')) continue;
      unlinkSync(target.configPath);
    } else {
      const r = reg.unregisterGuard(target.tool, readJson(target.configPath) ?? {});
      if (r.removed === 0) continue;
      writeJsonAtomic(target.configPath, r.config);
    }
    out.push({ label: target.label, configPath: target.configPath });
  }
  return out;
}

/** Remove the guard entry that earlier versions wrote where Antigravity does not read it. */
function removeLegacyAgyGuard(reg: typeof import('@chat-recall/engine/core/guard-registration.js')): void {
  const file = reg.legacyAgyHooksFile();
  if (!existsSync(file)) return;
  const r = reg.unregisterGuard('agy', readJson(file) ?? {});
  if (r.removed) writeJsonAtomic(file, r.config);
}

// ── The message hook in the AI tools that are not Claude Code ────────────────
//
// The same hook as in Claude Code, run as `message-hook.js --tool <id>`. A tool
// whose home directory is absent is skipped.

async function addMessagesToOtherTools(
  scriptsDir: string, nodePath: string, hookEntry: string,
): Promise<InstallReport['messageTargets']> {
  const reg = await import('@chat-recall/engine/core/message-registration.js');
  const out: InstallReport['messageTargets'] = [];
  for (const target of reg.messageTargets()) {
    if (!existsSync(target.homeDir)) continue;
    const wrapper = join(scriptsDir, reg.messageWrapperName(target.tool));
    writeFileSync(wrapper, reg.messageWrapperSource(target.tool, nodePath, hookEntry));
    chmodSync(wrapper, 0o755);
    mkdirSync(dirname(target.configPath), { recursive: true });
    if (target.tool === 'opencode') {
      writeFileSync(target.configPath, reg.opencodeMessagesSource(wrapper));
    } else if (target.tool === 'pi') {
      writeFileSync(target.configPath, reg.piMessagesSource(wrapper));
    } else {
      const config = readJson(target.configPath);
      if (!config) continue;   // unparseable: not ours to rewrite
      writeJsonAtomic(target.configPath, reg.registerMessages(target.tool, config, reg.messageCommand(wrapper)));
    }
    out.push({ label: target.label, configPath: target.configPath, note: target.note });
  }
  return out;
}

async function removeMessagesFromOtherTools(): Promise<UninstallReport['messagesRemoved']> {
  const reg = await import('@chat-recall/engine/core/message-registration.js');
  const out: UninstallReport['messagesRemoved'] = [];
  for (const target of reg.messageTargets()) {
    if (!existsSync(target.configPath)) continue;
    if (target.tool === 'opencode' || target.tool === 'pi') {
      if (!reg.isOurPluginSource(readFileSync(target.configPath, 'utf-8'))) continue;
      unlinkSync(target.configPath);
    } else {
      const config = readJson(target.configPath);
      if (!config) continue;
      const r = reg.unregisterMessages(target.tool, config);
      if (r.removed === 0) continue;
      writeJsonAtomic(target.configPath, r.config);
    }
    out.push({ label: target.label, configPath: target.configPath });
  }
  return out;
}
