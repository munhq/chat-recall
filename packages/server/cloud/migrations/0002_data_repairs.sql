-- 0002: one-off DATA repairs. Everything here is idempotent and re-runnable.
--
-- ── THE RLS TRAP THAT MAKES THIS FILE LOOK ODD ─────────────────────────────
--
-- Every tenant-scoped table carries this policy, for ALL commands, with RLS both
-- ENABLED and FORCED — so the owning role is subject to it too:
--
--   tenant_isolation:  tenant = current_setting('app.tenant', true)
--
-- A migration is cross-tenant and sets no tenant context. With `app.tenant`
-- unset, current_setting(…, true) is NULL, `tenant = NULL` is NULL, and NULL is
-- not true. Every row fails the check, the statement matches ZERO rows, and
-- nothing errors. It reports success, the runner writes the file into
-- schema_migrations, and because that ledger is the only guard it is never
-- retried. Silent, permanent, indistinguishable from success.
--
-- Two migrations were lost to exactly this before the files were consolidated:
-- an orphan-row cleanup (written 2026-08-04, all 4 rows still present 15 days
-- later) and the first attempt at the project-id consolidation below (371
-- memory_metadata rows and 16,155 memory_chunks untouched).
--
-- So every repair runs INSIDE a per-tenant loop that sets the GUC, which is the
-- same thing the application does via tenantQuery(). `tenants` is a control-plane
-- table with RLS deliberately disabled (see 0001 and pg-schema.ts), which is what
-- makes the loop able to enumerate at all.
--
-- migrate.mjs prints rows affected per statement, so a future silent no-op of
-- this kind shows up in the initContainer log instead of passing as success.

DO $$
DECLARE tn TEXT;
BEGIN
-- The migrate step runs BEFORE the server boots, so on a brand-new database none
-- of these tables exist yet — the bootstrap creates them moments later. Repairs
-- have nothing to act on there, and without this guard the whole initContainer
-- fails with `relation "tenants" does not exist` and the deployment never starts.
IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tenants') THEN
  RAISE NOTICE 'fresh database — no data to repair';
  RETURN;
END IF;

FOR tn IN SELECT tenant FROM tenants LOOP
  PERFORM set_config('app.tenant', tn, true);
  -- Some tables also carry a RESTRICTIVE author_visibility policy keyed on
  -- app.viewer; '*' is the service-level viewer the server itself uses.
  PERFORM set_config('app.viewer', '*', true);

  -- ── 1. Knowledge-graph junk from the pre-2026-07-02 entity extractor ──────
  -- It matched tool names as bare words in prose ("let me go check" → `go is_a
  -- language`), captured sentence fragments as entities ("otherwise.", "it"),
  -- read npm scopes as people (@playwright/test → "playwright is_a person"), and
  -- stamped `project uses claude/gemini` for essentially every AI transcript —
  -- zero information, since the per-session tool already lives in metadata.
  -- The extractor is fixed (context gating, evidence-based confidence,
  -- stoplists — see engine/src/core/entity-extractor.ts); this clears what it
  -- already wrote. Only classes that are junk BY CONSTRUCTION are deleted.

  DELETE FROM kg_triples
  WHERE length(trim(subject)) < 2
     OR length(trim(object)) < 2
     OR subject ~ '[.,;:!?]$'
     OR object  ~ '[.,;:!?]$'
     OR lower(trim(subject)) IN ('otherwise','it','this','that','them','these','those','here','there','then','thing','things','one','some','any','etc','else','such','more','most','the','a','an')
     OR lower(trim(object))  IN ('otherwise','it','this','that','them','these','those','here','there','then','thing','things','one','some','any','etc','else','such','more','most','the','a','an');

  DELETE FROM kg_triples
  WHERE lower(subject) IN ('claude','gemini')
     OR (predicate = 'uses' AND lower(object) IN ('claude','gemini'));

  DELETE FROM kg_triples
  WHERE predicate = 'is_a' AND object = 'person'
    AND lower(subject) IN ('playwright','vitest','jest','types','chat-recall','anthropic-ai','modelcontextprotocol','noble','lancedb');

  -- Entities orphaned by the deletions above — nothing refers to them on either
  -- side any more. RLS scopes both tables to the same tenant.
  DELETE FROM kg_entities e
  WHERE NOT EXISTS (
    SELECT 1 FROM kg_triples t WHERE t.subject = e.name OR t.object = e.name
  );

  -- ── 2. session_metadata rows with no memory_metadata parent ───────────────
  -- Unreachable by every read path AND unfixable in place: author_visibility
  -- hides them, and an ON CONFLICT DO UPDATE must read the conflicting row, so
  -- every sync touching one returned HTTP 500 for good. They hold only a title
  -- for a conversation that does not exist.

  DELETE FROM session_metadata s
  WHERE NOT EXISTS (
    SELECT 1 FROM memory_metadata m
    WHERE m.tenant = s.tenant AND m.id = s.session_id AND m.source_type = 'session'
  );

  -- ── 3. Project ids orphaned by the hotmun → munhq GitHub org rename ───────
  -- Identity is derived at index time from the git remote (see
  -- engine/src/types/project.ts, resolution step 2). That input is mutable, so
  -- renaming the org gave every affected repo a SECOND identity and the indexer
  -- created a new project beside the old one.
  --
  -- Not cosmetic: project_id tags sessions and chunks, not just code findings,
  -- so a project-scoped search returned only the half of the history indexed
  -- under the id being filtered on.
  --
  -- Scope is narrow on purpose — only git:github.com/hotmun/* → munhq/*,
  -- verified against the working tree where every affected repo's origin now
  -- points at munhq/<same-name>. Inco-fhevm, darkkraft, amunt0 and third-party
  -- clones are untouched, because an owner segment differing is not by itself
  -- evidence of a rename and guessing would merge unrelated repos. The prefix is
  -- matched in full so a PATH that merely contains the word (there is a
  -- `path:…/argocd-apps-hotmun` project) is never caught.

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
  -- keyed on (tenant, project_id) so a rename would collide, and finding /
  -- hotspot / action ids are derived FROM the project id, so repointing them
  -- would leave two rows per defect. The twin was indexed later and holds the
  -- same or more findings.

  DELETE FROM code_findings f
   WHERE f.project_id LIKE 'git:github.com/hotmun/%'
     AND EXISTS (SELECT 1 FROM code_projects p
                  WHERE p.project_id = replace(f.project_id, 'git:github.com/hotmun/', 'git:github.com/munhq/'));

  DELETE FROM code_hotspots h
   WHERE h.project_id LIKE 'git:github.com/hotmun/%'
     AND EXISTS (SELECT 1 FROM code_projects p
                  WHERE p.project_id = replace(h.project_id, 'git:github.com/hotmun/', 'git:github.com/munhq/'));

  DELETE FROM code_actions a
   WHERE a.project_id LIKE 'git:github.com/hotmun/%'
     AND EXISTS (SELECT 1 FROM code_projects p
                  WHERE p.project_id = replace(a.project_id, 'git:github.com/hotmun/', 'git:github.com/munhq/'));

  DELETE FROM code_projects s
   WHERE s.project_id LIKE 'git:github.com/hotmun/%'
     AND EXISTS (SELECT 1 FROM code_projects p
                  WHERE p.project_id = replace(s.project_id, 'git:github.com/hotmun/', 'git:github.com/munhq/'));

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

END LOOP;
END $$;
