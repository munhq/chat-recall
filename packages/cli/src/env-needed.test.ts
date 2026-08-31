/**
 * The message that tells someone which secrets they still owe.
 *
 * Tested because every defect in the line this replaced was a missing FACT, not
 * a rendering bug — no subject, no per-server mapping, no location, no
 * consequence — and a fact that is missing is exactly what a test can pin.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { collectEnvNeeds, renderEnvNeeds } from './env-needed.js';

const plain = (lines: string[]): string =>
  // eslint-disable-next-line no-control-regex
  lines.join('\n').replace(/\[[0-9;]*m/g, '');

describe('collectEnvNeeds', () => {
  test('groups by server instead of flattening to one list', () => {
    // The original bug: flatMap threw away which server needed what, so the
    // reader could not tell what would break.
    const needs = collectEnvNeeds([
      { name: 'github', needsEnv: ['GITHUB_PERSONAL_ACCESS_TOKEN'] },
      { name: 'xcodebuild', needsEnv: ['XCODEBUILDMCP_ENABLED_WORKFLOWS'] },
      { name: 'chat-recall', needsEnv: [] },
    ]);
    expect(needs).toEqual([
      { server: 'chat-recall', vars: [] },
      { server: 'github', vars: ['GITHUB_PERSONAL_ACCESS_TOKEN'] },
      { server: 'xcodebuild', vars: ['XCODEBUILDMCP_ENABLED_WORKFLOWS'] },
    ].filter((n) => n.vars.length));
  });

  test('merges duplicates across tools without repeating a variable', () => {
    // The same server is written once per AI tool, so the same variable arrives
    // several times and must be reported once.
    const needs = collectEnvNeeds([
      { name: 'github', needsEnv: ['TOKEN_A'] },
      { name: 'github', needsEnv: ['TOKEN_A', 'TOKEN_B'] },
    ]);
    expect(needs).toEqual([{ server: 'github', vars: ['TOKEN_A', 'TOKEN_B'] }]);
  });

  test('a server needing nothing is not mentioned', () => {
    expect(collectEnvNeeds([{ name: 'quiet' }, { name: 'also-quiet', needsEnv: [] }])).toEqual([]);
  });
});

describe('renderEnvNeeds', () => {
  test('says what was installed before saying what to do about it', () => {
    const out = plain(renderEnvNeeds(
      [{ server: 'github', vars: ['GITHUB_PERSONAL_ACCESS_TOKEN'] }], 3,
    ));
    // The instruction used to arrive with no subject.
    expect(out).toContain('Installed 3 MCP servers');
    expect(out).toContain('github');
    expect(out).toContain('GITHUB_PERSONAL_ACCESS_TOKEN');
  });

  test('says where to put them and what breaks without them', () => {
    const out = plain(renderEnvNeeds([{ server: 'github', vars: ['A_TOKEN'] }], 1));
    expect(out).toContain('shell profile');
    expect(out).toContain('fail to start');
  });

  test('the privacy note comes last, and only when a secret is involved', () => {
    const secret = plain(renderEnvNeeds([{ server: 'github', vars: ['A_TOKEN'] }], 1));
    expect(secret).toContain('never uploads secret values');
    // A feature flag is not withheld for privacy; claiming so trains people to
    // skim the warning that matters.
    const flag = plain(renderEnvNeeds([{ server: 'thing', vars: ['THING_ENABLED_WORKFLOWS'] }], 1));
    expect(flag).not.toContain('never uploads secret values');
  });

  test('nothing needed prints nothing at all', () => {
    expect(renderEnvNeeds([], 4)).toEqual([]);
  });
});

describe('platform relevance', () => {
  const original = process.platform;
  const setPlatform = (v: string): void => {
    Object.defineProperty(process, 'platform', { value: v, configurable: true });
  };
  beforeEach(() => vi.resetModules());
  afterEach(() => setPlatform(original));

  test('a macOS-only server is marked as nothing to do on Linux', () => {
    // Asking a Linux user to configure an Xcode tool is noise that costs trust
    // in everything printed beside it.
    setPlatform('linux');
    const out = plain(renderEnvNeeds(
      [{ server: 'xcodebuild', vars: ['XCODEBUILDMCP_ENABLED_WORKFLOWS'] }], 1,
    ));
    expect(out).toContain('macOS only');
  });

  test('and is not marked on macOS, where it is real work', () => {
    setPlatform('darwin');
    const out = plain(renderEnvNeeds(
      [{ server: 'xcodebuild', vars: ['XCODEBUILDMCP_ENABLED_WORKFLOWS'] }], 1,
    ));
    expect(out).not.toContain('macOS only');
  });
});
