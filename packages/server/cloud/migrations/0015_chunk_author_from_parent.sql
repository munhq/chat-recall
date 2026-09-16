-- Children that no longer agree with their parent session.
--
-- This began as groundwork for a chunk-local visibility policy. That policy was
-- NOT shipped: measurement showed the parent lookup was never what cost the
-- index — a non-leakproof operator was — so the policy stayed as it is. The
-- repair still stands on its own, because both defects below are real whatever
-- the policy asks.
--
-- Two defects, both from the purge and re-index paths writing a parent and its
-- children in separate transactions:
--
--   1. CHILDREN WITH NO PARENT. A session's memory_metadata row was deleted
--      while its chunks, envelope and embeddings survived. Every such row is a
--      DELETED session: all 20178 chunks carry a session_tombstones row. RLS
--      hides them because the parent that authorized them is gone, so this is
--      not a leak — it is a delete that kept the conversation.
--
--   2. CHUNKS WHOSE AUTHOR/PROJECT DISAGREES WITH THE PARENT. Written before
--      attribution was consistent, or by a server-side path that had no author
--      context (the self-heal sweep stamped NULL). The parent is the authority
--      on who owns a session, so the chunk is copied from it. A NULL parent
--      author is copied as NULL: a solo/self-host session keeps its visibility,
--      and the write path is fixed separately so new rows cannot land NULL.
--
-- Idempotent: after the first run no row matches either statement, so a second
-- run is a no-op. Guarded on the tables existing, because the migrate step runs
-- BEFORE the server boots and a fresh database has neither.
--
-- RLS-aware: memory_chunks and memory_metadata are tenant-scoped with FORCE RLS,
-- so a migration that sets no tenant matches ZERO rows without erroring. The
-- loop below sets the tenant per iteration and the '*'-viewer sentinel, exactly
-- as runUnrestricted does — without the viewer the RESTRICTIVE write guard
-- admits only NULL-author rows and the UPDATE would silently skip every owned
-- row (measured: 21 of 253273 admitted with the viewer unset).
-- THE DATABASE CAPS EVERY STATEMENT AT 30 SECONDS. This repair does not fit:
-- the backfill UPDATE measured 89-121s against the production row count, so
-- without this line the statement is cancelled, the DO block raises, and the
-- migrate initContainer crashloops the rollout.
SET statement_timeout = 0;

-- LOCK WINDOW. The UPDATE holds row locks on every row it touches for the
-- length of the statement, and this runs as an initContainer while the OLD
-- pods are still serving and still ingesting. Their writes to those rows wait.
-- Batching with a COMMIT between batches would shorten it, but the runner
-- sends each file as one multi-statement query, which Postgres executes as a
-- single implicit transaction — a COMMIT inside it raises. Shortening the
-- window is therefore a change to migrate.mjs, not to this file.
DO $$
DECLARE
  tn TEXT;
  n_orphans INT;
  n_envelopes INT;
  n_vectors INT;
  n_backfilled INT;
  total_orphans INT := 0;
  total_envelopes INT := 0;
  total_vectors INT := 0;
  total_backfilled INT := 0;
  any_work BOOLEAN := false;
BEGIN
  IF to_regclass('public.memory_chunks') IS NULL
     OR to_regclass('public.memory_metadata') IS NULL THEN
    RAISE NOTICE 'memory_chunks/memory_metadata do not exist yet — nothing to repair';
    RETURN;
  END IF;

  FOR tn IN SELECT tenant FROM tenants LOOP
    PERFORM set_config('app.tenant', tn, true);
    PERFORM set_config('app.viewer', '*', true);

    -- 1. Rows whose parent session is gone: a deleted session that the purge
    --    left behind. Not re-attributed — removed.
    --
    --    ALL THREE CHILDREN, not just the chunks. The first version deleted
    --    memory_chunks alone, which left 399 deleted sessions still holding
    --    their full redacted conversation envelope in content_cache and 1,195
    --    embedding rows in memory_vectors. RLS hides them, because the parent
    --    row that authorizes them is gone — so this was never a leak. It was a
    --    delete that kept the conversation, in a table that is 737 MB.
    DELETE FROM memory_chunks c
     WHERE c.tenant = tn
       AND NOT EXISTS (
             SELECT 1 FROM memory_metadata m
              WHERE m.tenant = c.tenant
                AND m.id = c.item_id
                AND m.source_type = c.source_type);
    GET DIAGNOSTICS n_orphans = ROW_COUNT;

    DELETE FROM content_cache cc
     WHERE cc.tenant = tn
       AND cc.source_type = 'session'
       AND NOT EXISTS (
             SELECT 1 FROM memory_metadata m
              WHERE m.tenant = cc.tenant
                AND m.id = cc.id
                AND m.source_type = cc.source_type);
    GET DIAGNOSTICS n_envelopes = ROW_COUNT;

    -- memory_vectors is absent on any deployment that never configured an
    -- embedder, so this is guarded rather than assumed.
    IF to_regclass('public.memory_vectors') IS NOT NULL THEN
      DELETE FROM memory_vectors v
       WHERE v.tenant = tn
         AND v.source_type = 'session'
         AND NOT EXISTS (
               SELECT 1 FROM memory_metadata m
                WHERE m.tenant = v.tenant
                  AND m.id = v.item_id
                  AND m.source_type = v.source_type);
      GET DIAGNOSTICS n_vectors = ROW_COUNT;
    ELSE
      n_vectors := 0;
    END IF;

    -- 2. Chunks that have a parent but disagree with it. The parent owns the
    --    session, so it is the authority on the chunk's author and project.
    UPDATE memory_chunks c
       SET author_sub   = m.author_sub,
           author_device = m.author_device,
           project_id    = m.project_id
      FROM memory_metadata m
     WHERE c.tenant = tn
       AND m.tenant = c.tenant
       AND m.id = c.item_id
       AND m.source_type = c.source_type
       AND (c.author_sub   IS DISTINCT FROM m.author_sub
         OR c.author_device IS DISTINCT FROM m.author_device
         OR c.project_id    IS DISTINCT FROM m.project_id);
    GET DIAGNOSTICS n_backfilled = ROW_COUNT;

    total_orphans := total_orphans + n_orphans;
    total_envelopes := total_envelopes + n_envelopes;
    total_vectors := total_vectors + n_vectors;
    total_backfilled := total_backfilled + n_backfilled;
    IF n_orphans > 0 OR n_envelopes > 0 OR n_vectors > 0 OR n_backfilled > 0 THEN
      any_work := true;
      RAISE NOTICE 'tenant %: removed % chunk(s), % envelope(s), % vector(s) with no parent; re-attributed % from parent',
        tn, n_orphans, n_envelopes, n_vectors, n_backfilled;
    END IF;
  END LOOP;

  IF NOT any_work THEN
    RAISE NOTICE 'no row disagreed with its parent — nothing to repair';
  END IF;
  RAISE NOTICE 'removed % chunk(s), % envelope(s), % vector(s) with no parent; re-attributed % in total',
    total_orphans, total_envelopes, total_vectors, total_backfilled;
END $$;
