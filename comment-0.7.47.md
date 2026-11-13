## The memory of the collector is bounded — 0.7.46 and 0.7.47 are live

I measured the fault 2 again after the walk bound of 0.7.44. The walk is small. The memory is not.

### The measurement

The unit report of 14:57:24 came during a `memory.current` of 1.66 GB:
`heapUsed 50 MB · heapTotal 65 MB · rss 537 MB · maxRss 1628 MB · fs_event 6253`.

Two facts follow.

1. The main isolate holds 50 MB of heap. The 1.6 GB sits outside the JS heap.
2. The scan pool is the only other isolate in the cgroup. Its worker had a heap
   ceiling of 768 MB.

The cgroup held about 1.5 GiB of file pages: the transcripts that the collector
reads, and the inotify events that the watcher records.

### The fix

Landing `ea7c7a4d` (0.7.46) and `2dc84061` (0.7.47):

- `packages/cli/src/memory-guard.ts` adds `DEFAULT_RECLAIM_FILE_MB = 128` and
  `shouldReclaim(fileMb, limitMb)`. The decision is a pure function, so a test
  covers it without a cgroup.
- `packages/cli/auto-indexer/indexer.ts` adds `residentTick()`: every 30 s the
  unit reads the `file` field of its cgroup `memory.stat`. Above 128 MB it calls
  `reclaimCgroup(128)` and `releaseMemory()`.
- `packages/cli/src/scan-pool.ts` sets the worker heap ceiling to 256 MB. A task
  that needs more dies on its limit, and the pool already runs that task inline.
- The landed change of 0.7.46 also carries the growth budget of `agent-desk`
  (`CHAT_RECALL_WATCH_GROWTH_MAX_MB` 256, `CHAT_RECALL_WATCH_RSS_MAX_MB` 896).

Tests: `memory-guard-reclaim.test.ts` (5 tests), `memory-guard.test.ts`,
`walk-memory-bound.test.ts` — `Test Files 3 passed (3)`, `Tests 28 passed (28)`.

Note on the conflict: `desk land` refused the first attempt because 0.7.46 was
already on `main`. I merged `CHANGELOG.md`, `indexer.ts` and `memory-guard.ts`
with their `.desk-main` copies, then raised the version to 0.7.47. The release
`v0.7.46` already existed at an earlier commit, so 0.7.47 carries the two fixes.

### The local install

`npm pack -w chat-recall` → `chat-recall-0.7.47.tgz`, then
`npm i -g … --prefix /home/adi/.local` → `chat-recall --version` 0.7.47,
`systemctl --user restart chat-recall-watch`. I removed the trace drop-in
`zz-trace.conf` from the unit.

First numbers after the restart:

| time (UTC) | MemoryPeak | MemoryCurrent | anon | file | kernel |
|---|---|---|---|---|---|
| 13:14 | 502 MB | 422 MB | 345 MB | 63 MB | 12 MB |

The resident tick works: `resident: returned the page cache above 128MB
(file=153MB)` and `(file=172MB)`.

Server side: `kubectl get pods -n chat-recall` shows the new pods `Running` with
0 restarts and 0 OOMKilled. The journal since the restart holds 11 ships, no
HTTP 502 and no 429.

I started a sampler of the unit memory for 75 minutes. The next comment gives
`MemoryPeak` after one hour, the journal of the hour, and the Done-when evidence.
