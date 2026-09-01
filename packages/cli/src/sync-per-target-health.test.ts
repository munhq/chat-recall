/**
 * ONE WALK, ONE VERDICT PER TARGET.
 *
 * ── The lie this closes ───────────────────────────────────────────────────
 * A walk pushes to every configured target in sequence and "succeeds" when ANY
 * of them accepted data. The daemon then recorded that single verdict against
 * EVERY target it knew about, so a walk where the hosted service accepted four
 * sessions and a LAN box refused the connection wrote `lastOkAt = now,
 * failures = 0` for both of them.
 *
 * `chat-recall doctor` reads that file. It reported "Synced to
 * http://192.168.1.9:8085 — 0m ago" for a box that had not accepted a byte in
 * days, while the collector was logging ECONNREFUSED against it every fifteen
 * minutes. The health file is the one place a user looks to answer "is my data
 * arriving", and it was fabricating the answer.
 *
 * So the walk now reports per target, and this test drives a real walk against
 * one working server and one closed port.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

import { startConformantServer, type ConformantServer } from './conformant-server.js';
import { _resetBreakers } from './target-breaker.js';

const SID = '22222222-2222-4222-8222-222222222222';

let sandbox = '';
let home = '';
let server: ConformantServer;
/** A port nothing is listening on, so a connection to it is REFUSED. */
let deadUrl = '';

/** One Claude transcript, in the shape the parser expects. */
function plantSession(claudeHome: string): void {
  const dir = join(claudeHome, 'projects', '-home-user-code-example');
  mkdirSync(dir, { recursive: true });
  const line = (role: 'user' | 'assistant', content: string, uuid: string, parent: string | null) =>
    JSON.stringify({
      parentUuid: parent, isSidechain: false, type: role,
      message: { role, content },
      uuid, timestamp: '2026-06-16T12:00:00.000Z',
      cwd: '/home/user/code/example', sessionId: SID, version: '2.0.0', gitBranch: 'main',
    });
  writeFileSync(
    join(dir, `${SID}.jsonl`),
    line('user', 'per-target-health fixture', 'u1', null) + '\n'
    + line('assistant', 'Fixed the per-target-health fixture.', 'a1', 'u1') + '\n',
  );
}

/** Bind an ephemeral port, learn its number, then release it. */
async function closedPortUrl(): Promise<string> {
  const s = createServer();
  await new Promise<void>((res) => s.listen(0, '127.0.0.1', () => res()));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((res) => s.close(() => res()));
  // 127.0.0.1 is a private host, so the transport gate allows plain http here —
  // what is under test is a refused connection, not the scheme.
  return `http://127.0.0.1:${port}`;
}

beforeAll(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'cr-pertarget-'));
  home = join(sandbox, 'home');
  mkdirSync(join(home, 'claude', 'projects'), { recursive: true });
  plantSession(join(home, 'claude'));

  server = await startConformantServer();
  deadUrl = await closedPortUrl();

  // Both targets, written the way `login` writes them.
  const dataDir = join(home, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'credentials.json'), JSON.stringify({
    targets: [
      { serverUrl: server.url, token: 'ct_per_target' },
      { serverUrl: deadUrl, token: 'ct_per_target' },
    ],
  }));

  Object.assign(process.env, {
    CHAT_RECALL_DATA_DIR: dataDir,
    CHAT_RECALL_CLAUDE_HOME: join(home, 'claude'),
    CHAT_RECALL_GEMINI_HOME: join(home, 'gemini'),
    CHAT_RECALL_CODEX_HOME: join(home, 'codex'),
    CHAT_RECALL_AGY_HOME: join(home, 'agy'),
    CHAT_RECALL_CURSOR_HOME: join(home, 'cursor'),
    CHAT_RECALL_CURSOR_IDE_HOME: join(home, 'cursor-ide'),
    CHAT_RECALL_OPENCODE_DB: join(home, 'none.db'),
    CHAT_RECALL_TELEMETRY: '0',
    HOME: home,
    USERPROFILE: home,
  });
  _resetBreakers();
});

afterAll(async () => {
  await server?.close();
  rmSync(sandbox, { recursive: true, force: true });
});

describe('a walk reports each target separately', () => {
  test('the working server is ok and the closed port is NOT', async () => {
    const { syncSessions } = await import('./sync-client.js');
    const r = await syncSessions({ cleartextPaths: true });

    expect(r.perTarget).toBeDefined();
    const per = r.perTarget!;
    // Exactly the two configured targets, no more and no fewer.
    expect(Object.keys(per).sort()).toEqual([server.url, deadUrl].sort());

    expect(per[server.url]).toEqual({ ok: true });

    // THE ASSERTION THAT MATTERS: the dead target is not reported as healthy,
    // and the recorded reason names the target that failed. Which layer notices
    // first is not the point — an unreachable server fails the sync-rules gate
    // before it ever refuses a connection — so this pins the verdict, not the
    // wording of whichever check got there first.
    expect(per[deadUrl].ok).toBe(false);
    expect(per[deadUrl].error).toBeTruthy();
    expect(per[deadUrl].error).toContain(deadUrl);

    // And the walk itself still succeeded, because one target did — which is
    // exactly the shape that used to hide the other one's failure.
    expect(r.uploaded).toBeGreaterThan(0);
  }, 60_000);
});
