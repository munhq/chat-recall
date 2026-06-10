#!/bin/sh
# Single-container entrypoint: one process tree serves the UI + API and keeps
# the index fresh. No separate nginx, no separate indexer container.
set -e
TSX="node_modules/.bin/tsx"

# Backfill the index (incremental — only new/changed sessions) and then watch
# for new ones. Runs in the background so the UI is reachable immediately and
# fills in as indexing proceeds, instead of blocking startup for minutes.
(
  echo "[entrypoint] indexing existing sessions (incremental)…"
  $TSX packages/cli/src/cli.ts memory index || echo "[entrypoint] initial index failed (will still watch)"
  echo "[entrypoint] watching for new sessions…"
  $TSX packages/cli/auto-indexer/indexer.ts
) &

# Server in the foreground (UI + API). It serves the built SPA from STATIC_DIR.
exec $TSX packages/server/src/server.ts
