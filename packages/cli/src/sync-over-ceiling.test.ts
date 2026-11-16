/**
 * An export over the full-build ceiling is scanned file by file and never built
 * into a container (issue #23).
 *
 * A session whose main file is small but whose subagent files are not has an export
 * over the ceiling. The build said "no container copy" for it, and then exported the
 * session a second time and built one, so a 44 MB export grew the process from
 * 156 MB to 838 MB and ended the daemon (2026-11-16). The secret scan reads one file
 * of the export at a time now. These cases hold that the findings are the same as
 * the scan of the container gives, with the same line numbers, and that no raw
 * archive is built.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SESSION_ID = '33333333-4444-5555-6666-777777777777';
const SECRET = 'AKIAIOSFODNN7EXAMPLE';
const PROJECT = '/home/user/code/example';

let dataDir = '';
let claudeHome = '';
const saved: Record<string, string | undefined> = {};

function setEnv(ceilingMb: string): void {
  const env: Record<string, string> = { CHAT_RECALL_DATA_DIR: dataDir, CHAT_RECALL_CLAUDE_HOME: claudeHome, CHAT_RECALL_FULL_BUILD_MAX_MB: ceilingMb };
  for (const [k, v] of Object.entries(env)) { if (!(k in saved)) saved[k] = process.env[k]; process.env[k] = v; }
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cr-ceiling-data-'));
  claudeHome = mkdtempSync(join(tmpdir(), 'cr-ceiling-home-'));
  vi.resetModules();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(claudeHome, { recursive: true, force: true });
});

/** A small main file and one subagent file of about 10 MB (the ceiling cannot be set below 8 MB) with a secret on a known line. */
function writeSession(): void {
  const dir = join(claudeHome, 'projects', '-home-user-code-example');
  const subdir = join(dir, SESSION_ID, 'subagents');
  mkdirSync(subdir, { recursive: true });
  const ts = (i: number) => new Date(1750000000000 + i * 1000).toISOString();
  const main: string[] = [];
  for (let i = 0; i < 40; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    const text = `turn ${i} some words to say`;
    main.push(JSON.stringify({
      type: role, timestamp: ts(i), cwd: PROJECT, sessionId: SESSION_ID,
      message: role === 'user' ? { role, content: text } : { role, content: [{ type: 'text', text }] },
    }));
  }
  writeFileSync(join(dir, `${SESSION_ID}.jsonl`), main.join('\n') + '\n');
  const sub: string[] = [];
  const pad = 'lorem ipsum dolor sit amet '.repeat(60);
  for (let i = 0; i < 6000; i++) {
    if (i === 100) {
      // A tool call whose input and result are longer than the cap of the sync wire.
      sub.push(JSON.stringify({
        type: 'assistant', timestamp: ts(100 + i), cwd: PROJECT, sessionId: SESSION_ID, isSidechain: true, agentId: 'agent-a',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_long', name: 'Bash', input: { command: 'echo '.repeat(3000) } }] },
      }));
      sub.push(JSON.stringify({
        type: 'user', timestamp: ts(100 + i), cwd: PROJECT, sessionId: SESSION_ID, isSidechain: true, agentId: 'agent-a',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_long', content: 'out '.repeat(10000) }] },
      }));
    }
    const text = i === 4000 ? `the key is ${SECRET}` : `sub turn ${i} ${pad}`;
    sub.push(JSON.stringify({
      type: 'assistant', timestamp: ts(100 + i), cwd: PROJECT, sessionId: SESSION_ID, isSidechain: true, agentId: 'agent-a',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    }));
  }
  writeFileSync(join(subdir, 'agent-a.jsonl'), sub.join('\n') + '\n');
}

async function build(ceilingMb: string) {
  // A data folder of its own for each build: the first build writes a shadow archive of the
  // session, and a session whose shadow is over the ceiling takes the chunked path instead.
  rmSync(dataDir, { recursive: true, force: true });
  dataDir = mkdtempSync(join(tmpdir(), 'cr-ceiling-data-'));
  setEnv(ceilingMb);
  const { buildConversationSync, FULL_BUILD_MAX_BYTES } = await import('./sync-client.js');
  const { claudeBackend } = await import('@chat-recall/engine/core/backends/claude.js');
  const loc = claudeBackend.findSession(SESSION_ID)!;
  const ref = {
    toolId: 'claude' as const, rawId: SESSION_ID, prefixedId: SESSION_ID,
    projectPath: loc.projectPath, projectDir: loc.projectDir, fullPath: loc.path,
    created: '', modified: '', mtime: loc.mtime, firstPrompt: '', messageCount: 0,
  };
  const built = await buildConversationSync(ref as never, Math.floor(loc.mtime), { includeRaw: true, includeMeta: true });
  return { built: built as any, ceiling: FULL_BUILD_MAX_BYTES };
}

describe('an export over the ceiling', () => {
  test('finds the secret of a subagent file with the line number the container scan gives, and builds no raw archive', async () => {
    writeSession();
    const whole = await build('64');            // under the ceiling: the container path
    vi.resetModules();
    const over = await build('8');              // over the ceiling: file by file
    expect(over.ceiling).toBe(8 * 1024 * 1024);

    expect(whole.built.conv.raw_b64).toBeTruthy();
    expect(over.built.conv.raw_b64).toBeUndefined();

    const rule = (f: any) => `${f.rule}@${f.line}`;
    const wholeFindings = whole.built.findings.map(rule).sort();
    const overFindings = over.built.findings.map(rule).sort();
    expect(wholeFindings.length).toBeGreaterThan(0);
    expect(overFindings).toEqual(wholeFindings);
  });

  test('delivers the same messages as the build under the ceiling', async () => {
    writeSession();
    const whole = await build('64');
    vi.resetModules();
    const over = await build('8');
    expect(over.built.conv.envelope.messages.length).toBe(whole.built.conv.envelope.messages.length);
    expect(over.built.conv.envelope.subagents.length).toBe(whole.built.conv.envelope.subagents.length);
    // Every message, tool call and cut payload, as the build under the ceiling sends them.
    expect(over.built.conv.envelope).toEqual(whole.built.conv.envelope);
    const longCall = over.built.conv.envelope.subagents[0].messages.flatMap((m: any) => m.toolCalls ?? []).find((c: any) => c.name === 'Bash');
    expect(String(longCall.result)).toMatch(/… \[\+\d+ chars\]$/);
  });
});
