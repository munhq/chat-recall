/**
 * The daemon's log is a HUMAN surface: a file on the user's own machine that
 * they tail and that `chat-recall doctor` points them at. So the format is part
 * of the contract, not an implementation detail.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('the logger owns the timestamp', () => {
  // THE REGRESSION. Converting 48 console.* calls stripped the `[${ts()}] `
  // prefix from each message, because the logger adds its own — but the regex
  // only matched prefixes on the SAME line as the call, and one multi-line call
  // kept its own. The result shipped to production and printed
  //   [2026-08-23T15:21:43.716Z] [2026-08-23T15:21:43.716Z] Sync (…)
  // on every completed sync. Cosmetic, and exactly the kind of thing nobody
  // fixes later.
  test('no daemon log call embeds its own timestamp', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../auto-indexer/indexer.ts', import.meta.url)), 'utf8',
    );
    const offenders = src.split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => line.includes('${ts()}'));
    expect(offenders.map((o) => `${o.n}: ${o.line.trim()}`)).toEqual([]);
  });

  test('the daemon does not print through console.* any more', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../auto-indexer/indexer.ts', import.meta.url)), 'utf8',
    );
    // console.* has no level, cannot be filtered, and bypasses the JSON mode an
    // operator switches on to ship these lines.
    expect(src).not.toMatch(/console\.(log|warn|error)\(/);
  });
});
