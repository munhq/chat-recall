import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentMemorySource } from './agent-memory-source.js';
import { _resetSourceSettingsCache } from '../core/settings.js';

let tmpHome: string;
const origClaudeHome = process.env.CHAT_RECALL_CLAUDE_HOME;
const origHome = process.env.HOME;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'am-home-'));
  // Pin the Claude home so discoverMemoryDirs only scans our temp tree
  // (no sibling .claude-* profiles, no real ~/.claude).
  process.env.CHAT_RECALL_CLAUDE_HOME = tmpHome;
  process.env.HOME = tmpHome;
  _resetSourceSettingsCache();
});

afterEach(() => {
  if (origClaudeHome === undefined) delete process.env.CHAT_RECALL_CLAUDE_HOME;
  else process.env.CHAT_RECALL_CLAUDE_HOME = origClaudeHome;
  process.env.HOME = origHome;
  _resetSourceSettingsCache();
  rmSync(tmpHome, { recursive: true, force: true });
});

// Create a Claude project-hash dir whose name decodes to a real path so
// projectHashToPath() gives something sensible. We mirror the real
// convention: -home-user-code-foo -> /home/user/code/foo.
function makeProjectMemoryDir(projectHash: string): string {
  const dir = join(tmpHome, 'projects', projectHash, 'memory');
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('AgentMemorySource', () => {
  test('discovers .md memory files under <claudeHome>/projects/<hash>/memory/', async () => {
    const memDir = makeProjectMemoryDir('-home-user-code-foo');
    writeFileSync(join(memDir, 'reference_staging_cluster_access.md'),
      `---
name: reference_staging_cluster_access
description: How to reach the staging k8s cluster via SSH
originSessionId: 9648da50-6c75-4f09-893c-66368e3629c4
---
# Staging Cluster Access
The kubeconfig times out. Use SSH to the k3s server node.`);
    writeFileSync(join(memDir, 'feedback_read_code.md'),
      `---
name: feedback_read_code
description: Read code before editing
---
Always read the file first.`);

    const src = new AgentMemorySource();
    const items: any[] = [];
    for await (const i of src.discover()) items.push(i);

    expect(items.length).toBe(2);
    const names = items.map(i => i.extra?.name).sort();
    expect(names).toEqual(['feedback_read_code', 'reference_staging_cluster_access']);
    expect(items.every(i => i.sourceType === 'agent_memory')).toBe(true);
  });

  test('extracts originSessionId from frontmatter and links to the session', async () => {
    const memDir = makeProjectMemoryDir('-home-user-code-foo');
    writeFileSync(join(memDir, 'reference_staging_cluster_access.md'),
      `---
name: reference_staging_cluster_access
originSessionId: 9648da50-6c75-4f09-893c-66368e3629c4
---
body text here with enough length to chunk properly abcdef`);
    const src = new AgentMemorySource();
    const items: any[] = [];
    for await (const i of src.discover()) items.push(i);
    expect(items.length).toBe(1);

    const links = await src.extractLinks(items[0]);
    const sessionLink = links.find(l => l.linkType === 'agent_memory_from_session');
    expect(sessionLink).toBeDefined();
    expect(sessionLink!.targetType).toBe('session');
    expect(sessionLink!.targetId).toBe('9648da50-6c75-4f09-893c-66368e3629c4');
  });

  test('parse() splits memory file body into chunks by headers', async () => {
    const memDir = makeProjectMemoryDir('-home-user-code-foo');
    writeFileSync(join(memDir, 'project_state.md'),
      `---
name: project_state
description: project state notes
---
## Section A
${'a '.repeat(40)}
## Section B
${'b '.repeat(40)}`);
    const src = new AgentMemorySource();
    const items: any[] = [];
    for await (const i of src.discover()) items.push(i);
    expect(items.length).toBe(1);

    const chunks = await src.parse(items[0]);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.every(c => c.sourceType === 'agent_memory')).toBe(true);
    // First section is the overview (pre-first-header content), then A and B.
    const headings = chunks.map(c => c.title);
    expect(headings).toEqual(expect.arrayContaining(['Section A', 'Section B']));
  });

  test('falls back to filename stem for id when frontmatter has no name', async () => {
    const memDir = makeProjectMemoryDir('-home-user-code-foo');
    writeFileSync(join(memDir, 'freeform-notes.md'),
      `just some markdown with no frontmatter and enough text to chunk xxxxxx`);
    const src = new AgentMemorySource();
    const items: any[] = [];
    for await (const i of src.discover()) items.push(i);
    expect(items.length).toBe(1);
    expect(items[0].id).toContain('freeform-notes');
    expect(items[0].extra?.name).toBeUndefined();
  });

  test('ignores non-markdown files', async () => {
    const memDir = makeProjectMemoryDir('-home-user-code-foo');
    writeFileSync(join(memDir, 'notes.md'), `## real\ncontent here abcdef`);
    writeFileSync(join(memDir, 'data.json'), `{"not":"markdown"}`);
    writeFileSync(join(memDir, 'README.txt'), `plain text`);
    const src = new AgentMemorySource();
    const items: any[] = [];
    for await (const i of src.discover()) items.push(i);
    expect(items.length).toBe(1);
    expect(items[0].filePath).toMatch(/notes\.md$/);
  });

  test('returns empty when no memory dirs exist', async () => {
    const src = new AgentMemorySource();
    const items: any[] = [];
    for await (const i of src.discover()) items.push(i);
    expect(items).toEqual([]);
  });

  test('is gated by the claude.agentMemory settings toggle', async () => {
    const memDir = makeProjectMemoryDir('-home-user-code-foo');
    writeFileSync(join(memDir, 'gated.md'),
      `---
name: gated
---
content with enough length to be indexed abcdefghij`);

    // Disable via a settings file at <dataDir>/settings/settings.json.
    // With CHAT_RECALL_CLAUDE_HOME pinned, the data dir resolution uses
    // homedir() — which we also pointed at tmpHome — so the settings file
    // lands in our temp tree and doesn't touch the developer's real config.
    const { getDataDir } = await import('../core/paths.js');
    const { writeFileSync: wf, mkdirSync: mf } = await import('fs');
    const settingsDir = join(getDataDir(), 'settings');
    mf(settingsDir, { recursive: true });
    wf(join(settingsDir, 'settings.json'), JSON.stringify({
      v: 3,
      embedding: { provider: 'none' },
      summary: { provider: 'none' },
      sources: { enabled: { claude: { agentMemory: false } } },
      privacy: { redactIndex: false, projectDenylist: [], redactToolOutputs: false, redactPasteCache: false, redactFilePaths: false },
      sync: { enabled: false, upload: {}, excludeTools: [], excludeProjects: [] },
      team: { enabled: false, autoPull: true, publishAllowed: {}, vault: { enabled: false, syncTools: [], excludeProjects: [] } },
    }));
    _resetSourceSettingsCache();

    const src = new AgentMemorySource();
    const items: any[] = [];
    for await (const i of src.discover()) items.push(i);
    expect(items).toEqual([]);
  });
});