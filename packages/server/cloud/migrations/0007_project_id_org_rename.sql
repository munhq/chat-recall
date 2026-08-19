-- 0007: consolidate project ids orphaned by the hotmun → munhq GitHub org rename.
--
-- WHY THIS IS NEEDED
--
-- A project's identity is derived at index time from its git remote
-- (`git:<host>/<owner>/<repo>` — see engine/src/types/project.ts, resolution
-- step 2). The remote is MUTABLE: renaming a repo or moving it between orgs
-- changes it. When the `hotmun` org became `munhq`, every affected repo therefore
-- acquired a SECOND identity, and the indexer did the only thing it could — it
-- created a new project and left the old one behind, frozen.
--
-- That split is not cosmetic. `project_id` tags sessions and chunks, not just
-- code findings, so a project-scoped search silently returned only the half of
-- the history that happened to be indexed under the id being filtered on.
--
-- Measured on production 2026-08-19, before this migration:
--
--   memory_metadata   371 rows on 14 stale ids   (662 on the current ids)
--   memory_chunks   16,155 rows on stale ids   (84,572 on the current ids)
--
-- So ~16k chunks of real history — every session in those repos from before the
-- rename — could not be reached by a filter on the repo's current id. All 14
-- stale ids have a current counterpart, so this consolidates; nothing disappears
-- from a listing, the two halves become one.
--
-- SCOPE — deliberately narrow. Only `git:github.com/hotmun/*` is rewritten, to
-- `git:github.com/munhq/*`, verified against the working tree: every affected
-- repo's `origin` now points at `munhq/<same-name>`. Other owners present in the
-- data (Inco-fhevm, darkkraft, amunt0, and third-party clones) are NOT touched —
-- an owner segment changing is not by itself evidence of a rename, and guessing
-- would merge unrelated repos.
--
-- WHY THE TWO HALVES ARE TREATED DIFFERENTLY
--
--   memory_* : `project_id` is a TAG, not part of any key, so the stale value is
--              simply rewritten and the rows merge into the current project.
--   code_*   : `code_projects` is keyed on (tenant, project_id), so a rename
--              would collide with an existing twin; and finding/hotspot/action
--              ids are DERIVED from the project id, so repointing them would
--              leave two rows for one defect. Where a current twin exists the
--              stale rows are dropped instead — the twin was re-indexed later and
--              holds the same or more findings. Where no twin exists the id is
--              renamed in place, keeping the findings.
--
-- Nothing here is unrecoverable: code findings are derived data that a re-index
-- regenerates from the repo, and the memory rows are only re-tagged, never
-- deleted.
--
-- This migration heals the existing split. It does not prevent recurrence — that
-- needs a durable identity at index time (a repo's root-commit sha) rather than
-- its current remote, which is a code change, not a data one.

-- ── 1. Sessions, chunks and vectors: re-tag onto the current id ──────────────
-- project_id is not part of any key in these tables, so this is a pure re-tag.
-- memory_vectors is partitioned by HASH(tenant), not by project_id, so no row
-- movement is involved.

UPDATE memory_metadata
   SET project_id = replace(project_id, 'git:github.com/hotmun/', 'git:github.com/munhq/')
 WHERE project_id LIKE 'git:github.com/hotmun/%';

UPDATE memory_chunks
   SET project_id = replace(project_id, 'git:github.com/hotmun/', 'git:github.com/munhq/')
 WHERE project_id LIKE 'git:github.com/hotmun/%';

UPDATE memory_vectors
   SET project_id = replace(project_id, 'git:github.com/hotmun/', 'git:github.com/munhq/')
 WHERE project_id LIKE 'git:github.com/hotmun/%';

-- ── 2. Code intelligence: drop the stale side where a current twin exists ────
-- Children first: their ids encode the stale project id, so they cannot simply be
-- repointed without duplicating each finding under the surviving project.

DELETE FROM code_findings f
 WHERE f.project_id LIKE 'git:github.com/hotmun/%'
   AND EXISTS (
     SELECT 1 FROM code_projects p
      WHERE p.tenant = f.tenant
        AND p.project_id = replace(f.project_id, 'git:github.com/hotmun/', 'git:github.com/munhq/')
   );

DELETE FROM code_hotspots h
 WHERE h.project_id LIKE 'git:github.com/hotmun/%'
   AND EXISTS (
     SELECT 1 FROM code_projects p
      WHERE p.tenant = h.tenant
        AND p.project_id = replace(h.project_id, 'git:github.com/hotmun/', 'git:github.com/munhq/')
   );

DELETE FROM code_actions a
 WHERE a.project_id LIKE 'git:github.com/hotmun/%'
   AND EXISTS (
     SELECT 1 FROM code_projects p
      WHERE p.tenant = a.tenant
        AND p.project_id = replace(a.project_id, 'git:github.com/hotmun/', 'git:github.com/munhq/')
   );

DELETE FROM code_projects s
 WHERE s.project_id LIKE 'git:github.com/hotmun/%'
   AND EXISTS (
     SELECT 1 FROM code_projects p
      WHERE p.tenant = s.tenant
        AND p.project_id = replace(s.project_id, 'git:github.com/hotmun/', 'git:github.com/munhq/')
   );

-- ── 3. Code intelligence: rename the remainder in place ─────────────────────
-- No twin exists for these, so the stale row IS the only record of the repo's
-- findings. Renaming keeps them until the next index run regenerates them under
-- the correct id. Parent last would orphan the children mid-statement, so the
-- children are updated first; both sides move within one implicit transaction.

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
