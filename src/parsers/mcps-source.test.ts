import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { McpsSource } from './mcps-source.js';

let tmpHome: string;
const origHome = process.env.HOME;
beforeEach(() => { tmpHome = mkdtempSync(join(tmpdir(), 'mcps-')); process.env.HOME = tmpHome; });
afterEach(() => { process.env.HOME = origHome; rmSync(tmpHome, { recursive: true, force: true }); });

async function collect(): Promise<any[]> {
  const src = new McpsSource();
  const out: any[] = [];
  for await (const i of src.discover()) out.push(i);
  return out;
}

function writeJson(rel: string, obj: any) {
  const path = join(tmpHome, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2));
}

describe('McpsSource', () => {
  test('reads Claude .mcp.json', async () => {
    writeJson('.mcp.json', { mcpServers: { ripgrep: { command: 'npx', args: ['mcp-ripgrep'] } } });
    const items = await collect();
    const r = items.find(i => i.extra.mcpName === 'ripgrep');
    expect(r).toBeDefined();
    expect(r.extra.tool).toBe('claude');
    expect(r.extra.scope).toBe('global');
  });

  test('reads ~/.claude.json mcpServers (user scope)', async () => {
    writeJson('.claude.json', { mcpServers: { devtools: { command: 'npx', args: ['mcp-chrome-devtools'] } } });
    const items = await collect();
    const r = items.find(i => i.extra.mcpName === 'devtools');
    expect(r.extra.scope).toBe('user');
  });

  test('reads OpenCode config.json mcp block', async () => {
    writeJson('.config/opencode/config.json', { mcp: { gitnexus: { type: 'local', command: ['npx', '-y', 'gitnexus@latest', 'mcp'] } } });
    const items = await collect();
    const r = items.find(i => i.extra.mcpName === 'gitnexus');
    expect(r.extra.tool).toBe('opencode');
    expect(r.extra.command).toContain('npx');
  });

  test('reads Codex config.toml [mcp_servers.X]', async () => {
    mkdirSync(join(tmpHome, '.codex'), { recursive: true });
    writeFileSync(join(tmpHome, '.codex', 'config.toml'),
      [
        '[mcp_servers.deepwiki]',
        'command = "uvx"',
        'args = ["mcp-deepwiki"]',
        '',
        '[mcp_servers.deepwiki.env]',
        'DEEPWIKI_API_KEY = "secret"',
      ].join('\n'),
    );
    const items = await collect();
    const r = items.find(i => i.extra.mcpName === 'deepwiki' && i.extra.tool === 'codex');
    expect(r).toBeDefined();
    expect(r.extra.command).toContain('uvx');
  });

  test('Codex plugin-bundled MCP at ~/.codex/.tmp/plugins/plugins/<x>/.mcp.json', async () => {
    // Codex plugins live at the doubled-"plugins" path on disk
    // (~/.codex/.tmp/plugins/plugins/<name>/). The source reads
    // `mcpData.mcpServers` from each plugin's .mcp.json, so the fixture
    // must use the same envelope as the production format.
    writeJson('.codex/.tmp/plugins/plugins/foo/.mcp.json', {
      mcpServers: { foo: { command: 'npx', args: ['foo-mcp'] } },
    });
    const items = await collect();
    const r = items.find(i => i.extra.tool === 'codex' && i.extra.scope === 'plugin' && i.extra.mcpName === 'foo');
    expect(r).toBeDefined();
  });

  test('Gemini settings.json with mcpServers', async () => {
    writeJson('.gemini/settings.json', { mcpServers: { gcloud: { command: 'npx', args: ['-y', '@google-cloud/gcloud-mcp'] } } });
    const items = await collect();
    expect(items.find(i => i.extra.tool === 'gemini' && i.extra.mcpName === 'gcloud')).toBeDefined();
  });

  test('parse() emits a single MCP chunk with command + allow list', async () => {
    writeJson('.mcp.json', { mcpServers: { rip: { command: 'npx', args: ['mcp-ripgrep'], alwaysAllow: ['search', 'count'] } } });
    const src = new McpsSource();
    const items: any[] = [];
    for await (const i of src.discover()) items.push(i);
    const chunks = await src.parse(items[0]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('Command:');
    expect(chunks[0].text).toMatch(/Always allow:.*search/);
  });

  test('returns nothing when no config files exist', async () => {
    expect(await collect()).toHaveLength(0);
  });
});
