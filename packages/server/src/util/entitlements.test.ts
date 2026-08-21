/**
 * The gate's contract. Two properties matter most and both are silent when broken:
 *
 *  1. An UNLICENSED self-host deployment allows ONE identity. It previously
 *     allowed unlimited, because seatCheck() treated "no seat count known" as
 *     "unlimited" — so any number of people could self-register on one free box,
 *     each getting their own tenant, and the invite gate beside it was decorative.
 *  2. A trialing or Solo tenant does NOT get team features. That exact confusion
 *     shipped twice: requireTeamFeature passes through on cloud, so three route
 *     mounts were guarded by "has any subscription" rather than "has Team".
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  planFeatures, licenceFeatures, featuresFor, allows,
  ssoAllowed,
  identityLimit, identityCheck, featureRequired, FREE_FEATURES,
} from './entitlements.js';

const saved: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined): void {
  if (!(k in saved)) saved[k] = process.env[k];
  if (v === undefined) delete process.env[k]; else process.env[k] = v;
}
const cloud = () => setEnv('STRIPE_SECRET_KEY', 'sk_test_x');
const selfhost = () => setEnv('STRIPE_SECRET_KEY', undefined);

beforeEach(() => { selfhost(); setEnv('CHAT_RECALL_LICENSE', undefined); });
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe('the free base is never withholdable', () => {
  test('memory and scan are granted in every configuration', () => {
    for (const plan of [null, undefined, '', 'solo-monthly', 'team-yearly', 'nonsense', 'enterprise']) {
      for (const edition of [cloud, selfhost]) {
        edition();
        const f = featuresFor(plan);
        expect(f.has('memory'), `memory for ${plan}`).toBe(true);
        expect(f.has('scan'), `scan for ${plan}`).toBe(true);
      }
    }
  });

  test('FREE_FEATURES is exactly memory + scan', () => {
    expect([...FREE_FEATURES].sort()).toEqual(['memory', 'scan']);
  });
});

describe('cloud: plan → features', () => {
  beforeEach(cloud);

  test('a NULL plan grants nothing beyond free — fail closed', () => {
    // This is the realistic input: every entitlement held plan=NULL while the
    // webhook was dropping it. It must not grant paid features.
    expect([...planFeatures(null)].sort()).toEqual(['memory', 'scan']);
  });

  test("the TRIAL grants the Solo set — it must demonstrate the product", () => {
    // Regression: the trial was created with plan=null, which resolves to the free
    // set, so a 14-day trial showed none of what it exists to sell.
    const f = featuresFor('trial');
    for (const x of ['sync', 'alerts', 'findings', 'insights', 'tasks', 'toolkit'] as const) {
      expect(f.has(x), `trial should grant ${x}`).toBe(true);
    }
    // ...but never COLLABORATION, which is the one thing needing a second person.
    // 'toolkit' and 'tasks' left this list deliberately: neither does. Toolkit
    // distributes your own config across your own machines, and a one-person
    // board has nobody to assign to. Gating them here refused two features to a
    // paying Solo customer, who discovered it only after paying.
    expect(f.has('team')).toBe(false);
  });

  test('featureRequired never tells anyone to buy the TRIAL', () => {
    // 'trial' is granted, not sold; offering it as an upgrade tier is nonsense.
    for (const x of ['sync', 'alerts', 'findings', 'insights'] as const) {
      expect(featureRequired(x).requires).toBe('solo');
    }
  });

  test('an UNKNOWN plan grants nothing beyond free', () => {
    expect([...planFeatures('mystery-tier')].sort()).toEqual(['memory', 'scan']);
  });

  test('Solo gets the single-player set, but never collaboration', () => {
    expect(allows('solo-monthly', 'findings')).toBe(true);
    expect(allows('solo-monthly', 'alerts')).toBe(true);
    expect(allows('solo-monthly', 'sync')).toBe(true);
    // Single-player by nature, so Solo has them: own config across own machines,
    // and a board for your own work.
    expect(allows('solo-monthly', 'toolkit')).toBe(true);
    expect(allows('solo-monthly', 'tasks')).toBe(true);
    // The line that must not move: assigning work to another person, shared
    // history and per-member activity all need a second identity.
    expect(allows('solo-monthly', 'team')).toBe(false);
    expect(allows('solo-monthly', 'sso')).toBe(false);
    expect(allows('solo-monthly', 'audit')).toBe(false);
  });

  test('Team gets collaboration but NOT enterprise features', () => {
    expect(allows('team-monthly', 'team')).toBe(true);
    expect(allows('team-monthly', 'toolkit')).toBe(true);
    expect(allows('team-monthly', 'sso')).toBe(false);
    expect(allows('team-monthly', 'audit')).toBe(false);
  });

  test('Enterprise gets everything', () => {
    for (const f of ['memory','scan','sync','alerts','findings','team','toolkit','sso','audit'] as const) {
      expect(allows('enterprise', f), f).toBe(true);
    }
  });

  test('plans match by PREFIX, so a new price needs no code change', () => {
    expect(allows('team-quarterly', 'team')).toBe(true);
    expect(allows('solo-2027-promo', 'findings')).toBe(true);
  });

  test('case is ignored', () => {
    expect(allows('TEAM-MONTHLY', 'team')).toBe(true);
  });
});

describe('self-host: licence → features', () => {
  beforeEach(selfhost);

  test('unlicensed self-host is FREE and FULL — the whole Solo set', () => {
    // Deliberately more than FREE_FEATURES. One person on their own hardware
    // pays nothing: charging them taxes the people who drive adoption while
    // earning almost nothing. See SELFHOST_FREE_FEATURES.
    expect([...licenceFeatures()].sort())
      .toEqual(['alerts', 'findings', 'insights', 'memory', 'scan', 'sync']);
  });

  test('but collaboration is NOT free — that is where the money is', () => {
    for (const f of ['team', 'toolkit', 'sso', 'audit'] as const) {
      expect(licenceFeatures().has(f)).toBe(false);
    }
    expect(allows('team-monthly', 'team')).toBe(false);   // plan is ignored off-cloud
  });

  test('the boundary is PEOPLE, not machines', () => {
    // No device cap exists anywhere by design — sync from as many machines as
    // you like. A SECOND identity is what means "a company", and that is capped.
    expect(identityLimit()).toBe(1);
  });

  test('the cloud plan is irrelevant on self-host', () => {
    // A self-hoster cannot grant themselves features by naming a plan.
    expect(allows('enterprise', 'sso')).toBe(false);
  });

  test('widening self-host did NOT widen the cloud free tier', () => {
    // planFeatures() must stay fail-closed: a cloud tenant whose plan failed to
    // record gets FREE_FEATURES, never the paid set. This is the regression that
    // would hand the product away to every NULL-plan row.
    cloud();
    expect([...planFeatures(null)].sort()).toEqual([...FREE_FEATURES].sort());
    expect(planFeatures(null).has('sync')).toBe(false);
  });
});

describe('identity limit — the multi-user gate', () => {
  test('UNLICENSED self-host allows exactly ONE identity', () => {
    selfhost();
    expect(identityLimit()).toBe(1);
    expect(identityCheck(0).ok).toBe(true);    // the first person may join
    expect(identityCheck(1).ok).toBe(false);   // the second may not
  });

  test('the refusal reports the numbers, not just false', () => {
    selfhost();
    const r = identityCheck(1);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.used).toBe(1); expect(r.limit).toBe(1); }
  });

  test('cloud does not apply the self-host limit', () => {
    // Seats on cloud are the subscription quantity, validated at checkout.
    cloud();
    expect(identityLimit()).toBeNull();
    expect(identityCheck(50).ok).toBe(true);
  });
});

describe('featureRequired — the canonical refusal', () => {
  test('names the tier that would grant it, on cloud', () => {
    cloud();
    expect(featureRequired('team').requires).toBe('team');
    expect(featureRequired('findings').requires).toBe('solo');
    expect(featureRequired('sso').requires).toBe('enterprise');
  });

  test('asks for a licence on self-host, and always carries an upgrade URL', () => {
    selfhost();
    const r = featureRequired('team');
    expect(r.requires).toBe('a licence');
    expect(r.upgradeUrl).toMatch(/^https?:\/\//);
    expect(r.feature).toBe('team');
  });
});

describe('ssoAllowed — the gate that was missing', () => {
  const L = { hosted: false, licensed: true };
  const U = { hosted: false, licensed: false };

  test('built-in auth needs no licence, ever', () => {
    for (const p of ['better-auth', 'none', 'static-token']) {
      expect(ssoAllowed(p, U)).toBe(true);
    }
  });

  test('an unlicensed self-hoster cannot bring their own IdP', () => {
    // The hole: 'sso' was sold and advertised while nothing checked it.
    expect(ssoAllowed('keycloak', U)).toBe(false);
  });

  test('a licensed self-hoster can', () => {
    expect(ssoAllowed('keycloak', L)).toBe(true);
  });

  test('the hosted service is never gated by a self-host licence', () => {
    // Our own AUTH_PROVIDER choice is not a customer entitlement — gating it
    // would stop the SaaS booting.
    expect(ssoAllowed('keycloak', { hosted: true, licensed: false })).toBe(true);
  });
});
