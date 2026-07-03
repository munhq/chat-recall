/**
 * Platform-native background-service installer for the watch daemon.
 *
 * `chat-recall init` and `chat-recall watch --install-service` both route
 * through here so there is ONE place that knows how to install, uninstall,
 * and detect the per-user service across Linux (systemd --user), macOS
 * (launchd), and Windows (Scheduled Task). No admin rights needed.
 *
 * The daemon entry is resolved next to this file (dist/watch.js) so the
 * service survives `npm prefix` moves better than relying on PATH at boot.
 */
import { execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

export type Platform = 'linux' | 'darwin' | 'win32' | 'other';

export interface ServicePaths {
  /** Absolute path to the unit/plist/task definition (or null on Windows). */
  definitionPath: string | null;
  /** Absolute path to the log file the service writes stdout+stderr to. */
  logFile: string;
}

/** Resolve the watch.js entry next to this file and the log file path. */
function resolveDaemonPaths(): { watchJs: string; node: string; logFile: string; dataDir: string } {
  const watchJs = fileURLToPath(new URL('./watch.js', import.meta.url));
  const node = process.execPath;
  const dataDir = join(homedir(), '.chat-recall');
  const logFile = join(dataDir, 'watch.log');
  return { watchJs, node, logFile, dataDir };
}

/** Best-effort command runner — swallows errors, returns stdout string. */
function tryCmd(cmd: string): string {
  try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString(); }
  catch { return ''; }
}

/** Detect whether the per-user service is currently installed+running. */
export function isServiceRunning(): boolean {
  if (process.platform === 'win32') {
    if (/Running/i.test(tryCmd('schtasks /query /tn chat-recall-watch /fo LIST /v 2>nul'))) return true;
    return /watch\.js/i.test(tryCmd('wmic process where "name=\'node.exe\'" get commandline 2>nul'));
  }
  if (process.platform === 'darwin') {
    // launchctl list shows the label when the agent is loaded.
    return /com\.chat-recall\.watch/.test(tryCmd('launchctl list 2>/dev/null'));
  }
  if (process.platform === 'linux') {
    // systemd is-active is authoritative; skip the pgrep fallback (it
    // self-matches the bash -c that runs the check, causing false positives).
    return /active/.test(tryCmd('systemctl --user is-active chat-recall-watch.service 2>/dev/null'));
  }
  return false;
}

/**
 * Install + start the per-user background service. Returns the paths written
 * (for status messaging) or throws on platform/manager failure.
 */
export function installService(): ServicePaths {
  const { watchJs, node, logFile, dataDir } = resolveDaemonPaths();
  mkdirSync(dataDir, { recursive: true });

  if (process.platform === 'linux') {
    return installSystemd(watchJs, node, logFile);
  }
  if (process.platform === 'darwin') {
    return installLaunchd(watchJs, node, logFile);
  }
  if (process.platform === 'win32') {
    return installWindowsTask(watchJs, node, logFile);
  }
  throw new ServiceInstallError(
    `--install-service: unsupported platform '${process.platform}'.`,
    'Run `chat-recall watch` in the foreground, or point your OS scheduler at `chat-recall-watch`.',
  );
}

function installSystemd(watchJs: string, node: string, logFile: string): ServicePaths {
  const unitDir = join(homedir(), '.config', 'systemd', 'user');
  const unitPath = join(unitDir, 'chat-recall-watch.service');
  const unit = renderSystemdUnit(watchJs, node, logFile);
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(unitPath, unit);
  try {
    execSync('systemctl --user daemon-reload && systemctl --user enable --now chat-recall-watch.service', { stdio: 'inherit' });
    // Survive logout/reboot when no session is open (best-effort; needs the
    // user's password once on some distros).
    try { execSync('loginctl enable-linger "$USER" 2>/dev/null', { stdio: 'ignore' }); } catch { /* optional */ }
  } catch (err) {
    throw new ServiceInstallError('Unit written but systemctl failed.', `Unit: ${unitPath}`);
  }
  return { definitionPath: unitPath, logFile };
}

/** Render the systemd --user unit file body (pure — no FS, no exec). */
export function renderSystemdUnit(watchJs: string, node: string, logFile: string): string {
  return [
    '[Unit]', 'Description=chat-recall live indexer (sessions → local index, optional server sync)', 'After=default.target', '',
    '[Service]',
    // Bounded heap: the daemon does bursty batch work (transcript parse,
    // base64 payloads); V8's default old-space on a big-RAM box is ~4GB and
    // GC only gets aggressive near the ceiling — observed as a multi-GB RSS
    // sawtooth. 1536MB keeps GC honest (768 OOMed on the largest subagent-fanout session) with plenty of headroom for the
    // largest transcripts.
    `ExecStart=${node} --max-old-space-size=1536 ${watchJs}`,
    'Restart=on-failure', 'RestartSec=10', 'Nice=10',
    // Keep the service's own stdout/stderr out of the journal noise but
    // available for `chat-recall service status` without paging journald.
    `StandardOutput=append:${logFile}`, `StandardError=append:${logFile}`, '',
    '[Install]', 'WantedBy=default.target', '',
  ].join('\n');
}

function installLaunchd(watchJs: string, node: string, logFile: string): ServicePaths {
  const label = 'com.chat-recall.watch';
  const plistDir = join(homedir(), 'Library', 'LaunchAgents');
  const plistPath = join(plistDir, `${label}.plist`);
  const plist = renderLaunchdPlist(watchJs, node, logFile, label);
  mkdirSync(plistDir, { recursive: true });
  writeFileSync(plistPath, plist);
  try {
    // Reload idempotently: unload an old copy first, ignore "not loaded".
    try { execSync(`launchctl unload "${plistPath}"`, { stdio: 'ignore' }); } catch { /* not loaded yet */ }
    execSync(`launchctl load "${plistPath}"`, { stdio: 'inherit' });
  } catch {
    throw new ServiceInstallError('Plist written but launchctl failed.', `Plist: ${plistPath}`);
  }
  return { definitionPath: plistPath, logFile };
}

/** Render the launchd plist body (pure — no FS, no exec). */
export function renderLaunchdPlist(watchJs: string, node: string, logFile: string, label = 'com.chat-recall.watch'): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `  <key>Label</key><string>${label}</string>`,
    `  <key>ProgramArguments</key><array><string>${node}</string><string>--max-old-space-size=1536</string><string>${watchJs}</string></array>`,
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><true/>',
    `  <key>StandardOutPath</key><string>${logFile}</string>`,
    `  <key>StandardErrorPath</key><string>${logFile}</string>`,
    '</dict></plist>', '',
  ].join('\n');
}

function installWindowsTask(watchJs: string, node: string, logFile: string): ServicePaths {
  const taskName = 'chat-recall-watch';
  const tr = `\\"${node}\\" --max-old-space-size=1536 \\"${watchJs}\\"`;
  try {
    execSync(`schtasks /create /tn "${taskName}" /tr "${tr}" /sc onlogon /rl LIMITED /f`, { stdio: 'inherit' });
    // Start now too (best-effort — starts next logon if /run unsupported).
    try { execSync(`schtasks /run /tn "${taskName}"`, { stdio: 'inherit' }); } catch { /* starts next logon */ }
  } catch {
    throw new ServiceInstallError('Scheduled Task creation failed (schtasks).', '');
  }
  return { definitionPath: null, logFile };
}

/** Render the schtasks /create command (pure — no exec). */
export function renderWindowsTaskCommand(watchJs: string, node: string, taskName = 'chat-recall-watch'): string {
  const tr = `\\"${node}\\" --max-old-space-size=1536 \\"${watchJs}\\"`;
  return `schtasks /create /tn "${taskName}" /tr "${tr}" /sc onlogon /rl LIMITED /f`;
}

/**
 * Stop + remove the per-user background service. Idempotent — no error if
 * the service isn't installed. Returns true if something was removed.
 */
export function uninstallService(): boolean {
  if (process.platform === 'linux') {
    let removed = false;
    try { execSync('systemctl --user disable --now chat-recall-watch.service 2>/dev/null', { stdio: 'ignore' }); removed = true; } catch { /* not installed */ }
    const unitPath = join(homedir(), '.config', 'systemd', 'user', 'chat-recall-watch.service');
    if (existsSync(unitPath)) { rmSync(unitPath, { force: true }); removed = true; }
    try { execSync('systemctl --user daemon-reload 2>/dev/null', { stdio: 'ignore' }); } catch { /* tolerate */ }
    return removed;
  }
  if (process.platform === 'darwin') {
    const plistPath = join(homedir(), 'Library', 'LaunchAgents', 'com.chat-recall.watch.plist');
    try { execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: 'ignore' }); } catch { /* not loaded */ }
    let removed = false;
    if (existsSync(plistPath)) { rmSync(plistPath, { force: true }); removed = true; }
    return removed;
  }
  if (process.platform === 'win32') {
    try { execSync('schtasks /delete /tn chat-recall-watch /f 2>nul', { stdio: 'ignore' }); return true; } catch { return false; }
  }
  return false;
}

/** Human-readable platform name for messaging. */
export function platformName(): string {
  if (process.platform === 'linux') return 'systemd --user';
  if (process.platform === 'darwin') return 'launchd';
  if (process.platform === 'win32') return 'Scheduled Task';
  return process.platform;
}

export class ServiceInstallError extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}