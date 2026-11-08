import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Host } from '@munhq/mcp-kit/cli';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { describeWhere, keepDeviceToken, registerRelay, relayCommand, signIn, tokenName } from './kit-store.js';

const DEFAULT = 'https://recall.example.com';

type Call = { bin: string; args: string[]; input?: string };

/** A machine that runs no program for real: each program answers as `answers` says, and the files are kept in memory. */
function fakeHost(answers: (c: Call) => number = () => 0): { host: Host; calls: Call[]; files: Map<string, { text: string; mode?: number }> } {
  const calls: Call[] = [];
  const files = new Map<string, { text: string; mode?: number }>();
  const host: Host = {
    home: '/home/user',
    env: {},
    run: (bin, args, opts) => {
      const call = { bin, args, input: opts?.input };
      calls.push(call);
      return { code: answers(call), stdout: '', stderr: '' };
    },
    read: (path) => files.get(path)?.text,
    write: (path, text, opts) => { files.set(path, { text, mode: opts?.mode }); },
  };
  return { host, calls, files };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kit-store-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('tokenName', () => {
  test('the default server is prod, another server is named by its host', () => {
    expect(tokenName(DEFAULT, DEFAULT)).toBe('personal/chat-recall/prod/DEVICE_TOKEN');
    expect(tokenName(`${DEFAULT}/`, DEFAULT)).toBe('personal/chat-recall/prod/DEVICE_TOKEN');
    expect(tokenName('http://localhost:3000', DEFAULT)).toBe('personal/chat-recall/localhost-3000/DEVICE_TOKEN');
  });
});

describe('keepDeviceToken', () => {
  test('by default the OS keyring takes the token and sealkeep is never asked', () => {
    const { host, calls } = fakeHost();
    const where = keepDeviceToken(DEFAULT, 'ct_secret', { defaultServer: DEFAULT, host, dataDir: dir, env: {} });
    expect(where).toMatchObject({ kind: 'keyring', account: 'personal/chat-recall/prod/DEVICE_TOKEN' });
    expect(calls.filter((c) => c.bin === 'sealkeep')).toEqual([]);
    expect(calls.some((c) => c.bin === 'secret-tool' && c.input === 'ct_secret')).toBe(true);
    expect(calls.flatMap((c) => c.args)).not.toContain('ct_secret');
    expect(describeWhere(where)).toContain('keyring');
  });

  test('CHAT_RECALL_SECRET_STORE=sealkeep gives the token to sealkeep first', () => {
    const { host, calls } = fakeHost();
    const where = keepDeviceToken(DEFAULT, 'ct_secret', { defaultServer: DEFAULT, host, dataDir: dir, env: { CHAT_RECALL_SECRET_STORE: 'sealkeep' } });
    expect(where).toEqual({ kind: 'sealkeep', name: 'personal/chat-recall/prod/DEVICE_TOKEN' });
    expect(calls[0].bin).toBe('sealkeep');
    expect(calls[0].input).toBe('ct_secret');
    expect(calls[0].args).not.toContain('ct_secret');
    expect(describeWhere(where)).toContain('sealkeep');
  });

  test('with no keyring, a file that only the owner reads takes it', () => {
    const { host, files } = fakeHost(() => 1);
    const where = keepDeviceToken(DEFAULT, 'ct_secret', { defaultServer: DEFAULT, host, dataDir: dir, env: {} });
    expect(where).toEqual({ kind: 'file', path: join(dir, 'tokens', 'prod') });
    expect(files.get(join(dir, 'tokens', 'prod'))).toEqual({ text: 'ct_secret\n', mode: 0o600 });
  });

  test('CHAT_RECALL_SECRET_STORE=file skips the keyring too', () => {
    const { host, calls, files } = fakeHost();
    const where = keepDeviceToken(DEFAULT, 'ct_secret', { defaultServer: DEFAULT, host, dataDir: dir, env: { CHAT_RECALL_SECRET_STORE: 'file' } });
    expect(where.kind).toBe('file');
    expect(calls).toEqual([]);
    expect(files.size).toBe(1);
  });
});

describe('signIn', () => {
  test('hands the prompt to the caller, polls, and answers the session token', async () => {
    const seen: string[] = [];
    const answers = [
      { status: 200, body: { device_code: 'dc', user_code: 'ABCD-EFGH', verification_uri: `${DEFAULT}/device`, verification_uri_complete: `${DEFAULT}/device?user_code=ABCD-EFGH`, expires_in: 600, interval: 1 } },
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 200, body: { access_token: 'session_token' } },
    ];
    const f = (async (input: string) => {
      seen.push(String(input));
      const a = answers.shift()!;
      return new Response(JSON.stringify(a.body), { status: a.status });
    }) as unknown as typeof fetch;
    const prompts: unknown[] = [];
    const session = await signIn(DEFAULT, (p) => prompts.push(p), { fetch: f, sleep: async () => undefined });
    expect(session).toBe('session_token');
    expect(prompts).toEqual([{ url: `${DEFAULT}/device?user_code=ABCD-EFGH`, userCode: 'ABCD-EFGH', verificationUri: `${DEFAULT}/device` }]);
    expect(seen[0]).toBe(`${DEFAULT}/api/auth/device/code`);
    expect(seen[1]).toBe(`${DEFAULT}/api/auth/device/token`);
  });

  test('a server with no device login is named in the error', async () => {
    const f = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
    await expect(signIn(DEFAULT, () => undefined, { fetch: f, sleep: async () => undefined })).rejects.toThrow(/no device login/);
  });
});

describe('registerRelay', () => {
  test('adds the relay command to each installed tool and replaces nothing that is current', () => {
    const { host, calls } = fakeHost((c) => {
      // `command -v <bin>` finds claude and codex only; `mcp get` says the server is not there yet.
      if (c.bin === 'sh') return /claude|codex/.test(c.args.join(' ')) ? 0 : 1;
      if (c.args[1] === 'get') return 1;
      return 0;
    });
    const outcomes = registerRelay(DEFAULT, dir, host);
    expect(outcomes.map((o) => o.client).sort()).toEqual(['claude', 'codex']);
    expect(outcomes.every((o) => o.ok)).toBe(true);
    const command = relayCommand(dir);
    const add = calls.filter((c) => c.args[0] === 'mcp' && c.args[1] === 'add');
    expect(add.map((c) => c.bin).sort()).toEqual(['claude', 'codex']);
    for (const c of add) expect(c.args.slice(c.args.indexOf('--') + 1)).toEqual(command);
    const claude = add.find((c) => c.bin === 'claude')!;
    expect(claude.args.slice(0, 5)).toEqual(['mcp', 'add', '--scope', 'user', 'chat-recall']);
  });

  test('no installed tool gives no outcome', () => {
    const { host } = fakeHost(() => 1);
    expect(registerRelay(DEFAULT, dir, host)).toEqual([]);
  });
});

describe('relayCommand', () => {
  test('without chat-recall-mcp on the PATH it names the bundle beside the CLI', () => {
    const saved = process.env.PATH;
    process.env.PATH = dir;
    try {
      expect(relayCommand('/opt/example/dist')).toEqual([process.execPath, '/opt/example/dist/mcp-relay.js']);
    } finally {
      process.env.PATH = saved;
    }
  });
});


describe('CHAT_RECALL_MCP_REGISTRATION=own', () => {
  test('runs no program of an AI tool', () => {
    const { host, calls } = fakeHost();
    expect(registerRelay(DEFAULT, dir, host, { CHAT_RECALL_MCP_REGISTRATION: 'own' })).toEqual([]);
    expect(calls).toEqual([]);
  });
});
