/**
 * The sign-in link is printed, and the browser is opened as a convenience.
 *
 * ── Why both, always ──────────────────────────────────────────────────────
 * open-browser.ts was written and then wired into the MCP server's login relay
 * ONLY, so the CLI — the surface nearly everyone actually signs in through —
 * printed a URL and left the user to copy it out of a terminal by hand. Every
 * comparable tool opens the browser and prints the link: `gh auth login`,
 * `aws sso login`, `gcloud auth login`, `stripe login`, `npm login`.
 *
 * The link stays unconditional, and that is the load-bearing half. `openBrowser`
 * reports whether a LAUNCHER started, never whether a browser appeared, and
 * there is no portable way to learn the second thing. Over ssh, in a container,
 * on a headless server or in CI there is nothing to open — so a flow that
 * suppressed the link on a "successful" launch would strand exactly those users
 * silently.
 */
import { describe, expect, test, afterEach, vi } from 'vitest';

import { openBrowser } from './open-browser.js';

const LINK = 'https://recall.example.com/device?user_code=ABCD-EFGH';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('openBrowser refuses the cases where there is nothing to open', () => {
  test('CI never gets a browser', () => {
    vi.stubEnv('CI', 'true');
    expect(openBrowser(LINK)).toBe(false);
  });

  test('CHAT_RECALL_NO_BROWSER=1 is the per-machine opt-out', () => {
    vi.stubEnv('CI', '');
    vi.stubEnv('CHAT_RECALL_NO_BROWSER', '1');
    expect(openBrowser(LINK)).toBe(false);
  });

  test('a non-http(s) URL is refused — the launchers take what we hand them', () => {
    vi.stubEnv('CI', '');
    vi.stubEnv('CHAT_RECALL_NO_BROWSER', '');
    // file:// would open a local file; a shell-ish string must never reach a
    // launcher. Only links this CLI built itself are http(s).
    expect(openBrowser('file:///etc/passwd')).toBe(false);
    expect(openBrowser('javascript:alert(1)')).toBe(false);
    expect(openBrowser('not a url at all')).toBe(false);
  });
});

describe('the CLI login prompt always prints the link', () => {
  test('the built CLI prints the URL and never gates it on the browser opening', () => {
    // Asserted against the SHIPPED bundle, because the bug was that the CLI
    // bundle never called openBrowser at all while the MCP bundle did.
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { resolve } = require('node:path') as typeof import('node:path');
    const built = readFileSync(resolve(import.meta.dirname, '../dist/cli.js'), 'utf8');
    expect(built).toMatch(/Open this to approve the machine:/);
    // The launcher is reached from the CLI, not only from the MCP server.
    expect(built).toMatch(/openBrowser|tried to open it for you/);
  });

  test('the prompt never claims a browser OPENED, only that it tried', () => {
    // openBrowser reports that a launcher started, not that a window appeared.
    // In an agent shell, over ssh or in a container it starts and nothing shows,
    // and "opening your browser…" then tells the user to wait for something that
    // is never coming — a working login that reads as a hang.
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { resolve } = require('node:path') as typeof import('node:path');
    const built = readFileSync(resolve(import.meta.dirname, '../dist/cli.js'), 'utf8');
    expect(built).not.toMatch(/opening your browser/);
  });

  test('the approval link is printed WHOLE — the code is a fallback, not a second address', () => {
    // p.url is verification_uri_complete (?user_code=…), so the link alone is
    // enough. The old copy printed the bare uri and the code beside it in equal
    // weight, which read as two things to do and one incomplete address.
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { resolve } = require('node:path') as typeof import('node:path');
    const built = readFileSync(resolve(import.meta.dirname, '../dist/cli.js'), 'utf8');
    expect(built).not.toMatch(/if prompted, enter code/);
    expect(built).toMatch(/If the page asks for a code/);
  });
});
