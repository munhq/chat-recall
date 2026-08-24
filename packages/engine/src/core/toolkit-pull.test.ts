/**
 * Cross-device pull.
 *
 * The toolkit was upload-only: a second device got nothing, and the web matrix
 * showing "45 MCPs" was a report rather than a sync. These tests pin the two
 * things that make a rebuild trustworthy — it must be faithful, and it must be
 * honest about what it cannot rebuild.
 */

import { describe, expect, test } from 'vitest';

import { entryFromSpec, planPull, type RemoteArtifactRow } from './toolkit-pull.js';

const row = (type: string, name: string, extra: Record<string, unknown>): RemoteArtifactRow => ({
  id: `${name}-${type}`,
  title: name,
  source_type: type,
  extra_json: JSON.stringify(extra),
});

describe('entryFromSpec', () => {
  test('a local server keeps its command and args structured', () => {
    // A flattened "cmd --flag x" string cannot be split back without guessing
    // at quoting, which is why the spec stores them apart.
    const got = entryFromSpec({ command: 'npx', args: ['-y', 'some-mcp'], type: 'local' });
    expect(got?.entry).toEqual({ command: 'npx', args: ['-y', 'some-mcp'] });
  });

  test('a remote server rebuilds as a url, never as a command', () => {
    // The display field folds a url into `command`; rebuilding from that would
    // register the url as an executable.
    const got = entryFromSpec({ url: 'https://mcp.example.com/sse', type: 'remote' });
    expect(got?.entry).toEqual({ url: 'https://mcp.example.com/sse' });
    expect(got?.entry.command).toBeUndefined();
  });

  test('the FULL allow-list survives, not the truncated display copy', () => {
    const allow = Array.from({ length: 18 }, (_, i) => `tool_${i}`);
    const got = entryFromSpec({ command: 'server', alwaysAllow: allow });
    expect(got?.entry.alwaysAllow).toHaveLength(18);
  });

  test('env variable NAMES are rebuilt, values are never present', () => {
    // The values are API keys and they are not uploaded. Writing the names
    // shapes the config correctly and tells the caller what to set.
    const got = entryFromSpec({ command: 'server', envKeys: ['ACME_API_KEY', 'ACME_REGION'] });
    expect(got?.entry.env).toEqual({ ACME_API_KEY: '', ACME_REGION: '' });
    expect(got?.needsEnv).toEqual(['ACME_API_KEY', 'ACME_REGION']);
  });

  test('a row with no spec, or a spec with neither command nor url, refuses', () => {
    // Refusing beats writing a plausible entry that can never work.
    expect(entryFromSpec(null)).toBeNull();
    expect(entryFromSpec({ type: 'local', enabled: true })).toBeNull();
  });
});

describe('planPull', () => {
  test('one MCP registered in several tools collapses to one target list', () => {
    const rows = [
      row('mcp', 'acme', { mcpName: 'acme', tool: 'claude', spec: { command: 'acme-mcp' } }),
      row('mcp', 'acme', { mcpName: 'acme', tool: 'codex', spec: { command: 'acme-mcp' } }),
    ];
    const { mcps } = planPull(rows);
    expect(mcps).toHaveLength(1);
    expect(mcps[0].name).toBe('acme');
    expect(mcps[0].tools.length).toBeGreaterThan(1);
  });

  test('the richest spec wins when rows disagree', () => {
    // An older client may have uploaded a row without a rebuildable spec; the
    // newer row must not lose to it just by arriving second.
    const rows = [
      row('mcp', 'acme', { mcpName: 'acme', tool: 'claude', spec: { type: 'local' } }),
      row('mcp', 'acme', { mcpName: 'acme', tool: 'codex', spec: { command: 'acme-mcp', alwaysAllow: ['a', 'b'] } }),
    ];
    const { mcps } = planPull(rows);
    expect(mcps).toHaveLength(1);
    expect(entryFromSpec(mcps[0].spec)?.entry.command).toBe('acme-mcp');
  });

  test('types whose bytes never travel are NAMED, not silently dropped', () => {
    // A partial sync reported as a success is why nobody reads a sync report
    // twice.
    const rows = [
      row('mcp', 'acme', { mcpName: 'acme', spec: { command: 'acme-mcp' } }),
      row('skill', 'deploy', { skillName: 'deploy' }),
      row('skill', 'review', { skillName: 'review' }),
      row('agent', 'auditor', { agentName: 'auditor' }),
    ];
    const { mcps, unsupported } = planPull(rows);
    expect(mcps).toHaveLength(1);
    const skill = unsupported.find(u => u.type === 'skill');
    expect(skill?.rows).toBe(2);
    expect(skill?.reason).toMatch(/directory of files/);
    expect(unsupported.find(u => u.type === 'agent')?.rows).toBe(1);
  });

  test('a row whose spec is missing entirely is not planned', () => {
    const { mcps } = planPull([row('mcp', 'old', { mcpName: 'old', command: 'old-mcp' })]);
    expect(mcps).toHaveLength(0);
  });

  test('a types filter excludes mcp when not requested', () => {
    const rows = [row('mcp', 'acme', { mcpName: 'acme', spec: { command: 'acme-mcp' } })];
    expect(planPull(rows, { types: ['skill'] }).mcps).toHaveLength(0);
    expect(planPull(rows, { types: ['mcp'] }).mcps).toHaveLength(1);
  });
});
