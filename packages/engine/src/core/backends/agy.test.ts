import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { agyBackend } from './agy.js';

let home: string;
const orig = process.env.CHAT_RECALL_AGY_HOME;

function writeSession(id: string, lines: object[]) {
  const logs = join(home, 'brain', id, '.system_generated', 'logs');
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, 'transcript.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
}

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'agy-')); process.env.CHAT_RECALL_AGY_HOME = home; });
afterEach(() => {
  if (orig === undefined) delete process.env.CHAT_RECALL_AGY_HOME; else process.env.CHAT_RECALL_AGY_HOME = orig;
  rmSync(home, { recursive: true, force: true });
});

describe('AgyBackend project attribution (Q1)', () => {
  test('derives the project from the file paths the session touched (no corpus line)', () => {
    // Files live under a deep, hyphenated project dir with no .git — should
    // resolve to the common ancestor, NOT the trustedWorkspaces fallback.
    writeSession('11111111-1111-1111-1111-111111111111', [
      { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'do the thing', created_at: '2026-07-08T00:00:00Z' },
      { source: 'MODEL', type: 'CODE_ACTION', status: 'OK',
        content: 'File Path: `file:///home/u/code/personal/infra-interview/Makefile`' },
      { source: 'MODEL', type: 'VIEW_FILE',
        content: 'Viewing `file:///home/u/code/personal/infra-interview/charts/api/values.yaml`' },
    ]);
    const loc = agyBackend.findSession('11111111-1111-1111-1111-111111111111');
    expect(loc).not.toBeNull();
    expect(loc!.projectPath).toBe('/home/u/code/personal/infra-interview');
  });

  test('falls back to trustedWorkspaces[0] only when no paths are referenced', () => {
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ trustedWorkspaces: ['/home/u/code/fallback'] }));
    writeSession('22222222-2222-2222-2222-222222222222', [
      { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'hello, no files here', created_at: '2026-07-08T00:00:00Z' },
    ]);
    const loc = agyBackend.findSession('22222222-2222-2222-2222-222222222222');
    expect(loc!.projectPath).toBe('/home/u/code/fallback');
  });
});

describe('AgyBackend edit extraction (Q2)', () => {
  test('normalizes TargetFile → file_path so edits carry a filename', () => {
    writeSession('33333333-3333-3333-3333-333333333333', [
      { source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'editing', created_at: '2026-07-08T00:00:00Z',
        tool_calls: [{ name: 'write_to_file', args: { TargetFile: '/home/u/code/proj/app.ts', CodeContent: 'x' } }] },
    ]);
    const events = agyBackend.readEvents('33333333-3333-3333-3333-333333333333');
    const use = events.find((e) => e.kind === 'tool_use') as any;
    expect(use.toolInput.file_path).toBe('/home/u/code/proj/app.ts');
  });

  test('reads transcript_full.jsonl (complete log), not the compacted transcript.jsonl', () => {
    const logs = join(home, 'brain', '44444444-4444-4444-4444-444444444444', '.system_generated', 'logs');
    mkdirSync(logs, { recursive: true });
    // Compacted file: only the last write. Full file: both writes.
    writeFileSync(join(logs, 'transcript.jsonl'), JSON.stringify(
      { source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'b', created_at: '2026-07-08T00:00:02Z',
        tool_calls: [{ name: 'write_to_file', args: { TargetFile: '/p/second.ts', CodeContent: '2' } }] }));
    writeFileSync(join(logs, 'transcript_full.jsonl'), [
      { source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'a', created_at: '2026-07-08T00:00:01Z',
        tool_calls: [{ name: 'write_to_file', args: { TargetFile: '/p/first.ts', CodeContent: '1' } }] },
      { source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'b', created_at: '2026-07-08T00:00:02Z',
        tool_calls: [{ name: 'write_to_file', args: { TargetFile: '/p/second.ts', CodeContent: '2' } }] },
    ].map((o) => JSON.stringify(o)).join('\n'));
    const events = agyBackend.readEvents('44444444-4444-4444-4444-444444444444');
    const writes = events.filter((e) => e.kind === 'tool_use' && e.toolName === 'write_to_file');
    expect(writes.length).toBe(2); // both, from the full log — not the 1 in the compacted file
  });

  test('multi_replace_file_content produces a before/after delta from its chunks', () => {
    const delta = agyBackend.extractEditDelta('multi_replace_file_content', {
      TargetFile: '/x/a.ts',
      ReplacementChunks: [
        { TargetContent: 'old line', ReplacementContent: 'new line' },
        { TargetContent: 'foo', ReplacementContent: 'bar' },
      ],
    });
    expect(delta).toEqual({ before: 'old line\nfoo', after: 'new line\nbar' });
  });
});
