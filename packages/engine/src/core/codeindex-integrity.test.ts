/**
 * We download a ~53 MB executable and make it runnable. It must be verified.
 *
 * detector-install.ts already pinned and sha256-checked gitleaks and
 * trufflehog. codeindex was the one binary chat-recall fetched from the network
 * and chmod +x'd with no verification at all — a mirror, a proxy, a
 * compromised release or a re-upload would have been executed without question.
 *
 * The hashes are PINNED IN SOURCE rather than fetched. A checksum served from
 * the same host as the binary proves nothing: whoever can swap one can swap the
 * other. Pinning means the bytes were verified once at review time and are
 * re-verified on every install.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedCodeindexSha256, detectPlatform } from './companions.js';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), 'companions.ts');

describe('codeindex download integrity', () => {
  test.each([
    ['codeindex-x86_64-linux', '4378f12e7c80fa8bb53e41c02db4b95955f2f878369abfb28b5edd94b4adbb85'],
    ['codeindex-aarch64-linux', '5a1d6c9c2592a3721547c42cd9b6b11f460e903bfc46407ae27d5879e7259587'],
    ['codeindex-x86_64-macos', '6ad2a2b40faa4ec72ac35fee84f35ea7c848cddc4f6382b4cafedb644f30389f'],
    ['codeindex-aarch64-macos', 'f366d00918f79a4a0acc09c6091d97c6c378c79edbdbe3cb22e4014ea57f08d2'],
    ['codeindex-x86_64-windows.exe', 'a96fc8c8949bb399a44cc0615b12e458460a529c69f01e8829cc39a20f45ab29'],
    ['codeindex-aarch64-windows.exe', '42620d56272cd9ba9d785569d8d754d6b4a3e80f36f28db3e0c483fd600ed117'],
  ])('%s has its published sha256 pinned', (artifact, sha) => {
    // Computed from the actual v0.3.1 assets and cross-checked against the
    // release's own SHA256SUMS. If a bump changes them, recompute — do not
    // relax the check.
    expect(expectedCodeindexSha256(artifact)).toBe(sha);
  });

  test('EVERY artifact the platform detector can produce has a pin', () => {
    // The failure this prevents: adding a platform to the prebuilt list and
    // forgetting its hash, which would install it unverified.
    const realArch = process.arch;
    const realPlatform = process.platform;
    try {
      for (const [arch, platform] of [
        ['x64', 'linux'], ['arm64', 'linux'], ['x64', 'darwin'], ['arm64', 'darwin'],
        ['x64', 'win32'], ['arm64', 'win32'],
      ] as const) {
        Object.defineProperty(process, 'arch', { value: arch, configurable: true });
        Object.defineProperty(process, 'platform', { value: platform, configurable: true });
        const { artifact, reason } = detectPlatform();
        expect(reason, `${arch}-${platform} should be installable`).toBeUndefined();
        expect(expectedCodeindexSha256(artifact!), `no pinned sha256 for ${artifact}`).toBeTruthy();
      }
    } finally {
      Object.defineProperty(process, 'arch', { value: realArch, configurable: true });
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    }
  });

  test('an artifact we do not publish has no pin, so installing it is refused', () => {
    expect(expectedCodeindexSha256('codeindex-riscv64-linux')).toBeNull();
    expect(expectedCodeindexSha256('codeindex-totally-made-up')).toBeNull();
  });

  test('the installer verifies BEFORE chmod, and refuses without a pin', () => {
    // Order is the whole guarantee: hash, then make executable, then move into
    // place. Asserted on the source because exercising it needs a 53 MB
    // download. If this ever reads oddly, read installCodeindex — do not
    // weaken the assertion.
    const src = readFileSync(SRC, 'utf-8');
    const verify = src.indexOf('Checksum mismatch');
    const noPin = src.indexOf('refusing to install an unverified binary');
    const chmod = src.indexOf('chmodSync(tmpPath, 0o755)');
    const rename = src.indexOf('renameSync(tmpPath, CODEINDEX_BIN_PATH)');
    expect(verify).toBeGreaterThan(-1);
    expect(noPin).toBeGreaterThan(-1);
    expect(verify).toBeLessThan(chmod);     // verified before it can run
    expect(chmod).toBeLessThan(rename);     // and before it takes the real path
  });

  test('a binary the user supplied is NOT hash-checked', () => {
    // checkCodeindexStatus resolves PATH and the install dir without touching
    // the manifest. A contributor running a local build, or anyone who
    // installed codeindex themselves, must not be refused — we only vouch for
    // what we downloaded.
    const src = readFileSync(SRC, 'utf-8');
    const status = src.slice(src.indexOf('export function checkCodeindexStatus'), src.indexOf('async function downloadArtifact'));
    expect(status).not.toContain('expectedCodeindexSha256');
    expect(status).not.toContain('createHash');
  });
});
