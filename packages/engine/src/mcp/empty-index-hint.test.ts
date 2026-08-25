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
    expect(h).toMatch(/already exists/i);
    expect(h).toMatch(/free trial is running/i);
    expect(h).toMatch(/nothing to sign up for/i);
  });

  test('remote: hands a SHELL-CAPABLE agent something it can just run', async () => {
    // Most connector clients that hit this are coding agents with a Bash tool.
    // Told plainly, the agent closes the gap itself and the user types nothing.
    const h = await hint(true);
    expect(h).toMatch(/if you have a shell/i);
    // Two numbered steps rather than one chained command: `init` blocks on a
    // browser approval, so chaining it with && hides which half is waiting.
    expect(h).toContain('npm install -g chat-recall');
    expect(h).toContain('chat-recall init');
  });

  test('remote: stays short enough to survive summarising', async () => {
    // A bound exists because the first version was a wall of prose, and a wall
    // gets compressed into "you need to install the CLI" with the commands
    // dropped. Numbered steps earn their length; paragraphs do not.
    const h = await hint(true);
    expect(h.length).toBeLessThan(1200);
  });

  test('remote: reads as an ordered procedure, not a paragraph', async () => {
    const h = await hint(true);
    expect(h).toMatch(/1\. npm install -g chat-recall/);
    expect(h).toMatch(/2\. chat-recall init/);
    // Step 2 blocks on a human approving in a browser. An agent that does not
    // expect the wait kills the command and reports a hang.
    expect(h).toMatch(/do not kill the command/i);
    // And it must close the loop rather than leaving the agent guessing.
    expect(h).toMatch(/recall_status to confirm/i);
  });

  test('remote: gives the npm install and init, not a command they lack', async () => {
    const h = await hint(true);
    expect(h).toContain('npm install -g chat-recall');
    expect(h).toContain('chat-recall init');
    // `sync` was the old wrong answer for a first-timer.
    expect(h).not.toMatch(/run `chat-recall sync`/);
  });

  test('remote: says it LINKS this account, not creates a second one', async () => {
    const h = await hint(true);
    expect(h).toMatch(/same account/i);
  });

  test('remote: says what already works, so it does not read as an empty product', async () => {
    const h = await hint(true);
    expect(h).toMatch(/facts, decisions, tasks/i);
    expect(h).toMatch(/not an error/i);
  });

  test('local: stays short — the CLI user already has the CLI', async () => {
    const h = await hint(false);
    expect(h).toContain('chat-recall init');
    expect(h).not.toMatch(/npm install/);
    expect(h.length).toBeLessThan(260);
  });
});
