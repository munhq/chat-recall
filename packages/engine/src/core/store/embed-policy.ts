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
 * The `AND ...` clauses that keep only embeddable chunks, for a query over
 * `memory_chunks <alias>`. `minTurnsParam` and `maxOutParam` are the bind
 * placeholders ('$3', '$4') that the caller fills with `policy.minTurns` and
 * `policy.maxTrivialOut`.
 */
export function embeddableChunkSql(
  alias: string,
  policy: EmbedPolicy,
  minTurnsParam: string,
  maxOutParam: string,
): string {
  const c = alias;
  const chunkFilter = policy.includeAll
    ? ''
    : `AND NOT (${c}.chunk_type = 'assistant' OR ${c}.chunk_type = 'harness' OR ${c}.chunk_type LIKE 'subagent%')`;
  return `${chunkFilter}
             AND NOT (
               ${c}.source_type = 'session'
               AND EXISTS (
                 SELECT 1 FROM memory_metadata m
                  WHERE m.tenant = ${c}.tenant AND m.id = ${c}.item_id AND m.source_type = 'session'
                    AND m.extra_json LIKE '{%'
                    AND COALESCE(NULLIF(m.extra_json::jsonb ->> 'messageCount', '')::int, 999) <= ${minTurnsParam}
                    AND COALESCE(NULLIF(m.extra_json::jsonb ->> 'outputTokens', '')::bigint, 0) < ${maxOutParam}
               )
             )`;
}
