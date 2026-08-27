/**
 * THE SELF-UPDATER MUST REPLACE THE COPY THAT RUNS.
 *
 * ── The silent no-op ──────────────────────────────────────────────────────
 * `realInstall` ran `npm install -g`, falling back to `--prefix ~/.local` only
 * if that THREW. On a machine with nvm, `npm install -g` does not throw — it
 * succeeds, into nvm's prefix. So on an install that lives in `~/.local` (which
 * is where install.sh puts it whenever the global prefix is not writable, i.e.
 * precisely the population that fallback exists for) the running copy was never
 * replaced. Measured on a real machine:
 *
 *   ~/.nvm/versions/node/v23.9.0/lib/node_modules/chat-recall  0.5.24  (not on PATH)
 *   ~/.local/lib/node_modules/chat-recall                      0.5.18  (on PATH)
 *
 * And it reported `✓ updated 0.5.18 → 0.5.24` — truthfully, since it HAD
 * installed 0.5.24 somewhere — on every sync, for six releases. A self-updater
 * that installs where the user never runs is worse than none at all: the success
 * also silences the "update available" notice, so nothing complains again.
 *
 * Two things are pinned here: the prefix is derived from where THIS module was
 * loaded from, and a reported success is checked against the bytes on disk.
 */
import { describe, expect, test } from 'vitest';
import { sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { executeAutoUpdate, runningPrefix, type UpdatePlan } from './auto-update.js';

describe('runningPrefix — the prefix the running copy came from', () => {
  test('a user-prefix install resolves to that prefix, NOT npm global', () => {
    const url = pathToFileURL(`/home/user/.local/lib/node_modules/chat-recall/dist/auto-update.js`).href;
    expect(runningPrefix(url)).toBe(`${sep}home${sep}user${sep}.local`);
  });

  test('an nvm-style global install resolves to the nvm prefix', () => {
    const url = pathToFileURL('/home/user/.nvm/versions/node/v23.9.0/lib/node_modules/chat-recall/dist/auto-update.js').href;
    expect(runningPrefix(url)).toBe(
      ['', 'home', 'user', '.nvm', 'versions', 'node', 'v23.9.0'].join(sep));
  });

  test('a system install resolves to the system prefix', () => {
    const url = pathToFileURL('/usr/lib/node_modules/chat-recall/dist/auto-update.js').href;
    expect(runningPrefix(url)).toBe(`${sep}usr`);
  });

  test('a source checkout has no prefix to install over', () => {
    // Running from a clone: there is nothing npm-managed to replace, so the
    // caller falls back rather than writing into a random directory.
    const url = pathToFileURL('/home/user/code/example/packages/cli/dist/auto-update.js').href;
    expect(runningPrefix(url)).toBeNull();
  });
});

describe('executeAutoUpdate verifies the install actually landed', () => {
  const plan: UpdatePlan = {
    update: true, reason: 'newer', url: 'https://recall.example.com/install/chat-recall.tgz',
    // sha256 of the exact bytes `download` returns below.
    sha256: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    from: '0.5.18', to: '0.5.24',
  };
  const deps = (verify: () => string | null, installed: string[] = []) => ({
    download: async () => Buffer.from('hello world'),
    install: (tgz: string) => { installed.push(tgz); },
    restart: () => { /* no daemon in a test */ },
    verify,
  });

  test('a real update is reported as updated', async () => {
    const r = await executeAutoUpdate(plan, deps(() => '0.5.24'));
    expect(r.updated).toBe(true);
    expect(r.reason).toMatch(/0\.5\.18 → 0\.5\.24/);
  });

  test('THE LIE: npm succeeded but the disk still has the old version', async () => {
    const r = await executeAutoUpdate(plan, deps(() => '0.5.18'));
    expect(r.updated).toBe(false);
    expect(r.reason).toMatch(/still on disk/);
    // The message must name the manual escape, because the user cannot see the
    // prefix mix-up from the outside.
    expect(r.reason).toMatch(/npm install -g/);
  });

  test('a NEWER version on disk than requested is still a success', async () => {
    // Two processes can race, or the user may have installed by hand. Only
    // "older than wanted" is a failure.
    const r = await executeAutoUpdate(plan, deps(() => '0.6.0'));
    expect(r.updated).toBe(true);
  });

  test('an unreadable manifest does not turn a good install into a failure', async () => {
    // verify() returning null means "cannot tell" — refusing on that would break
    // every install shape whose manifest is not where this expects.
    const r = await executeAutoUpdate(plan, deps(() => null));
    expect(r.updated).toBe(true);
  });

  test('a checksum mismatch is still refused before anything is installed', async () => {
    const installed: string[] = [];
    const r = await executeAutoUpdate({ ...plan, sha256: 'deadbeef' }, deps(() => '0.5.24', installed));
    expect(r.updated).toBe(false);
    expect(r.reason).toMatch(/checksum mismatch/);
    expect(installed).toEqual([]);
  });
});
