/**
 * Trial reminders on the lifecycle scheduler, against real Postgres.
 *
 * Two facts are tested here:
 *
 *   1. Two replicas that sweep at the same time send each stage once. The
 *      flag sweep read a tenant setting, sent, and then wrote the setting, so
 *      two replicas that read together both sent.
 *   2. A tenant whose `trial_reminder_<stage>` flag the migration copied does
 *      not get that stage again.
 *
 * Both need Postgres (DATABASE_URL) and the private @munhq/product-kit. A run
 * without either skips this file and says which one is missing.
 */
import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { pgTestUrl } from '@chat-recall/engine/test-support/pg-urls.js';
import type { TrialUsage } from './trial-reminders.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;

interface FakeTenant { tenant: string; periodEnd: number; email: string; usage: TrialUsage | null }

const state = vi.hoisted(() => ({ tenants: [] as FakeTenant[] }));

// The control plane is a fake: the claims are the subject here, and they live
// in Postgres whichever store the tenants come from.
vi.mock('../imports.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../imports.js')>()),
  createControlPlane: async () => ({
    listTenants: async () => state.tenants.map((t) => t.tenant),
    getEntitlement: async (tenant: string) => {
      const t = state.tenants.find((x) => x.tenant === tenant);
      return t ? {
        tenant, plan: 'trial', status: 'trialing', currentPeriodEnd: t.periodEnd,
        stripeCustomerId: null, stripeSubscriptionId: null, seats: null,
      } : null;
    },
    listMembers: async (tenant: string) => {
      const t = state.tenants.find((x) => x.tenant === tenant);
      return t ? [{ email: t.email, role: 'owner' }] : [];
    },
    close: async () => {},
  }),
}));

const url = pgTestUrl();
const lifecycleMod = await import('@munhq/product-kit/lifecycle').catch(() => null);
const mailMod = await import('@munhq/product-kit/mail').catch(() => null);
const kitMod = await import('@munhq/product-kit').catch(() => null);
const missing = !url ? 'DATABASE_URL is not set' : !lifecycleMod || !mailMod || !kitMod ? '@munhq/product-kit is not installed' : '';
if (missing) console.warn(`trial-reminders.pg.test.ts skipped: ${missing}`);

const MIGRATION = new URL('../../cloud/migrations/0017_trial_reminder_claims.sql', import.meta.url);

/** The copy pack: one message for every id, so a send has a subject and a kind. */
const fakeMailkit = {
  copy: (id: string, to: string) => ({ to, subject: `subject of ${id}`, preheader: '', blocks: [] }),
  word: (key: string) => key,
  withFigures: (m: unknown) => m,
  compose: (m: { to: string; subject: string }) => ({ to: m.to, subject: m.subject, text: 'text', html: '<p>text</p>' }),
  hasCopy: () => true,
  setLogger: () => {},
};

describe.skipIf(!!missing)('trial reminders claimed in Postgres', () => {
  const sends: Array<{ to: string; subject: string }> = [];
  const pools: pg.Pool[] = [];
  const created: string[] = [];
  const pool = () => {
    const p = new pg.Pool({ connectionString: url, max: 4 });
    pools.push(p);
    return p;
  };

  const tenant = (daysLeft: number, usage: TrialUsage | null): FakeTenant => {
    const id = `trial-test-${randomUUID()}`;
    created.push(id);
    const now = Date.now();
    const t = {
      tenant: id,
      // An hour past the whole day, so trialDaysLeft() floors to `daysLeft`.
      periodEnd: daysLeft <= 0 ? now - HOUR : now + daysLeft * DAY + HOUR,
      email: `${id}@example.com`,
      usage,
    };
    state.tenants.push(t);
    return t;
  };

  async function scheduler(p: pg.Pool) {
    const { trialReminders } = await import('./trial-reminders.js');
    const s = await trialReminders({
      pool: p,
      loadUsage: async (id) => state.tenants.find((t) => t.tenant === id)?.usage ?? null,
    });
    if (!s) throw new Error('no scheduler: the kit did not load');
    return s;
  }

  const claimsOf = async (p: pg.Pool, id: string) => (await p.query(
    `SELECT step, message, outcome FROM lifecycle_mail WHERE product = 'chat-recall' AND subject = $1 ORDER BY step`,
    [id],
  )).rows;

  beforeAll(async () => {
    const { setMailkit } = await import('../auth/mail-kit.js');
    const { __setProductKit } = await import('../util/product-kit.js');
    setMailkit(fakeMailkit as never);
    __setProductKit(kitMod as never, null, lifecycleMod as never);
    process.env.SMTP_HOST = 'smtp.example.com';
    mailMod!.__setTransport(async () => ({
      sendMail: async (m: object) => {
        sends.push(m as { to: string; subject: string });
        // A send that takes time, so the two sweeps overlap.
        await new Promise((r) => setTimeout(r, 25));
        return { response: '250 Ok 0100019a1b2c3d4e-test-message-id' };
      },
    }));
  });

  afterAll(async () => {
    const p = pool();
    if (created.length) await p.query(`DELETE FROM lifecycle_mail WHERE product = 'chat-recall' AND subject = ANY($1)`, [created]);
    if (created.length) await p.query(`DELETE FROM tenant_settings WHERE tenant = ANY($1)`, [created]).catch(() => {});
    mailMod!.__setTransport(null);
    delete process.env.SMTP_HOST;
    state.tenants.length = 0;
    await Promise.all(pools.map((x) => x.end()));
  });

  test('two concurrent sweeps send each stage once', async () => {
    state.tenants.length = 0;
    sends.length = 0;
    const active: TrialUsage = { sessions: 40, projects: 3, oldestMs: Date.UTC(2025, 0, 1) };
    const idle: TrialUsage = { sessions: 0, projects: 0, oldestMs: null };
    const half = tenant(3, active);
    const final = tenant(1, idle);
    const ended = tenant(0, null);
    const nudge = tenant(5, idle);

    const [a, b] = [await scheduler(pool()), await scheduler(pool())];
    const now = new Date();
    const [ra, rb] = await Promise.all([a.sweep(now), b.sweep(now)]);

    expect(sends.map((m) => m.to).sort()).toEqual([half, final, ended, nudge].map((t) => t.email).sort());
    expect(ra.sent.length + rb.sent.length).toBe(4);
    expect(ra.claimedElsewhere + rb.claimedElsewhere).toBe(4);

    const p = pools[0]!;
    expect(await claimsOf(p, half.tenant)).toEqual([{ step: 'trial.half', message: 'trial.value.half.holdings', outcome: 'sent' }]);
    expect(await claimsOf(p, final.tenant)).toEqual([{ step: 'trial.final', message: 'trial.setup.final', outcome: 'sent' }]);
    expect(await claimsOf(p, ended.tenant)).toEqual([{ step: 'trial.ended', message: 'trial.value.ended.plain', outcome: 'sent' }]);
    expect(await claimsOf(p, nudge.tenant)).toEqual([{ step: 'trial.nudge', message: 'trial.setup.nudge', outcome: 'sent' }]);

    // The next sweep finds every stage claimed.
    const again = await a.sweep(new Date());
    expect(again.sent).toEqual([]);
    expect(sends).toHaveLength(4);
  });

  test('a flag the migration copied suppresses its stage', async () => {
    state.tenants.length = 0;
    sends.length = 0;
    const active: TrialUsage = { sessions: 12, projects: 1, oldestMs: Date.now() };
    const flagged = tenant(3, active);
    const control = tenant(3, active);

    const p = pool();
    // The table as engine/src/core/store/pg-schema.ts creates it.
    await p.query(`CREATE TABLE IF NOT EXISTS tenant_settings (
      tenant TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at BIGINT NOT NULL,
      PRIMARY KEY (tenant, key))`);
    const sentAt = Date.UTC(2026, 8, 20, 9, 30);
    await p.query(
      `INSERT INTO tenant_settings (tenant, key, value, updated_at) VALUES ($1, 'trial_reminder_half', $2, $3)`,
      [flagged.tenant, String(sentAt), sentAt],
    );

    const sql = readFileSync(MIGRATION, 'utf8');
    await p.query(sql);
    // Idempotent: a second run changes nothing.
    await p.query(sql);

    const copied = (await p.query(
      `SELECT step, message, outcome, done_at FROM lifecycle_mail WHERE product = 'chat-recall' AND subject = $1`,
      [flagged.tenant],
    )).rows;
    expect(copied).toHaveLength(1);
    expect(copied[0]).toMatchObject({ step: 'trial.half', message: 'trial_reminder_half', outcome: 'sent' });
    expect((copied[0].done_at as Date).getTime()).toBe(sentAt);

    const report = await (await scheduler(p)).sweep(new Date());
    expect(sends.map((m) => m.to)).toEqual([control.email]);
    expect(report.claimedElsewhere).toBe(1);
    expect(await claimsOf(p, flagged.tenant)).toEqual([{ step: 'trial.half', message: 'trial_reminder_half', outcome: 'sent' }]);
  });
});
