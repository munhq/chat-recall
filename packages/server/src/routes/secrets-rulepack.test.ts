/**
 * The rule-pack endpoint the collector pulls at sync time.
 *
 * Contract:
 *   - GET  /rules carries `redact` per rule and a `version` content hash, so a
 *     device can log which rules it actually ran and skip an unchanged pack.
 *   - The version changes when a rule's pattern/name/redact flag changes, and
 *     NOT when something cosmetic (description) changes.
 *   - POST refuses to save a `redact` rule the collector would drop anyway. A
 *     rule saved here but silently ignored on every device is worse than an
 *     error: the dashboard would show coverage that does not exist.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
let prevDataDir: string | undefined;

beforeAll(() => {
  prevDataDir = process.env.CHAT_RECALL_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'cr-rulepack-test-'));
  process.env.CHAT_RECALL_DATA_DIR = dataDir;
});

afterAll(() => {
  if (prevDataDir === undefined) delete process.env.CHAT_RECALL_DATA_DIR;
  else process.env.CHAT_RECALL_DATA_DIR = prevDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

async function makeApp() {
  const secretsRouter = (await import('./secrets.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/secrets', secretsRouter);
  return app;
}

describe('GET/POST /api/secrets/rules — the collector rule pack', () => {
  test('serves redact + a version that tracks rule content', async () => {
    const app = await makeApp();

    const empty = await request(app).get('/api/secrets/rules');
    expect(empty.status).toBe(200);
    expect(empty.body.version).toBe('empty');

    const save = await request(app).post('/api/secrets/rules').send({
      name: 'acme-internal', regex: 'acme_(?:live|test)_[a-zA-Z0-9]{32}',
      severity: 'high', redact: true,
    });
    expect(save.status).toBe(200);

    const withRule = await request(app).get('/api/secrets/rules');
    expect(withRule.status).toBe(200);
    const rule = withRule.body.rules.find((r: { name: string }) => r.name === 'acme-internal');
    expect(rule).toBeTruthy();
    expect(!!rule.redact).toBe(true);          // the collector keys off this
    const v1 = withRule.body.version;
    expect(v1).toMatch(/^[0-9a-f]{12}$/);

    // Cosmetic edit ⇒ same version (a device need not re-install the pack).
    await request(app).post('/api/secrets/rules').send({
      name: 'acme-internal', regex: 'acme_(?:live|test)_[a-zA-Z0-9]{32}',
      severity: 'high', redact: true, description: 'internal keys',
    });
    expect((await request(app).get('/api/secrets/rules')).body.version).toBe(v1);

    // Pattern edit ⇒ new version.
    await request(app).post('/api/secrets/rules').send({
      name: 'acme-internal', regex: 'acme_(?:live|test)_[a-zA-Z0-9]{40}',
      severity: 'high', redact: true,
    });
    expect((await request(app).get('/api/secrets/rules')).body.version).not.toBe(v1);
  });

  test('a tenant with no rules of its own still gets the curated pack', async () => {
    // The regression this endpoint shipped with: `version: "empty"` and no
    // redaction rules at all, so every customer's coverage was whatever their
    // installed CLI had compiled in. The pack is what makes coverage improve
    // from a server deploy.
    const app = await makeApp();
    const res = await request(app).get('/api/secrets/rules');
    expect(res.status).toBe(200);
    expect(res.body.pack).toBeTruthy();
    expect(res.body.pack.rules.length).toBeGreaterThan(50);
    expect(res.body.pack.version).toMatch(/^[0-9a-f]{12}$/);
    expect(res.body.pack.source).toMatch(/MIT/);
    for (const r of res.body.pack.rules) {
      expect(r.redact).toBe(true);       // the pack IS the redaction set
      expect(['pack', 'tenant']).toContain(r.source);
    }
  });

  test('a tenant redact rule joins the pack, and moves pack.version', async () => {
    const app = await makeApp();
    const before = await request(app).get('/api/secrets/rules');
    const beforeCount = before.body.pack.rules.length;
    const beforeVersion = before.body.pack.version;

    await request(app).post('/api/secrets/rules').send({
      name: 'acme-pack-member', regex: 'acme_pack_[a-zA-Z0-9]{20}',
      severity: 'high', redact: true,
    });

    const after = await request(app).get('/api/secrets/rules');
    expect(after.body.pack.rules.length).toBe(beforeCount + 1);
    expect(after.body.pack.version).not.toBe(beforeVersion);
    const mine = after.body.pack.rules.find((r: { name: string }) => r.name === 'acme-pack-member');
    expect(mine.source).toBe('tenant');

    // A REPORT-ONLY tenant rule must not join the redaction set.
    await request(app).post('/api/secrets/rules').send({
      name: 'acme-report-only', regex: 'acme_report_[a-zA-Z0-9]{20}', severity: 'low',
    });
    const third = await request(app).get('/api/secrets/rules');
    expect(third.body.pack.rules.find((r: { name: string }) => r.name === 'acme-report-only')).toBeUndefined();
  });

  test('refuses to save an over-broad rule as a redact rule', async () => {
    const app = await makeApp();
    const res = await request(app).post('/api/secrets/rules').send({
      name: 'everything', regex: '.*', severity: 'critical', redact: true,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not safe to redact/);

    // Same pattern as REPORT-ONLY is still allowed — noisy findings are the
    // operator's call; destroying stored content is not.
    const reportOnly = await request(app).post('/api/secrets/rules').send({
      name: 'everything', regex: '.*', severity: 'low',
    });
    expect(reportOnly.status).toBe(200);
  });

  test('an uncompilable regex is rejected regardless of redact', async () => {
    const app = await makeApp();
    const res = await request(app).post('/api/secrets/rules').send({
      name: 'broken', regex: '([unclosed', severity: 'high',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid regex/);
  });
});
