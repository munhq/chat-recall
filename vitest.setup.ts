// resolveBackend() is fail-closed: an unset CHAT_RECALL_STORAGE throws instead
// of silently falling back to sqlite (a misconfigured server must not boot onto
// a local file). Tests are the one place sqlite is a legitimate backend, so the
// suite opts in explicitly here. Postgres-mode runs (store parity/isolation)
// export CHAT_RECALL_STORAGE=postgres + DATABASE_URL themselves.
if (!process.env.CHAT_RECALL_STORAGE) {
  process.env.CHAT_RECALL_STORAGE = 'sqlite';
}
