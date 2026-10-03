/**
 * The streamed archive is the same container the inline path sends, so the
 * server and every reader treat both alike.
 */
import { describe, test, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { writeArchiveFile } from './raw-archive-parts.js';
import { redactSecrets } from '@chat-recall/engine/core/secret-redactor.js';
import { redactContainer } from '@chat-recall/engine/transcript/index.js';

const SECRET = 'AKIAIOSFODNN7EXAMPLE';
// SYNTHETIC values, shape-valid only.
const KEY = 'sk-AbCdEfGh1234567890IjKlMnOp';
const ENV_VALUE = 'dbpass0example0value';
const redact = (t: string) => redactSecrets(t, { force: true, count: { redactions: 0 } });
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function texts() {
  const main = [
    JSON.stringify({ type: 'user', message: { content: `the key is ${SECRET}` } }),
    JSON.stringify({ type: 'assistant', message: { content: 'ünïcödé — "quotes" \\ and a\ttab' } }),
    JSON.stringify({ type: 'mode', mode: 'normal' }),
    // Secrets that plain redaction of the raw line misses (raw-redact.test.ts):
    // an env value in escaped quotes, and a key at the start of a line in a string.
    JSON.stringify({ type: 'user', message: { content: `run it with export API_KEY="${ENV_VALUE}" set` } }),
    JSON.stringify({ content: `the key is\n${KEY}\nkeep it safe` }),
  ].join('\n') + '\n';
  const sub = JSON.stringify({ type: 'user', message: { content: 'no newline at the end' } });
  return [{ name: 's.jsonl', text: main }, { name: 'subagents/a.jsonl', text: sub }, { name: 'meta.json', text: `{"token":"${SECRET}"}` }];
}

const inline = (files: Array<{ name: string; text: string }>) =>
  redactContainer({ v: 1, tool: 'claude', mtime: 1234, files }, redact);

describe('writeArchiveFile', () => {
  test('from memory: the same container the inline path builds, with the secret redacted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cr-parts-')); dirs.push(dir);
    const files = texts();
    const out = await writeArchiveFile({ kind: 'memory', files }, { tool: 'claude', mtime: 1234.9 }, redact, dir);
    const json = gunzipSync(readFileSync(out.path)).toString('utf-8');
    expect(JSON.parse(json)).toEqual(inline(files));
    expect(out.size).toBe(Buffer.byteLength(json));
    for (const v of [SECRET, KEY, ENV_VALUE]) expect(json).not.toContain(v);
  });

  test('from disk: the same container, read line by line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cr-parts-')); dirs.push(dir);
    const files = texts();
    const paths = files.map((f, i) => { const p = join(dir, `f${i}`); writeFileSync(p, f.text); return { name: f.name, path: p }; });
    const out = await writeArchiveFile({ kind: 'disk', files: paths }, { tool: 'claude', mtime: 1234 }, redact, dir);
    expect(JSON.parse(gunzipSync(readFileSync(out.path)).toString('utf-8'))).toEqual(inline(files));
  });

  test('a line longer than a read chunk stays one line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cr-parts-')); dirs.push(dir);
    const long = JSON.stringify({ type: 'file-history-snapshot', blob: 'x'.repeat(3 * 1024 * 1024) }) + '\n';
    const p = join(dir, 'big'); writeFileSync(p, long + '{"b":2}\n');
    const out = await writeArchiveFile({ kind: 'disk', files: [{ name: 'big.jsonl', path: p }] }, { tool: 'claude', mtime: 1 }, redact, dir);
    const c = JSON.parse(gunzipSync(readFileSync(out.path)).toString('utf-8'));
    expect(c.files[0].text).toBe(long + '{"b":2}\n');
  });
});
