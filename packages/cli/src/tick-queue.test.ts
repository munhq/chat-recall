/**
 * The daemon's heavy background work must not overlap itself.
 *
 * Three independent in-flight booleans each stopped their own tick overlapping
 * ITSELF and knew nothing about the others, so a code-intelligence sweep could
 * run alongside a full sync walk and an intent drain. Measured with a sweep and
 * a walk overlapping: main thread 80–95%, RSS more than doubled.
 */
import { describe, test, expect } from 'vitest';
import { TickQueue, TICK_PRIORITY } from './tick-queue.js';

const tick = () => new Promise<void>((r) => setImmediate(r));

describe('serialisation', () => {
  test('only one task runs at a time, across DIFFERENT kinds', async () => {
    const q = new TickQueue();
    let concurrent = 0;
    let peak = 0;
    const work = async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await tick();
      concurrent--;
    };
    q.request('sync', TICK_PRIORITY.sync, work);
    q.request('codeIndex', TICK_PRIORITY.codeIndex, work);
    q.request('intents', TICK_PRIORITY.intents, work);
    await q.drain();
    // THE POINT. The old booleans allowed 3 here.
    expect(peak).toBe(1);
  });

  test('a task that throws does not wedge the queue', async () => {
    const errors: string[] = [];
    const q = new TickQueue({ onError: (kind) => errors.push(kind) });
    let ran = false;
    q.request('boom', 1, async () => { throw new Error('nope'); });
    q.request('after', 2, async () => { ran = true; });
    await q.drain();
    expect(errors).toEqual(['boom']);
    expect(ran).toBe(true);
  });
});

describe('coalescing', () => {
  test('a second request for a WAITING kind is dropped, not queued twice', async () => {
    const q = new TickQueue();
    let runs = 0;
    const blocker = q;
    // Occupy the queue so the next requests have to wait.
    q.request('blocker', 0, async () => { await tick(); await tick(); });
    q.request('sync', 10, async () => { runs++; });
    q.request('sync', 10, async () => { runs++; });
    q.request('sync', 10, async () => { runs++; });
    await blocker.drain();
    expect(runs).toBe(1);
  });

  // The behaviour the booleans got WRONG: a request arriving while its kind is
  // running was silently dropped, so a file change during a walk was lost until
  // the next timer. It must run once more instead.
  test('a request arriving while its kind is RUNNING triggers exactly one re-run', async () => {
    const q = new TickQueue();
    let runs = 0;
    const self = async () => {
      runs++;
      if (runs === 1) {
        q.request('sync', 10, self);   // state changed under us
        q.request('sync', 10, self);   // and again — still only one re-run
      }
      await tick();
    };
    q.request('sync', 10, self);
    await q.drain();
    expect(runs).toBe(2);
  });
});

describe('priority', () => {
  test('waiting tasks run in priority order, not arrival order', async () => {
    const q = new TickQueue();
    const order: string[] = [];
    q.request('blocker', -1, async () => { await tick(); await tick(); });
    q.request('codeIndex', TICK_PRIORITY.codeIndex, async () => { order.push('codeIndex'); });
    q.request('housekeeping', TICK_PRIORITY.housekeeping, async () => { order.push('housekeeping'); });
    q.request('sync', TICK_PRIORITY.sync, async () => { order.push('sync'); });
    await q.drain();
    // Shipping to the server outranks refreshing code intelligence, which is the
    // whole reason priority exists.
    expect(order).toEqual(['sync', 'codeIndex', 'housekeeping']);
  });

  test('equal priority keeps arrival order', async () => {
    const q = new TickQueue();
    const order: string[] = [];
    q.request('blocker', -1, async () => { await tick(); });
    q.request('a', 5, async () => { order.push('a'); });
    q.request('b', 5, async () => { order.push('b'); });
    await q.drain();
    expect(order).toEqual(['a', 'b']);
  });

  // A long sweep must finish rather than being abandoned when a sync falls due.
  test('a running task is never preempted', async () => {
    const q = new TickQueue();
    const order: string[] = [];
    q.request('codeIndex', TICK_PRIORITY.codeIndex, async () => {
      q.request('sync', TICK_PRIORITY.sync, async () => { order.push('sync'); });
      await tick(); await tick();
      order.push('codeIndex-finished');
    });
    await q.drain();
    expect(order).toEqual(['codeIndex-finished', 'sync']);
  });

  test('sync outranks intents outranks codeIndex outranks housekeeping', () => {
    expect(TICK_PRIORITY.sync).toBeLessThan(TICK_PRIORITY.intents);
    expect(TICK_PRIORITY.intents).toBeLessThan(TICK_PRIORITY.codeIndex);
    expect(TICK_PRIORITY.codeIndex).toBeLessThan(TICK_PRIORITY.housekeeping);
  });
});

describe('introspection', () => {
  test('active names the running kind and clears when idle', async () => {
    const q = new TickQueue();
    expect(q.active).toBeNull();
    let seen: string | null = null;
    q.request('sync', 1, async () => { seen = q.active; await tick(); });
    await q.drain();
    expect(seen).toBe('sync');
    expect(q.active).toBeNull();
    expect(q.depth).toBe(0);
  });
});
