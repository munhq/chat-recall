/**
 * The external detectors (gitleaks/trufflehog) are OPT-IN and default OFF.
 *
 * This is a product guarantee, not a preference: those binaries are third-party
 * subprocesses that run inside a customer's sync daemon, they need PRE-redaction
 * text materialized on disk to work, and one of them (trufflehog, via overseer)
 * copies its own 34MB binary into $TMPDIR on every spawn and never cleans up —
 * which filled a 31GB tmpfs on a dev machine. Nothing may spawn them unless the
 * operator asked for it with CHAT_RECALL_EXTERNAL_SCANNERS.
 *
 * What must KEEP working with the gate closed: everything in-process — the
 * builtin redactor/findings rules and tenant regex rules. Those are what every
 * user actually relies on, and they have no external dependency.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  externalScannersEnabled, isSecretScannerAvailable,
  scanFileForSecrets, scanDirForSecrets, scanTenantRules,
} from './secret-scanner.js';

let dir: string;
let prev: string | undefined;

/** A file with a shape gitleaks/trufflehog would both flag, plus one only a
 *  tenant rule knows about. */
function fixture(): string {
  const p = join(dir, 'session.txt');
  writeFileSync(p, [
    'export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
    'internal ref ACME-9931-XZ',
  ].join('\n'));
  return p;
}

beforeEach(() => {
  prev = process.env.CHAT_RECALL_EXTERNAL_SCANNERS;
  delete process.env.CHAT_RECALL_EXTERNAL_SCANNERS;
  dir = mkdtempSync(join(tmpdir(), 'cr-gate-test-'));
});

afterEach(() => {
  if (prev === undefined) delete process.env.CHAT_RECALL_EXTERNAL_SCANNERS;
  else process.env.CHAT_RECALL_EXTERNAL_SCANNERS = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe('external secret detectors are opt-in', () => {
  test('disabled by default — regardless of what is on PATH', () => {
    expect(externalScannersEnabled()).toBe(false);
    // isSecretScannerAvailable is what callers use to decide whether to
    // materialize raw text at all, so it must report "no" behind the gate even
    // on a machine that has both binaries installed.
    expect(isSecretScannerAvailable()).toBe(false);
  });

  test('only explicit truthy values open the gate', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) {
      process.env.CHAT_RECALL_EXTERNAL_SCANNERS = v;
      expect(externalScannersEnabled(), v).toBe(true);
    }
    for (const v of ['0', 'false', 'no', 'off', '', ' ']) {
      process.env.CHAT_RECALL_EXTERNAL_SCANNERS = v;
      expect(externalScannersEnabled(), JSON.stringify(v)).toBe(false);
    }
  });

  test('no detector findings come back while the gate is closed', () => {
    const p = fixture();
    // Empty means "the optional pass did not run" — never "the file is clean".
    expect(scanFileForSecrets(p)).toEqual([]);
    expect(scanDirForSecrets(dir)).toEqual([]);
  });

  test('tenant rules still run with the gate closed — they are in-process', () => {
    const p = fixture();
    const rules = [{ name: 'acme-internal-ref', regex: 'ACME-\\d{4}-[A-Z]{2}' }];

    const viaFile = scanFileForSecrets(p, { tenantRules: rules });
    expect(viaFile.map((f) => f.rule)).toEqual(['acme-internal-ref']);
    expect(viaFile[0].detector).toBe('tenant');
    // Masked: last 4 chars only, never the matched value.
    expect(viaFile[0].preview).toBe('********1-XZ'); // ACME-9931-XZ → 8 stars + '1-XZ'
    expect(viaFile[0].preview).not.toContain('ACME');

    // Same rules applied to text in memory — the path the sync client uses.
    expect(scanTenantRules('internal ref ACME-9931-XZ', rules)).toHaveLength(1);
  });
});
