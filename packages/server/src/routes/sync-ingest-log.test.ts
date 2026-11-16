/**
 * The batch line of the sync route (issue #27): it names what a request that
 * kills its pod was working on.
 */
import { describe, test, expect } from 'vitest';
import { summariseIngestBatch } from './ingest-log.js';

const usage = (rss: number, heap: number, ext: number, ab: number): NodeJS.MemoryUsage =>
  ({ rss, heapTotal: heap, heapUsed: heap, external: ext, arrayBuffers: ab });
const MB = 1048576;

describe('summariseIngestBatch', () => {
  test('counts appends and full conversations', () => {
    const s = summariseIngestBatch({
      tenant: 'acme', bodyBytes: 1234,
      conversations: [
        { session_id: 'a', append: true, envelope: { messages: [1, 2, 3] } },
        { session_id: 'b', append: true, envelope: { messages: [] } },
        { session_id: 'c', raw_size: 5 * MB },
      ],
    }, usage(300 * MB, 100 * MB, 20 * MB, 5 * MB));
    expect(s).toMatchObject({ tenant: 'acme', bodyBytes: 1234, conversations: 3, appends: 2, fulls: 1 });
  });

  test('lists the largest sessions first, at most five', () => {
    const conversations = Array.from({ length: 8 }, (_, i) => ({ session_id: `s-${i}`, raw_size: (i + 1) * MB }));
    const s = summariseIngestBatch({ tenant: 'acme', bodyBytes: 0, conversations }, usage(0, 0, 0, 0));
    expect(s.largest.map((r) => r.session)).toEqual(['s-7', 's-6', 's-5', 's-4', 's-3']);
    expect(s.largest[0]).toMatchObject({ mode: 'full', rawBytes: 8 * MB });
  });

  test('sizes a conversation from its base64 body when raw_size is missing', () => {
    const s = summariseIngestBatch({ tenant: 'acme', bodyBytes: 0, conversations: [{ session_id: 'a', raw_b64: 'A'.repeat(4000) }] }, usage(0, 0, 0, 0));
    expect(s.largest[0].rawBytes).toBe(3000);
  });

  test('reports the memory of the process in MiB', () => {
    const s = summariseIngestBatch({ tenant: 'acme', bodyBytes: 0, conversations: [] }, usage(263 * MB, 120 * MB, 30 * MB, 8 * MB));
    expect(s.memory).toEqual({ rssMb: 263, heapUsedMb: 120, externalMb: 30, arrayBuffersMb: 8 });
  });

  test('an empty batch has no largest session', () => {
    const s = summariseIngestBatch({ tenant: 'acme', bodyBytes: 0, conversations: [] }, usage(0, 0, 0, 0));
    expect(s).toMatchObject({ conversations: 0, appends: 0, fulls: 0, largest: [] });
  });
});
