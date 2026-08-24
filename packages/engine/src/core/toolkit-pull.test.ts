/**
 * Cross-device pull.
 *
 * The toolkit was upload-only: a second device got nothing, and the web matrix
 * showing "45 MCPs" was a report rather than a sync. These tests pin the two
 * things that make a rebuild trustworthy — it must be faithful, and it must be
 * honest about what it cannot rebuild.
 */

import { describe, expect, test } from 'vitest';

import { entryFromSpec, planPull, portableCommand, type RemoteArtifactRow } from './toolkit-pull.js';

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
    // Skills ARE installable now, but only when the row carries a full body.
    // These fixtures have none, so they are reported as such rather than
    // rebuilt from a 2000-char search chunk.
    const skill = unsupported.find(u => u.type === 'skill');
    expect(skill?.rows).toBe(2);
    expect(skill?.reason).toMatch(/no full body/);
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

describe('portableCommand', () => {
  test('a bare name that exists on PATH is kept as-is', () => {
    // `node` is running these tests, so it is on PATH by definition.
    const r = portableCommand('node');
    expect(r).toEqual({ command: 'node', rewritten: false });
  });

  test('an absolute path that exists here is kept', () => {
    const r = portableCommand(process.execPath);   // the running node binary
    expect(r).toEqual({ command: process.execPath, rewritten: false });
  });

  test("THE CROSS-DEVICE TRAP: another machine's absolute path falls back to this machine's copy", () => {
    // 40 of 183 real registrations name a path under the uploader's home. That
    // path does not exist on the second machine — and its home is not even the
    // same shape. Registering it verbatim yields a server that cannot spawn.
    const r = portableCommand('/opt/somewhere-else/bin/node');
    expect(r).toEqual({ command: 'node', rewritten: true });
  });

  test('a command this machine does not have at all is refused, and named', () => {
    // A named refusal tells the user what to install; a silent write gives them
    // a broken MCP in five tools.
    const r = portableCommand('/opt/nowhere/bin/definitely-not-installed-xyz');
    expect(r).toEqual({ missing: '/opt/nowhere/bin/definitely-not-installed-xyz' });
    expect(portableCommand('definitely-not-installed-xyz')).toEqual({ missing: 'definitely-not-installed-xyz' });
  });
});

describe('planPull — skills', () => {
  const skill = (name: string, tool: string, body: string, extra: Record<string, unknown> = {}) =>
    ({ id: `${tool}_skill_${name}`, title: name, source_type: 'skill',
       extra_json: JSON.stringify({ skillName: name, tool, body, ...extra }) });

  test('a skill with a full body is planned for every tool', () => {
    const { skills } = planPull([skill('deploy', 'claude', '# Deploy\nsteps')]);
    expect(skills).toHaveLength(1);
    expect(skills[0].body).toBe('# Deploy\nsteps');
    expect(skills[0].tools.length).toBeGreaterThan(1);
  });

  test('a row with NO body is refused, not rebuilt from the search chunk', () => {
    // The search chunk is capped at 2000 chars. Rebuilding from it would write
    // a truncated skill that looks installed and quietly misbehaves — 733 of
    // 794 real skills exceed that cap.
    const row = { id: 'x', title: 'deploy', source_type: 'skill',
                  extra_json: JSON.stringify({ skillName: 'deploy', tool: 'claude' }) };
    const { skills, unsupported } = planPull([row]);
    expect(skills).toHaveLength(0);
    expect(unsupported.find(u => u.type === 'skill')?.rows).toBe(1);
  });

  test('THE COLLISION: the same name in two tools resolves by precedence, not by length', () => {
    // Picking the longest body was arbitrary and differed between machines: it
    // installed a cursor copy over the claude one that owns the name.
    const { skills } = planPull([
      skill('shared', 'cursor', 'x'.repeat(500)),
      skill('shared', 'claude', 'the owner'),
    ]);
    expect(skills).toHaveLength(1);
    expect(skills[0].body).toBe('the owner');
  });

  test('precedence holds regardless of row order', () => {
    const a = planPull([skill('s', 'claude', 'A'), skill('s', 'gemini', 'B')]).skills[0].body;
    const b = planPull([skill('s', 'gemini', 'B'), skill('s', 'claude', 'A')]).skills[0].body;
    expect(a).toBe('A');
    expect(b).toBe('A');
  });

  test('a truncated body is carried through so the installer can refuse it', () => {
    const { skills } = planPull([skill('big', 'claude', 'partial', { bodyTruncated: true })]);
    expect(skills[0].truncated).toBe(true);
  });

  test('a body whose secret was stripped is flagged, not hidden', () => {
    const { skills } = planPull([skill('k', 'claude', 'run --key __SECRET_NOT_SYNCED__', { bodySecretsRedacted: true })]);
    expect(skills[0].redacted).toBe(true);
  });

  test('an agent row with no body is reported, not rebuilt from its preview', () => {
    // Agents DO cross devices now, through the codec — but only when the row
    // carries a full body. One without is named, never approximated.
    const rows = [{ id: 'a', title: 'auditor', source_type: 'agent', extra_json: '{}' }];
    const { codecs, unsupported } = planPull(rows);
    expect(codecs).toHaveLength(0);
    expect(unsupported.find(u => u.type === 'agent')?.reason).toMatch(/no full body/);
  });
});

describe('planPull — agents and commands through the codec', () => {
  const agent = (name: string, tool: string, body: string, format = 'md', extra: Record<string, unknown> = {}) =>
    ({ id: `${tool}_agent_${name}`, title: name, source_type: 'agent',
       extra_json: JSON.stringify({ agentName: name, tool, format, body, ...extra }) });

  test('an agent with a full body is planned for every tool', () => {
    const { codecs } = planPull([agent('auditor', 'claude', '---\nname: auditor\n---\nDo the audit.')]);
    expect(codecs).toHaveLength(1);
    expect(codecs[0].type).toBe('agent');
    expect(codecs[0].format).toBe('md');
    expect(codecs[0].tools.length).toBeGreaterThan(1);
  });

  test('the source ENCODING is carried, because each target needs a different one', () => {
    // A TOML body written into a tool that reads markdown is a file the tool
    // silently ignores — the whole reason this goes through the codec.
    const { codecs } = planPull([agent('a', 'codex', 'name = "a"\ninstructions = "x"', 'toml')]);
    expect(codecs[0].format).toBe('toml');
  });

  test('a row with no body, or a truncated one, is refused rather than approximated', () => {
    const noBody = { id: 'x', title: 'a', source_type: 'agent', extra_json: JSON.stringify({ agentName: 'a', tool: 'claude' }) };
    expect(planPull([noBody]).codecs).toHaveLength(0);
    expect(planPull([agent('a', 'claude', 'partial', 'md', { bodyTruncated: true })]).codecs).toHaveLength(0);
  });

  test('a name in two tools resolves by precedence, deterministically', () => {
    const rows = [agent('dup', 'cursor', 'from cursor'), agent('dup', 'claude', 'from claude')];
    expect(planPull(rows).codecs[0].body).toBe('from claude');
    expect(planPull([...rows].reverse()).codecs[0].body).toBe('from claude');
  });

  test('instructions remain excluded — and for a reason that is not a limitation', () => {
    // A CLAUDE.md belongs to a REPOSITORY. Installing one per machine would put
    // a project's rules where they do not apply.
    const rows = [{ id: 'i', title: 'CLAUDE.md', source_type: 'instructions', extra_json: '{}' }];
    const { unsupported } = planPull(rows);
    expect(unsupported.find(u => u.type === 'instructions')?.reason).toMatch(/repo, not to a machine/);
  });
});
