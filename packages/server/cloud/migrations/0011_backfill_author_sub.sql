-- Give every unowned row an owner.
--
-- `author_sub IS NULL` means "written before attribution existed". The
-- team-visibility policies read NULL as legacy and make the row visible to the
-- WHOLE tenant (see author_visibility in pg-schema.ts) — a deliberate choice, so
-- that turning attribution on could not retroactively hide anyone's data. The
-- cost is that an unowned row is the one row a new member sees on the day they
-- join, and nobody can say whose it is.
--
-- Five tables consult author_sub directly for visibility: memory_metadata,
-- secret_findings, session_metadata, kg_triples, diary_entries. The others
-- inherit from a parent, so stamping them changes no read — it just makes
-- per-author activity and analytics agree with the rest.
--
-- SAFE ONLY FOR A SINGLE-MEMBER TENANT. Where one person is the only member,
-- every row is theirs by construction. Where there are several, a legacy row
-- cannot be attributed from the data, and guessing would either hide it from
-- someone who relies on it or credit the wrong person — so those tenants are
-- skipped and named in the log.
--
-- Idempotent: the predicate is `author_sub IS NULL`, so a second run matches
-- nothing.
--
-- GUARDED on each table existing (this runs before the server boots, so on a
-- fresh database nothing does) and RLS-aware: these tables are tenant-scoped
-- with FORCE RLS, so a migration that sets no tenant matches ZERO rows without
-- erroring. Loop the tenants and set the GUC per iteration, exactly as
-- tenantQuery does. app.viewer is set to the '*' worker sentinel so the
-- RESTRICTIVE author_visibility policy does not filter the rows being repaired.
DO $$
DECLARE
  tn       TEXT;
  owner_sub TEXT;
  members  INT;
  tbl      TEXT;
  stamped  INT;
  per_tn   INT;
  total    INT := 0;
  skipped  INT := 0;
  TABLES   TEXT[] := ARRAY[
    'memory_metadata', 'memory_chunks', 'session_metadata', 'session_outcome_cache',
    'secret_findings', 'kg_triples', 'diary_entries',
    'code_projects', 'code_findings', 'code_hotspots', 'code_actions'
  ];
BEGIN
  IF to_regclass('public.memberships') IS NULL THEN
    RAISE NOTICE 'memberships does not exist yet — the bootstrap runs first, skipping';
    RETURN;
  END IF;

  FOR tn IN SELECT tenant FROM tenants LOOP
    SELECT count(*) INTO members FROM memberships WHERE team_slug = tn;

    IF members <> 1 THEN
      -- 0 members: an orphan or test tenant, nobody to attribute to.
      -- 2+ members: ambiguous, and a wrong guess is worse than a NULL.
      IF members > 1 THEN
        skipped := skipped + 1;
        RAISE NOTICE 'skipped % — % members, cannot attribute a legacy row', tn, members;
      END IF;
      CONTINUE;
    END IF;

    SELECT user_sub INTO owner_sub FROM memberships WHERE team_slug = tn;

    PERFORM set_config('app.tenant', tn, true);
    PERFORM set_config('app.viewer', '*', true);

    per_tn := 0;
    FOREACH tbl IN ARRAY TABLES LOOP
      CONTINUE WHEN to_regclass('public.' || tbl) IS NULL;
      CONTINUE WHEN NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = tbl AND column_name = 'author_sub'
      );

      EXECUTE format('UPDATE %I SET author_sub = %L WHERE author_sub IS NULL', tbl, owner_sub);
      GET DIAGNOSTICS stamped = ROW_COUNT;
      per_tn := per_tn + stamped;
    END LOOP;

    IF per_tn > 0 THEN
      RAISE NOTICE 'stamped % row(s) in %', per_tn, tn;
    END IF;
    total := total + per_tn;
  END LOOP;

  RAISE NOTICE 'author_sub backfill: % row(s) stamped, % tenant(s) skipped', total, skipped;
END $$;
