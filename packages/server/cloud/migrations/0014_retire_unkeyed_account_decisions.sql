-- Account-scope decisions that no caller ever asked for.
--
-- Before the scope cascade existed, a decision write with nothing to key it on
-- fell back to the account sentinel. Eight decisions were recorded that way from
-- inside one repository, reading that repository's package.json: `*:api` Express,
-- `*:auth` BetterAuth, `*:database` Postgres, and five more. Every project with
-- no opinion of its own then inherited them, so a Tauri application whose store
-- is rusqlite was told its database decision was Postgres, and two unrelated
-- products printed an identical register.
--
-- The code stopped producing these in 2fb24f6e: a write that names a scope it
-- cannot key is refused, and only a caller that names NO scope at all reaches the
-- account. The rows already written stayed, and nothing retires a decision except
-- another decision replacing it — which never comes, because no project writes to
-- the account key.
--
-- So this ends their validity window. The graph is temporal: `valid_to` retires a
-- fact without deleting it, so the register stops answering from these while the
-- history still shows they were asserted and when.
--
-- ── What it will NOT touch ──────────────────────────────────────────────────
--
-- An account-wide decision somebody MEANT is a supported thing, and after the
-- fix it is the only way one gets written — the caller passes `scope: "account"`
-- explicitly. So the cut is the date that shipped: rows written before
-- 2026-09-15 could not have named a scope, and rows written after it did.
-- A deliberate account decision recorded since then survives this untouched.
--
-- Idempotent: only rows whose window is still open match, so a second run
-- matches nothing.
--
-- RLS-aware: kg_triples and kg_entities are tenant-scoped with FORCE RLS, so a
-- migration that sets no tenant matches ZERO rows without erroring. Loop the
-- tenants and set the GUC per iteration, exactly as tenantQuery does.
DO $$
DECLARE tn TEXT; retired INT; total INT := 0;
BEGIN
  IF to_regclass('public.kg_triples') IS NULL OR to_regclass('public.kg_entities') IS NULL THEN
    RAISE NOTICE 'the knowledge graph does not exist yet — nothing to repair';
    RETURN;
  END IF;

  FOR tn IN SELECT tenant FROM tenants LOOP
    PERFORM set_config('app.tenant', tn, true);

    UPDATE kg_triples t
       SET valid_to = to_char(now(), 'YYYY-MM-DD')
     WHERE t.tenant = tn
       AND t.valid_to IS NULL
       -- The rationale goes with the decision it explains. Left behind, it
       -- would keep printing under whatever replaces it.
       AND t.predicate IN ('decided', 'because')
       AND t.extracted_at < '2026-09-15'
       AND t.subject IN (
             SELECT e.id FROM kg_entities e
              WHERE e.tenant = tn
                -- `<scope>:<area>`, with the account sentinel as the scope. The
                -- entity NAME carries the subject; the triple's column holds a
                -- slug id, so matching on the column alone would match nothing.
                AND e.name LIKE '*:%'
           );

    GET DIAGNOSTICS retired = ROW_COUNT;
    total := total + retired;
    IF retired > 0 THEN
      RAISE NOTICE 'tenant %: retired % account-scope decision row(s)', tn, retired;
    END IF;
  END LOOP;

  RAISE NOTICE 'retired % unkeyed account-scope decision row(s) in total', total;
END $$;
