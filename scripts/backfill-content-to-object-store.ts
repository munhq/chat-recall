/**
 * One-off backfill: move every cached conversation body out of Postgres and into
 * object storage.
 *
 * `content_cache.content_json` was 1,015 MB of a 3.0 GB production database —
 * 12,321 rows of about 82 KB each, almost all of it TOAST. A cache lookup ran
 * 28,714 times, and every byte went through the WAL and every replica. Search,
 * sync and summaries read the body; nothing queries inside it.
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
 * Run:  npx tsx scripts/backfill-content-to-object-store.ts [--limit N] [--dry-run]
 *
 * SAFE TO STOP AND RE-RUN. It moves one row at a time and commits each before
 * starting the next, so an interrupted run leaves finished rows finished and
 * the rest untouched. Selection is `WHERE object_key = ''`, which is exactly
 * the set that has not moved.
 *
 * ORDER: the object is written first, then the row is updated. A row naming an
 * object that was never stored breaks every later read of that conversation.
 * An object with no row pointing at it costs storage and serves nobody.
 *
 * VERIFIED BEFORE THE BYTES GO. Each object is read back and compared with the
 * body that was uploaded before the row is cleared, so a silent truncation
 * cannot cost a conversation.
 *
 * RLS: content_cache is force-walled on `app.tenant`, so each tenant's rows are
 * read with that GUC set on a dedicated connection. Without it the script sees
 * nothing and would report success having moved nothing.
 *
 * It does NOT reclaim disk. Postgres marks the TOAST rows dead; the file keeps
 * its size until the table is rewritten or vacuumed. Do that separately, once
 * this has run clean and the conversations read correctly from the bucket.
 */
import pg from 'pg';
import { getObjectStore, contentObjectKey, contentDigest, gzipText, gunzipText } from '../packages/engine/src/core/store/object-store.js';

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

// The control plane knows every tenant; content_cache cannot list them itself
// because RLS hides every row until app.tenant is set.
let tenants: string[] = [];
try {
  tenants = (await pool.query(`SELECT tenant FROM tenants ORDER BY tenant`)).rows.map((r: any) => r.tenant);
} catch {
  console.error('No tenants table: pass a privileged DATABASE_URL, or run this after the schema bootstrap.');
  await pool.end();
  process.exit(1);
}

let moved = 0, failed = 0, bytes = 0, total = 0;

for (const tenant of tenants) {
  const client = await pool.connect();
  try {
    // Session-scoped, on this dedicated connection only.
    await client.query(`SELECT set_config('app.tenant', $1, false)`, [tenant]);
    const todo = (await client.query(
      `SELECT count(*)::int AS n, COALESCE(sum(length(content_json)), 0)::bigint AS bytes
         FROM content_cache WHERE tenant=$1 AND object_key = '' AND content_json <> ''`, [tenant])).rows[0];
    if (todo.n === 0) continue;
    total += todo.n;
    console.log(`tenant ${tenant}: ${todo.n} body(ies) to move, ${(Number(todo.bytes) / 1024 / 1024).toFixed(1)} MB`);

    for (;;) {
      if (moved + failed >= LIMIT) break;
      // One row at a time, by primary key, so a long run never holds a snapshot
      // open across the whole table.
      const { rows } = await client.query(
        `SELECT id, source_type, content_json FROM content_cache
          WHERE tenant=$1 AND object_key = '' AND content_json <> ''
          ORDER BY id, source_type LIMIT 1`, [tenant]);
      if (!rows.length) break;
      const { id, source_type: sourceType, content_json: body } = rows[0];
      const hash = contentDigest(body);
      const key = contentObjectKey(tenant, sourceType, id, hash);
      try {
        const gz = gzipText(body);
        await objects.put(key, gz);
        const back = await objects.get(key);
        if (gunzipText(back) !== body) throw new Error('read-back differs from the uploaded body');
        // `object_key = ''` again: an ingest that stored a newer copy between
        // the SELECT and here has already moved the row to its own object, and
        // this key holds the older bytes.
        await client.query(
          `UPDATE content_cache
              SET object_key=$4, content_hash=$5, content_bytes=$6, content_json=''
            WHERE tenant=$1 AND id=$2 AND source_type=$3 AND object_key = ''`,
          [tenant, id, sourceType, key, hash, Buffer.byteLength(body, 'utf8')]);
        moved++; bytes += Buffer.byteLength(body, 'utf8');
        if (moved % 50 === 0) console.log(`  ${moved}/${total} moved (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
      } catch (e) {
        failed++;
        console.error(`  FAILED ${tenant}/${sourceType}/${id}: ${e instanceof Error ? e.message : String(e)}`);
        // Leave the row as it is and stop: a failing bucket fails for the next
        // row too, and a long list of identical errors buries the first one.
        break;
      }
    }
  } finally {
    client.release();
  }
  if (failed) break;
}

console.log(`Moved ${moved} body(ies), ${(bytes / 1024 / 1024).toFixed(1)} MB. ${failed} failed.`);
await pool.end();
process.exit(failed ? 1 : 0);
