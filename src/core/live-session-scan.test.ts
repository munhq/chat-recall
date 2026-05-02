/**
 * Unit tests for live-session-scan helpers.
 *
 * The pure-logic surface is `detectTool` (id → AI tool); the on-disk
 * scanners (`liveScanSessionEdits`, `liveScanRecentEdits`,
 * `liveScanModifiedFiles`) are tested against a temp directory we
 * populate per test so they run anywhere without depending on the
 * developer's actual ~/.claude/projects content.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  detectTool,
  liveScanSessionEdits,
  liveScanRecentEdits,
  liveScanModifiedFiles,
  type AiTool,
} from './live-session-scan.js';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('detectTool', () => {
  const cases: Array<[string, AiTool]> = [
    ['12345678-1234-4321-8765-123456789012', 'claude'],
    ['gemini_session-2026-01-foo', 'gemini'],
    ['opencode_ses_xyz', 'opencode'],
    ['codex_2026-05-02T10-21-58-019de790', 'codex'],
  ];
  for (const [id, expected] of cases) {
    test(`prefix → tool: ${id.slice(0, 24)} → ${expected}`, () => {
      expect(detectTool(id)).toBe(expected);
    });
  }
});

describe('liveScanSessionEdits (claude)', () => {
  let tmpHome: string;
  const origHome = process.env.HOME;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'live-scan-'));
    process.env.HOME = tmpHome;
  });
  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function writeClaudeSession(uuid: string, projectDirEnc: string, lines: object[]) {
    const dir = join(tmpHome, '.claude', 'projects', projectDirEnc);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${uuid}.jsonl`),
      lines.map(l => JSON.stringify(l)).join('\n') + '\n',
    );
  }

  test('returns found=false when session id is not on disk', () => {
    const r = liveScanSessionEdits('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    expect(r.found).toBe(false);
    expect(r.edits).toEqual([]);
  });

  test('extracts Edit/Write/Read tool_use blocks from a session', () => {
    const sid = '11111111-2222-4333-8444-555555555555';
    writeClaudeSession(sid, '-home-user-myproject', [
      {
        type: 'assistant',
        timestamp: '2026-05-02T10:00:00.000Z',
        message: {
          content: [
            { type: 'tool_use', name: 'Edit', input: { file_path: '/home/user/myproject/src/foo.ts' } },
            { type: 'tool_use', name: 'Read', input: { file_path: '/home/user/myproject/README.md' } },
          ],
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-05-02T10:01:00.000Z',
        message: {
          content: [
            { type: 'tool_use', name: 'Write', input: { file_path: '/home/user/myproject/src/bar.ts' } },
          ],
        },
      },
    ]);

    const r = liveScanSessionEdits(sid);
    expect(r.found).toBe(true);
    expect(r.tool).toBe('claude');
    expect(r.edits).toHaveLength(3);

    const ops = r.edits.map(e => e.op);
    expect(ops).toContain('edit');
    expect(ops).toContain('write');
    expect(ops).toContain('read');

    const editEdit = r.edits.find(e => e.op === 'edit')!;
    expect(editEdit.file).toBe('/home/user/myproject/src/foo.ts');
    expect(editEdit.toolName).toBe('Edit');
    expect(editEdit.tool).toBe('claude');
  });

  test('ignores non-file-touching tool_uses (Bash, Grep, …)', () => {
    const sid = '22222222-2222-4333-8444-555555555555';
    writeClaudeSession(sid, '-tmp-x', [
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
            { type: 'tool_use', name: 'Grep', input: { pattern: 'foo' } },
          ],
        },
      },
    ]);
    const r = liveScanSessionEdits(sid);
    expect(r.found).toBe(true);
    expect(r.edits).toHaveLength(0);
  });

  test('skips malformed JSONL lines without throwing', () => {
    const sid = '33333333-2222-4333-8444-555555555555';
    const dir = join(tmpHome, '.claude', 'projects', '-x');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${sid}.jsonl`),
      'not json\n' +
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/a' } }] } }) +
      '\nalso not json\n',
    );
    const r = liveScanSessionEdits(sid);
    expect(r.edits).toHaveLength(1);
  });
});

describe('liveScanModifiedFiles', () => {
  let tmpHome: string;
  const origHome = process.env.HOME;
  beforeEach(() => { tmpHome = mkdtempSync(join(tmpdir(), 'mod-')); process.env.HOME = tmpHome; });
  afterEach(() => { process.env.HOME = origHome; rmSync(tmpHome, { recursive: true, force: true }); });

  test('separates writes (files) from reads', () => {
    const sid = 'aaaaaaaa-1111-4222-8333-444444444444';
    const dir = join(tmpHome, '.claude', 'projects', '-x');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${sid}.jsonl`),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Edit', input: { file_path: '/a/b.ts' } },
            { type: 'tool_use', name: 'Write', input: { file_path: '/a/c.ts' } },
            { type: 'tool_use', name: 'Read', input: { file_path: '/a/d.ts' } },
          ],
        },
      }) + '\n',
    );

    const r = liveScanModifiedFiles(sid);
    expect(r.found).toBe(true);
    expect(r.files).toEqual(expect.arrayContaining(['/a/b.ts', '/a/c.ts']));
    expect(r.files).not.toContain('/a/d.ts');
    expect(r.reads).toEqual(['/a/d.ts']);
  });
});

describe('liveScanRecentEdits', () => {
  let tmpHome: string;
  const origHome = process.env.HOME;
  beforeEach(() => { tmpHome = mkdtempSync(join(tmpdir(), 'recent-')); process.env.HOME = tmpHome; });
  afterEach(() => { process.env.HOME = origHome; rmSync(tmpHome, { recursive: true, force: true }); });

  test('returns empty when no projects directory exists', () => {
    const r = liveScanRecentEdits({ sinceMs: 0 });
    expect(r).toEqual([]);
  });

  test('honors pattern filter', () => {
    const dir = join(tmpHome, '.claude', 'projects', '-p');
    mkdirSync(dir, { recursive: true });
    const sid = '99999999-1111-4222-8333-444444444444';
    writeFileSync(
      join(dir, `${sid}.jsonl`),
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: {
          content: [
            { type: 'tool_use', name: 'Edit', input: { file_path: '/code/src/auth.ts' } },
            { type: 'tool_use', name: 'Edit', input: { file_path: '/code/test/foo.ts' } },
          ],
        },
      }) + '\n',
    );

    const all = liveScanRecentEdits({ sinceMs: 0 });
    expect(all.length).toBeGreaterThanOrEqual(2);

    const onlyAuth = liveScanRecentEdits({ sinceMs: 0, pattern: 'auth' });
    expect(onlyAuth.every(e => e.file.includes('auth'))).toBe(true);
  });
});
