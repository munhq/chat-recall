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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
/**
 * Rewrite the service definition when the installed one no longer matches what
 * this version renders.
 *
 * WHY THIS IS NOT JUST installService(). That runs only when someone types
 * `chat-recall watch --install-service`. An upgrade never rewrote the unit, so
 * every supervision fix shipped to nobody: machines installed before it kept
 * the old file, including the start limiter that lets systemd abandon a
 * crash-looping collector permanently. The daemon calls this on startup, and a
 * daemon start is what an upgrade produces, so the fix arrives with the code
 * that needs it.
 *
 * Compares the rendered text and returns false when it already matches, so the
 * common path writes nothing and restarts nothing. Best-effort by contract: a
 * collector that cannot rewrite its own unit must keep collecting.
 */
export function refreshServiceDefinition(): boolean {
  if (process.platform !== 'linux') return false;   // launchd/schtasks refresh on reinstall
  try {
    const { watchJs, node, logFile } = resolveDaemonPaths();
    const unitPath = join(homedir(), '.config', 'systemd', 'user', 'chat-recall-watch.service');
    if (!existsSync(unitPath)) return false;        // not service-managed; nothing to refresh
    const wanted = renderSystemdUnit(watchJs, node, logFile);
    if (readFileSync(unitPath, 'utf8') === wanted) return false;
    writeFileSync(unitPath, wanted);
    // daemon-reload only. Restarting here would kill the process that is
    // running this code, and the new unit applies on the next start anyway --
    // which for a crash-looping daemon is seconds away, and is exactly the
    // case this fixes.
    execSync('systemctl --user daemon-reload', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

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
    // `restart` (not `enable --now`) so an upgrade reload actually replaces a
    // running daemon — `--now` no-ops on an already-running unit, leaving the
    // old binary in memory. restart starts it if stopped, restarts if running.
    execSync('systemctl --user daemon-reload && systemctl --user enable chat-recall-watch.service && systemctl --user restart chat-recall-watch.service', { stdio: 'inherit' });
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
    // NEVER STOP RETRYING. systemd's default start limiter gives up after a
    // burst of restarts and leaves the unit dead until a human notices. On a
    // developer machine here that was 53 restarts, then
    //
    //   chat-recall-watch.service: Start request repeated too quickly.
    //   Failed to start chat-recall-watch.service
    //
    // and twelve hours with nothing collected and nothing said. A collector
    // that stops forever after a crash loop is worse than one that keeps
    // crashing: the user is told nothing and their history silently ends.
    // 0 disables the limiter, so RestartSec above is the only pacing.
    'StartLimitIntervalSec=0',
    // A bounded cgroup, so a leak becomes a restart rather than a machine that
    // swaps. MemoryHigh throttles and reclaims first; MemoryMax is the kill.
    // --max-old-space-size bounds the V8 heap and NOT Buffers, and the observed
    // peak was 2.1 GB RSS against a 1536 MB heap cap, so only a cgroup limit
    // bounds the external half.
    'MemoryAccounting=yes', 'MemoryHigh=1G', 'MemoryMax=2G',
    // JOURNAL, not append:. The file version had no rotation and nothing to
    // give it any: systemd holds the fd open, so the daemon cannot rename or
    // truncate its own log without leaving systemd writing into a hole. It
    // reached 45 MB on this developer's machine and would have grown forever.
    // journald already rotates and applies disk limits. Read it with
    //   journalctl --user -u chat-recall-watch -f
    'StandardOutput=journal', 'StandardError=journal', '',
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
  // REDIRECT THE LOG. systemd gets StandardOutput=append: and launchd gets
  // StandardOutPath, but the Scheduled Task had no redirection at all — so
  // every diagnostic the daemon printed was discarded, while the CLI went on
  // telling the user to read ~/.chat-recall/watch.log, a file that was never
  // created. A crash-looping collector with no log is undiagnosable.
  //
  // schtasks /tr cannot express redirection itself, so wrap in cmd /c. The
  // whole thing is one /tr argument, hence the escaped quotes.
  const tr = `cmd /c \\"\\"${node}\\" --max-old-space-size=1536 \\"${watchJs}\\" >> \\"${logFile}\\" 2>&1\\"`;
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
export function renderWindowsTaskCommand(watchJs: string, node: string, taskName = 'chat-recall-watch', logFile?: string): string {
  const tr = logFile
    ? `cmd /c \\"\\"${node}\\" --max-old-space-size=1536 \\"${watchJs}\\" >> \\"${logFile}\\" 2>&1\\"`
    : `\\"${node}\\" --max-old-space-size=1536 \\"${watchJs}\\"`;
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