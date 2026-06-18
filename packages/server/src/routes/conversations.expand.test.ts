/**
 * Session-id prefix resolution (expandSessionId) — the fix that lets
 * recall_summary/recall_context/recall_show accept a unique prefix instead of
 * the full id. Postgres-gated (the server is Postgres-only); skipped when
 * DATABASE_URL isn't set, exactly like the postgres suite in store.test.ts.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { expandSessionId } from './conversations.js';
import { createStore } from '../imports.js';
import type { MemoryItem } from '../imports.js';

const PG_URL = process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL;

const FULL = 'e3105b00-4529-4576-86ff-9fb9211adb00';
const SIBLING = 'e3aa1111-0000-0000-0000-000000000000';
const OPENCODE = 'opencode_ses_130643791';

function session(id: string): MemoryItem {
  return {
    id, sourceType: 'session', title: id, projectPath: '/x',
    contentPreview: id, filePath: `/x/${id}`, mtime: 1000,
    extra: { tool: id.startsWith('opencode') ? 'opencode' : 'claude' },
  };
}

(PG_URL ? describe : describe.skip)('expandSessionId — session id prefix resolution (postgres)', () => {
  const tenant = `expand_${process.pid}`;
  const origDbUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    process.env.DATABASE_URL = PG_URL;
    const store = await createStore({ backend: 'postgres', databaseUrl: PG_URL, tenant } as any);
    try {
      await store.clearSourceType('session');
      for (const id of [FULL, SIBLING, OPENCODE]) await store.setItem(session(id));
    } finally { await store.close(); }
  });
  afterAll(() => { process.env.DATABASE_URL = origDbUrl; });

  test('exact id is returned unchanged', async () => {
    expect(await expandSessionId(tenant, FULL)).toEqual({ resolved: FULL });
  });

  test('unique prefix expands to the full id', async () => {
    expect(await expandSessionId(tenant, FULL.slice(0, 8))).toEqual({ resolved: FULL });
    expect(await expandSessionId(tenant, OPENCODE.slice(0, 18))).toEqual({ resolved: OPENCODE });
  });

  test('ambiguous prefix returns the candidate list', async () => {
    const r = await expandSessionId(tenant, 'e3');
    expect(r && 'ambiguous' in r).toBe(true);
    if (r && 'ambiguous' in r) expect(r.ambiguous.sort()).toEqual([FULL, SIBLING].sort());
  });

  test('unknown prefix returns null', async () => {
    expect(await expandSessionId(tenant, 'zzzz-nope')).toBeNull();
  });
});
