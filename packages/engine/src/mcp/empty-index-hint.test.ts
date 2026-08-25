/**
 * What a brand-new account is told, which is the first thing every connector
 * user reads.
 *
 * It used to be "No sessions on the server yet — run `chat-recall sync` on your
 * machines." Someone who connected from claude.ai has installed nothing, so that
 * named a command they did not have, used the wrong one for a first-timer
 * (`sync`, not `init`), and gave no way to understand the state. The honest read
 * of it is "this product is broken" — when in fact the account is simply new.
 *
 * The message has to carry four things, and each is asserted below because each
 * was missing at some point:
 *   1. the account already EXISTS and the trial is already running, so nobody
 *      goes looking for a second signup;
 *   2. the two commands, on the user's own machine;
 *   3. that `init` links this same account rather than creating another;
 *   4. that the connection is already useful for memory created here.
 */
import { describe, test, expect, afterEach } from 'vitest';
import { setMultiTenantMode } from './credential-context.js';

/** The hint is module-private, so exercise it through the module's own state. */
async function hint(remote: boolean): Promise<string> {
  setMultiTenantMode(remote);
  const mod = await import('./tools.js');
  return (mod as unknown as { __emptyIndexHintForTest?: () => string }).__emptyIndexHintForTest?.() ?? '';
}

afterEach(() => setMultiTenantMode(false));

describe('the empty-account message', () => {
  test('remote: says the account exists and the trial is already running', async () => {
    const h = await hint(true);
    expect(h).toMatch(/already set up/i);
    expect(h).toMatch(/free trial/i);
    expect(h).toMatch(/nothing more to sign up for/i);
  });

  test('remote: gives the npm install and init, not a command they lack', async () => {
    const h = await hint(true);
    expect(h).toContain('npm install -g chat-recall');
    expect(h).toContain('chat-recall init');
    // `sync` was the old wrong answer for a first-timer.
    expect(h).not.toMatch(/run `chat-recall sync`/);
  });

  test('remote: says init LINKS this account, not creates a second one', async () => {
    const h = await hint(true);
    expect(h).toMatch(/same account/i);
    expect(h).toMatch(/not a second\s*\n?\s*signup|not a second signup/i);
  });

  test('remote: says what already works, so it does not read as an empty product', async () => {
    const h = await hint(true);
    expect(h).toMatch(/facts, decisions, tasks/i);
    expect(h).toMatch(/do not report this as a failure/i);
  });

  test('local: stays short — the CLI user already has the CLI', async () => {
    const h = await hint(false);
    expect(h).toContain('chat-recall init');
    expect(h).not.toMatch(/npm install/);
    expect(h.length).toBeLessThan(260);
  });
});
