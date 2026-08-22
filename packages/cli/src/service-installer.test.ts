import { describe, test, expect } from 'vitest';
import { renderSystemdUnit, renderLaunchdPlist, renderWindowsTaskCommand } from './service-installer.js';

describe('service-installer renders', () => {
  const node = '/usr/local/bin/node';
  const watchJs = '/Users/alice/.nvm/.../chat-recall/dist/watch.js';
  const logFile = '/Users/alice/.chat-recall/watch.log';

  test('systemd unit interpolates ExecStart + log paths (no literal ${...})', () => {
    const unit = renderSystemdUnit(watchJs, node, logFile);
    expect(unit).toContain(`ExecStart=${node} --max-old-space-size=1536 ${watchJs}`);
    expect(unit).toContain(`StandardOutput=append:${logFile}`);
    expect(unit).toContain(`StandardError=append:${logFile}`);
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('WantedBy=default.target');
    // The bug we fixed: no un-interpolated template vars should leak.
    expect(unit).not.toContain('${');
  });

  test('launchd plist is valid XML and interpolates ProgramArguments', () => {
    const plist = renderLaunchdPlist(watchJs, node, logFile);
    expect(plist).toContain('<plist version="1.0"><dict>');
    expect(plist).toContain('</dict></plist>');
    expect(plist).toContain('<key>Label</key><string>com.chat-recall.watch</string>');
    // ProgramArguments MUST contain the real paths, not literal ${node}.
    expect(plist).toContain(`<string>${node}</string>`);
    expect(plist).toContain(`<string>${watchJs}</string>`);
    expect(plist).toContain('<key>RunAtLoad</key><true/>');
    expect(plist).toContain('<key>KeepAlive</key><true/>');
    expect(plist).toContain(`<key>StandardOutPath</key><string>${logFile}</string>`);
    // No un-interpolated vars.
    expect(plist).not.toContain('${');
  });

  test('windows schtasks command quotes paths with spaces', () => {
    const cmd = renderWindowsTaskCommand(watchJs, node);
    expect(cmd).toContain('schtasks /create');
    expect(cmd).toContain('/sc onlogon');
    expect(cmd).toContain('/rl LIMITED');
    // Both paths are escaped-quoted inside the /tr argument.
    expect(cmd).toContain(`\\"${node}\\"`);
    expect(cmd).toContain(`\\"${watchJs}\\"`);
  });

  test('launchd plist handles a custom label', () => {
    const plist = renderLaunchdPlist(watchJs, node, logFile, 'com.example.foo');
    expect(plist).toContain('<string>com.example.foo</string>');
  });
});

describe('the Windows Scheduled Task command', () => {
  const NODE = 'C:\\Program Files\\nodejs\\node.exe';
  const WATCH = 'C:\\Users\\First Last\\AppData\\Roaming\\npm\\node_modules\\chat-recall\\dist\\watch.js';
  const LOG = 'C:\\Users\\First Last\\.chat-recall\\watch.log';

  test('redirects stdout and stderr to the log the CLI advertises', () => {
    // systemd gets StandardOutput=append: and launchd gets StandardOutPath;
    // the Scheduled Task had NO redirection, so every diagnostic was discarded
    // while the CLI told the user to read a file that was never created. A
    // crash-looping collector with no log cannot be diagnosed at all.
    const cmd = renderWindowsTaskCommand(WATCH, NODE, 'chat-recall-watch', LOG);
    expect(cmd).toContain('>>');
    expect(cmd).toContain('2>&1');
    expect(cmd).toContain(LOG);
  });

  test('paths with spaces stay quoted — Program Files and First Last', () => {
    // Both of these are the DEFAULT on Windows, not edge cases.
    const cmd = renderWindowsTaskCommand(WATCH, NODE, 'chat-recall-watch', LOG);
    expect(cmd).toContain(`\\"${NODE}\\"`);
    expect(cmd).toContain(`\\"${WATCH}\\"`);
    expect(cmd).toContain(`\\"${LOG}\\"`);
  });

  test('the heap cap survives the wrapper', () => {
    const cmd = renderWindowsTaskCommand(WATCH, NODE, 'chat-recall-watch', LOG);
    expect(cmd).toContain('--max-old-space-size=1536');
  });

  test('without a log file it stays a bare invocation, not a broken redirect', () => {
    const cmd = renderWindowsTaskCommand(WATCH, NODE);
    expect(cmd).not.toContain('>>');
    expect(cmd).toContain('--max-old-space-size=1536');
  });
});
