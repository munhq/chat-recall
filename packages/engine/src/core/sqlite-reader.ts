/**
 * Read-only SQLite access — the single place this project opens a database
 * that isn't Postgres.
 *
 * It exists for exactly one reason: OpenCode stores its sessions in its own
 * SQLite file, so indexing OpenCode means reading that file. Everything
 * chat-recall itself stores lives in Postgres on the server. There is no write
 * path here, deliberately — if you need one, you want the server.
 *
 * Uses Node's built-in `node:sqlite` (22.5+). It used to be better-sqlite3, a
 * native optionalDependency, which meant a machine without a C++ toolchain
 * either skipped OpenCode silently or failed to boot at all.
 *
 * Loaded LAZILY, via createRequire rather than a static import, for two
 * reasons:
 *   1. `backends/index.js` is imported at collector boot, so a static import
 *      would pull node:sqlite into every process that never touches OpenCode.
 *   2. node:sqlite still emits an ExperimentalWarning on Node 22 and 23 (it is
 *      silent on the 24 we ship). A static import prints that on `--version`.
 *      Deferring it means only an actual OpenCode read can surface it, and the
 *      filter below removes it even then — we have pinned the API we use and
 *      test it against a real database.
 */
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);

let _sqlite: { DatabaseSync: typeof DatabaseSync } | undefined;
let _filtered = false;

/**
 * Drop the SQLite ExperimentalWarning, and only that one.
 *
 * `--no-warnings` or removeAllListeners would hide deprecations and real
 * process warnings too; this re-emits everything else untouched.
 */
function filterExperimentalWarning(): void {
  if (_filtered) return;
  _filtered = true;
  const existing = process.listeners('warning');
  process.removeAllListeners('warning');
  process.on('warning', (w: Error & { name?: string }) => {
    if (w?.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return;
    if (existing.length === 0) console.error(w?.stack || String(w));
    else for (const l of existing) (l as (w: Error) => void)(w);
  });
}

function sqlite(): { DatabaseSync: typeof DatabaseSync } {
  if (!_sqlite) {
    filterExperimentalWarning();
    _sqlite = require('node:sqlite') as { DatabaseSync: typeof DatabaseSync };
  }
  return _sqlite;
}

/**
 * Open a database read-only, or null if it cannot be opened.
 *
 * `readOnly` also refuses to CREATE a missing file, which is what better-sqlite3
 * needed a separate `fileMustExist` flag for — so a wrong path yields null here
 * instead of silently producing an empty database.
 */
export function openSqliteReadonly(path: string): DatabaseSync | null {
  try {
    return new (sqlite().DatabaseSync)(path, { readOnly: true });
  } catch {
    return null;
  }
}

/** Same, but throws — for callers that already guard on existsSync and want the
 *  underlying error rather than a silent null. */
export function openSqliteReadonlyOrThrow(path: string): DatabaseSync {
  return new (sqlite().DatabaseSync)(path, { readOnly: true });
}
