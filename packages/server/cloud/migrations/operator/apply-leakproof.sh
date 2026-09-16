#!/usr/bin/env bash
# Apply the leakproof search operators to the hosted database.
#
# Full-text search never used its index: under RLS, PostgreSQL will not push a
# non-leakproof operator into an index condition. Measured in production as the
# app role, 253k chunks: 8,453 ms with 253,276 rows discarded by filter, on the
# wrong index. With these flags the same query takes a Bitmap Index Scan.
#
# Superuser-only, one time, this database only. Revert with REVERT=1.
set -euo pipefail

# Point KUBECONFIG at the cluster running the database before calling this.
: "${KUBECONFIG:?set KUBECONFIG to the kubeconfig for the cluster hosting Postgres}"
export KUBECONFIG
DB="${DB:-chat_recall}"
NS="${NS:-database}"
SQL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The primary moves. Resolve it, never hardcode it.
PRIMARY="$(kubectl get pods -n "$NS" \
  -l 'cnpg.io/cluster=postgresql,role=primary' \
  -o jsonpath='{.items[0].metadata.name}')"
[ -n "$PRIMARY" ] || { echo "no primary found in namespace $NS" >&2; exit 1; }
echo "primary: $PRIMARY   database: $DB"

if [ "${REVERT:-0}" = "1" ]; then
  echo "REVERTING — search will sequential-scan again."
  kubectl exec -i "$PRIMARY" -n "$NS" -c postgres -- \
    psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 <<'SQL'
ALTER FUNCTION pg_catalog.ts_match_vq(tsvector, tsquery) NOT LEAKPROOF;
ALTER FUNCTION public.similarity_op(text, text) NOT LEAKPROOF;
ALTER FUNCTION public.word_similarity_op(text, text) NOT LEAKPROOF;
ALTER FUNCTION public.strict_word_similarity_op(text, text) NOT LEAKPROOF;
SELECT proname, proleakproof FROM pg_proc
 WHERE proname IN ('ts_match_vq','similarity_op','word_similarity_op','strict_word_similarity_op')
 ORDER BY 1;
SQL
  exit 0
fi

kubectl exec -i "$PRIMARY" -n "$NS" -c postgres -- \
  psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 < "$SQL_DIR/leakproof-search-operators.sql"

echo
echo "verifying the planner now reaches the index (as the app role, not a superuser):"
# Resolve the busiest tenant and one of its authors as the SUPERUSER — under the
# app role these lookups are themselves behind RLS, and with app.tenant not yet
# set they return nothing, which silently verifies an empty tenant.
T="$(kubectl exec -i "$PRIMARY" -n "$NS" -c postgres -- psql -U postgres -d "$DB" -qAt -c \
  "SELECT tenant FROM memory_metadata WHERE source_type='session' GROUP BY tenant ORDER BY count(*) DESC LIMIT 1")"
V="$(kubectl exec -i "$PRIMARY" -n "$NS" -c postgres -- psql -U postgres -d "$DB" -qAt -c \
  "SELECT author_sub FROM memory_metadata WHERE tenant='$T' AND author_sub IS NOT NULL LIMIT 1")"
TERM_TO_FIND="${TERM_TO_FIND:-postgres}"
echo "tenant under test: $T"

kubectl exec -i "$PRIMARY" -n "$NS" -c postgres -- psql -U postgres -d "$DB" -qAt <<SQL
BEGIN;
SET LOCAL statement_timeout = '120s';
SET LOCAL ROLE ${APP_ROLE:-chat_recall};
SELECT set_config('app.tenant', '$T', true);
SELECT set_config('app.viewer', '$V', true);
EXPLAIN (ANALYZE, COSTS OFF, TIMING ON)
  SELECT chunk_id FROM memory_chunks
   WHERE tenant = '$T' AND tsv @@ plainto_tsquery('english','$TERM_TO_FIND');
COMMIT;
SQL
echo
echo "Want: 'Bitmap Index Scan on idx_chunks_tenant_tsv' and a non-zero row count."
echo "A Seq Scan, or rows=0, means it did not take or the term matched nothing."
