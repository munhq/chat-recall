/**
 * Which chunks the vector backfill embeds.
 *
 * Plain `assistant` chatter (~64% of chunks), `subagent:*` fan-out (~8%) and
 * `harness` text stay keyword-searchable and get no vector. Trivial sessions
 * (few turns and little output) get none either. The embed worker and the
 * pending-vectors metric both build their WHERE from this file, so the metric
 * counts exactly the chunks the worker will embed. Counting every chunk
 * without a vector gave 245,352 on the largest tenant, of which only the
 * embeddable part is work.
 */
export interface EmbedPolicy {
  /** Sessions with this many turns or fewer can be trivial. */
  minTurns: number;
  /** A session below this many output tokens can be trivial. */
  maxTrivialOut: number;
  /** EMBED_INCLUDE_ALL_CHUNKS: embed assistant, harness and subagent chunks too. */
  includeAll: boolean;
}

export function embedPolicy(env: NodeJS.ProcessEnv = process.env): EmbedPolicy {
  return {
    minTurns: Math.max(0, Number(env.EMBED_MIN_TURNS ?? env.SUMMARY_MIN_TURNS) || 4),
    maxTrivialOut: Math.max(0, Number(
      env.EMBED_TRIVIAL_MAX_OUTPUT_TOKENS ?? env.SUMMARY_TRIVIAL_MAX_OUTPUT_TOKENS) || 2000),
    includeAll: Boolean(env.EMBED_INCLUDE_ALL_CHUNKS),
  };
}

/**
 * The chunk types the worker embeds, as a WHERE clause over `<alias>.chunk_type`
 * (no alias: bare column names, for an index predicate).
 */
export function embeddableChunkTypeSql(alias = ''): string {
  const col = alias ? `${alias}.chunk_type` : 'chunk_type';
  return `NOT (${col} = 'assistant' OR ${col} = 'harness' OR ${col} LIKE 'subagent%')`;
}

/**
 * The predicate of idx_chunks_embeddable. A query that repeats it, as
 * embeddableChunkSql does together with `c.text <> ''`, reads the index (about
 * 53,000 rows on the largest tenant) and never touches the 275,000 chunks.
 */
export const EMBEDDABLE_CHUNK_INDEX_PREDICATE = `text <> '' AND ${embeddableChunkTypeSql()}`;

/**
 * The `AND ...` clauses that keep only embeddable chunks, for a query over
 * `memory_chunks <alias>`.
 *
 * #10 follow-up: the trivial-session test is no longer an `EXISTS` against
 * `memory_metadata` per chunk — it reads the chunk's own `trivial` flag, which
 * the writer maintains (pg.ts: writeChunkRows sets it from the parent metadata,
 * writeItemRows clears it when a session grows past the threshold). The flag is
 * also in the partial index predicate (pg-pool.ts), so the pending-vectors
 * count is an index-only scan over the chunks that will actually be embedded
 * instead of walking every trivial chunk and discarding it.
 */
export function embeddableChunkFlagSql(alias: string, policy: EmbedPolicy): string {
  const c = alias;
  const chunkFilter = policy.includeAll ? '' : `AND ${embeddableChunkTypeSql(c)}`;
  return `${chunkFilter} AND NOT ${c}.trivial`;
}

/**
 * SQL boolean: the metadata row `<m>` is a trivial session under `policy`.
 *
 * Kept next to the flag so the writer and the predicate cannot drift: the same
 * expression decides a chunk's `trivial` value at write time. `minParam` and
 * `outParam` are the bind placeholders ('$3', '$4') the caller fills with
 * `policy.minTurns` and `policy.maxTrivialOut`.
 */
export function trivialSessionPredicateSql(
  m: string,
  minParam: string,
  outParam: string,
): string {
  return `(${m}.extra_json LIKE '{%'
    AND COALESCE(NULLIF(${m}.extra_json::jsonb ->> 'messageCount', '')::int, 999) <= ${minParam}
    AND COALESCE(NULLIF(${m}.extra_json::jsonb ->> 'outputTokens', '')::bigint, 0) < ${outParam})`;
}
