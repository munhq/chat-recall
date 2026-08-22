/**
 * Which machines get code intelligence.
 *
 * This list said `x86_64-linux` only, justified by a comment about the v0.1.0
 * release, long after the release matrix had grown to four targets. So every
 * Mac — Intel and Apple Silicon — was told to install Zig and build from
 * source, and got NO code intelligence at all: no findings, no hotspots, no
 * actions, no security scan, on the largest developer platform this product
 * has. It failed politely, which is why it lasted.
 *
 * A second bug hid underneath: the platform was mapped to 'darwin' while the
 * published asset is named 'macos', so the download would have 404'd even if
 * somebody had widened the list.
 *
 * These names must match the artifacts in munhq/codeindex's release.yml
 * exactly. A typo here is a 404 at install time on someone else's machine.
 */
import { describe, test, expect, afterEach } from 'vitest';
import { detectPlatform } from './companions.js';

const realArch = process.arch;
const realPlatform = process.platform;
const as = (arch: string, platform: string) => {
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  return detectPlatform();
};
afterEach(() => {
  Object.defineProperty(process, 'arch', { value: realArch, configurable: true });
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
});

describe('codeindex prebuilt matrix', () => {
  test.each([
    ['x64', 'linux', 'codeindex-x86_64-linux'],
    ['arm64', 'linux', 'codeindex-aarch64-linux'],
    ['x64', 'darwin', 'codeindex-x86_64-macos'],
    ['arm64', 'darwin', 'codeindex-aarch64-macos'],
    // Windows landed in v0.3.1. Its assets carry .exe; the others do not, and
    // getting that wrong is a 404 at install time on someone else's machine.
    ['x64', 'win32', 'codeindex-x86_64-windows.exe'],
    ['arm64', 'win32', 'codeindex-aarch64-windows.exe'],
  ])('%s/%s resolves to %s and is accepted', (arch, platform, artifact) => {
    const r = as(arch, platform);
    expect(r.artifact).toBe(artifact);
    expect(r.reason).toBeUndefined();          // undefined reason == prebuilt available
  });

  test('macOS is NOT refused — the regression this file exists for', () => {
    expect(as('arm64', 'darwin').reason).toBeUndefined();
    expect(as('x64', 'darwin').reason).toBeUndefined();
  });

  test("the artifact says 'macos', never 'darwin'", () => {
    // The asset in the release is codeindex-aarch64-macos. Naming it darwin
    // produces a URL that 404s, which reads to a user as "install failed".
    expect(as('arm64', 'darwin').artifact).not.toContain('darwin');
  });

  test('Windows is supported as of v0.3.1, and its asset keeps the .exe', () => {
    // It used to be refused because codeindex would not compile for Windows.
    // It does now, so the refusal has to go — a stale allow-list is how macOS
    // stayed dark for a whole release cycle.
    const r = as('x64', 'win32');
    expect(r.reason).toBeUndefined();
    expect(r.artifact).toBe('codeindex-x86_64-windows.exe');
  });

  test('an unknown architecture is refused rather than guessed at', () => {
    expect(as('mips', 'linux').reason).toMatch(/Unsupported platform/);
  });
});
