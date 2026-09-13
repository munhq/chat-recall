/**
 * The star ask must stay invisible everywhere except an interactive run that
 * just produced results.
 *
 * The expensive failure is not a missed star. It is a stray line of text
 * reaching a machine consumer: a piped `chat-recall search … | jq`, a CI log,
 * or — the reason the module documents its own scope — an MCP stdio stream,
 * where one unexpected line corrupts JSON-RPC for the rest of the session.
 * Each guard below is one of those consumers.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
const ENV_KEYS = ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'TEAMCITY_VERSION',
  'CHAT_RECALL_NO_STAR_PROMPT', 'CHAT_RECALL_DATA_DIR'] as const;
let saved: Record<string, string | undefined>;

/** stderr.isTTY is a getter on a real stream, so it is redefined rather than
 *  assigned; `configurable` keeps each test able to set it again. */
function setTty(v: boolean): void {
  Object.defineProperty(process.stderr, 'isTTY', { value: v, configurable: true });
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), 'cr-star-'));
  process.env.CHAT_RECALL_DATA_DIR = dir;
  setTty(true);
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Imported per test: getDataDir() reads the env var at call time, but a fresh
 *  import keeps each case independent of any module state added later. */
async function mod() {
  return import('./star-nudge.js');
}

describe('shouldAskForStar', () => {
  test('asks on an interactive run that returned results', async () => {
    const { shouldAskForStar } = await mod();
    expect(shouldAskForStar(3)).toBe(true);
  });

  // The ask follows something that worked. After "No matching sessions found"
  // it would read as the product asking to be thanked for failing.
  test('stays quiet when the search found nothing', async () => {
    const { shouldAskForStar } = await mod();
    expect(shouldAskForStar(0)).toBe(false);
  });

  test('stays quiet when stderr is not a terminal', async () => {
    const { shouldAskForStar } = await mod();
    setTty(false);
    expect(shouldAskForStar(3)).toBe(false);
  });

  test.each(['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'TEAMCITY_VERSION'])(
    'stays quiet under %s',
    async (key) => {
      const { shouldAskForStar } = await mod();
      process.env[key] = 'true';
      expect(shouldAskForStar(3)).toBe(false);
    },
  );

  test('stays quiet when the user opted out', async () => {
    const { shouldAskForStar } = await mod();
    process.env.CHAT_RECALL_NO_STAR_PROMPT = '1';
    expect(shouldAskForStar(3)).toBe(false);
  });

  test('asks once, then never again', async () => {
    const { shouldAskForStar, markStarAsked } = await mod();
    expect(shouldAskForStar(3)).toBe(true);
    markStarAsked();
    expect(existsSync(join(dir, '.star-asked'))).toBe(true);
    expect(shouldAskForStar(3)).toBe(false);
  });

  // A read-only or full home must cost a search nothing. Failing open here
  // shows the line at most one extra time, which is the harmless direction.
  test('survives a marker path it cannot write', async () => {
    const { markStarAsked, shouldAskForStar } = await mod();
    process.env.CHAT_RECALL_DATA_DIR = join(dir, 'nope', '\0bad');
    expect(() => markStarAsked()).not.toThrow();
    expect(() => shouldAskForStar(3)).not.toThrow();
  });
});

describe('askForStar', () => {
  test('writes to stderr, never stdout', async () => {
    const { askForStar } = await mod();
    const out: string[] = []; const err: string[] = [];
    const so = process.stdout.write.bind(process.stdout);
    const se = process.stderr.write.bind(process.stderr);
    // @ts-expect-error test double
    process.stdout.write = (c: string) => { out.push(String(c)); return true; };
    // @ts-expect-error test double
    process.stderr.write = (c: string) => { err.push(String(c)); return true; };
    try { askForStar(3, (s) => s); } finally {
      process.stdout.write = so; process.stderr.write = se;
    }
    expect(out.join('')).toBe('');
    expect(err.join('')).toContain('github.com/munhq/chat-recall');
    expect(err.join('')).toContain('CHAT_RECALL_NO_STAR_PROMPT');
  });

  test('prints nothing when a guard rejects it', async () => {
    const { askForStar } = await mod();
    writeFileSync(join(dir, '.star-asked'), 'x');
    const err: string[] = [];
    const se = process.stderr.write.bind(process.stderr);
    // @ts-expect-error test double
    process.stderr.write = (c: string) => { err.push(String(c)); return true; };
    try { askForStar(3, (s) => s); } finally { process.stderr.write = se; }
    expect(err.join('')).toBe('');
  });
});
