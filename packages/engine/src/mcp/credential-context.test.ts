/**
 * Credential isolation between concurrent callers.
 *
 * This is the property the remote /mcp endpoint rests on. One process will serve
 * many people at once, each identified by their own OAuth bearer token, against
 * a tool surface written when one process served exactly one human. If a store
 * ever leaked across requests, tenant A would be answered out of tenant B's
 * history — silently, and in a memory product that is the worst failure there
 * is. So the leak is tested directly rather than assumed from the API's docs.
 *
 * The interleaving below is deliberate: both "requests" are in flight at the
 * same time and each yields to the event loop between reads, which is exactly
 * the shape a module-level variable would fail on and AsyncLocalStorage passes.
 */
import { describe, test, expect, afterEach } from 'vitest';
import {
  withCredentials, currentCredentials, setMultiTenantMode, isMultiTenant,
} from './credential-context.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => setMultiTenantMode(false));

describe('credential context', () => {
  test('no store means null — the stdio product falls through to env and disk', () => {
    expect(currentCredentials()).toBeNull();
  });

  test('a request sees its own credentials', () => {
    const seen = withCredentials({ base: 'https://a.test', token: 'tok-a' }, () => currentCredentials());
    expect(seen).toEqual({ base: 'https://a.test', token: 'tok-a' });
    // And the store does not outlive the call.
    expect(currentCredentials()).toBeNull();
  });

  test('the store survives awaits — helpers are async, several deep', async () => {
    const seen = await withCredentials({ base: 'https://a.test', token: 'tok-a' }, async () => {
      await tick();
      const inner = async () => { await tick(); return currentCredentials(); };
      return inner();
    });
    expect(seen?.token).toBe('tok-a');
  });

  test('CONCURRENT requests never see each other — the whole point', async () => {
    const run = async (token: string, log: string[]) =>
      withCredentials({ base: `https://${token}.test`, token }, async () => {
        log.push(currentCredentials()!.token);
        await tick();
        log.push(currentCredentials()!.token);   // after yielding to the other request
        await tick();
        log.push(currentCredentials()!.token);
        return currentCredentials()!.token;
      });

    const a: string[] = [];
    const b: string[] = [];
    const [ra, rb] = await Promise.all([run('tok-a', a), run('tok-b', b)]);

    expect(ra).toBe('tok-a');
    expect(rb).toBe('tok-b');
    // Every read inside each request saw only its own token, despite the two
    // being interleaved across three yields.
    expect(a).toEqual(['tok-a', 'tok-a', 'tok-a']);
    expect(b).toEqual(['tok-b', 'tok-b', 'tok-b']);
  });

  test('a nested run shadows, and the outer value is restored', () => {
    withCredentials({ base: 'https://a.test', token: 'outer' }, () => {
      withCredentials({ base: 'https://b.test', token: 'inner' }, () => {
        expect(currentCredentials()!.token).toBe('inner');
      });
      expect(currentCredentials()!.token).toBe('outer');
    });
  });

  test('a throw inside the request does not strand the store', () => {
    expect(() => withCredentials({ base: 'https://a.test', token: 't' }, () => {
      throw new Error('tool failed');
    })).toThrow('tool failed');
    expect(currentCredentials()).toBeNull();
  });

  test('multi-tenant mode is off unless the remote transport turns it on', () => {
    expect(isMultiTenant()).toBe(false);
    setMultiTenantMode(true);
    expect(isMultiTenant()).toBe(true);
  });
});
