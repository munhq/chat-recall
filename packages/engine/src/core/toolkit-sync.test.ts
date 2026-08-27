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

    // Command review → gemini TOML, opencode md, codex prompt md
    expect(existsSync(join(tmp, '.gemini', 'commands', 'review.toml'))).toBe(true);
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
  test('copies one named command claude → gemini, translating to TOML', async () => {
    w(join(tmp, '.claude', 'commands', 'deploy.md'), '---\nname: deploy\ndescription: ship\n---\nDeploy it.');
    const r = await executeCopy('command', 'deploy', 'claude', 'gemini');
    expect(r.ok).toBe(true);
    const out = join(tmp, '.gemini', 'commands', 'deploy.toml');
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, 'utf-8')).toContain('Deploy it.');
  });

  test('404 when the named source does not exist', async () => {
    const r = await executeCopy('command', 'nope', 'claude', 'gemini');
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
