-- Recover the commits a card's own closing comment already names.
--
-- `done` requires the sha(s) that fixed it, but the cards closed BEFORE that rule
-- carry none — so the board showed no evidence on exactly the 19 cards it had.
-- Seven of them say it in plain text: an agent closing a card wrote "Fixed in
-- <repo> <sha>" as its comment, which is the same information the column now
-- holds, in a place nothing reads.
--
-- This parses THE CARD'S OWN comments. It invents nothing: a card whose comments
-- name no sha is left alone, and the UI falls back to the linked session's
-- changes for those.
--
-- Idempotent (only fills a NULL), guarded on the table and column existing, and
-- tenant-looped because team_tasks is RLS-forced and a migration that sets no
-- tenant matches zero rows without erroring.
DO $$
DECLARE tn TEXT; filled INT; total INT := 0;
BEGIN
  IF to_regclass('public.team_tasks') IS NULL
     OR to_regclass('public.team_task_comments') IS NULL THEN
    RAISE NOTICE 'tables not present yet — nothing to recover';
    RETURN;
  END IF;
  ALTER TABLE team_tasks ADD COLUMN IF NOT EXISTS done_evidence_json TEXT;

  FOR tn IN SELECT tenant FROM tenants LOOP
    PERFORM set_config('app.tenant', tn, true);
    WITH found AS (
      SELECT t.id,
             -- The first 7-40 char hex run in any comment on this card that is
             -- NOT one of our own ids (cf_… / ca_… / t_… carry hex too).
             (SELECT (regexp_match(
                        regexp_replace(c.body, '\m(cf_|ca_|t_)[0-9a-f]+\M', '', 'g'),
                        '\m([0-9a-f]{7,40})\M'))[1]
                FROM team_task_comments c
               WHERE c.task_id = t.id
                 AND regexp_replace(c.body, '\m(cf_|ca_|t_)[0-9a-f]+\M', '', 'g') ~ '\m[0-9a-f]{7,40}\M'
               ORDER BY c.created_at ASC LIMIT 1) AS sha
        FROM team_tasks t
       WHERE t.tenant = tn
         AND t.status = 'done'
         AND (t.done_evidence_json IS NULL OR t.done_evidence_json = '' OR t.done_evidence_json = 'null')
    )
    UPDATE team_tasks t
       SET done_evidence_json = json_build_object('commits', json_build_array(found.sha))::text,
           updated_at = t.updated_at
      FROM found
     WHERE t.id = found.id AND t.tenant = tn AND found.sha IS NOT NULL;
    GET DIAGNOSTICS filled = ROW_COUNT;
    total := total + filled;
    IF filled > 0 THEN
      RAISE NOTICE 'tenant %: recovered commits for % card(s)', tn, filled;
    END IF;
  END LOOP;
  RAISE NOTICE 'total recovered: %', total;
END $$;
