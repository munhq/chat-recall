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