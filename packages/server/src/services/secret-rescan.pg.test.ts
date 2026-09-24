/**
 * Server-side re-scan + the finding-ownership boundary it depends on.
 *
 * The re-scan exists to catch the one thing client-side detection structurally
 * cannot: a device whose redactor MISSED a secret, so the secret is now sitting
 * in the server's own store in cleartext with nothing to notice it.
 *
 * Two things have to hold, and both are easy to break later:
 *   - the re-scan only reports what the client did NOT already report (otherwise
 *     the Security view doubles every finding), and
 *   - its rows survive that same client's next sync. The client replaces its
 *     findings wholesale on every sync; if that delete also took server rows,
 *     the findings would vanish on the next tick from the very device whose old
 *     rules caused them.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MetadataCache } from '@chat-recall/engine/core/metadata-cache.js';
import { createStore, type StorageDriver } from '@chat-recall/engine/core/store/index.js';
import { SERVER_DETECTOR } from '@chat-recall/engine/core/secret-detectors.js';
import { rescanSession } from './secret-rescan.js';

const SESSION = 'sess-rescan-1';
// A key shape the builtin rules catch. This is a documented AWS example value,
// not a real credential.
const LEAKED = 'AKIAIOSFODNN7EXAMPLE';
const MASKED = '*'.repeat(LEAKED.length - 4) + LEAKED.slice(-4);

// Postgres is where this actually ships: the detector<>server DELETE scope and
// the insert-only path are separate SQL in pg.ts, so run the same suite against
// both backends whenever a DATABASE_URL is available (same policy as store.test.ts).
const PG_URL = process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL;

let tmp: string | null = null;
let store: StorageDriver;
let pgSeq = 0;

/** Store an envelope the way ingest does, i.e. this is what the server holds. */
async function storeEnvelope(text: string): Promise<void> {
  await store.setCachedContent(SESSION, 'session', 1000, JSON.stringify({
    messages: [{ role: 'user', content: text }],
  }));
}

for (const backend of ['sqlite', ...(PG_URL ? ['postgres'] as const : [])] as const) {
describe(`secret re-scan [${backend}]`, () => {

beforeEach(async () => {
  if (backend === 'sqlite') {
    tmp = mkdtempSync(join(tmpdir(), 'cr-rescan-'));
    const dbPath = join(tmp, 't.db');
    new MetadataCache(dbPath).close();   // session_metadata must exist for session rows
    store = await createStore({ sqlitePath: dbPath });
  } else {
    // Fresh tenant per test = isolation, same as the store suite.
    const tenant = `rescan_${++pgSeq}_${process.pid}`;
    store = await createStore({ backend: 'postgres', databaseUrl: PG_URL, tenant } as never);
  }
});

afterEach(async () => {
  await store.close();
  if (tmp) { rmSync(tmp, { recursive: true, force: true }); tmp = null; }
});

describe('rescanSession', () => {
  test('reports a secret that survived redaction, masked', async () => {
    // A client with older/broken rules shipped this text unredacted.
    await storeEnvelope(`here is the key ${LEAKED} use it`);

    const r = await rescanSession(store as never, SESSION);
    expect(r.missed).toBeGreaterThan(0);
    expect(r.written).toBe(r.missed);

    const rows = await store.secretFindingsForSession(SESSION);
    expect(rows.length).toBe(r.written);
    expect(rows[0].detector).toBe(SERVER_DETECTOR);
    // Never the raw value — same last-4 mask as every other detector.
    expect(rows[0].preview).toBe(MASKED);
    for (const row of rows) expect(row.preview).not.toContain('AKIAIOSFODNN');
  });

  test('properly redacted text produces nothing', async () => {
    await storeEnvelope('here is the key [REDACTED:aws-access-token] use it');
    expect(await rescanSession(store as never, SESSION)).toMatchObject({ missed: 0, written: 0 });
    expect(await store.secretFindingsForSession(SESSION)).toEqual([]);
  });

  test('a secret the client already reported is not re-reported', async () => {
    await storeEnvelope(`here is the key ${LEAKED} use it`);
    // Client saw it pre-redaction and shipped a finding for it.
    await store.replaceSecretFindings(SESSION, [{
      detector: 'builtin', rule: 'aws-access-token', line: 1, preview: MASKED,
    }]);

    expect(await rescanSession(store as never, SESSION)).toMatchObject({ missed: 0, written: 0 });
    const rows = await store.secretFindingsForSession(SESSION);
    expect(rows).toHaveLength(1);
    expect(rows[0].detector).toBe('builtin'); // no duplicate server row
  });

  test('is idempotent — a second pass writes nothing new', async () => {
    await storeEnvelope(`here is the key ${LEAKED} use it`);
    const first = await rescanSession(store as never, SESSION);
    const before = (await store.secretFindingsForSession(SESSION)).length;

    const second = await rescanSession(store as never, SESSION);
    expect(first.written).toBeGreaterThan(0);
    expect(second.written).toBe(0);
    expect((await store.secretFindingsForSession(SESSION)).length).toBe(before);
  });

  test('no stored envelope ⇒ no-op (nothing to scan)', async () => {
    expect(await rescanSession(store as never, 'never-synced')).toMatchObject({ missed: 0, written: 0 });
  });
});

describe('finding ownership', () => {
  test("a client sync replaces its own findings but cannot delete the server's", async () => {
    await storeEnvelope(`here is the key ${LEAKED} use it`);
    await rescanSession(store as never, SESSION);
    const serverRows = (await store.secretFindingsForSession(SESSION))
      .filter((f) => f.detector === SERVER_DETECTOR);
    expect(serverRows.length).toBeGreaterThan(0);

    // The same old client syncs again, reporting only its own (different) finding.
    await store.replaceSecretFindings(SESSION, [
      { detector: 'builtin', rule: 'github-pat', line: 3, preview: '****abcd' },
    ]);

    const after = await store.secretFindingsForSession(SESSION);
    expect(after.filter((f) => f.detector === SERVER_DETECTOR).length).toBe(serverRows.length);
    expect(after.filter((f) => f.detector === 'builtin').map((f) => f.rule)).toEqual(['github-pat']);
  });

  test('a client sync DOES drop its own stale findings', async () => {
    await store.replaceSecretFindings(SESSION, [
      { detector: 'builtin', rule: 'stale-rule', line: 1, preview: '****0000' },
    ]);
    await store.replaceSecretFindings(SESSION, [
      { detector: 'builtin', rule: 'fresh-rule', line: 1, preview: '****1111' },
    ]);
    const rules = (await store.secretFindingsForSession(SESSION)).map((f) => f.rule);
    expect(rules).toEqual(['fresh-rule']);
  });

  test('addSecretFindings never removes anything and dedupes on re-insert', async () => {
    const f = { detector: SERVER_DETECTOR, rule: 'aws-access-token', line: 1, preview: '****MPLE' };
    expect((await store.addSecretFindings(SESSION, [f])).written).toBe(1);
    expect((await store.addSecretFindings(SESSION, [f])).written).toBe(0); // unique index
    expect(await store.secretFindingsForSession(SESSION)).toHaveLength(1);
  });
});

});
}
