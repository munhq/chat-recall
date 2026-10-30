/**
 * OpenCode 2.x storage, read through the 1.x table names.
 *
 * OpenCode 2.x writes sessions to `session_v2` and their turns to
 * `session_message`, one row per user prompt or assistant reply, with the text,
 * reasoning and tool calls of a reply in its `data.content` array. The 1.x
 * tables `session`, `message` and `part` stopped growing: on one machine the
 * newest 1.x session was from 2026-10-08, while `session_v2` held 127 sessions
 * more, and none of them was synced.
 *
 * SQLite resolves a table name in the `temp` schema before `main`, and a
 * read-only connection may create temp views. So temp views named `session`,
 * `message` and `part` give every 1.x query of the backend and the parsers the
 * 2.x data in the 1.x shape:
 *
 *   session  every row of `session_v2`, which also holds every 1.x session
 *   message  1.x rows of a session with no 2.x messages, else one row per
 *            2.x user or assistant message, with `role`, model, cost and tokens
 *   part     1.x rows of such a session, else the user text, one row per
 *            content block of a reply (text, reasoning, tool with its output),
 *            and a `step-finish` row per reply for the cost and token totals
 *
 * A session whose messages exist in both stores is read from the 2.x store, so
 * nothing is counted twice. A database without `session_v2` is left as it is.
 */
import type { DatabaseSync } from 'node:sqlite';
import { openSqliteReadonly, openSqliteReadonlyOrThrow } from '../sqlite-reader.js';

const SESSION_COLUMNS = [
  'id', 'project_id', 'parent_id', 'slug', 'directory', 'title', 'version', 'share_url',
  'summary_additions', 'summary_deletions', 'summary_files', 'summary_diffs', 'revert', 'permission',
  'time_created', 'time_updated', 'time_compacting', 'time_archived', 'workspace_id', 'path', 'agent',
  'model', 'cost', 'tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read',
  'tokens_cache_write', 'metadata',
];

/** A JSON value of a 2.x row, kept as JSON inside json_object(). */
const j = (path: string, fallback = "'{}'") => `json(coalesce(json_extract(m.data, '${path}'), ${fallback}))`;

const V2_SESSIONS = 'SELECT session_id FROM main.session_message';

function hasTable(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function columnsOf(db: DatabaseSync, table: string): Set<string> {
  return new Set((db.prepare(`SELECT name FROM pragma_table_info('${table}', 'main')`).all() as Array<{ name: string }>).map((r) => r.name));
}

/** Create the temp views on an open connection; true when the database is 2.x. */
export function installOpencodeV2Views(db: DatabaseSync): boolean {
  if (!hasTable(db, 'session_v2') || !hasTable(db, 'session_message')) return false;
  const v2Cols = columnsOf(db, 'session_v2');
  const sessionCols = SESSION_COLUMNS.map((c) => (v2Cols.has(c) ? c : `NULL AS ${c}`)).join(', ');
  const hasV1 = hasTable(db, 'message') && hasTable(db, 'part');

  const v1Messages = hasV1
    ? `SELECT id, session_id, time_created, time_updated, data FROM main.message WHERE session_id NOT IN (${V2_SESSIONS}) UNION ALL `
    : '';
  const v1Parts = hasV1
    ? `SELECT id, message_id, session_id, time_created, time_updated, data FROM main.part WHERE session_id NOT IN (${V2_SESSIONS}) UNION ALL `
    : '';

  db.exec(`
    CREATE TEMP VIEW IF NOT EXISTS session AS SELECT ${sessionCols} FROM main.session_v2;

    CREATE TEMP VIEW IF NOT EXISTS message AS
    ${v1Messages}
    SELECT m.id, m.session_id, m.time_created, m.time_updated,
      CASE m.type
        WHEN 'user' THEN json_object('role', 'user', 'time', ${j('$.time')})
        ELSE json_object(
          'role', 'assistant',
          'agent', json_extract(m.data, '$.agent'),
          'modelID', json_extract(m.data, '$.model.id'),
          'providerID', json_extract(m.data, '$.model.providerID'),
          'cost', coalesce(json_extract(m.data, '$.cost'), 0),
          'tokens', ${j('$.tokens')},
          'time', ${j('$.time')})
      END AS data
    FROM main.session_message m WHERE m.type IN ('user', 'assistant');

    CREATE TEMP VIEW IF NOT EXISTS part AS
    ${v1Parts}
    SELECT m.id || ':text', m.id, m.session_id, m.time_created, m.time_updated,
      json_object('type', 'text', 'text', json_extract(m.data, '$.text'))
    FROM main.session_message m
    WHERE m.type = 'user' AND json_extract(m.data, '$.text') IS NOT NULL
    UNION ALL
    SELECT m.id || ':' || c.key, m.id, m.session_id, m.time_created + c.key, m.time_updated,
      CASE json_extract(c.value, '$.type')
        WHEN 'tool' THEN json_object(
          'type', 'tool',
          'tool', json_extract(c.value, '$.name'),
          'callID', json_extract(c.value, '$.id'),
          'state', json_object(
            'status', json_extract(c.value, '$.state.status'),
            'input', json(coalesce(json_extract(c.value, '$.state.input'), '{}')),
            'output', (SELECT group_concat(json_extract(o.value, '$.text'), char(10))
                       FROM json_each(c.value, '$.state.content') o
                       WHERE json_extract(o.value, '$.type') = 'text')))
        ELSE json_object('type', json_extract(c.value, '$.type'), 'text', json_extract(c.value, '$.text'))
      END
    FROM main.session_message m, json_each(m.data, '$.content') c
    WHERE m.type = 'assistant'
    UNION ALL
    SELECT m.id || ':step', m.id, m.session_id,
      coalesce(json_extract(m.data, '$.time.completed'), m.time_created), m.time_updated,
      json_object('type', 'step-finish', 'cost', coalesce(json_extract(m.data, '$.cost'), 0), 'tokens', ${j('$.tokens')})
    FROM main.session_message m WHERE m.type = 'assistant';
  `);
  return true;
}

/** Open an OpenCode database read-only, with the 2.x views; null when it cannot be opened. */
export function openOpencodeDb(path: string): DatabaseSync | null {
  const db = openSqliteReadonly(path);
  if (!db) return null;
  try {
    installOpencodeV2Views(db);
  } catch {
    // A schema the views do not fit reads as 1.x, as it did before.
  }
  return db;
}

/** Open an OpenCode database read-only, with the 2.x views; throws when it cannot be opened. */
export function openOpencodeDbOrThrow(path: string): DatabaseSync {
  const db = openSqliteReadonlyOrThrow(path);
  try {
    installOpencodeV2Views(db);
  } catch {
    // As above.
  }
  return db;
}
