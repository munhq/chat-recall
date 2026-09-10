/**
 * One dashboard load must produce ONE `/api/status` request.
 *
 * Three components ask for it independently on a single load — App,
 * CommandEnter's panel and SyncCoverage — and the server answers each by
 * recounting the whole corpus (three aggregates over `memory_chunks`). Three
 * identical requests about 2s apart were visible in the production request log
 * for every page view.
 *
 * The failure mode this locks out is subtle: memoizing the RESOLVED VALUE would
 * still let all three fire, because on a cold load they all start before the
 * first response lands. The promise itself has to be shared.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getStatus } from './api';

/** A fetch stub whose response resolves only when the test says so. */
function deferredFetch() {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const fetchMock = vi.fn(async () => {
    await gate;
    return {
      ok: true,
      statusText: 'OK',
      json: async () => ({ totalChunks: 7, totalSessions: 3, projects: {} }),
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, release };
}

describe('getStatus request de-duplication', () => {
  // The memo lives at module scope (one page, one browser), so each test must
  // start outside the previous test's window or it inherits its answer. Only
  // `Date` is faked: faking timers wholesale would stall the real promises
  // these tests await.
  let clock = 1_700_000_000_000;
  beforeEach(() => {
    clock += 60_000;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(clock);
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('serves three concurrent callers from ONE request', async () => {
    const { fetchMock, release } = deferredFetch();

    // All three start before any response arrives — the real cold-load shape.
    const all = Promise.all([getStatus(), getStatus(), getStatus()]);
    release();
    const [a, b, c] = await all;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a.totalChunks).toBe(7);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('does not serve a failure to later callers', async () => {
    // A cached rejection would fail every component on the page for the whole
    // window, turning one blip into a broken dashboard.
    vi.stubGlobal('fetch', vi.fn(async () => {
      return { ok: false, statusText: 'Bad Gateway' } as unknown as Response;
    }));
    await expect(getStatus()).rejects.toThrow(/Bad Gateway/);

    const ok = vi.fn(async () => ({
      ok: true,
      statusText: 'OK',
      json: async () => ({ totalChunks: 1, totalSessions: 1, projects: {} }),
    } as unknown as Response));
    vi.stubGlobal('fetch', ok);

    // The immediately-following caller must issue a fresh request.
    await expect(getStatus()).resolves.toMatchObject({ totalChunks: 1 });
    expect(ok).toHaveBeenCalledTimes(1);
  });
});
