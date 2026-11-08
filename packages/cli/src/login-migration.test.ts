/**
 * `chat-recall login` on a machine that is already connected: a token that an earlier version wrote to
 * `credentials.json` moves to the kit store once, and the file keeps a pointer and no token.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { startConformantServer, type ConformantServer } from './conformant-server.js';

const CLI = (process.env.CHAT_RECALL_TEST_CLI || '').trim() || resolve(import.meta.dirname, '../dist/cli.js');

let sandbox = '';
let server: ConformantServer;

beforeAll(async () => {
  if (!existsSync(CLI)) throw new Error(`build first — ${CLI} is missing`);
  sandbox = mkdtempSync(join(tmpdir(), 'cr-migrate-'));
  server = await startConformantServer();
});

afterAll(async () => {
  await server?.close();
  rmSync(sandbox, { recursive: true, force: true });
});

function runCli(args: string[], home: string): Promise<{ out: string; status: number }> {
  const env = {
    ...process.env,
    CHAT_RECALL_DATA_DIR: join(home, 'data'),
    CHAT_RECALL_SECRET_STORE: 'file',
    CHAT_RECALL_MCP_REGISTRATION: 'own',
    CHAT_RECALL_TOKEN: '',
    CHAT_RECALL_SERVER: '',
    CHAT_RECALL_TELEMETRY: '0',
    HOME: home,
    USERPROFILE: home,
  };
  return new Promise((res) => {
    execFile(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 120_000 }, (err, stdout, stderr) => {
      const e = err as (Error & { code?: number | string }) | null;
      res({ out: `${stdout ?? ''}${stderr ?? ''}`, status: e ? (typeof e.code === 'number' ? e.code : 1) : 0 });
    });
  });
}

describe('login on a machine that is already connected', () => {
  test('moves the token out of credentials.json and keeps the login working', async () => {
    const home = mkdtempSync(join(sandbox, 'home-'));
    const dataDir = join(home, 'data');
    mkdirSync(dataDir, { recursive: true });
    // The way an earlier version wrote it: the token in the file.
    const first = await runCli(['login', server.url, '--token', 'ct_migration_test'], home);
    expect(first.status, first.out).toBe(0);
    const credPath = join(dataDir, 'credentials.json');
    // Put the token back in the file, as the earlier version left it.
    writeFileSync(credPath, JSON.stringify({ targets: [{ serverUrl: server.url, token: 'ct_migration_test' }] }));

    const again = await runCli(['login', server.url], home);
    expect(again.status, again.out).toBe(0);
    expect(again.out).toMatch(/Already connected/);
    expect(again.out).toMatch(/token moved to/);

    const file = readFileSync(credPath, 'utf-8');
    expect(file).not.toContain('ct_migration_test');
    const target = (JSON.parse(file) as { targets: Array<{ token: string; secret?: { kind: string; path?: string } }> }).targets[0];
    expect(target.token).toBe('');
    expect(target.secret?.kind).toBe('file');
    expect(readFileSync(target.secret!.path!, 'utf-8').trim()).toBe('ct_migration_test');

    // A third run finds the token through the pointer and moves nothing.
    const third = await runCli(['login', server.url], home);
    expect(third.status, third.out).toBe(0);
    expect(third.out).toMatch(/Already connected/);
    expect(third.out).not.toMatch(/token moved to/);
  });
});
