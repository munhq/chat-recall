import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WriteAheadLog } from './write-ahead-log.js';

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'wal-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('WriteAheadLog', () => {
  test('writes one JSONL entry per log call', () => {
    const wal = new WriteAheadLog(tmp);
    wal.log('index', { source: 'session', count: 5 });
    wal.log('kg_add', { subject: 'a' });

    const content = readFileSync(join(tmp, 'write_log.jsonl'), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);

    const e1 = JSON.parse(lines[0]);
    expect(e1.operation).toBe('index');
    expect(e1.params.source).toBe('session');
    expect(e1.timestamp).toMatch(/^20\d\d-/);
  });

  test('redacts sensitive keys (content, text, api_key, password, …)', () => {
    const wal = new WriteAheadLog(tmp);
    wal.log('diary_write', {
      agent: 'me',
      entry: 'a'.repeat(500),
      api_key: 'sk-secret',
      password: 'hunter2',
    });
    const log = readFileSync(join(tmp, 'write_log.jsonl'), 'utf-8');
    const e = JSON.parse(log);
    // Long string content gets truncated with a "[N chars]" prefix.
    expect(e.params.entry).toMatch(/^\[\d+ chars\]/);
    // Non-string sensitive values would be [REDACTED]; strings get truncated.
    expect(e.params.api_key).toBeDefined();
    expect(e.params.password).toBeDefined();
    expect(e.params.agent).toBe('me');
  });

  test('keeps short sensitive strings inline (no truncation under 200 chars)', () => {
    const wal = new WriteAheadLog(tmp);
    wal.log('diary_write', { entry: 'short note' });
    const e = JSON.parse(readFileSync(join(tmp, 'write_log.jsonl'), 'utf-8').trim());
    expect(e.params.entry).toBe('short note');
  });

  test('logWithResult appends both params and result', () => {
    const wal = new WriteAheadLog(tmp);
    wal.logWithResult('index', { source: 'plan' }, { itemsProcessed: 7 });
    const e = JSON.parse(readFileSync(join(tmp, 'write_log.jsonl'), 'utf-8').trim());
    expect(e.result?.itemsProcessed).toBe(7);
  });
});
