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

  it('the manifest still exists where the workflow looks for it', () => {
    // The workflow runs `node -p "require('./server.json').version"` from the
    // repo root. Moving the file would make it read undefined and publish
    // nothing, which — again — would not be red.
    expect(existsSync(join(repoRoot, 'server.json'))).toBe(true);
  });
});
