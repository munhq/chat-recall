-- migrate:split
-- One-off backfill for #10. DELETE THIS FILE AND THE ENTRY IN migrate.mjs once
-- it has run everywhere — see migrations/README.md.
--
-- The `-- migrate:split` marker tells migrate.mjs to run each `-- @@` part as
-- its own statement. A single multi-statement query is one implicit transaction
-- and a procedure's COMMIT inside it fails with "invalid transaction
-- termination"; one statement per call lets the batching COMMIT work.
--
-- `memory_chunks.trivial` (pg-schema.ts) is the write-through flag the writer
-- maintains: true when the chunk's parent session is trivial (few turns and
-- little output — see embed-policy.ts) and therefore will never be embedded.
-- It is in the idx_chunks_pending_vector_v2 predicate, so trivial chunks stay
-- out of the pending-vectors scan. Without this backfill every existing chunk
-- is `false`, the worker would embed trivial sessions again, and the count
-- would keep them in the index — the work this flag exists to remove.
--
-- A PROCEDURE, not a DO block, because it commits each batch. The first version
-- was a DO block and the initContainer killed it: setting the flag rewrites the
-- row version and the table is large and busy, so 20,000 rows took 33 s as the
-- owner under RLS — over the cluster's statement_timeout of 30 s. Committing per
-- batch keeps every statement under that limit and releases its row locks
-- before the next one. 0018 finished only because no chunk had a vector yet, so
-- it updated no rows.
--
-- The server bootstrap runs AFTER this initContainer, so the column does not
-- exist here yet and this file adds it itself (guarded, idempotent; the
-- bootstrap's ADD COLUMN IF NOT EXISTS is then a no-op).
--
-- The threshold literals below are the documented defaults (EMBED_MIN_TURNS /
-- SUMMARY_MIN_TURNS 4, EMBED_TRIVIAL_MAX_OUTPUT_TOKENS /
-- SUMMARY_TRIVIAL_MAX_OUTPUT_TOKENS 2000). A deployment that overrides them
-- re-derives the flag for every session it re-syncs (writeChunkRows), and
-- releaseTrivialChunks clears a stale `true` once a session crosses the line.
-- This one-off cannot read process.env, so it uses the defaults.
--
-- RLS: memory_chunks and memory_metadata are FORCE-walled on
-- tenant = current_setting('app.tenant'), and author_visibility (RESTRICTIVE
-- FOR SELECT) hides every authored row from an unset app.viewer. Loop the
-- control-plane `tenants` table and set both GUCs per tenant, as tenantQuery()
-- does. The GUCs are session-scoped (`false`) because a commit resets a
-- transaction-scoped one; they are cleared at the end.
CREATE OR REPLACE PROCEDURE cr_backfill_chunk_trivial() LANGUAGE plpgsql AS $$
DECLARE
  tn text;
  n bigint;
  total bigint := 0;
BEGIN
  IF to_regclass('public.memory_chunks') IS NULL
     OR to_regclass('public.memory_metadata') IS NULL
     OR to_regclass('public.tenants') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE memory_chunks ADD COLUMN IF NOT EXISTS trivial BOOLEAN NOT NULL DEFAULT false;

  FOR tn IN SELECT tenant FROM tenants LOOP
    LOOP
      PERFORM set_config('app.tenant', tn, false);
      PERFORM set_config('app.viewer', '*', false);
      UPDATE memory_chunks AS c
         SET trivial = true
       WHERE c.tenant = tn
         AND c.source_type = 'session'
         AND c.trivial = false
         AND c.ctid IN (
           SELECT c2.ctid
             FROM memory_chunks c2
            WHERE c2.tenant = tn
              AND c2.source_type = 'session'
              AND c2.trivial = false
              AND EXISTS (
                SELECT 1 FROM memory_metadata m
                 WHERE m.tenant = c2.tenant AND m.id = c2.item_id
                   AND m.source_type = 'session'
                   AND m.extra_json LIKE '{%'
                   AND COALESCE(NULLIF(m.extra_json::jsonb ->> 'messageCount', '')::int, 999) <= 4
                   AND COALESCE(NULLIF(m.extra_json::jsonb ->> 'outputTokens', '')::bigint, 0) < 2000)
            LIMIT 5000);
      GET DIAGNOSTICS n = ROW_COUNT;
      total := total + n;
      COMMIT;
      EXIT WHEN n = 0;
    END LOOP;
  END LOOP;

  PERFORM set_config('app.tenant', '', false);
  PERFORM set_config('app.viewer', '', false);
  RAISE NOTICE 'trivial backfill: % chunks marked', total;
END $$;

-- @@
CALL cr_backfill_chunk_trivial();

-- @@
DROP PROCEDURE cr_backfill_chunk_trivial();
