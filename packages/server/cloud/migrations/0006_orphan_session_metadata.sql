-- 0006: remove `session_metadata` rows with no `memory_metadata` parent.
--
-- These rows are unreachable by every read path. The `author_visibility` SELECT
-- policy on session_metadata is:
--
--   USING (app.viewer = '*' OR EXISTS (
--     SELECT 1 FROM memory_metadata m
--     WHERE m.tenant = session_metadata.tenant
--       AND m.id     = session_metadata.session_id
--       AND m.source_type = 'session'))
--
-- so a parentless row is invisible to anything that is not a '*' viewer. The
-- sync path runs as the author's sub (not '*') by design, and
-- `INSERT ... ON CONFLICT DO UPDATE` has to READ the conflicting row — so every
-- field-reconcile touching one of these failed with
--   new row violates row-level security policy "author_visibility"
-- and returned HTTP 500. Permanently: the row could never be updated, and could
-- never be seen in order to be fixed.
--
-- Measured on production 2026-08-04: 4 such rows, failing on every sync since
-- 2026-07-22 (33 occurrences in the app log, none captured by error reporting
-- because the surrounding conversation pushes kept succeeding).
--
-- The write path is fixed in engine/src/core/store/caches.ts — setToolTitle and
-- setUserTitle now guard their INSERT on the parent existing, so this state is
-- no longer reachable. This migration clears the rows that already exist.
--
-- Nothing is lost that anyone can see: these rows hold only a title for a
-- session that has no conversation row, and no reader can return them. The
-- alternative (fabricating a memory_metadata parent) would put empty sessions
-- into listings and search, which is worse than dropping a title.

DELETE FROM session_metadata s
WHERE NOT EXISTS (
  SELECT 1 FROM memory_metadata m
  WHERE m.tenant = s.tenant
    AND m.id = s.session_id
    AND m.source_type = 'session'
);
