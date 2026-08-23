/**
 * `init` promised memory across five AI tools and configured one. These tests
 * pin the fix: every client this machine uses gets the entry, in ITS OWN
 * format, without damaging what the user already put in that file.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerMcpEverywhere, inspectMcpClients, MCP_CLIENTS } from './mcp-clients.js';

const SPEC = {
  command: 'chat-recall-mcp',
  env: { NODE_OPTIONS: '--max-old-space-size=1024' },
  alwaysAllow: ['recall_search', 'recall_show'],
};

let home: string;
const savedEnv: Record<string, string | undefined> = {};

/** The path helpers honour these; a value inherited from the developer's own
 *  shell would point the test at the developer's real config. */
const ENV_KEYS = ['XDG_CONFIG_HOME', 'CHAT_RECALL_CODEX_HOME', 'CHAT_RECALL_GEMINI_HOME'];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cr-mcp-clients-'));
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(home, { recursive: true, force: true });
});

/** Make the machine look like every tool is installed. */
function makeAllPresent() {
  for (const d of ['.codex', '.gemini', join('.gemini', 'antigravity-cli'), '.cursor', join('.config', 'opencode')]) {
    mkdirSync(join(home, d), { recursive: true });
  }
}

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf-8'));

describe('registerMcpEverywhere', () => {
  test('writes every present client, each in its own format', () => {
    makeAllPresent();
    const results = registerMcpEverywhere(SPEC, { home });
    expect(results.map((r) => r.id).sort()).toEqual(['agy', 'claude', 'codex', 'cursor', 'gemini', 'opencode']);
    expect(results.every((r) => r.state === 'created')).toBe(true);

    // Claude Code and Cursor: plain mcpServers
    for (const p of [join(home, '.mcp.json'), join(home, '.cursor', 'mcp.json')]) {
      const cfg = readJson(p);
      expect(cfg.mcpServers['chat-recall'].command).toBe('chat-recall-mcp');
      expect(cfg.mcpServers['chat-recall'].env.NODE_OPTIONS).toBe('--max-old-space-size=1024');
      expect(cfg.mcpServers['chat-recall'].alwaysAllow).toEqual(['recall_search', 'recall_show']);
    }

    // Gemini CLI: same shape, different file
    expect(readJson(join(home, '.gemini', 'settings.json')).mcpServers['chat-recall'].command)
      .toBe('chat-recall-mcp');

    // Antigravity: same shape again, under the Gemini config dir it shares
    expect(readJson(join(home, '.gemini', 'config', 'mcp_config.json')).mcpServers['chat-recall'].command)
      .toBe('chat-recall-mcp');

    // OpenCode: argv ARRAY under `mcp`, plus type/enabled or it never spawns
    const oc = readJson(join(home, '.config', 'opencode', 'opencode.json'));
    expect(oc.mcp['chat-recall']).toEqual({
      type: 'local',
      command: ['chat-recall-mcp'],
      enabled: true,
      environment: { NODE_OPTIONS: '--max-old-space-size=1024' },
    });

    // Codex: TOML tables
    const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf-8');
    expect(toml).toContain('[mcp_servers.chat-recall]');
    expect(toml).toContain('command = "chat-recall-mcp"');
    expect(toml).toContain('[mcp_servers.chat-recall.env]');
    expect(toml).toContain('NODE_OPTIONS = "--max-old-space-size=1024"');
  });

  test('a machine with no other tool gets Claude Code only', () => {
    const results = registerMcpEverywhere(SPEC, { home });
    expect(results.map((r) => r.id)).toEqual(['claude']);
    expect(existsSync(join(home, '.codex', 'config.toml'))).toBe(false);
  });

  test('extraIds registers a tool that is installed but never run', () => {
    const results = registerMcpEverywhere(SPEC, { home, extraIds: ['codex'] });
    expect(results.map((r) => r.id).sort()).toEqual(['claude', 'codex']);
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf-8')).toContain('[mcp_servers.chat-recall]');
  });

  test('re-running reports current and rewrites nothing', () => {
    makeAllPresent();
    registerMcpEverywhere(SPEC, { home });
    const before = MCP_CLIENTS.map((c) => readFileSync(c.configPath(home), 'utf-8'));
    const again = registerMcpEverywhere(SPEC, { home });
    expect(again.every((r) => r.state === 'current')).toBe(true);
    expect(MCP_CLIENTS.map((c) => readFileSync(c.configPath(home), 'utf-8'))).toEqual(before);
  });

  test('a stale launch path is repaired, not duplicated', () => {
    makeAllPresent();
    registerMcpEverywhere({ ...SPEC, command: 'node', args: ['/old/dist/mcp.js'] }, { home });
    const results = registerMcpEverywhere(SPEC, { home });
    expect(results.every((r) => r.state === 'repaired')).toBe(true);

    const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf-8');
    expect(toml.match(/\[mcp_servers\.chat-recall\]/g)).toHaveLength(1);
    expect(toml).not.toContain('/old/dist/mcp.js');
    expect(readJson(join(home, '.mcp.json')).mcpServers['chat-recall'].args).toBeUndefined();
  });
});

describe('what the user already had in the file', () => {
  test('Gemini keeps its unrelated settings and its other servers', () => {
    mkdirSync(join(home, '.gemini'), { recursive: true });
    writeFileSync(join(home, '.gemini', 'settings.json'), JSON.stringify({
      theme: 'dark',
      mcpServers: { other: { command: 'other-mcp' } },
    }));
    registerMcpEverywhere(SPEC, { home });
    const cfg = readJson(join(home, '.gemini', 'settings.json'));
    expect(cfg.theme).toBe('dark');
    expect(cfg.mcpServers.other.command).toBe('other-mcp');
    expect(cfg.mcpServers['chat-recall'].command).toBe('chat-recall-mcp');
  });

  test('a hand-curated alwaysAllow list survives', () => {
    writeFileSync(join(home, '.mcp.json'), JSON.stringify({
      mcpServers: { 'chat-recall': { command: 'stale', alwaysAllow: ['recall_search'] } },
    }));
    registerMcpEverywhere(SPEC, { home });
    expect(readJson(join(home, '.mcp.json')).mcpServers['chat-recall'].alwaysAllow)
      .toEqual(['recall_search']);
  });

  test('Codex keeps the tables and comments around our block', () => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'config.toml'),
      '# my settings\nmodel = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other-mcp"\n\n'
      + '[projects."/home/x/repo"]\ntrust_level = "trusted"\n');
    registerMcpEverywhere(SPEC, { home });
    const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf-8');
    expect(toml).toContain('# my settings');
    expect(toml).toContain('model = "gpt-5"');
    expect(toml).toContain('[mcp_servers.other]');
    expect(toml).toContain('trust_level = "trusted"');
    expect(toml).toContain('[mcp_servers.chat-recall]');
  });

  test('a stale Codex block is replaced without eating the table after it', () => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'config.toml'),
      '[mcp_servers.chat-recall]\ncommand = "node"\nargs = ["/old/mcp.js"]\n'
      + '[mcp_servers.chat-recall.env]\nNODE_OPTIONS = "--old"\n\n'
      + '[projects."/home/x/repo"]\ntrust_level = "trusted"\n');
    registerMcpEverywhere(SPEC, { home });
    const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf-8');
    expect(toml).not.toContain('/old/mcp.js');
    expect(toml).not.toContain('--old');
    expect(toml).toContain('[projects."/home/x/repo"]');
    expect(toml).toContain('trust_level = "trusted"');
  });

  test('an unparseable config is left alone, not clobbered', () => {
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(join(home, '.cursor', 'mcp.json'), '{ this is not json');
    const results = registerMcpEverywhere(SPEC, { home });
    const cursor = results.find((r) => r.id === 'cursor')!;
    expect(cursor.state).toBe('unparseable');
    expect(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf-8')).toBe('{ this is not json');
  });
});

describe('inspectMcpClients', () => {
  test('reports per client, so doctor can name the one that is missing', () => {
    makeAllPresent();
    registerMcpEverywhere(SPEC, { home });
    rmSync(join(home, '.gemini', 'settings.json'));
    const rows = inspectMcpClients({ home });
    const gemini = rows.find((r) => r.id === 'gemini')!;
    expect(gemini.present).toBe(true);
    expect(gemini.registered).toBe(false);
    expect(rows.find((r) => r.id === 'codex')!.registered).toBe(true);
    expect(rows.find((r) => r.id === 'opencode')!.registered).toBe(true);
  });
});
