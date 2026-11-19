/**
 * The longest `recall_index` waits for the index before it answers.
 *
 * An MCP client closes a request after 60 s. The call that waited for the whole
 * index failed with "The operation timed out." at 60.8 s, and the index went on
 * without a caller.
 */
export const INDEX_REPLY_MS = 45_000;

/** What the tool answers when the index is still running after INDEX_REPLY_MS. */
export const INDEX_RUNNING_REPLY =
  'The index is running in the background and finishes on its own. recall_status shows the session count, and the watch daemon keeps syncing meanwhile.';

/**
 * Answer with the result of `work` when it ends within `ms`, and with
 * `fallback` when it does not. `work` keeps running after the fallback.
 */
export function answerWithin<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * One shared run for every caller. A call that arrives while the run is going
 * joins it and its argument is ignored, so the process holds one index child
 * at a time.
 */
export function sharedRun<A, T>(start: (arg: A) => Promise<T>): (arg: A) => Promise<T> {
  let current: Promise<T> | undefined;
  return (arg) => {
    if (current === undefined) {
      current = start(arg).finally(() => { current = undefined; });
    }
    return current;
  };
}
