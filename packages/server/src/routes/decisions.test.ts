/**
 * Integration tests for /api/decisions — the cascade, and the reversal.
 *
 * The reversal case is the one this whole feature exists for, and it is the one
 * that silently did nothing before areas existed: a free-text subject meant
 * "auth" and "authentication" were different facts, so recording a new auth
 * decision never closed the old one and both stayed live forever.
 *
 * These run against the sqlite driver on a temp home, like the kv/diary route
 * tests, so they assert behaviour rather than a Postgres plan.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import decisionsRouter from './decisions.js';
import { homeEnvSnapshot, restoreHomeEnv, useHomeDir } from '@chat-recall/engine/test-support/home-env.js';

let tmpHome: string;
const origHome = homeEnvSnapshot();
let app: Express;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'decisions-route-'));
  useHomeDir(tmpHome);
  app = express();
  app.use(express.json());
  app.use('/api/decisions', decisionsRouter);
});
afterAll(() => {
  restoreHomeEnv(origHome);
  rmSync(tmpHome, { recursive: true, force: true });
});

const post = (body: Record<string, unknown>) => request(app).post('/api/decisions').send(body);
const get = (qs = '') => request(app).get(`/api/decisions${qs}`);

describe('recording a decision', () => {
  test('an area is required — a decision with no key supersedes nothing', async () => {
    const r = await post({ value: 'BetterAuth' });
    expect(r.status).toBe(400);
  });

  test('a value is required', async () => {
    const r = await post({ area: 'auth' });
    expect(r.status).toBe(400);
  });

  test('the area is canonicalised, so spellings do not split the key', async () => {
    const r = await post({ area: 'Authentication', value: 'BetterAuth' });
    expect(r.status).toBe(201);
    expect(r.body.area).toBe('auth');
    expect(r.body.subject).toBe('*:auth');
  });
});

describe('THE REVERSAL — the case the feature exists for', () => {
  test('a later decision on the same area closes the earlier one', async () => {
    await post({ area: 'database', value: 'Keycloak-era Postgres', reason: 'first call' });
    await post({ area: 'database', value: 'SQLite', reason: 'changed our minds' });

    const r = await get();
    const db = r.body.decisions.find((d: { area: string }) => d.area === 'database');
    expect(db.value).toBe('SQLite');

    // The old value is history, not a second live answer.
    const replaced = db.history.filter((h: { current: boolean }) => !h.current);
    expect(replaced.map((h: { value: string }) => h.value)).toContain('Keycloak-era Postgres');
    expect(db.history.filter((h: { current: boolean }) => h.current)).toHaveLength(1);
  });

  test('a reversal in one area does not touch another', async () => {
    const r = await get();
    const auth = r.body.decisions.find((d: { area: string }) => d.area === 'auth');
    // `auth` was decided before the database reversals above and must survive
    // them — superseding on (project, area) rather than on the project alone is
    // exactly what stops one decision closing every unrelated one.
    expect(auth.value).toBe('BetterAuth');
  });

  test('a differently-spelled area still supersedes, because the key is canonical', async () => {
    await post({ area: 'sign-in', value: 'Passkeys' });
    const r = await get();
    const auth = r.body.decisions.find((d: { area: string }) => d.area === 'auth');
    expect(auth.value).toBe('Passkeys');
    expect(auth.history.filter((h: { current: boolean }) => !h.current).map((h: { value: string }) => h.value))
      .toContain('BetterAuth');
  });
});

describe('the cascade', () => {
  test('a project with no opinion inherits the account decision', async () => {
    const r = await get('?project=example-app');
    const auth = r.body.decisions.find((d: { area: string }) => d.area === 'auth');
    expect(auth.inherited).toBe(true);
    expect(auth.override).toBe(false);
    expect(auth.value).toBe('Passkeys');
  });

  test('a project decision beats the account, and is flagged as an override', async () => {
    await post({ area: 'auth', value: 'Keycloak', project: 'acme', reason: 'client mandates it' });

    const r = await get('?project=acme');
    const auth = r.body.decisions.find((d: { area: string }) => d.area === 'auth');
    expect(auth.value).toBe('Keycloak');
    expect(auth.override).toBe(true);
    expect(auth.inherited).toBe(false);
    expect(auth.scope).toBe('project');
  });

  test('one project overriding does not change what another project sees', async () => {
    const r = await get('?project=example-app');
    const auth = r.body.decisions.find((d: { area: string }) => d.area === 'auth');
    expect(auth.value).toBe('Passkeys');
    expect(auth.override).toBe(false);
  });

  test('the account view is unaffected by a project override', async () => {
    const r = await get();
    const auth = r.body.decisions.find((d: { area: string }) => d.area === 'auth');
    expect(auth.value).toBe('Passkeys');
  });
});

describe('gaps', () => {
  test('a canonical area nobody decided is reported as a gap', async () => {
    const r = await get();
    const areas = r.body.gaps.map((g: { area: string }) => g.area);
    expect(areas).toContain('observability');
    expect(areas).not.toContain('auth');
  });

  test('a decided area leaves the gap list', async () => {
    await post({ area: 'observability', value: 'Grafana + Loki' });
    const r = await get();
    expect(r.body.gaps.map((g: { area: string }) => g.area)).not.toContain('observability');
  });

  test('an invented slug area is not treated as a gap everywhere else owes an answer for', async () => {
    await post({ area: 'Package Pinning', value: 'exact versions' });
    const r = await get();
    const decided = r.body.decisions.map((d: { area: string }) => d.area);
    expect(decided).toContain('package-pinning');
    // It is decided, but it never appears in `gaps` for anyone — gaps are the
    // canonical set only, or one team's local habit becomes everybody's debt.
    expect(r.body.gaps.map((g: { area: string }) => g.area)).not.toContain('package-pinning');
  });
});

describe('rationale', () => {
  test('the reason recorded with a decision comes back with it', async () => {
    await post({ area: 'payments', value: 'Stripe', reason: 'only rail that bills per seat' });
    const r = await get();
    const pay = r.body.decisions.find((d: { area: string }) => d.area === 'payments');
    expect(pay.why).toBe('only rail that bills per seat');
  });

  test('a new reason does not close the old decision — only a new value does', async () => {
    await post({ area: 'payments', value: 'Stripe', reason: 'and it handles VAT' });
    const r = await get();
    const pay = r.body.decisions.find((d: { area: string }) => d.area === 'payments');
    expect(pay.value).toBe('Stripe');
  });
});

describe('resolving a candidate', () => {
  test('confirm needs an area it can actually key on', async () => {
    const r = await request(app).post('/api/decisions/candidates/resolve')
      .send({ value: 'the second option', action: 'confirm' });
    expect(r.status).toBe(400);
  });

  test('an unknown action is refused', async () => {
    const r = await request(app).post('/api/decisions/candidates/resolve')
      .send({ value: 'Redis', action: 'maybe' });
    expect(r.status).toBe(400);
  });

  test('confirm infers the area from the value when none is given', async () => {
    const r = await request(app).post('/api/decisions/candidates/resolve')
      .send({ value: 'Redis', action: 'confirm' });
    expect(r.status).toBe(200);
    expect(r.body.area).toBe('database');

    const list = await get();
    const db = list.body.decisions.find((d: { area: string }) => d.area === 'database');
    expect(db.value).toBe('Redis');
  });

  test('an explicit area beats the inferred one', async () => {
    const r = await request(app).post('/api/decisions/candidates/resolve')
      .send({ value: 'Firebase', action: 'confirm', area: 'deploy' });
    expect(r.status).toBe(200);
    // inferArea('Firebase') says auth; the caller said deploy and wins.
    expect(r.body.area).toBe('deploy');
  });

  test('discard retires the guess without recording a decision', async () => {
    const before = await get();
    const r = await request(app).post('/api/decisions/candidates/resolve')
      .send({ value: 'Nothing Anyone Chose', action: 'discard' });
    expect(r.status).toBe(200);
    expect(r.body.area).toBeNull();

    const after = await get();
    // No new decision appeared from a discard.
    expect(after.body.decisions.length).toBe(before.body.decisions.length);
  });
});
