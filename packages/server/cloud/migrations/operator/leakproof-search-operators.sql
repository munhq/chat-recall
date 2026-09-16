-- SUPERUSER, RUN ONCE PER DATABASE. Not in migrate.mjs's FILES list on purpose.
--
-- WHAT THIS IS FOR
--
-- Full-text search on memory_chunks never used its index. Measured against a
-- NOBYPASSRLS role on 60k chunks, one matching row:
--
--   superuser (RLS bypassed)                Bitmap Index Scan     207 buffers
--   app role, any author_visibility policy  Seq Scan            3,228 buffers
--   app role, after this script             Bitmap Index Scan      15 buffers
--
-- The cause is not the policy. Under RLS, PostgreSQL will not push a
-- NON-LEAKPROOF operator into an index condition, because the index would be
-- consulted before the security filter. `@@` (ts_match_vq) and the trigram
-- similarity operators ship non-leakproof, so every search degraded to a
-- sequential scan over the tenant's whole chunk set — which is also why
-- idx_chunks_tenant_tsv (114 MB) and idx_chunks_tenant_trgm (306 MB) had been
-- scanned once and never, and why the typo fallback hit the statement timeout.
--
-- Rewriting the policy does NOT fix this. The unmodified parent-lookup policy
-- uses the index once these operators are leakproof.
--
-- WHAT IT COSTS
--
-- LEAKPROOF asserts the operator cannot reveal anything about its arguments
-- through errors or side channels. These compare a tsvector or a string and
-- raise no data-dependent error. The residual exposure is inference: with the
-- index consulted first, response time can suggest that SOME row matches a
-- query the caller may not read. Existence, never content, and never across a
-- tenant — tenant_isolation is a separate policy on a leakproof comparison.
-- PostgreSQL leaves these unmarked out of caution, not for a known exploit.
--
-- SCOPE. pg_proc is per-database: this affects this database only. On the
-- shared cluster the other databases are untouched.
--
-- TO REVERT: the same statements with NOT LEAKPROOF.
--
--   psql "$SUPERUSER_URL" -f leakproof-search-operators.sql
--
DO $$
BEGIN
  IF NOT current_setting('is_superuser')::boolean THEN
    RAISE EXCEPTION 'must run as a superuser: ALTER FUNCTION ... LEAKPROOF is superuser-only, and the app role (chat_recall) is NOSUPERUSER';
  END IF;
END $$;

-- Full-text search: `tsv @@ plainto_tsquery(...)`.
ALTER FUNCTION pg_catalog.ts_match_vq(tsvector, tsquery) LEAKPROOF;

-- Typo/trigram fallback: word_similarity(query, text) and the `<%` operator
-- behind idx_chunks_tenant_trgm. pg_trgm installs these into public, not
-- pg_catalog, so they are schema-qualified differently from `@@`.
ALTER FUNCTION public.similarity_op(text, text) LEAKPROOF;
ALTER FUNCTION public.word_similarity_op(text, text) LEAKPROOF;
ALTER FUNCTION public.strict_word_similarity_op(text, text) LEAKPROOF;

SELECT proname, proleakproof
  FROM pg_proc
 WHERE proname IN ('ts_match_vq', 'similarity_op', 'word_similarity_op', 'strict_word_similarity_op')
 ORDER BY proname;
