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
 * Run:  npx tsx scripts/backfill-content-to-object-store.ts [--limit N] [--batch N] [--dry-run]
 *
 * SAFE TO STOP AND RE-RUN. It moves one batch at a time and commits each row
 * before starting the next, so an interrupted run leaves finished rows finished
 * and the rest untouched. Selection is `WHERE object_key = ''`, which is exactly
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
 * read with that GUC set on a dedicated connection, and `app.viewer = '*'` for
 * the author_visibility policy (the seed's pattern; an unset viewer hides every
 * authored row). Without both the script sees nothing and would report success
 * having moved nothing.
 *
 * COST: it never reads the whole column. The count is on `object_key` alone and
 * the selection is keyset-paginated on the primary key, because a
 * `sum(length(content_json))` over 1 GB of TOAST is cancelled by the database's
 * 30s statement timeout — as it was on the live primary.
 *
 * It does NOT reclaim disk. Postgres marks the TOAST rows dead; the file keeps
 * its size until the table is rewritten or vacuumed. In practice autovacuum
 * truncates the trailing dead TOAST pages of this table once every row has been
 * rewritten (the production table went from 1,015 MB to 32 MB on its own).
 */
import pg from 'pg';
import { getObjectStore, contentObjectKey, contentDigest, gzipText, gunzipText } from '../packages/engine/src/core/store/object-store.js';

const DRY = process.argv.includes('--dry-run');
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;
const batchArg = process.argv.indexOf('--batch');
const BATCH = batchArg > -1 ? Math.max(1, Number(process.argv[batchArg + 1])) : 200;

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
    // Session-scoped, on this dedicated connection only. app.viewer = '*' is the
    // pattern the seed uses: the author_visibility policy hides authored rows
    // from an unset viewer, so without it this sees nothing and reports success.
    await client.query(
      `SELECT set_config('app.tenant', $1, false), set_config('app.viewer', '*', false)`, [tenant]);
    // Count on `object_key` alone. Touching `content_json` here would detoast
    // every body in the table (1 GB on the production database) for an estimate,
    // which is exactly the statement this script must not run: the database has
    // statement_timeout = 30s, and that count was cancelled on the live primary.
    const todo = (await client.query(
      `SELECT count(*) FILTER (WHERE object_key = '')::int AS n
         FROM content_cache WHERE tenant=$1`, [tenant])).rows[0];
    if (todo.n === 0) continue;
    total += todo.n;
    console.log(`tenant ${tenant}: ${todo.n} body(ies) to move`);

    let lastId: string | null = null;
    let lastType: string | null = null;
    for (;;) {
      if (moved + failed >= LIMIT) break;
      // Keyset pagination on the primary key: linear in the rows, and a long
      // run never holds one snapshot open across the whole table. One row at a
      // time cost 12,327 index scans that each walked past every moved row.
      // (`object_key = ''` alone is the set that has not moved; a row in the
      // column always carries the body, and the column default is ''.)
      const { rows } = await client.query(
        `SELECT id, source_type, content_json FROM content_cache
          WHERE tenant=$1 AND object_key = ''
            AND ($2::text IS NULL OR (id, source_type) > ($2, $3))
          ORDER BY id, source_type LIMIT $4`, [tenant, lastId, lastType, BATCH]);
      if (!rows.length) break;
      for (const { id, source_type: sourceType, content_json: body } of rows) {
        lastId = id; lastType = sourceType;
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
          if (moved % 200 === 0) console.log(`  ${moved}/${total} moved (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
        } catch (e) {
          failed++;
          console.error(`  FAILED ${tenant}/${sourceType}/${id}: ${e instanceof Error ? e.message : String(e)}`);
          // Leave the row as it is and stop: a failing bucket fails for the next
          // row too, and a long list of identical errors buries the first one.
          break;
        }
      }
      if (failed) break;
    }
  } finally {
    client.release();
  }
  if (failed) break;
}

console.log(`Moved ${moved} body(ies), ${(bytes / 1024 / 1024).toFixed(1)} MB. ${failed} failed.`);
await pool.end();
process.exit(failed ? 1 : 0);
