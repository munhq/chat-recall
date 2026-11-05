-- One-off backfill for #10. DELETE THIS FILE AND THE ENTRY IN migrate.mjs once
-- it has run everywhere — see migrations/README.md.
--
-- `memory_chunks.has_vector` (pg-schema.ts) is the write-through flag the embed
-- worker maintains. It is added by the server bootstrap, which runs AFTER this
-- initContainer — so the column does not exist yet here and this file adds it
-- itself (guarded, idempotent; the bootstrap's ADD COLUMN IF NOT EXISTS is then
-- a no-op). It then marks every chunk that already has a row in memory_vectors,
-- otherwise the pending-vectors gauge (and therefore KEDA) would read every
-- already-embedded chunk as pending after the rollout.
--
-- RLS: memory_chunks is FORCE-walled on tenant = current_setting('app.tenant'),
-- so loop the control-plane `tenants` table and set the GUC per tenant, as
-- tenantQuery() does. Without it every row fails the policy and the statement
-- succeeds having touched nothing (see migrations/README.md).
--
-- Batched at 20,000 rows so the init container does not hold one long lock on
-- the live table while old pods still serve traffic.
DO $$
DECLARE
  tn text;
  n bigint;
  total bigint := 0;
BEGIN
  IF to_regclass('public.memory_chunks') IS NULL OR to_regclass('public.tenants') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE memory_chunks ADD COLUMN IF NOT EXISTS has_vector BOOLEAN NOT NULL DEFAULT false;

  IF to_regclass('public.memory_vectors') IS NULL THEN
    RETURN;  -- no pgvector on this deployment: nothing can be embedded
  END IF;

  FOR tn IN SELECT tenant FROM tenants LOOP
    PERFORM set_config('app.tenant', tn, true);
    LOOP
      UPDATE memory_chunks AS c
         SET has_vector = true
       WHERE c.tenant = tn
         AND c.ctid IN (
           SELECT c2.ctid
             FROM memory_chunks c2
            WHERE c2.tenant = tn
              AND c2.has_vector = false
              AND EXISTS (SELECT 1 FROM memory_vectors v
                           WHERE v.tenant = c2.tenant AND v.chunk_id = c2.chunk_id)
            LIMIT 20000);
      GET DIAGNOSTICS n = ROW_COUNT;
      total := total + n;
      EXIT WHEN n = 0;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'has_vector backfill: % chunks marked', total;
END $$;
