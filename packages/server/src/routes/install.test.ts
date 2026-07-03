/**
 * Public install surface — /install.sh must render a runnable POSIX script
 * pointing back at THIS server (proxy-header aware), and the tarball route
 * must fail loudly (not a bare 404) on builds without the pack step.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let app: Express;
let tmp: string;
const origEnv = { PUBLIC_URL: process.env.PUBLIC_URL, INSTALL_TGZ_PATH: process.env.INSTALL_TGZ_PATH };

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'install-'));
  delete process.env.PUBLIC_URL;
  process.env.INSTALL_TGZ_PATH = join(tmp, 'chat-recall.tgz');
  // Env is read at module load for the tarball path — import AFTER setting it.
  const { default: installRouter } = await import('./install.js');
  app = express();
  app.use('/', installRouter);
});
afterAll(() => {
  for (const [k, v] of Object.entries(origEnv)) {
    if (v === undefined) delete process.env[k as keyof typeof origEnv];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('GET /install.sh', () => {
  test('renders a POSIX script pointing at the requesting origin (proxy headers win)', async () => {
    const res = await request(app)
      .get('/install.sh')
      .set('x-forwarded-proto', 'https')
      .set('x-forwarded-host', 'chat-recall.example.com');
    expect(res.status).toBe(200);
    expect(res.type).toBe('text/plain');
    expect(res.text).toContain('#!/bin/sh');
    expect(res.text).toContain('https://chat-recall.example.com/install/chat-recall.tgz');
    expect(res.text).toContain('chat-recall login https://chat-recall.example.com');
    // No bashisms that break `curl | sh` on dash: the shebang + set -eu only.
    expect(res.text).toContain('set -eu');
  });

  test('runs the full connect flow: token page URL → paste → login → sync', async () => {
    const res = await request(app)
      .get('/install.sh')
      .set('x-forwarded-proto', 'https')
      .set('x-forwarded-host', 'chat-recall.example.com');
    // Skip the dance when this machine already holds a working credential.
    expect(res.text).toContain('chat-recall login https://chat-recall.example.com --check');
    // Fresh machine: point at the token page (?view=connect) with a RANDOM
    // device slug — the hostname must never leak into a URL...
    expect(res.text).toContain('https://chat-recall.example.com/?view=connect&device=$DEVICE');
    expect(res.text).toContain('/dev/urandom');
    expect(res.text).not.toContain('$(hostname');
    // ...read the pasted token from the TERMINAL, not the piped-in script...
    expect(res.text).toContain('read TOKEN < /dev/tty');
    // ...log in with it (login validates before saving)...
    expect(res.text).toContain('chat-recall login https://chat-recall.example.com --token "$TOKEN"');
    // ...and sync in the BACKGROUND (service, or nohup fallback) — the first
    // sync of a big history must not hold the terminal hostage.
    expect(res.text).toContain('chat-recall service install');
    expect(res.text).toContain('nohup chat-recall sync');
    expect(res.text).not.toMatch(/^chat-recall sync\b/m);
    // No stale "open the site and mint a token by hand" instructions.
    expect(res.text).not.toMatch(/mint a device token/i);
  });

  test('PUBLIC_URL overrides request-derived origin', async () => {
    process.env.PUBLIC_URL = 'https://override.example.com/';
    try {
      const res = await request(app).get('/install.sh').set('host', 'ignored.local');
      expect(res.text).toContain('https://override.example.com/install/chat-recall.tgz');
      expect(res.text).not.toContain('ignored.local');
    } finally {
      delete process.env.PUBLIC_URL;
    }
  });
});

describe('GET /install/chat-recall.tgz', () => {
  test('missing tarball → diagnosable 404, not a bare one', async () => {
    const res = await request(app).get('/install/chat-recall.tgz');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/tarball/i);
    expect(res.body.hint).toMatch(/Dockerfile/);
  });

  test('serves the tarball when present', async () => {
    writeFileSync(join(tmp, 'chat-recall.tgz'), Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
    const res = await request(app).get('/install/chat-recall.tgz');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/gzip');
  });
});
