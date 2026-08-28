-- Cards the MACHINE closed are not `done`.
--
-- Two paths wrote 'done' without anybody doing the work: the close sweep, when a
-- finding stopped being reported, and the dedup sweep, for a card that turned out
-- to duplicate another. 'done' is the one status the API refuses to a person or
-- an agent who cannot name the session that earned it — so the strictest rule in
-- the product was bypassed by the paths that produced most of the closures. On
-- the board that prompted this, 36 of 55 'done' cards had no session at all.
--
-- The code writes 'closed' with a reason now. This moves the rows already there,
-- and infers each reason from the comment the sweep left. Idempotent: it only
-- touches 'done' rows with no session, and re-running matches nothing.
--
-- GUARDED on the table existing (this runs before the server boots on a fresh
-- database) and RLS-aware: team_tasks is tenant-scoped with FORCE RLS, so a
-- migration that sets no tenant matches ZERO rows without erroring. Loop the
-- tenants and set the GUC per iteration, exactly as tenantQuery does.
DO $$
DECLARE tn TEXT; moved INT; total INT := 0;
BEGIN
  IF to_regclass('public.team_tasks') IS NULL THEN
    RAISE NOTICE 'team_tasks does not exist yet — nothing to repair';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'team_tasks' AND column_name = 'closed_reason') THEN
    RAISE NOTICE 'closed_reason not added yet — the bootstrap runs first, skipping';
    RETURN;
  END IF;

  FOR tn IN SELECT tenant FROM tenants LOOP
    PERFORM set_config('app.tenant', tn, true);
    WITH why AS (
      SELECT t.id,
             COALESCE(
               (SELECT CASE
                         WHEN c.body LIKE 'Closed automatically%' THEN
                           'the collector stopped reporting its finding (closed before this was recorded as a reason)'
                         WHEN c.body LIKE 'Closed as a duplicate%' THEN
                           'duplicate of another card for the same finding'
                         ELSE NULL END
                  FROM team_task_comments c
                  WHERE c.task_id = t.id AND c.author_sub = 'auto-tasks'
                  ORDER BY c.created_at DESC LIMIT 1),
               'closed without a recorded reason, before closures had to give one')
             AS reason
        FROM team_tasks t
       WHERE t.tenant = tn
         AND t.status = 'done'
         AND t.linked_session_id IS NULL
         AND t.created_by = 'auto-tasks'
    )
    UPDATE team_tasks t
       SET status = 'closed', closed_reason = why.reason, updated_at = t.updated_at
      FROM why
     WHERE t.id = why.id AND t.tenant = tn;
    GET DIAGNOSTICS moved = ROW_COUNT;
    total := total + moved;
    IF moved > 0 THEN
      RAISE NOTICE 'tenant %: % machine-closed card(s) moved from done to closed', tn, moved;
    END IF;
  END LOOP;
  RAISE NOTICE 'total moved: %', total;
END $$;
