/**
 * Paging a conversation must advance by SERVER rows, not by the length of the
 * client's array.
 *
 * `getConversationPage` drops command-noise rows after the fetch. A caller that
 * pages by `messages.length` therefore asks for an offset the server already
 * served, and those messages arrive a second time. `nextOffset` exists to make
 * that impossible.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getConversationPage, loadRestOfConversation, MAX_CONVERSATION_PAGES } from './api';

/** One `user` row that the client strips: a command envelope with no prose. */
const noiseRow = (line: number) => ({
  role: 'user',
  line,
  content: '<command-name>/clear</command-name>',
});

const realRow = (line: number, role = 'assistant') => ({ role, line, content: `msg ${line}` });

/** Record every offset the code under test requests. */
function stubServer(pages: Array<{ messages: any[]; total: number; hasMore: boolean }>) {
  const asked: number[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    const offset = Number(new URL(url, 'http://localhost').searchParams.get('offset'));
    asked.push(offset);
    const page = pages.shift() ?? { messages: [], total: 0, hasMore: false };
    return {
      ok: true,
      statusText: 'OK',
      json: async () => ({ ...page, offset, subagents: [] }),
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return { asked };
}

describe('conversation paging offsets', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('reports nextOffset from the rows the SERVER returned, not the filtered array', async () => {
    stubServer([{
      // 5 rows out of the server, 2 of which the client strips.
      messages: [realRow(1), noiseRow(2), realRow(3), noiseRow(4), realRow(5)],
      total: 100,
      hasMore: true,
    }]);

    const page = await getConversationPage('sess', 0);

    expect(page.messages).toHaveLength(3);   // what the user sees
    expect(page.nextOffset).toBe(5);         // what the server has served
    expect(page.nextOffset).not.toBe(page.messages.length);
  });

  it('never re-requests an offset the server already served', async () => {
    const { asked } = stubServer([
      { messages: [realRow(1), noiseRow(2), realRow(3)], total: 6, hasMore: true },
      { messages: [realRow(4), realRow(5), noiseRow(6)], total: 6, hasMore: false },
    ]);

    const seen: any[] = [];
    const r = await loadRestOfConversation('sess', 0, (p) => seen.push(...p.messages));

    expect(asked).toEqual([0, 3]);           // 3 = rows served, not 2 = rows kept
    expect(r.hasMore).toBe(false);
    expect(seen.map((m) => m.line)).toEqual([1, 3, 4, 5]);   // no duplicates
  });

  it('stops instead of spinning when a page comes back empty', async () => {
    // hasMore stays true but the server yields nothing — a walk that trusted
    // hasMore alone would request the same offset for ever.
    const { asked } = stubServer([
      { messages: [realRow(1)], total: 99, hasMore: true },
      { messages: [], total: 99, hasMore: true },
    ]);

    const r = await loadRestOfConversation('sess', 0, () => {});

    expect(asked).toEqual([0, 1]);
    expect(r.hasMore).toBe(false);
    expect(r.pagesLoaded).toBe(2);
  });

  it('stops at the page bound and keeps hasMore true so the caller can resume', async () => {
    const pages = Array.from({ length: MAX_CONVERSATION_PAGES + 5 }, (_, i) => ({
      messages: [realRow(i + 1)],
      total: 10_000,
      hasMore: true,
    }));
    stubServer(pages);

    const r = await loadRestOfConversation('sess', 0, () => {});

    expect(r.pagesLoaded).toBe(MAX_CONVERSATION_PAGES);
    expect(r.hasMore).toBe(true);
    expect(r.nextOffset).toBe(MAX_CONVERSATION_PAGES);
  });
});
