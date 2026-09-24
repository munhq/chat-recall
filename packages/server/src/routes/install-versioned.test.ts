/**
 * GET /install/chat-recall-<version>.tgz serves the tarball only while this
 * server holds that version.
 *
 * Auto-update downloaded the unversioned tarball from whichever pod answered.
 * During a rollout a new pod named 0.7.3 in the sync response, an old pod
 * served 0.7.2 for the download, and the checksum failed. A pod that holds
 * another version now answers 409, which the client retries on a later sync.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let app: Express;
let tmp: string;
const saved = { INSTALL_TGZ_PATH: process.env.INSTALL_TGZ_PATH, INSTALL_VERSION_PATH: process.env.INSTALL_VERSION_PATH };

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'install-versioned-'));
  process.env.INSTALL_TGZ_PATH = join(tmp, 'chat-recall.tgz');
  process.env.INSTALL_VERSION_PATH = join(tmp, 'cli-version.txt');
  writeFileSync(process.env.INSTALL_TGZ_PATH, Buffer.from('tarball-bytes'));
  writeFileSync(process.env.INSTALL_VERSION_PATH, '0.7.4\n');
  const mod = await import('./install.js');
  app = express();
  app.use('/', mod.default);
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('GET /install/chat-recall-<version>.tgz', () => {
  test('serves the tarball for the version this server holds', async () => {
    const res = await request(app).get('/install/chat-recall-0.7.4.tgz').buffer(true).parse((r, cb) => {
      const parts: Buffer[] = [];
      r.on('data', (c: Buffer) => parts.push(c));
      r.on('end', () => cb(null, Buffer.concat(parts)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/gzip');
    expect((res.body as Buffer).toString()).toBe('tarball-bytes');
  });

  test('answers 409 for another version, and names the one it holds', async () => {
    const res = await request(app).get('/install/chat-recall-0.7.3.tgz');
    expect(res.status).toBe(409);
    expect(res.body.held).toBe('0.7.4');
  });

  test('the unversioned tarball is still served, for older clients', async () => {
    const res = await request(app).get('/install/chat-recall.tgz');
    expect(res.status).toBe(200);
  });
});
