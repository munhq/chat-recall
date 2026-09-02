/**
 * server.json must state the version that is actually on npm.
 *
 * WHY THIS TEST EXISTS: the mcp-registry workflow fires on every `v*` tag and
 * publishes whatever `server.json` says. Nothing bumped that file, and the
 * workflow treats "duplicate version" as success so the run stayed green. Five
 * consecutive releases therefore republished 0.5.6 while npm served up to
 * 0.5.11, and the official MCP registry — which is how an AI assistant finds
 * this server at all — advertised a five-release-old package the whole time.
 *
 * Nothing was red. That is the point: a silent failure needs a test, not a
 * comment. The release workflow gained a matching guard, but a guard only fires
 * on a tag, and by then the mistake is already in the commit.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const read = (rel: string) => JSON.parse(readFileSync(join(repoRoot, rel), 'utf-8'));

describe('server.json version parity', () => {
  const cliVersion = read('packages/cli/package.json').version as string;

  it('the CLI package has a sane semver version', () => {
    expect(cliVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('server.json top-level version matches the published CLI version', () => {
    const manifest = read('server.json');
    expect(
      manifest.version,
      `server.json says ${manifest.version}, the CLI is ${cliVersion}. The registry ` +
      `publishes what server.json says, so this drift means the listing points at ` +
      `the wrong tarball.`,
    ).toBe(cliVersion);
  });

  it('every packages[] entry matches too', () => {
    const manifest = read('server.json');
    const packages: Array<{ version?: string; identifier?: string }> = manifest.packages ?? [];
    expect(packages.length, 'server.json declares no packages — the listing would be uninstallable').toBeGreaterThan(0);
    for (const pkg of packages) {
      expect(
        pkg.version,
        `server.json packages[${pkg.identifier ?? '?'}] says ${pkg.version}, the CLI is ${cliVersion}`,
      ).toBe(cliVersion);
    }
  });

  it('the npm package it names is the one this repo publishes', () => {
    const manifest = read('server.json');
    const cliName = read('packages/cli/package.json').name as string;
    const npmPkgs = (manifest.packages ?? []).filter(
      (p: { registryType?: string }) => !p.registryType || p.registryType === 'npm',
    );
    for (const pkg of npmPkgs) {
      expect(pkg.identifier ?? pkg.name).toBe(cliName);
    }
  });

  it('the tool counts the directories advertise match the code', () => {
    // These numbers are the FIRST thing a person reads about this server, on
    // registry.modelcontextprotocol.io and on smithery.ai, and they are typed
    // by hand into two files that no test looked at. The 58 -> 60 move needed a
    // sweep of five files; the lean count then drifted the moment two tools
    // joined LEAN_TOOLS, because nothing derived it from the set.
    //
    // Read from source text, not by importing: importing tools.ts starts a
    // server and reads credentials (same reason as mcp-tool-registry.test.ts).
    const toolsSrc = readFileSync(
      join(repoRoot, 'packages/engine/src/mcp/tools.ts'), 'utf-8');

    const namesIn = (start: number, end: number) => new Set(
      [...toolsSrc.slice(start, end).matchAll(/'(recall_[a-z_]+)'/g)].map((m) => m[1]));

    const leanStart = toolsSrc.indexOf('const LEAN_TOOLS = new Set([');
    expect(leanStart, 'LEAN_TOOLS not found').toBeGreaterThan(-1);
    // +1 for recall_help, which lean APPENDS as the signpost to the rest.
    const leanCount = namesIn(leanStart, toolsSrc.indexOf(']);', leanStart)).size + 1;
    // recall_help is defined inside that same append, not in the `all` array, so
    // it is not one of the tools the full profile registers. Counting it made
    // this read 61 against a live full listing of 60.
    const allNames = new Set(
      [...toolsSrc.matchAll(/name: '(recall_[a-z_]+)'/g)].map((m) => m[1]));
    allNames.delete('recall_help');
    const fullCount = allNames.size;

    expect(leanCount, 'lean set looks empty — regex broken?').toBeGreaterThan(10);
    expect(fullCount).toBeGreaterThan(leanCount);

    const manifest = JSON.stringify(read('server.json'));
    const smithery = readFileSync(join(repoRoot, 'smithery.yaml'), 'utf-8');
    for (const [where, text] of [['server.json', manifest], ['smithery.yaml', smithery]] as const) {
      expect(text, `${where} does not state the lean count of ${leanCount}`)
        .toContain(`${leanCount} tools`);
      expect(text, `${where} does not state the full count of ${fullCount}`)
        .toContain(`${fullCount} tools`);
    }
  });

  it('the manifest still exists where the workflow looks for it', () => {
    // The workflow runs `node -p "require('./server.json').version"` from the
    // repo root. Moving the file would make it read undefined and publish
    // nothing, which — again — would not be red.
    expect(existsSync(join(repoRoot, 'server.json'))).toBe(true);
  });

  it('the Claude Code plugin manifest matches (the Anthropic plugin directory reads it)', () => {
    const plugin = read('plugin/.claude-plugin/plugin.json');
    expect(
      plugin.version,
      `plugin/.claude-plugin/plugin.json says ${plugin.version}, the CLI is ${cliVersion}. ` +
      `Run npm run version:sync.`,
    ).toBe(cliVersion);
  });

  it('the Cursor marketplace manifest matches', () => {
    const market = read('.cursor-plugin/marketplace.json');
    expect(
      market.metadata?.version,
      `.cursor-plugin/marketplace.json says ${market.metadata?.version}, the CLI is ${cliVersion}. ` +
      `Run npm run version:sync.`,
    ).toBe(cliVersion);
  });
});
