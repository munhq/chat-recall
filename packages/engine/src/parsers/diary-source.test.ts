import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DiarySource } from './diary-source.js';
import { homeEnvSnapshot, restoreHomeEnv, useHomeDir } from '../test-support/home-env.js';

let tmpHome: string;
const origHome = homeEnvSnapshot();
beforeEach(() => { tmpHome = mkdtempSync(join(tmpdir(), 'diary-')); useHomeDir(tmpHome); });
afterEach(() => { restoreHomeEnv(origHome); rmSync(tmpHome, { recursive: true, force: true }); });

describe('DiarySource', () => {
  test.skip('discovers diary entries under ~/.claude/chat-recall-index/diary/<agent>/', async () => {
    const dir = join(tmpHome, '.claude', 'chat-recall-index', 'diary', 'agent-x');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'entry1.json'), JSON.stringify({
      agent_name: 'agent-x',
      entry: 'Discovered the off-by-one in the auth code',
      topic: 'auth',
      timestamp: '2026-05-01T00:00:00Z',
      session_id: 'sess1',
      project_path: '/proj',
    }));
    const src = new DiarySource();
    const items: any[] = [];
    for await (const i of src.discover()) items.push(i);
    expect(items.length).toBe(1);
    expect(items[0].title).toContain('agent-x');
  });

  test('returns nothing when diary root is missing', async () => {
    const src = new DiarySource();
    const out: any[] = [];
    for await (const i of src.discover()) out.push(i);
    expect(out).toEqual([]);
  });

  test.skip('skips malformed JSON entries', async () => {
    const dir = join(tmpHome, '.claude', 'chat-recall-index', 'diary', 'a');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bad.json'), '{ not json');
    writeFileSync(join(dir, 'good.json'), JSON.stringify({
      agent_name: 'a', entry: 'fine', timestamp: '2026-01-01T00:00:00Z',
    }));
    const src = new DiarySource();
    const items: any[] = [];
    for await (const i of src.discover()) items.push(i);
    expect(items).toHaveLength(1);
  });
});
