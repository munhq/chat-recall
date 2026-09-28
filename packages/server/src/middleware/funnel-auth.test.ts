/**
 * The kit's funnel plugin, inside this server's own better-auth version.
 *
 * @munhq/product-kit is tested against the newest better-auth. This server pins
 * an older one, and the plugin relies on two behaviours of it: after-hooks run
 * on a refused request, and a hook sees the parsed body and the session. If an
 * upgrade or a pin changed either, every failure would lose its address, and
 * only a test that runs this server's copy of better-auth would notice.
 *
 * The events are read back from a real metrics database: METRICS_TEST_DSN names
 * one with the platform's `events` table. Skipped without it, and on a build
 * without the kit, which is optional and private.
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { bearer, deviceAuthorization, emailOTP } from 'better-auth/plugins';

const DSN = process.env.METRICS_TEST_DSN;
const PRODUCT = 'chat-recall-funnel-test';

let funnel: (() => unknown) | null = null;
let closeGrowth: (() => Promise<void>) | null = null;
try {
  funnel = (await import('@munhq/product-kit/funnel')).funnel;
  closeGrowth = (await import('@munhq/product-kit')).closeGrowth;
} catch { funnel = null; }

describe.skipIf(!funnel || !DSN)('the kit funnel in this better-auth', () => {
  const ORIGIN = 'http://127.0.0.1:5000';
  let auth: { handler(r: Request): Promise<Response> };
  let token = '';
  const db = new pg.Pool({ connectionString: DSN });

  /** The funnel rows written since the last reset, oldest first. */
  async function events() {
    await new Promise((r) => setTimeout(r, 300));  // the insert is detached
    const { rows } = await db.query<{ event: string; props: Record<string, unknown> }>(
      'SELECT event, props FROM events WHERE product = $1 ORDER BY id', [PRODUCT]);
    return rows.map((r) => ({ event: r.event, extra: r.props }));
  }

  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    return auth.handler(new Request(`${ORIGIN}/api/auth${path}`, {
      method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
    }));
  }

  beforeAll(async () => {
    process.env.METRICS_ENABLED = 'true';
    process.env.METRICS_PRODUCT = PRODUCT;
    process.env.METRICS_DSN = DSN;
    auth = betterAuth({
      baseURL: ORIGIN,
      basePath: '/api/auth',
      secret: 'funnel-auth-test-secret-with-enough-length-0123456789',
      database: memoryAdapter({ user: [], session: [], account: [], verification: [], deviceCode: [] }),
      emailAndPassword: { enabled: true },
      plugins: [bearer(), emailOTP({ sendVerificationOTP: async () => {} }),
        deviceAuthorization({ verificationUri: '/device' }), funnel!() as never],
      logger: { disabled: true },
    }) as never;
    const res = await post('/sign-up/email', { email: 'member@example.com', password: 'correct-horse-9', name: 'M' });
    expect(res.status).toBe(200);
    token = res.headers.get('set-auth-token') ?? '';
    // The sign-up's own event is a detached insert; let it land before the
    // first test clears the table.
    await new Promise((r) => setTimeout(r, 300));
  });
  beforeEach(async () => { await db.query('DELETE FROM events WHERE product = $1', [PRODUCT]); });
  afterAll(async () => { await closeGrowth?.(); await db.end(); });

  test('a wrong password names the address, without the password', async () => {
    expect((await post('/sign-in/email', { email: 'Member@Example.com', password: 'wrong-password-1' })).status).toBe(401);
    const got = await events();
    expect(got).toEqual([{ event: 'funnel_fail', extra: { step: 'signin', status: 401, email: 'member@example.com' } }]);
    expect(JSON.stringify(got)).not.toContain('wrong-password-1');
  });

  test('a refused CLI approval takes the session address', async () => {
    await post('/device/approve', { userCode: 'NOPE-NOPE' }, { authorization: `Bearer ${token}` });
    expect((await events())[0]?.extra).toMatchObject({ step: 'cli_login_approved', email: 'member@example.com' });
  });

  test('a success carries the step and status only', async () => {
    await post('/sign-in/email', { email: 'member@example.com', password: 'correct-horse-9' });
    expect(await events()).toEqual([{ event: 'funnel', extra: { step: 'signin', status: 200 } }]);
  });
});
