/**
 * The local sync executor end-to-end against a temp HOME: lay down artifacts
 * for several tools, run discover → plan → executeSyncAll, and confirm files
 * land in the right tool dirs in the right encoding. This is exactly what the
 * CLI agent runs when it drains a server-queued intent.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { homeEnvSnapshot, restoreHomeEnv, useHomeDir } from '../test-support/home-env.js';
import {
  discoverLocalArtifacts, planSync, executeSyncAll, executeCopy, writeMcpEntry,
  removeArtifactFromTool, stripCodexMcpBlock,
} from './toolkit-sync.js';

let tmp: string;
const origHome = homeEnvSnapshot();
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'tksync-')); useHomeDir(tmp); });
afterEach(() => { restoreHomeEnv(origHome); rmSync(tmp, { recursive: true, force: true }); });

function w(p: string, c: string) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); }

// Regression guard for the 2026-07 opencode-config incident: an MCP copied to
// opencode MUST use opencode's schema (type + array command + enabled), never
// the generic {command,args} shape — else opencode refuses to start.
describe('writeMcpEntry → opencode schema', () => {
  test('converts {command,args} to {type:"local", command:[], enabled:true}', () => {
    const r = writeMcpEntry('opencode', 'fff', { command: '/bin/fff-mcp', args: ['--mcp'] });
    expect(r.ok).toBe(true);
    const cfg = JSON.parse(readFileSync(join(tmp, '.config', 'opencode', 'opencode.json'), 'utf-8'));
    expect(cfg.mcp.fff).toEqual({ type: 'local', command: ['/bin/fff-mcp', '--mcp'], enabled: true });
  });
  test('remote (url) entries carry type:"remote" + enabled', () => {
    writeMcpEntry('opencode', 'remote1', { url: 'https://example.com/mcp' });
    const cfg = JSON.parse(readFileSync(join(tmp, '.config', 'opencode', 'opencode.json'), 'utf-8'));
    expect(cfg.mcp.remote1).toEqual({ type: 'remote', url: 'https://example.com/mcp', enabled: true });
  });
});

describe('discoverLocalArtifacts', () => {
  test('reads skills/commands/agents/mcp across tools from disk', async () => {
    w(join(tmp, '.claude', 'skills', 'foo', 'SKILL.md'), '---\nname: foo\ndescription: d\n---\nbody');
    w(join(tmp, '.claude', 'commands', 'review.md'), '---\nname: review\ndescription: r\n---\nbody');
    w(join(tmp, '.claude', 'agents', 'auditor.md'), '---\nname: auditor\ndescription: a\n---\nbody');
    w(join(tmp, '.mcp.json'), JSON.stringify({ mcpServers: { srv: { command: 'node', args: ['x.js'] } } }));

    const rows = await discoverLocalArtifacts();
    expect(rows.skill.find(r => r.name === 'foo')?.tool).toBe('claude');
    expect(rows.command.find(r => r.name === 'review')).toBeTruthy();
    expect(rows.agent.find(r => r.name === 'auditor')).toBeTruthy();
    expect(rows.mcp.find(r => r.name === 'srv')?.tool).toBe('claude');
  });
});

describe('executeSyncAll', () => {
  test('fans a Claude-only command/agent/skill out to the other tools', async () => {
    w(join(tmp, '.claude', 'commands', 'review.md'), '---\nname: review\ndescription: Review\n---\nFind bugs.');
    w(join(tmp, '.claude', 'agents', 'auditor.md'), '---\nname: auditor\ndescription: Audit\n---\nHunt vulns.');
    w(join(tmp, '.claude', 'skills', 'foo', 'SKILL.md'), '---\nname: foo\ndescription: d\n---\nbody');
    // Make the other tools "present" so they're valid targets (dirs exist).
    mkdirSync(join(tmp, '.config', 'opencode', 'skills'), { recursive: true });

    const report = await executeSyncAll();

    // Command review → Antigravity TOML, opencode md, codex prompt md
    expect(existsSync(join(tmp, '.gemini', 'antigravity-cli', 'commands', 'review.toml'))).toBe(true);
    expect(existsSync(join(tmp, '.config', 'opencode', 'commands', 'review.md'))).toBe(true);
    expect(existsSync(join(tmp, '.codex', 'prompts', 'review.md'))).toBe(true);
    // Agent auditor → codex TOML
    expect(existsSync(join(tmp, '.codex', 'agents', 'auditor.toml'))).toBe(true);
    // Skill foo → opencode skills dir
    expect(existsSync(join(tmp, '.config', 'opencode', 'skills', 'foo', 'SKILL.md'))).toBe(true);

    expect(report.copied.length).toBeGreaterThan(0);
    expect(report.failed).toHaveLength(0);

    // Idempotent — second run copies nothing new (all 409-skipped).
    const again = await executeSyncAll();
    expect(again.copied).toHaveLength(0);
  });
});

describe('executeCopy', () => {
  test('copies one named command claude → agy, translating to TOML', async () => {
    w(join(tmp, '.claude', 'commands', 'deploy.md'), '---\nname: deploy\ndescription: ship\n---\nDeploy it.');
    const r = await executeCopy('command', 'deploy', 'claude', 'agy');
    expect(r.ok).toBe(true);
    const out = join(tmp, '.gemini', 'antigravity-cli', 'commands', 'deploy.toml');
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, 'utf-8')).toContain('Deploy it.');
  });

  test('404 when the named source does not exist', async () => {
    const r = await executeCopy('command', 'nope', 'claude', 'agy');
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
  });
});

describe('planSync', () => {
  test('excludes read-only and shared rows as sources', async () => {
    w(join(tmp, '.agents', 'skills', 'shared-one', 'SKILL.md'), '---\nname: shared-one\ndescription: d\n---\nb');
    w(join(tmp, '.codex', 'skills', '.system', 'sys', 'SKILL.md'), '---\nname: sys\ndescription: d\n---\nb');
    const rows = await discoverLocalArtifacts();
    const plan = planSync(rows);
    expect(plan.find(p => p.name === 'shared-one')).toBeUndefined();
    expect(plan.find(p => p.name === 'sys')).toBeUndefined();
  });
});

describe('removeArtifactFromTool', () => {
  const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf-8'));

  test('removes one MCP server and keeps its siblings in the Claude file', async () => {
    w(join(tmp, '.mcp.json'), JSON.stringify({ mcpServers: { alpha: { command: 'a' }, beta: { command: 'b' } } }));
    const r = await removeArtifactFromTool('mcp', 'alpha', 'claude');
    expect(r.ok).toBe(true);
    expect(r.targetPath).toBe(join(tmp, '.mcp.json'));
    expect(readJson(join(tmp, '.mcp.json')).mcpServers).toEqual({ beta: { command: 'b' } });
  });

  test('removes a name that sits in both Claude files, so it does not reappear', async () => {
    w(join(tmp, '.mcp.json'), JSON.stringify({ mcpServers: { dup: { command: 'x' } } }));
    w(join(tmp, '.claude.json'), JSON.stringify({ mcpServers: { dup: { command: 'y' }, keep: { command: 'z' } } }));
    expect((await removeArtifactFromTool('mcp', 'dup', 'claude')).ok).toBe(true);
    expect(readJson(join(tmp, '.mcp.json')).mcpServers).toEqual({});
    expect(readJson(join(tmp, '.claude.json')).mcpServers).toEqual({ keep: { command: 'z' } });
  });

  test('removes from the opencode file that writeMcpEntry writes to', async () => {
    writeMcpEntry('opencode', 'fff', { command: '/bin/fff-mcp' });
    const r = await removeArtifactFromTool('mcp', 'fff', 'opencode');
    expect(r.ok).toBe(true);
    expect(readJson(join(tmp, '.config', 'opencode', 'opencode.json')).mcp).toEqual({});
  });

  test('removes from the Cursor config under the Cursor home', async () => {
    w(join(tmp, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { c1: { command: 'c' } } }));
    expect((await removeArtifactFromTool('mcp', 'c1', 'cursor')).ok).toBe(true);
    expect(readJson(join(tmp, '.cursor', 'mcp.json')).mcpServers).toEqual({});
  });

  test('returns 404 when the MCP server is absent', async () => {
    const r = await removeArtifactFromTool('mcp', 'nope', 'claude');
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
  });

  test('removes a skill folder and keeps a trash copy of it', async () => {
    const dir = join(tmp, '.claude', 'skills', 'my-skill');
    w(join(dir, 'SKILL.md'), '# my-skill');
    const r = await removeArtifactFromTool('skill', 'my-skill', 'claude');
    expect(r.ok).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(readFileSync(join(r.backupPaths![0], 'SKILL.md'), 'utf-8')).toBe('# my-skill');
  });

  test('removes a command file and keeps a trash copy of it', async () => {
    const file = join(tmp, '.claude', 'commands', 'review.md');
    w(file, '---\nname: review\ndescription: Review\n---\nFind bugs.');
    const r = await removeArtifactFromTool('command', 'review', 'claude');
    expect(r.ok).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(r.backupPaths![0], 'utf-8')).toContain('Find bugs.');
  });

  test('removes an agent file', async () => {
    const file = join(tmp, '.claude', 'agents', 'auditor.md');
    w(file, '---\nname: auditor\ndescription: Audit\n---\nHunt vulns.');
    expect((await removeArtifactFromTool('agent', 'auditor', 'claude')).ok).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  test('refuses instruction files, which a name alone cannot pick', async () => {
    w(join(tmp, '.claude', 'CLAUDE.md'), '# rules');
    const r = await removeArtifactFromTool('instructions', 'CLAUDE.md', 'claude');
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(existsSync(join(tmp, '.claude', 'CLAUDE.md'))).toBe(true);
  });

  test('refuses a skill name that escapes the skills folder and deletes nothing', async () => {
    const victim = join(tmp, '.claude', 'victim');
    w(join(victim, 'keep.txt'), 'do not delete');
    const r = await removeArtifactFromTool('skill', '../victim', 'claude');
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(existsSync(join(victim, 'keep.txt'))).toBe(true);
  });

  test('refuses an empty name, "." and "..", and a name with a separator', async () => {
    for (const bad of ['', '.', '..', 'a/b', 'a\\b']) {
      expect((await removeArtifactFromTool('skill', bad, 'claude')).status).toBe(400);
      expect((await removeArtifactFromTool('mcp', bad, 'claude')).status).toBe(400);
    }
  });
});

describe('stripCodexMcpBlock', () => {
  test('removes the named server and its env table, and keeps the tables after it', () => {
    const toml = [
      '[mcp_servers.alpha]',
      'command = "a"',
      '[mcp_servers.alpha.env]',
      'KEY = "v"',
      '[profiles.work]',
      'model = "m"',
      '[mcp_servers.beta]',
      'command = "b"',
      '',
    ].join('\n');
    const out = stripCodexMcpBlock(toml, 'alpha');
    expect(out).not.toContain('[mcp_servers.alpha');
    expect(out).not.toContain('KEY = "v"');
    expect(out).toContain('[profiles.work]');
    expect(out).toContain('model = "m"');
    expect(out).toContain('[mcp_servers.beta]');
    expect(out).toContain('command = "b"');
  });

  test('removes a Codex MCP server through removeArtifactFromTool', async () => {
    w(join(tmp, '.codex', 'config.toml'), '[mcp_servers.gone]\ncommand = "g"\n[model_settings]\nname = "n"\n');
    expect((await removeArtifactFromTool('mcp', 'gone', 'codex')).ok).toBe(true);
    const left = readFileSync(join(tmp, '.codex', 'config.toml'), 'utf-8');
    expect(left).not.toContain('gone');
    expect(left).toContain('[model_settings]');
  });
});
