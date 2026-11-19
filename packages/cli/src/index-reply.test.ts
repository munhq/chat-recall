/**
 * `recall_index` answers inside the 60 s request limit of an MCP client, and one
 * index child serves every call.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { answerWithin, sharedRun, INDEX_REPLY_MS } from './index-reply.js';

afterEach(() => { vi.useRealTimers(); });

describe('INDEX_REPLY_MS', () => {
  it('is below the 60 s a client waits', () => {
    expect(INDEX_REPLY_MS).toBeLessThan(60_000);
  });
});

describe('answerWithin', () => {
  it('returns the result of work that ends in time', async () => {
    vi.useFakeTimers();
    const answer = answerWithin(new Promise<string>((resolve) => setTimeout(() => resolve('indexed'), 1_000)), 45_000, 'running');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await answer).toBe('indexed');
  });

  it('returns the fallback when work is still running at the limit, and work goes on', async () => {
    vi.useFakeTimers();
    let ended = false;
    const work = new Promise<string>((resolve) => setTimeout(() => { ended = true; resolve('indexed'); }, 120_000));
    const answer = answerWithin(work, 45_000, 'running');
    await vi.advanceTimersByTimeAsync(45_000);
    expect(await answer).toBe('running');
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(75_000);
    expect(ended).toBe(true);
  });

  it('passes a failure of work on and leaves no timer behind', async () => {
    vi.useFakeTimers();
    const answer = answerWithin(Promise.reject(new Error('child failed')), 45_000, 'running');
    await expect(answer).rejects.toThrow('child failed');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('sharedRun', () => {
  it('starts one run for the calls that arrive while it goes', async () => {
    let starts = 0;
    let finish: (v: string) => void = () => {};
    const run = sharedRun((force: boolean) => {
      starts += 1;
      return new Promise<string>((resolve) => { finish = (v) => resolve(`${v}:${force}`); });
    });
    const first = run(false);
    const second = run(true);
    expect(starts).toBe(1);
    finish('done');
    expect(await first).toBe('done:false');
    expect(await second).toBe('done:false');
  });

  it('starts a new run after the first one ended', async () => {
    let starts = 0;
    const run = sharedRun(async (_: boolean) => { starts += 1; return 'ok'; });
    await run(false);
    await run(false);
    expect(starts).toBe(2);
  });

  it('starts a new run after a failed one', async () => {
    let starts = 0;
    const run = sharedRun(async (_: boolean) => { starts += 1; if (starts === 1) throw new Error('boom'); return 'ok'; });
    await expect(run(false)).rejects.toThrow('boom');
    expect(await run(false)).toBe('ok');
  });
});
