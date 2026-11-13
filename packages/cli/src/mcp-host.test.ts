import { describe, expect, test } from 'vitest';
import { join } from 'node:path';
import type { Host, Run } from './vendor/mcp-kit/host.js';
import { hostSupported, installMcpHost, localMcpUrl, machineConfig, removeMcpHost } from './mcp-host.js';

/**
 * A machine with no system: files in a map, and a record of every command the
 * kit runs. `systemctl` and `launchctl` answer 0, which is a service that runs.
 */
function fakeMachine(home = '/home/user'): Host & { files: Map<string, string>; calls: string[][] } {
  const files = new Map<string, string>();
  const calls: string[][] = [];
  const run: Run = (bin, args) => {
    calls.push([bin, ...args]);
    return { code: 0, stdout: '', stderr: '' };
  };
  return {
    home, env: {}, run, files, calls,
    read: (path) => files.get(path),
    write: (path, text) => { files.set(path, text); },
  };
}

const dist = '/opt/app/dist';
const config = '/home/user/.config/mcp-kit/host.json';
const unit = '/home/user/.config/systemd/user/mcp-kit-host.service';

describe('the host of the machine', () => {
  test('needs Linux or macOS', () => {
    expect(hostSupported('linux')).toBe(true);
    expect(hostSupported('darwin')).toBe(true);
    expect(hostSupported('win32')).toBe(false);
  });

  test('adds chat-recall and installs the one service', () => {
    const machine = fakeMachine();
    const got = installMcpHost(dist, { host: machine, platform: 'linux', execPath: '/usr/bin/node' });

    expect(got.problem).toBeUndefined();
    expect(got.changed).toBe(true);
    expect(got.url).toBe('http://127.0.0.1:7717/chat-recall');
    expect(JSON.parse(machine.files.get(config)!).servers).toEqual([
      { name: 'chat-recall', command: '/usr/bin/node', args: [join(dist, 'mcp.js')], env: { NODE_OPTIONS: '--max-old-space-size=1024' } },
    ]);
    // The service runs the vendored program of the kit, not a command of chat-recall.
    expect(machine.files.get(unit)).toContain(join(dist, 'vendor', 'mcp-kit', 'host-main.js'));
    expect(machine.files.get(unit)).toContain(`"${config}"`);
    expect(got.written).toEqual([unit]);
  });

  test('writes nothing on a second run', () => {
    const machine = fakeMachine();
    installMcpHost(dist, { host: machine, platform: 'linux', execPath: '/usr/bin/node' });
    const calls = machine.calls.length;

    const again = installMcpHost(dist, { host: machine, platform: 'linux', execPath: '/usr/bin/node' });

    expect(again.changed).toBe(false);
    expect(again.written).toEqual([]);
    // No restart: the entry and the service are the same, so the sessions of the machine stay connected.
    expect(machine.calls.slice(calls).some(([bin, ...args]) => bin === 'systemctl' && args.includes('restart'))).toBe(false);
  });

  test('restarts a host that runs when the entry changed', () => {
    const machine = fakeMachine();
    installMcpHost(dist, { host: machine, platform: 'linux', execPath: '/usr/bin/node' });
    machine.calls.length = 0;

    const got = installMcpHost('/opt/app-2/dist', { host: machine, platform: 'linux', execPath: '/usr/bin/node' });

    expect(got.changed).toBe(true);
    expect(machine.calls.some(([bin, ...args]) => bin === 'systemctl' && args.includes('restart'))).toBe(true);
  });

  test('keeps the port and the other servers of the machine', () => {
    const machine = fakeMachine();
    machine.files.set(config, JSON.stringify({
      port: 8100,
      servers: [{ name: 'codeindex', command: 'codeindex' }],
    }));

    const got = installMcpHost(dist, { host: machine, platform: 'linux', execPath: '/usr/bin/node' });

    expect(got.url).toBe('http://127.0.0.1:8100/chat-recall');
    expect(JSON.parse(machine.files.get(config)!).servers.map((s: { name: string }) => s.name)).toEqual(['codeindex', 'chat-recall']);
  });

  test('reads the URL of a host that was never installed', () => {
    const machine = fakeMachine();
    expect(localMcpUrl({ host: machine })).toBe('http://127.0.0.1:7717/chat-recall');
    expect(machineConfig({ host: machine })).toEqual({ port: 7717, host: '127.0.0.1', servers: [] });
  });

  test('reads a broken file as an empty one, so init still writes an entry', () => {
    const machine = fakeMachine();
    machine.files.set(config, '{not json');
    expect(localMcpUrl({ host: machine })).toBe('http://127.0.0.1:7717/chat-recall');
  });

  test('does nothing on a platform that keeps no host', () => {
    const machine = fakeMachine();
    const got = installMcpHost(dist, { host: machine, platform: 'win32', execPath: 'C:\\node.exe' });
    expect(got.written).toEqual([]);
    expect(got.problem).toContain('Linux or macOS');
    expect(machine.files.size).toBe(0);
    expect(removeMcpHost({ host: machine, platform: 'win32' })).toEqual([]);
  });
});

describe('removing chat-recall from the machine', () => {
  test('keeps the host while another server uses it', () => {
    const machine = fakeMachine();
    installMcpHost(dist, { host: machine, platform: 'linux', execPath: '/usr/bin/node' });
    const withOther = JSON.parse(machine.files.get(config)!);
    withOther.servers.push({ name: 'codeindex', command: 'codeindex' });
    machine.files.set(config, JSON.stringify(withOther));

    const removed = removeMcpHost({ host: machine, platform: 'linux' });

    expect(removed).toEqual([config]);
    expect(JSON.parse(machine.files.get(config)!).servers).toEqual([{ name: 'codeindex', command: 'codeindex' }]);
    expect(machine.calls.some(([bin, ...args]) => bin === 'systemctl' && args.includes('restart'))).toBe(true);
  });

  test('stops the host with the last server', () => {
    const machine = fakeMachine();
    installMcpHost(dist, { host: machine, platform: 'linux', execPath: '/usr/bin/node' });

    const removed = removeMcpHost({ host: machine, platform: 'linux' });

    expect(removed).toEqual([unit]);
    expect(machine.calls.some(([bin, ...args]) => bin === 'systemctl' && args.includes('disable'))).toBe(true);
    expect(JSON.parse(machine.files.get(config)!).servers).toEqual([]);
  });

  test('leaves a machine that never held chat-recall alone', () => {
    const machine = fakeMachine();
    expect(removeMcpHost({ host: machine, platform: 'linux' })).toEqual([]);
    expect(machine.files.size).toBe(0);
  });
});
