/**
 * Hermes keeps its MCP servers in config.yaml. These tests check that an edit
 * touches one server and leaves the comments and the other keys as they were.
 */
import { describe, test, expect } from 'vitest';
import { parse } from 'yaml';
import { addHermesMcpServer, deleteHermesMcpServer, hermesServerEntry } from './hermes-config.js';

const CONFIG = [
  '# Hermes main configuration',
  'model:',
  '  name: example-model   # kept by every edit',
  'mcp_servers:',
  '  alpha:',
  '    command: /bin/alpha',
  '    args:',
  '      - --stdio',
  '  beta:',
  '    url: https://example.com/mcp',
  'hooks:',
  '  on_start: []',
  '',
].join('\n');

describe('addHermesMcpServer', () => {
  test('adds a server and keeps the comments and the other keys', () => {
    const out = addHermesMcpServer(CONFIG, 'gamma', { command: '/bin/gamma', args: ['--x'] });
    expect(out).not.toBeNull();
    expect(out).toContain('# Hermes main configuration');
    expect(out).toContain('# kept by every edit');
    expect(out).toContain('hooks:');
    expect(out).toContain('gamma:');
    const cfg = parse(out!);
    expect(cfg.mcp_servers.gamma).toEqual({ command: '/bin/gamma', args: ['--x'] });
    expect(cfg.mcp_servers.alpha.command).toBe('/bin/alpha');
    expect(cfg.mcp_servers.beta.url).toBe('https://example.com/mcp');
  });

  test('returns null when a server of that name already exists', () => {
    expect(addHermesMcpServer(CONFIG, 'alpha', { command: '/bin/other' })).toBeNull();
  });

  test('creates the mcp_servers table when the config has none', () => {
    const out = addHermesMcpServer('model:\n  name: m\n', 'solo', { command: '/bin/solo' });
    expect(parse(out!).mcp_servers.solo.command).toBe('/bin/solo');
  });
});

describe('deleteHermesMcpServer', () => {
  test('removes one server and keeps everything else', () => {
    const out = deleteHermesMcpServer(CONFIG, 'alpha');
    expect(out).not.toBeNull();
    expect(out).toContain('# Hermes main configuration');
    expect(out).toContain('# kept by every edit');
    const cfg = parse(out!);
    expect(cfg.mcp_servers.alpha).toBeUndefined();
    expect(cfg.mcp_servers.beta.url).toBe('https://example.com/mcp');
    expect(cfg.hooks).toEqual({ on_start: [] });
  });

  test('returns null when the server is absent', () => {
    expect(deleteHermesMcpServer(CONFIG, 'nope')).toBeNull();
  });
});

describe('hermesServerEntry', () => {
  test('keeps the fields Hermes reads and drops the rest', () => {
    expect(hermesServerEntry({ command: '/bin/x', args: ['a'], env: { K: 'v' }, alwaysAllow: ['t'], type: 'local' }))
      .toEqual({ command: '/bin/x', args: ['a'], env: { K: 'v' } });
  });

  test('splits an opencode-style command array into command and args', () => {
    expect(hermesServerEntry({ command: ['/bin/x', '--mcp'] })).toEqual({ command: '/bin/x', args: ['--mcp'] });
  });

  test('keeps a remote url', () => {
    expect(hermesServerEntry({ url: 'https://example.com/mcp', type: 'remote' })).toEqual({ url: 'https://example.com/mcp' });
  });
});
