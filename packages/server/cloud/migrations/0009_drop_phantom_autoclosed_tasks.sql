-- Delete auto-filed cards that closed themselves without anything being fixed.
--
-- WHAT WENT WRONG. `code_actions.id` used to be hashed from data that moved: the
-- title carried its own occurrence counts ("inflate copy-pasted 2×") and the
-- location key took loc[0], whose order came from the analyzer rather than the
-- problem. So a re-index over unchanged code minted a NEW id for the SAME
-- finding. The auto-filer then did two wrong things at once, both of them
-- looking correct from the inside:
--
--   1. the card holding the OLD id no longer matched any open action, so the
--      close sweep flipped it to 'done' and commented "the finding is no longer
--      reported" — when the finding was still there, untouched;
--   2. a fresh card was filed under the new id, for the same problem.
--
-- Measured before this ran: 97 cards, 93 of them 'done', every one with NO
-- linked session, 93 distinct finding ids across only 33 distinct titles — and
-- meanwhile every one of the 313 code_actions was still 'suggested'. Nothing had
-- been fixed. The board was asserting ~90 completed pieces of work that never
-- happened, which makes the whole surface worthless to read.
--
-- The id is fixed (identityTitle collapses digits, locationKey sorts files and
-- drops the line number). This removes the wreckage it left, which no product
-- path can: the board deliberately has no delete.
--
-- THE PREDICATE IS THE SAFETY. Four conditions, all required:
--   created_by = 'auto-tasks'  — never a card a person made
--   status     = 'done'        — never an open card, never a REJECTED one
--                                (rejected is the human's verdict; see below)
--   linked_session_id IS NULL  — never a card with work attached to it
--   linked_finding_id orphaned — the finding it names does not exist any more,
--                                so the card cannot be about a live problem
--
-- A genuinely-fixed card fails the third condition: closing one through the API
-- requires a linked session ("a task is marked done by the work, not by hand"),
-- so real completions are untouched. A card whose finding is still open fails
-- the fourth. 'rejected' is excluded explicitly because a rejection means a
-- person looked and said no, and that verdict outlives its finding.
--
-- IDEMPOTENT: a DELETE that matches nothing on the second run.

DO $$
DECLARE
  tn TEXT;
  removed BIGINT := 0;
  n BIGINT;
BEGIN
  -- The migrate step runs BEFORE the server boots, so on a fresh database these
  -- tables do not exist yet. Unguarded, that fails the initContainer and the
  -- deployment never starts.
  IF to_regclass('public.team_tasks') IS NULL
     OR to_regclass('public.code_actions') IS NULL THEN
    RAISE NOTICE 'team_tasks/code_actions absent — nothing to repair';
    RETURN;
  END IF;

  -- Per-tenant, with the GUC set. Every tenant-scoped table carries
  -- `tenant = current_setting('app.tenant', true)` under FORCEd RLS, and the
  -- owning role obeys it too. Without this loop `tenant = NULL` is NULL, the
  -- policy matches ZERO rows, nothing errors, and the ledger records the
  -- migration as applied — which is how two earlier repairs were lost.
  FOR tn IN SELECT t.tenant FROM tenants t LOOP
    PERFORM set_config('app.tenant', tn, true);

    -- Comments first: they are FK-free but tenant-scoped, and an orphan comment
    -- row is invisible garbage that later counts wrong.
    DELETE FROM team_task_comments c
     WHERE c.task_id IN (
       SELECT t.id FROM team_tasks t
        WHERE t.created_by = 'auto-tasks'
          AND t.status = 'done'
          AND t.linked_session_id IS NULL
          AND t.linked_finding_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM code_actions a WHERE a.id = t.linked_finding_id)
     );

    DELETE FROM team_tasks t
     WHERE t.created_by = 'auto-tasks'
       AND t.status = 'done'
       AND t.linked_session_id IS NULL
       AND t.linked_finding_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM code_actions a WHERE a.id = t.linked_finding_id);

    GET DIAGNOSTICS n = ROW_COUNT;
    removed := removed + n;
  END LOOP;

  -- Printed into the initContainer log. A repair that reports nothing is
  -- indistinguishable from a repair that silently matched no rows.
  RAISE NOTICE 'phantom auto-closed tasks removed: %', removed;
END $$;
