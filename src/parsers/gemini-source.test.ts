import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GeminiSessionSource } from './gemini-source.js';

let tmpHome: string;
const origHome = process.env.HOME;
beforeEach(() => { tmpHome = mkdtempSync(join(tmpdir(), 'gem-')); process.env.HOME = tmpHome; });
afterEach(() => { process.env.HOME = origHome; rmSync(tmpHome, { recursive: true, force: true }); });

function writeGeminiSession(projHash: string, sid: string, content: object) {
  const dir = join(tmpHome, '.gemini', 'tmp', projHash, 'chats');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `session-${sid}.json`), JSON.stringify(content));
}

async function collect(): Promise<any[]> {
  const src = new GeminiSessionSource();
  const out: any[] = [];
  for await (const i of src.discover()) out.push(i);
  return out;
}

describe('GeminiSessionSource', () => {
  test('discovers a session with messages', async () => {
    writeGeminiSession('hash1', 'abc', {
      sessionId: 'abc',
      messages: [
        { type: 'user', content: 'help me' },
        { type: 'gemini', content: 'sure', toolCalls: [], tokens: { input: 10, output: 5 } },
      ],
      startTime: '2026-05-01T00:00:00Z',
      lastUpdated: '2026-05-01T00:01:00Z',
    });
    const items = await collect();
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0].extra.tool).toBe('gemini');
  });

  test('skips summary-generator artifact sessions', async () => {
    writeGeminiSession('hash2', 'sumg', {
      sessionId: 'sumg',
      messages: [
        { type: 'user', content: 'You are summarizing a coding assistant conversation. Output JSON.' },
        { type: 'gemini', content: 'sure' },
      ],
    });
    const items = await collect();
    expect(items.find(i => i.id.includes('sumg'))).toBeUndefined();
  });

  test('skips sessions with fewer than 2 messages', async () => {
    writeGeminiSession('hash3', 'xx', {
      sessionId: 'xx',
      messages: [{ type: 'user', content: 'one' }],
    });
    const items = await collect();
    expect(items.find(i => i.id.includes('xx'))).toBeUndefined();
  });

  test('returns empty when ~/.gemini/tmp doesn\'t exist', async () => {
    expect(await collect()).toEqual([]);
  });
});
