/**
 * One-off backfill: move every raw session archive out of Postgres and into
 * object storage.
 *
 * `raw_sessions.gz` was 1232 MB of a 3564 MB production database, and its heap
 * was 2.7 MB — all of it TOAST. Only getRawSession reads those bytes, and it
 * reads one row by primary key. Every other accessor reads session_id, mtime,
 * size and project_id.
 *
 * Runs against the SERVER's database, so it needs the server's DATABASE_URL and
 * the same RAW_ARCHIVE_S3_* settings the server uses:
 *
 *   DATABASE_URL=postgres://…                 the primary, never a replica
 *   RAW_ARCHIVE_S3_ENDPOINT=https://…
 *   RAW_ARCHIVE_S3_BUCKET=…
 *   RAW_ARCHIVE_S3_ACCESS_KEY_ID=…
 *   RAW_ARCHIVE_S3_SECRET_ACCESS_KEY=…
 *   RAW_ARCHIVE_S3_REGION=…
 *
 * Run:  npx tsx scripts/backfill-raw-to-object-store.ts [--limit N] [--dry-run]
 *
 * SAFE TO STOP AND RE-RUN. It moves one row at a time and commits each before
 * starting the next, so an interrupted run leaves finished rows finished and
 * the rest untouched. Selection is `WHERE object_key = ''`, which is exactly
 * the set that has not moved.
 *
 * ORDER: the object is written first, then the row is updated. A row naming an
 * object that was never stored breaks every later read of that session. An
 * object with no row pointing at it costs storage and serves nobody.
 *
 * VERIFIED BEFORE THE BYTES GO. Each object is read back and compared with what
 * was uploaded before the row is updated, so a silent truncation cannot cost a
 * transcript.
 *
 * It does NOT drop the gz column and does NOT reclaim disk. Postgres marks the
 * TOAST rows dead; the file keeps its size until the column is dropped and the
 * table is rewritten. Do that separately, once this has run clean and the
 * archive reads correctly from the bucket.
 */
import pg from 'pg';
import { getObjectStore, rawObjectKey } from '../packages/engine/src/core/store/object-store.js';

const DRY = process.argv.includes('--dry-run');
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;

const url = process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set.'); process.exit(1); }

const objects = getObjectStore();
if (!objects) {
  console.error('No object store configured. Set RAW_ARCHIVE_S3_ENDPOINT, _BUCKET, _ACCESS_KEY_ID and _SECRET_ACCESS_KEY.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url });

const { rows: [todo] } = await pool.query(
  `SELECT count(*)::int AS n, COALESCE(sum(length(gz)), 0)::bigint AS bytes
     FROM raw_sessions WHERE object_key = '' AND gz IS NOT NULL`);
const mb = (Number(todo.bytes) / 1024 / 1024).toFixed(1);
console.log(`${todo.n} archive(s) to move, ${mb} MB compressed → ${objects.bucket}`);
if (DRY) { console.log('--dry-run: nothing written.'); await pool.end(); process.exit(0); }

let moved = 0, failed = 0, bytes = 0;
for (;;) {
  if (moved + failed >= LIMIT) break;
  // One row at a time, by primary key, so a long run never holds a snapshot
  // open across the whole table.
  const { rows } = await pool.query(
    `SELECT tenant, session_id, gz FROM raw_sessions
      WHERE object_key = '' AND gz IS NOT NULL
      ORDER BY tenant, session_id LIMIT 1`);
  if (!rows.length) break;
  const { tenant, session_id: sessionId, gz } = rows[0];
  const key = rawObjectKey(tenant, sessionId);
  try {
    await objects.put(key, gz);
    const back = await objects.get(key);
    if (Buffer.compare(back, gz) !== 0) throw new Error(`read-back differs (${back.length} vs ${gz.length} bytes)`);
    await pool.query(
      `UPDATE raw_sessions SET object_key = $3, gz = NULL WHERE tenant = $1 AND session_id = $2`,
      [tenant, sessionId, key]);
    moved++; bytes += gz.length;
    if (moved % 50 === 0) console.log(`  ${moved}/${todo.n} moved (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
  } catch (e) {
    failed++;
    console.error(`  FAILED ${tenant}/${sessionId}: ${e instanceof Error ? e.message : String(e)}`);
    // Leave the row as it is and stop: a failing bucket fails for the next row
    // too, and a long list of identical errors buries the first one.
    break;
  }
}

const { rows: [left] } = await pool.query(
  `SELECT count(*)::int AS n FROM raw_sessions WHERE object_key = '' AND gz IS NOT NULL`);
console.log(`Moved ${moved} archive(s), ${(bytes / 1024 / 1024).toFixed(1)} MB. ${failed} failed. ${left.n} still in Postgres.`);
await pool.end();
process.exit(failed ? 1 : 0);
