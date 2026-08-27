/**
 * The resume-guard must not re-read a file that has not moved.
 *
 * It polls once a minute per active session. On this developer's machine 15,455
 * of 23,156 snapshots — 67% — concluded 'unchanged', and every one of them had
 * already read the whole live transcript, gunzipped and JSON.parsed the whole
 * shadow, rebuilt the container and hashed every byte to find that out. The
 * srcHash fast path exists, but it sits after all of that work.
 *
 * mtime+size answers the same question with a stat. What must NOT happen is a
 * skip that loses data: this guard exists so a resume cannot truncate history,
 * so it may only skip when it already holds a shadow for an untouched file.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useHomeDir } from '../test-support/home-env.js';

let dir: string;
let home: string;
const saved: Record<string, string | undefined> = {};

const SID = '11111111-2222-3333-4444-555555555555';

async function mod() {
  const m = await import('./shadow.js');
  m._resetShadowFingerprintsForTests();
  return m;
}

function writeSession(lines: string[]) {
  const projDir = join(home, '.claude', 'projects', '-tmp-proj');
  mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, `${SID}.jsonl`), lines.join('\n') + '\n');
  return join(projDir, `${SID}.jsonl`);
}

beforeEach(() => {
  for (const k of ['HOME', 'CHAT_RECALL_DATA_DIR', 'CHAT_RECALL_CLAUDE_HOME']) saved[k] = process.env[k];
  dir = mkdtempSync(join(tmpdir(), 'cr-shadow-skip-'));
  home = dir;
  useHomeDir(home);
  process.env.CHAT_RECALL_DATA_DIR = join(dir, '.chat-recall');
  process.env.CHAT_RECALL_CLAUDE_HOME = join(home, '.claude');
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('snapshotShadow skip', () => {
  test('the FIRST snapshot always does the work, whatever the mtime', async () => {
    writeSession(['{"type":"user","uuid":"a"}']);
    const { snapshotShadow } = await mod();
    const r = await snapshotShadow(SID);
    expect(r.status).not.toBe('skipped');
  });

  test('an untouched file is skipped on the next call', async () => {
    writeSession(['{"type":"user","uuid":"a"}']);
    const { snapshotShadow } = await mod();
    await snapshotShadow(SID);
    const again = await snapshotShadow(SID);
    expect(again.status).toBe('skipped');
    expect(again.container).toBeNull();      // nothing was read, so nothing to hand back
  });

  test('a file that GROWS is never skipped — the whole point of the guard', async () => {
    const path = writeSession(['{"type":"user","uuid":"a"}']);
    const { snapshotShadow } = await mod();
    await snapshotShadow(SID);
    appendFileSync(path, '{"type":"user","uuid":"b"}\n');
    const r = await snapshotShadow(SID);
    expect(r.status).not.toBe('skipped');
  });

  test('a file that SHRINKS is never skipped — this is the truncation case', async () => {
    // A resume rewriting the transcript shorter is exactly what the shadow
    // exists to survive. Size is part of the fingerprint for this reason.
    const path = writeSession(['{"type":"user","uuid":"a"}', '{"type":"user","uuid":"b"}']);
    const { snapshotShadow } = await mod();
    await snapshotShadow(SID);
    writeFileSync(path, '{"type":"user","uuid":"a"}\n');
    const r = await snapshotShadow(SID);
    expect(r.status).not.toBe('skipped');
  });

  test('force overrides the skip', async () => {
    writeSession(['{"type":"user","uuid":"a"}']);
    const { snapshotShadow } = await mod();
    await snapshotShadow(SID);
    const r = await snapshotShadow(SID, { force: true });
    expect(r.status).not.toBe('skipped');
  });

  test('a session with no live file is not remembered as clean', async () => {
    // Otherwise a transient read failure would latch 'skipped' forever.
    const { snapshotShadow } = await mod();
    const first = await snapshotShadow(SID);
    expect(first.status).not.toBe('skipped');
    const second = await snapshotShadow(SID);
    expect(second.status).not.toBe('skipped');
  });
});
