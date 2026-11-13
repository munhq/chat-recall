## The opencode dump has a size budget — 0.7.45

The spike of 1.6 GB came back at 12:51 with only the daemon in the cgroup. The
cause was the opencode backend export.

### The measurement

`probe-oc.mjs` built one large opencode session on 0.7.44. The build took 20 s and
held 1.5 GB. The export wrote every message row of every session into one JSON
string, and the string doubled in the parse and in the gzip.

### The fix

`packages/engine/src/core/backends/opencode.ts` now stops the export at a budget:

- `DEFAULT_DUMP_MAX_BYTES = 64 * 1024 * 1024`, from
  `CHAT_RECALL_OPENCODE_DUMP_MAX_BYTES` through `dumpMaxBytes(env)`.
- A row that passes the budget is skipped, and the export adds one line
  `{"kind":"truncated","skipped_rows":N,"limit_bytes":M}`, so the reader knows
  that the session is not complete.

The same build after the fix: 73 ms and 2.1 MB. Test
`packages/engine/src/core/backends/opencode-dump-bound.test.ts` (4 tests) covers
the budget, the marker line and the default.
