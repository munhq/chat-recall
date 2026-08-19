-- 0008: redo the data fixes that 0006 and 0007 only APPEARED to make.
--
-- ── THE TRAP ────────────────────────────────────────────────────────────────
--
-- Every tenant-scoped table carries this policy, for ALL commands:
--
--   tenant_isolation:  tenant = current_setting('app.tenant', true)
--
-- and RLS is both ENABLED and FORCED, so the table owner is subject to it too
-- (see the note at the bottom of migrate.mjs: the migrating role is NOBYPASSRLS).
--
-- A migration is a cross-tenant operation and sets no tenant context. With
-- `app.tenant` unset, `current_setting(..., true)` returns NULL, `tenant = NULL`
-- is NULL, and NULL is not true — so every row fails the check. The statement
-- therefore matches ZERO rows. It does not error. It reports success. The runner
-- records the file in `schema_migrations`, and because that record is the only
-- guard, the migration never runs again.
--
-- Two migrations were lost to this, both confirmed against production 2026-08-19:
--
--   0006  written to delete 4 orphaned session_metadata rows (measured
--         2026-08-04). All 4 were still present 15 days later.
--   0007  written to consolidate project ids after the hotmun → munhq rename.
--         All 371 memory_metadata rows, 16,155 memory_chunks, 2 memory_vectors
--         and 4 code_projects on stale ids were untouched.
--
-- Neither failed. Both were marked done. That is the dangerous part: a data
-- migration against an RLS'd table is silently a no-op, and the mechanism then
-- guarantees it is never retried.
--
-- ── THE FIX ─────────────────────────────────────────────────────────────────
--
-- RLS is disabled for the duration of the transaction and re-enabled at the end.
-- The migrating role OWNS these tables, so it may toggle enforcement; and DDL in
-- Postgres is transactional, so a failure anywhere rolls the toggle back with the
-- data. `FORCE ROW LEVEL SECURITY` is a separate flag that DISABLE does not
-- clear, so re-enabling restores the original posture exactly.
--
-- The alternative — looping tenants with set_config('app.tenant', …) — cannot
-- bootstrap: enumerating the tenants requires reading a table that the same
-- policy hides. Hence toggling rather than satisfying the policy.
--
-- migrate.mjs now reports rows affected per file, so a future no-op of this kind
-- is visible in the initContainer log instead of passing as success.

BEGIN;

ALTER TABLE session_metadata DISABLE ROW LEVEL SECURITY;
ALTER TABLE memory_metadata  DISABLE ROW LEVEL SECURITY;
ALTER TABLE memory_chunks    DISABLE ROW LEVEL SECURITY;
ALTER TABLE memory_vectors   DISABLE ROW LEVEL SECURITY;
ALTER TABLE code_projects    DISABLE ROW LEVEL SECURITY;
ALTER TABLE code_findings    DISABLE ROW LEVEL SECURITY;
ALTER TABLE code_hotspots    DISABLE ROW LEVEL SECURITY;
ALTER TABLE code_actions     DISABLE ROW LEVEL SECURITY;

-- ── 0006's work: session_metadata rows with no memory_metadata parent ───────
-- Unreachable by every read path, and unfixable in place: the author_visibility
-- policy hides them, and an ON CONFLICT DO UPDATE must read the conflicting row,
-- so every sync touching one returned HTTP 500. They hold only a title for a
-- conversation that does not exist.

DELETE FROM session_metadata s
WHERE NOT EXISTS (
  SELECT 1 FROM memory_metadata m
  WHERE m.tenant = s.tenant
    AND m.id = s.session_id
    AND m.source_type = 'session'
);

-- ── 0007's work: consolidate ids orphaned by the hotmun → munhq org rename ──
-- Identity is derived from the git remote (engine/src/types/project.ts step 2),
-- which is mutable, so the rename minted a second identity per repo. project_id
-- tags sessions and chunks as well as findings, so a project filter returned only
-- the half of the history indexed under the id being filtered on.
--
-- Scope is narrow on purpose: only git:github.com/hotmun/* → munhq/*, verified
-- against the working tree where every affected repo's origin now points at
-- munhq/<same-name>. Inco-fhevm, darkkraft, amunt0 and third-party clones are
-- left alone, because an owner segment differing is not evidence of a rename.

UPDATE memory_metadata
   SET project_id = replace(project_id, 'git:github.com/hotmun/', 'git:github.com/munhq/')
 WHERE project_id LIKE 'git:github.com/hotmun/%';

UPDATE memory_chunks
   SET project_id = replace(project_id, 'git:github.com/hotmun/', 'git:github.com/munhq/')
 WHERE project_id LIKE 'git:github.com/hotmun/%';

UPDATE memory_vectors
   SET project_id = replace(project_id, 'git:github.com/hotmun/', 'git:github.com/munhq/')
 WHERE project_id LIKE 'git:github.com/hotmun/%';

-- Code intelligence, stale side WITH a current twin: drop it. code_projects is
-- keyed on (tenant, project_id) so a rename would collide, and finding/hotspot/
-- action ids are derived FROM the project id, so repointing them would leave two
-- rows per defect. The twin was indexed later and holds the same or more.

DELETE FROM code_findings f
 WHERE f.project_id LIKE 'git:github.com/hotmun/%'
   AND EXISTS (SELECT 1 FROM code_projects p
                WHERE p.tenant = f.tenant
                  AND p.project_id = replace(f.project_id, 'git:github.com/hotmun/', 'git:github.com/munhq/'));

DELETE FROM code_hotspots h
 WHERE h.project_id LIKE 'git:github.com/hotmun/%'
   AND EXISTS (SELECT 1 FROM code_projects p
                WHERE p.tenant = h.tenant
                  AND p.project_id = replace(h.project_id, 'git:github.com/hotmun/', 'git:github.com/munhq/'));

DELETE FROM code_actions a
 WHERE a.project_id LIKE 'git:github.com/hotmun/%'
   AND EXISTS (SELECT 1 FROM code_projects p
                WHERE p.tenant = a.tenant
                  AND p.project_id = replace(a.project_id, 'git:github.com/hotmun/', 'git:github.com/munhq/'));

DELETE FROM code_projects s
 WHERE s.project_id LIKE 'git:github.com/hotmun/%'
   AND EXISTS (SELECT 1 FROM code_projects p
                WHERE p.tenant = s.tenant
                  AND p.project_id = replace(s.project_id, 'git:github.com/hotmun/', 'git:github.com/munhq/'));

-- Stale side with NO twin: it is the only record of that repo's findings, so
-- rename in place and keep them until the next index run regenerates them.

UPDATE code_findings
   SET project_id = replace(project_id, 'git:github.com/hotmun/', 'git:github.com/munhq/')
 WHERE project_id LIKE 'git:github.com/hotmun/%';

UPDATE code_hotspots
   SET project_id = replace(project_id, 'git:github.com/hotmun/', 'git:github.com/munhq/')
 WHERE project_id LIKE 'git:github.com/hotmun/%';

UPDATE code_actions
   SET project_id = replace(project_id, 'git:github.com/hotmun/', 'git:github.com/munhq/')
 WHERE project_id LIKE 'git:github.com/hotmun/%';

UPDATE code_projects
   SET project_id = replace(project_id, 'git:github.com/hotmun/', 'git:github.com/munhq/')
 WHERE project_id LIKE 'git:github.com/hotmun/%';

-- ── Restore the original security posture ───────────────────────────────────
-- FORCE was never cleared, so ENABLE returns each table to enabled + forced.

ALTER TABLE session_metadata ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_metadata  ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_chunks    ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_vectors   ENABLE ROW LEVEL SECURITY;
ALTER TABLE code_projects    ENABLE ROW LEVEL SECURITY;
ALTER TABLE code_findings    ENABLE ROW LEVEL SECURITY;
ALTER TABLE code_hotspots    ENABLE ROW LEVEL SECURITY;
ALTER TABLE code_actions     ENABLE ROW LEVEL SECURITY;

COMMIT;
