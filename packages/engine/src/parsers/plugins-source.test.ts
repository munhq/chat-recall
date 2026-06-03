import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PluginsSource } from './plugins-source.js';

let tmpHome: string;
const origHome = process.env.HOME;
beforeEach(() => { tmpHome = mkdtempSync(join(tmpdir(), 'plugins-')); process.env.HOME = tmpHome; });
afterEach(() => { process.env.HOME = origHome; rmSync(tmpHome, { recursive: true, force: true }); });

async function collect(): Promise<any[]> {
  const out: any[] = [];
  for await (const i of new PluginsSource().discover()) out.push(i);
  return out;
}

describe('PluginsSource', () => {
  test('reads Claude installed_plugins.json', async () => {
    mkdirSync(join(tmpHome, '.claude', 'plugins'), { recursive: true });
    writeFileSync(
      join(tmpHome, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'rust-analyzer-lsp@official': [
            { scope: 'user', version: '1.0.0', installPath: '/x', installedAt: '2026-01-01', lastUpdated: '2026-01-01', gitCommitSha: 'abc' },
          ],
        },
      }),
    );
    const items = await collect();
    expect(items.find(i => i.extra.tool === 'claude' && i.title === 'rust-analyzer-lsp')).toBeDefined();
  });

  test('reads Gemini extensions/<n>/gemini-extension.json', async () => {
    const dir = join(tmpHome, '.gemini', 'extensions', 'gcloud');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'gemini-extension.json'), JSON.stringify({
      name: 'gcloud',
      version: '0.1.0',
      description: 'GCP MCP integration',
      contextFileName: 'GEMINI.md',
      mcpServers: { gcloud: { command: 'npx', args: [] } },
    }));
    const items = await collect();
    const r = items.find(i => i.extra.tool === 'gemini' && i.title === 'gcloud');
    expect(r).toBeDefined();
    expect(r.extra.mcpServers).toContain('gcloud');
  });

  test('parse() chunk text mentions tool and version', async () => {
    mkdirSync(join(tmpHome, '.claude', 'plugins'), { recursive: true });
    writeFileSync(
      join(tmpHome, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'p@m': [{ version: '2.0.0', scope: 'user' }] } }),
    );
    const src = new PluginsSource();
    const items: any[] = [];
    for await (const i of src.discover()) items.push(i);
    const chunks = await src.parse(items[0]);
    expect(chunks[0].text).toMatch(/Tool: claude/);
    expect(chunks[0].text).toMatch(/Version: 2.0.0/);
  });

  test('returns empty when neither root exists', async () => {
    expect(await collect()).toHaveLength(0);
  });
});
