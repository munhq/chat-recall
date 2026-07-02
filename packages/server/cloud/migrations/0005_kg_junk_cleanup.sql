-- 0005: purge knowledge-graph triples minted by the pre-2026-07-02 entity
-- extractor, which matched tool names as bare words in prose ("let me go
-- check" → `go is_a language`), captured sentence fragments as entities
-- ("otherwise.", "it"), treated npm scopes as people (@playwright/test →
-- "playwright is_a person"), and stamped `project uses claude/gemini` for
-- essentially every AI transcript (zero information — the per-session tool
-- already lives in metadata).
--
-- The extractor is fixed (context-gated ambiguous names, evidence-based
-- confidence, stoplists — see engine/src/core/entity-extractor.ts); this
-- deletes what it already wrote so the UI's display-side junk filter can be
-- removed instead of papering over bad rows forever. Deliberately
-- conservative: only classes of triple that are junk BY CONSTRUCTION are
-- touched — an ambiguous-word triple like `go is_a language` may be
-- legitimate for a real Go project, so those stay (they age out as sessions
-- re-sync through the fixed extractor).
--
-- kg_triples/kg_entities are under FORCE RLS and the migrator role is
-- NOBYPASSRLS, so a naked DELETE here would silently match ZERO rows. The
-- `tenants` control-plane table is not RLS'd — loop it and set the tenant
-- GUC (txn-local) per iteration, exactly like the app does.
DO $$
DECLARE tn TEXT;
BEGIN
  FOR tn IN SELECT tenant FROM tenants LOOP
    PERFORM set_config('app.tenant', tn, true);

    -- 1. Sentence fragments and filler words as subject or object.
    DELETE FROM kg_triples
    WHERE length(trim(subject)) < 2
       OR length(trim(object)) < 2
       OR subject ~ '[.,;:!?]$'
       OR object  ~ '[.,;:!?]$'
       OR lower(trim(subject)) IN ('otherwise','it','this','that','them','these','those','here','there','then','thing','things','one','some','any','etc','else','such','more','most','the','a','an')
       OR lower(trim(object))  IN ('otherwise','it','this','that','them','these','those','here','there','then','thing','things','one','some','any','etc','else','such','more','most','the','a','an');

    -- 2. Zero-signal assistant-name triples: every AI transcript mentions
    --    the assistant, so these say nothing about the project.
    DELETE FROM kg_triples
    WHERE lower(subject) IN ('claude','gemini')
       OR (predicate = 'uses' AND lower(object) IN ('claude','gemini'));

    -- 3. npm scopes / package handles misread as people.
    DELETE FROM kg_triples
    WHERE predicate = 'is_a' AND object = 'person'
      AND lower(subject) IN ('playwright','vitest','jest','types','chat-recall','anthropic-ai','modelcontextprotocol','noble','lancedb');

    -- 4. Entities orphaned by the deletions above (nothing refers to them
    --    on either side anymore, same tenant — RLS scopes both tables).
    DELETE FROM kg_entities e
    WHERE NOT EXISTS (
      SELECT 1 FROM kg_triples t
      WHERE t.subject = e.name OR t.object = e.name
    );
  END LOOP;
END $$;
