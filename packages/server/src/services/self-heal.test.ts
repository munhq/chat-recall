/**
 * Self-heal unit test: a session whose raw archive is FULL but whose rendered
 * view (content_cache envelope + FTS chunks) was truncated must heal back to
 * the full message count from its own archive — and a healthy session must be
 * left untouched (heal only ever grows).
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
let prevDataDir: string | undefined;

beforeAll(() => {
  prevDataDir = process.env.CHAT_RECALL_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'cr-selfheal-'));
  process.env.CHAT_RECALL_DATA_DIR = dataDir;
});
afterAll(() => {
  if (prevDataDir === undefined) delete process.env.CHAT_RECALL_DATA_DIR;
  else process.env.CHAT_RECALL_DATA_DIR = prevDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

// A claude JSONL transcript of N user/assistant messages.
function jsonl(n: number): string {
  return Array.from({ length: n }, (_, i) =>
    JSON.stringify({ type: i % 2 ? 'assistant' : 'user', uuid: `u${i}`, parentUuid: i ? `u${i - 1}` : null, message: { role: i % 2 ? 'assistant' : 'user', content: `message ${i} zorptext` } }),
  ).join('\n') + '\n';
}

describe('healSessionFromArchive', () => {
  test('rebuilds a truncated view from the full raw archive; leaves a healthy one alone', async () => {
    const { createStore, buildRawContainer, gzipContainer, parseTranscriptFromContainer, TRANSCRIPT_VERSION } = await import('../imports.js');
    const { healSessionFromArchive } = await import('./self-heal.js');

    const store = await createStore();
    const id = 'heal-0001';
    const mtime = 1760000000000;

    // Full archive. The exact parsed count is whatever the canonical parser
    // yields from these bytes — assert against THAT, not a guess.
    const container = buildRawContainer({ tool: 'claude', mtime, files: [{ name: `${id}.jsonl`, bytes: Buffer.from(jsonl(40), 'utf-8') }] });
    const expectedFull = parseTranscriptFromContainer(container).messages.length;
    expect(expectedFull).toBeGreaterThan(3); // sanity: archive is fuller than the damaged stub
    const { gz, size } = gzipContainer(container);
    await store.putRawSession(id, 'claude', mtime, gz, size);

    // Metadata row (head-derived; survives truncation).
    await store.setItem({
      id, sourceType: 'session', title: 'message 0 zorptext', projectPath: '/tmp/heal',
      projectId: 'ws:heal', contentPreview: 'message 0', filePath: '', mtime,
      extra: { tool: 'claude', synced: true },
    } as Parameters<typeof store.setItem>[0]);

    // DAMAGED view: envelope with only 3 messages (a resume-truncated sync).
    await store.setCachedContent(id, 'session', mtime, JSON.stringify({
      v: TRANSCRIPT_VERSION, messages: Array.from({ length: 3 }, (_, i) => ({ line: i + 1, role: 'user', content: `stub ${i}` })), subagents: [], o: 0,
    }));

    // Heal it.
    const r = await healSessionFromArchive(store, id);
    expect(r.healed).toBe(true);
    expect(r.from).toBe(3);
    expect(r.to).toBe(expectedFull);

    // Envelope now full.
    const healed = JSON.parse((await store.getCachedContentStale(id, 'session'))!.content);
    expect(healed.messages).toHaveLength(expectedFull);

    // Search now finds it (chunks rebuilt).
    const hits = await store.searchFTS('zorptext', { topK: 5 });
    expect(hits.some((h) => h.itemId === id)).toBe(true);

    // Idempotent: a second heal is a no-op (already full, only-ever-grow).
    const again = await healSessionFromArchive(store, id);
    expect(again.healed).toBe(false);
    expect(again.reason).toBe('healthy');

    // No archive → nothing to heal (candidate for client recheck, not an error).
    const none = await healSessionFromArchive(store, 'does-not-exist');
    expect(none.healed).toBe(false);
    expect(none.reason).toBe('no-archive');

    await store.close();
  });

  test('dry-run detects damage but writes nothing', async () => {
    const { createStore, buildRawContainer, gzipContainer, parseTranscriptFromContainer, TRANSCRIPT_VERSION } = await import('../imports.js');
    const { healSessionFromArchive } = await import('./self-heal.js');
    const store = await createStore();
    const id = 'heal-dry-1';
    const mtime = 1760000100000;
    const container = buildRawContainer({ tool: 'claude', mtime, files: [{ name: `${id}.jsonl`, bytes: Buffer.from(jsonl(30), 'utf-8') }] });
    const full = parseTranscriptFromContainer(container).messages.length;
    const { gz, size } = gzipContainer(container);
    await store.putRawSession(id, 'claude', mtime, gz, size);
    await store.setCachedContent(id, 'session', mtime, JSON.stringify({ v: TRANSCRIPT_VERSION, messages: [{ line: 1, role: 'user', content: 'stub' }], subagents: [], o: 0 }));

    const dry = await healSessionFromArchive(store, id, { dryRun: true });
    expect(dry.damaged).toBe(true);
    expect(dry.healed).toBe(false);
    expect(dry.to).toBe(full);
    // Envelope untouched by the dry run.
    expect(JSON.parse((await store.getCachedContentStale(id, 'session'))!.content).messages).toHaveLength(1);
    await store.close();
  });

  test('recreates a hard-deleted metadata row from the archive, with grouping from raw_sessions', async () => {
    const { createStore, buildRawContainer, gzipContainer } = await import('../imports.js');
    const { healSessionFromArchive } = await import('./self-heal.js');
    const store = await createStore();
    const id = 'heal-regroup-1';
    const mtime = 1760000300000;
    const container = buildRawContainer({ tool: 'claude', mtime, files: [{ name: `${id}.jsonl`, bytes: Buffer.from(jsonl(20), 'utf-8') }] });
    const { gz, size } = gzipContainer(container);
    // Archive carries the project identity; NO metadata/chunks/envelope exist
    // (simulates a hard-deleted item whose raw archive survived — the incident).
    await store.putRawSession(id, 'claude', mtime, gz, size, 'git:github.com/o/repo', '/home/u/repo');
    expect(await store.getItem(id, 'session')).toBeNull();

    const r = await healSessionFromArchive(store, id);
    expect(r.healed).toBe(true);

    // Metadata row is back — grouped from the archive's own stored project id,
    // no client, no manual patch.
    const item = await store.getItem(id, 'session');
    expect(item).not.toBeNull();
    expect(item!.project_id).toBe('git:github.com/o/repo');
    // And searchable again (chunks rebuilt).
    const hits = await store.searchFTS('zorptext', { topK: 5 });
    expect(hits.some((h) => h.itemId === id)).toBe(true);
    await store.close();
  });

  test('recheck: a session with an envelope but no archive is enqueued for client recheck', async () => {
    const { createStore, TRANSCRIPT_VERSION } = await import('../imports.js');
    const { selfHealTenant } = await import('./self-heal.js');
    const store = await createStore();
    const id = 'recheck-1';
    const mtime = 1760000200000;
    // Envelope present, NO raw archive → server can't self-heal → client recheck.
    await store.setItem({ id, sourceType: 'session', title: 't', projectPath: '/tmp/r', contentPreview: 'c', filePath: '', mtime, extra: { tool: 'claude' } } as Parameters<typeof store.setItem>[0]);
    await store.setCachedContent(id, 'session', mtime, JSON.stringify({ v: TRANSCRIPT_VERSION, messages: [{ line: 1, role: 'user', content: 'thin' }], subagents: [], o: 0 }));

    const r = await selfHealTenant(store, { sinceMs: 0, dryRun: false });
    expect(r.recheckEnqueued).toBeGreaterThanOrEqual(1);
    const pending = await store.listPendingSyncIntents(undefined, 100);
    expect(pending.some((p) => p.kind === 'recheck_session' && p.name === id)).toBe(true);

    // Idempotent: a second sweep doesn't double-enqueue (dedup vs pending).
    const r2 = await selfHealTenant(store, { sinceMs: 0, dryRun: false });
    expect(r2.recheckEnqueued).toBe(0);
    await store.close();
  });

  // The HTTP route has a gateway deadline; the background sweep does not. An
  // unbounded pass costs ~150ms per session, so the route's own default —
  // "scan everything" — took 125s on a real tenant and returned 524 every
  // time. `limit` is what makes the route answerable, and `truncated` is what
  // stops a capped answer reading as "your whole history is healthy".
  test('limit caps the pass, reports what it skipped, and takes the freshest first', async () => {
    const { createStore } = await import('../imports.js');
    const { selfHealTenant } = await import('./self-heal.js');
    const { gzipSync } = await import('zlib');
    const store = await createStore();

    const base = 1760000300000;
    for (let i = 0; i < 5; i++) {
      const body = JSON.stringify({ type: 'user', message: { role: 'user', content: `body ${i}` } });
      const gz = gzipSync(Buffer.from(body + '\n'));
      await store.putRawSession(`cap-${i}`, 'claude', base + i * 1000, gz, gz.length, 'git:github.com/o/repo', '/home/u/repo');
    }

    const capped = await selfHealTenant(store, { sinceMs: 0, dryRun: true, limit: 2 });
    expect(capped.scanned).toBe(2);
    expect(capped.eligible).toBeGreaterThanOrEqual(5);
    expect(capped.truncated).toBe(true);

    // No limit: everything, and it must not claim truncation.
    const full = await selfHealTenant(store, { sinceMs: 0, dryRun: true });
    expect(full.scanned).toBe(full.eligible);
    expect(full.truncated).toBe(false);
    expect(full.scanned).toBeGreaterThan(capped.scanned);
    await store.close();
  });
});
